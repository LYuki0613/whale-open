// 记忆海适配层：把本体的 SQLite 记忆库，翻译成 memory-sea 要的三段数据。
//
// 上游 3d-memory-sea 只认 { longTerm, messages, diaries }：
//   longTerm → 我们的 memories（五种 kind 映射到它的 event/feeling/fact/plan/conclusion）
//   messages → style_samples（真人消息）+ share_log（她主动说过的话）
//   diaries  → <dataRoot>/diary/YYYY-MM.md（本体自己的日记，可用 config.life.diaryDir 改）
import fs from 'node:fs';
import path from 'node:path';
import { createSceneService } from '../mindsea/src/scene-service.mjs';
import { now, parseMeta } from './db.mjs';

// 我们的 kind → 上游**源数据层**的 kind。
// 注意：不能直接给最终颜色名。上游 pointFromLongTerm 还有一层 LT_KIND_MAP
// （fact→fact / event→event / promise→plan / preference→feeling，其余一律 conclusion），
// 所以这里要给出它认得的那四个词，否则 feeling / plan 会被拍平成 conclusion（实测踩过）。
const KIND_MAP = {
  episode: 'event',
  reflection: 'preference',   // → feeling
  fact: 'fact',
  skill: 'promise',           // → plan
  lesson: 'lesson',           // 不在映射表里 → conclusion（正是我们要的）
};

const CACHE_MS = 30_000;
let service = null;
let cache = { at: 0, scene: null, points: 0 };

/** 解析日记文件：## YYYY-MM-DD HH:mm · 标题 + 正文 */
export function readDiaries(dir, limit = 200) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (!/^\d{4}-\d{2}\.md$/.test(name)) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    for (const chunk of text.split(/\n## /).slice(1)) {
      const nl = chunk.indexOf('\n');
      const head = (nl >= 0 ? chunk.slice(0, nl) : chunk).trim();
      const body = (nl >= 0 ? chunk.slice(nl + 1) : '').trim();
      const m = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?\s*·?\s*(.*)$/.exec(head);
      if (!m || !body) continue;
      out.push({
        date: m[1],
        text: body.slice(0, 1000),
        createdAt: new Date(`${m[1]}T${m[2] ?? '00:00'}:00`).getTime(),
        title: m[3] || undefined,
      });
    }
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out.slice(-limit);
}

/** 从 SQLite 取三段数据。 */
export function buildData(db, cfg, at = now()) {
  const longTerm = db.prepare(`
    SELECT id, kind, text, importance, created_at, COALESCE(last_access, created_at) AS last_seen, status, meta
    FROM memories WHERE status IN ('active','conflict') ORDER BY created_at DESC LIMIT 800
  `).all().map((r) => {
    const meta = parseMeta(r.meta);
    const topic = Array.isArray(meta.entities) && meta.entities.length ? String(meta.entities[0]) : undefined;
    return {
      id: r.id,
      text: String(r.text).slice(0, 300),
      kind: KIND_MAP[r.kind] ?? 'conclusion',
      topic,
      confirmed: r.status === 'active',
      importance: Number(r.importance ?? 0.5),
      createdAt: Number(r.created_at),
      lastMentionAt: Number(r.last_seen),
    };
  });

  // 真人消息（语感样本就是最近 300 条真人发言）
  const messages = db.prepare('SELECT text, at, key FROM style_samples ORDER BY at DESC LIMIT 400').all()
    .map((r) => ({ sender: String(r.key ?? '群友'), text: String(r.text).slice(0, 200), at: Number(r.at), isOwner: false }));

  // 她主动说过的话，标成 isSelf
  try {
    for (const r of db.prepare('SELECT text, at FROM share_log ORDER BY at DESC LIMIT 100').all()) {
      messages.push({ sender: '她', text: String(r.text).slice(0, 200), at: Number(r.at), isSelf: true });
    }
  } catch {}

  const diaries = readDiaries(cfg.life?.diaryDir || path.join(cfg.system.dataRoot, 'diary'));

  return { name: '记忆海', longTerm, messages, diaries };
}

/** 取场景（30 秒缓存，避免每帧都重建）。 */
export function getScene(db, cfg, { force = false, rebuild = false, at = now() } = {}) {
  if (!force && !rebuild && cache.scene && at - cache.at < CACHE_MS) {
    return { ...cache.scene, cached: true };
  }
  const data = buildData(db, cfg, at);
  if (!service) service = createSceneService({ data });
  else service.load(data);
  const stats = service.rebuild();
  const scene = service.scene({});
  cache = { at, scene, points: stats.points };
  return { ...scene, cached: false, source: { longTerm: data.longTerm.length, messages: data.messages.length, diaries: data.diaries.length } };
}

export function resetScene() {
  service = null;
  cache = { at: 0, scene: null, points: 0 };
}
