// 生活层：随机活动 + 兴趣权重 + 长期/临时笔记。
// 设计上它是**独立进程**（cli.mjs life），不在聊天主进程里；这里只放纯逻辑。
import fs from 'node:fs';
import path from 'node:path';
import { now, uid } from './db.mjs';
import { loadState as loadEmotion } from './emotion.mjs';
import { remember } from './memory.mjs';

const DAY = 86400000;

/** 初始化兴趣池（只跑一次）。 */
export function seedInterests(db) {
  const n = db.prepare('SELECT COUNT(*) AS c FROM interests').get()?.c ?? 0;
  if (n) return n;
  const seed = [
    ['看二次元日常番', 0.7, ['放松']],
    ['研究 DSH 插件', 0.6, ['烧脑']],
    ['写点小东西', 0.6, ['创造']],
    ['刷 B 站鬼畜', 0.65, ['放松']],
    ['整理日记本', 0.5, ['创造']],
    ['发呆看窗外', 0.4, ['放松']],
  ];
  for (const [name, w, tags] of seed) {
    db.prepare('INSERT OR REPLACE INTO interests(id,name,weight,tags,last_done,done_count) VALUES (?,?,?,?,?,0)')
      .run(uid(), name, w, JSON.stringify(tags), null);
  }
  return seed.length;
}

/** 久未碰的兴趣衰减。 */
export function decayInterests(db, at = now()) {
  const rows = db.prepare('SELECT id, weight, last_done FROM interests').all();
  for (const r of rows) {
    const ref = Number(r.last_done ?? 0);
    if (!ref) continue;
    const days = (at - ref) / DAY;
    if (days < 1) continue;
    const w = Math.max(0.05, Number(r.weight) - days * 0.03);
    db.prepare('UPDATE interests SET weight=? WHERE id=?').run(w, r.id);
  }
}

/**
 * 挑一个活动。
 * score = weight × moodFit × novelty；10% 概率直接探索新兴趣。
 */
export function pickActivity(db, cfg, at = now()) {
  const state = loadEmotion(db, cfg);
  const lowMood = state.p < -0.2;
  const rows = db.prepare('SELECT * FROM interests').all();
  if (!rows.length) return { activity: '发呆', interest: null, note: '没什么想干的', explore: false };

  if (Math.random() < Number(cfg.life?.exploreRate ?? 0.1)) {
    const names = ['临摹一张画', '试着写首诗', '研究一个冷知识', '听没听过的歌单', '翻旧番'];
    const name = names[Math.floor(Math.random() * names.length)];
    db.prepare('INSERT INTO interests(id,name,weight,tags,last_done,done_count) VALUES (?,?,?,?,?,1)')
      .run(uid(), name, 0.45, JSON.stringify(['放松']), at);
    return { activity: '探索新兴趣', interest: name, note: '第一次试', explore: true };
  }

  const scored = rows.map((r) => {
    const tags = safeTags(r.tags);
    const bias = lowMood
      ? (tags.some((t) => (cfg.life?.moodBiasWhenLow ?? []).includes(t)) ? 1.6 : 0.7)
      : 1;
    const novelty = r.last_done ? 1 : 1.3;
    return { row: r, score: Number(r.weight) * bias * novelty * (0.8 + Math.random() * 0.4) };
  }).sort((a, b) => b.score - a.score);

  const pick = scored[0].row;
  return { activity: pick.name, interest: pick.name, note: '', explore: false, id: pick.id };
}

export function finishActivity(db, cfg, pick, at = now()) {
  try {
    db.prepare('UPDATE interests SET weight = MIN(1, weight + ?), last_done = ?, done_count = done_count + 1 WHERE id = ?')
      .run(Number(cfg.life?.weightUp ?? 0.05), at, pick.id);
  } catch {}
  try {
    db.prepare('INSERT OR REPLACE INTO life_log(at,activity,interest,note) VALUES (?,?,?,?)')
      .run(at, pick.activity, pick.interest ?? '', pick.note ?? '');
  } catch {}
  // 清理过期临时笔记
  try { db.prepare('DELETE FROM working_notes WHERE expires_at < ?').run(at); } catch {}
  return pick;
}

/** 写一条笔记：长期 → 记忆层；临时 → working_notes（TTL 1 天）。 */
export function writeNote(db, cfg, { text, long = false, at = now() }) {
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, reason: '空笔记' };
  if (long) {
    const r = remember(db, cfg, { kind: 'reflection', text: body, importance: 0.55, source: 'life', meta: { from: 'life-note' } }, { at });
    // 同时落一份人类可读文件
    try {
      const f = path.join(cfg.system.dataRoot, 'life', 'notes', 'long', `${new Date(at).toISOString().slice(0, 10)}.md`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, `## ${new Date(at).toLocaleTimeString('zh-CN')}\n${body}\n\n`, 'utf8');
    } catch {}
    return { ok: true, store: 'memory', ...r };
  }
  const ttl = Number(cfg.life?.tmpNoteTtlHours ?? 24) * 3600000;
  try {
    db.prepare('INSERT INTO working_notes(id,text,created_at,expires_at) VALUES (?,?,?,?)').run(uid(), body, at, at + ttl);
  } catch {}
  return { ok: true, store: 'working', expiresAt: at + ttl };
}

function safeTags(v) {
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
