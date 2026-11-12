// 记忆写入：去重合并（余弦≥0.92 或 bigram Jaccard≥0.92）、冲突标记、分类上限淘汰、归档清理。
import fs from 'node:fs';
import path from 'node:path';
import { toFtsText, tokens } from './bigram.mjs';
import { now, uid, parseMeta } from './db.mjs';

const KINDS = new Set(['episode', 'fact', 'reflection', 'skill', 'lesson']);
const DAY = 86400000;

export function jaccard(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** 相似度：有向量用余弦，没有就用 bigram Jaccard（embed.mode=off 时的等价近似）。 */
export function similarity(rowA, textB, embedFn) {
  if (rowA.embedding && embedFn) {
    const vecB = embedFn(textB);
    if (vecB) return cosine(rowA.embedding, vecB);
  }
  return jaccard(rowA.text, textB);
}

export function cosine(bufA, vecB) {
  if (!bufA || !vecB) return 0;
  const a = new Float32Array(bufA.buffer, bufA.byteOffset, bufA.byteLength / 4);
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, vecB.length);
  for (let i = 0; i < n; i += 1) { dot += a[i] * vecB[i]; na += a[i] * a[i]; nb += vecB[i] * vecB[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

function ftsInsert(db, row) {
  try {
    db.prepare('DELETE FROM mem_fts WHERE rowid = ?').run(row.rid);
    db.prepare('INSERT INTO mem_fts(rowid, bigram) VALUES (?, ?)').run(row.rid, toFtsText(row.text));
  } catch {}
}

function ftsDelete(db, rid) {
  try { db.prepare('DELETE FROM mem_fts WHERE rowid = ?').run(rid); } catch {}
}

/**
 * 实体 + 关系入库（手册 §2.3 第 2 步：摘要里抽实体关系写进图谱）。
 * 没有这一步，检索公式里的「图谱 0.11」永远是 0 分。
 *
 * @param {{entities?: string[], relations?: Array<{src:string,dst:string,kind?:string}>}} graph
 */
export function linkGraph(db, memoryId, graph = {}, at = now()) {
  const entities = Array.isArray(graph.entities) ? graph.entities.filter(Boolean).slice(0, 12) : [];
  const relations = Array.isArray(graph.relations) ? graph.relations.slice(0, 12) : [];
  const names = new Set(entities);
  for (const r of relations) { if (r?.src) names.add(String(r.src)); if (r?.dst) names.add(String(r.dst)); }

  const ids = new Map();
  for (const name of names) {
    const raw = String(name).trim().slice(0, 40);
    if (!raw) continue;
    const kind = raw.startsWith('@') ? 'person' : 'topic';
    const id = `${kind}:${raw}`;
    ids.set(raw, id);
    try {
      db.prepare(`INSERT INTO entities(id,kind,name,mention_count,first_seen,last_seen,profile)
        VALUES (?,?,?,1,?,?,'{}')
        ON CONFLICT(id) DO UPDATE SET mention_count = mention_count + 1, last_seen = excluded.last_seen`)
        .run(id, kind, raw, at, at);
      db.prepare('INSERT OR REPLACE INTO memory_entities(memory_id, entity_id, role, weight) VALUES (?,?,?,?)')
        .run(memoryId, id, 'mention', 0.5);
    } catch {}
  }

  for (const r of relations) {
    const src = ids.get(String(r?.src ?? '').trim());
    const dst = ids.get(String(r?.dst ?? '').trim());
    if (!src || !dst || src === dst) continue;
    try {
      db.prepare(`INSERT INTO relations(src,dst,kind,weight,updated_at,memory_id)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(src,dst,kind) DO UPDATE SET weight = MIN(1, weight + 0.1), updated_at = excluded.updated_at`)
        .run(src, dst, String(r.kind ?? 'related').slice(0, 20), 0.5, at, memoryId);
    } catch {}
  }
  return { entities: ids.size, relations: relations.length };
}

/**
 * 写入一条记忆。返回 { action: 'created'|'merged'|'conflict'|'rejected', id, ... }。
 */
export function remember(db, cfg, input, { embedFn = null, at = now(), vec = null } = {}) {
  const kind = String(input.kind ?? 'episode');
  if (!KINDS.has(kind)) return { action: 'rejected', reason: `未知 kind: ${kind}` };
  const text = String(input.text ?? '').trim();
  if (!text) return { action: 'rejected', reason: 'text 为空' };
  if (text.length > 2000) return { action: 'rejected', reason: 'text 过长（>2000）' };

  const importance = clamp01(input.importance ?? 0.5);
  const valence = Math.max(-1, Math.min(1, Number(input.valence ?? 0)));
  const mergeThreshold = Number(cfg.memory?.maintain?.mergeCosine ?? 0.92);

  // 1) 查同类候选，判重
  const pool = db.prepare(`SELECT * FROM memories WHERE kind = ? AND status IN ('active','conflict') ORDER BY created_at DESC LIMIT 400`).all(kind);
  for (const row of pool) {
    const sim = similarity(row, text, embedFn);
    if (sim >= mergeThreshold) {
      const merged = mergeInto(db, row, { text, importance, valence, meta: input.meta, at });
      return { action: 'merged', id: row.id, sim: Number(sim.toFixed(3)), ...merged };
    }
  }

  // 2) 冲突检测：同 kind、同实体词、极性相反（有/没有、喜欢/讨厌…）
  let conflictWith = null;
  if (cfg.memory?.maintain?.conflictDetect !== false) {
    for (const row of pool.slice(0, 120)) {
      const sim = similarity(row, text, embedFn);
      if (sim >= 0.55 && polarityFlip(row.text, text)) { conflictWith = row.id; break; }
    }
  }

  // 3) 插入
  const id = uid();
  const st = conflictWith ? 'conflict' : 'active';
  const blob = vec ? Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength) : null;
  db.prepare(`INSERT INTO memories
    (id, kind, text, importance, valence, arousal, confidence, created_at, updated_at, last_access, access_count, status, source, visibility, meta, embedding, embed_model, merged_into, conflict_with)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, kind, text, importance, valence, Math.max(-1, Math.min(1, Number(input.arousal ?? 0))), clamp01(input.confidence ?? 0.7),
    at, at, at, 0, st, String(input.source ?? 'chat'), String(input.visibility ?? 'private'),
    JSON.stringify(input.meta ?? {}), blob, blob ? (cfg.memory?.embed?.model ?? 'bge-m3') : null, null, conflictWith
  );
  const row = db.prepare('SELECT rid FROM memories WHERE id = ?').get(id);
  if (row) ftsInsert(db, { rid: row.rid, text });

  // 实体/关系入库（手册 §2.3 第 2 步）——没有它，图谱那 0.11 权重永远是 0 分
  try { linkGraph(db, id, { entities: input.meta?.entities, relations: input.meta?.relations }, at); } catch {}

  if (conflictWith) {
    db.prepare("UPDATE memories SET status='conflict', conflict_with=?, updated_at=? WHERE id=?").run(id, at, conflictWith);
    try {
      db.prepare('INSERT OR REPLACE INTO conflicts(a_id,b_id,reason,resolved,created_at) VALUES (?,?,?,0,?)')
        .run(id, conflictWith, '反义词 + 高相似', at);
    } catch {}
  }

  enforceCaps(db, cfg);
  return { action: conflictWith ? 'conflict' : 'created', id, conflict_with: conflictWith };
}

function polarityFlip(a, b) {
  const pairs = [['喜欢', '讨厌'], ['喜欢', '不喜欢'], ['是', '不是'], ['能', '不能'], ['会', '不会'], ['有', '没有'], ['开心', '难过'], ['同意', '不同意']];
  const s = String(a ?? ''), t = String(b ?? '');
  return pairs.some(([x, y]) => (s.includes(x) && t.includes(y)) || (s.includes(y) && t.includes(x)));
}

function mergeInto(db, row, { text, importance, valence, meta, at }) {
  const keepLonger = String(text).length > String(row.text).length ? text : row.text;
  // 反复提及 = 同一件事被再说一遍：这是最硬的"重要性"信号。
  // 旧实现只取 max(importance)，说一遍和说一百遍完全一样 —— 等于没有优先级。
  const mentions = Number(row.mention_count ?? 1) + 1;
  // 边际递减：第 2 次 +0.06，第 10 次只 +0.02，避免老话题无限膨胀到 1.0
  const bump = 0.06 / (1 + Math.max(0, mentions - 2) * 0.15);
  const imp = Math.min(1, Math.max(Number(row.importance ?? 0.5), importance) + bump);
  const nextMeta = { ...parseMeta(row.meta), ...(meta ?? {}), mergedCount: (parseMeta(row.meta).mergedCount ?? 1) + 1 };
  db.prepare('UPDATE memories SET text=?, importance=?, valence=?, updated_at=?, last_access=?, meta=?, mention_count=?, last_mention_at=? WHERE id=?')
    .run(keepLonger, imp, valence, at, at, JSON.stringify(nextMeta), mentions, at, row.id);
  const fresh = db.prepare('SELECT rid FROM memories WHERE id=?').get(row.id);
  if (fresh) ftsInsert(db, { rid: fresh.rid, text: keepLonger });
  return { text: keepLonger };
}

export function enforceCaps(db, cfg) {
  const caps = cfg.memory?.caps ?? {};
  for (const [kind, cap] of Object.entries(caps)) {
    const n = db.prepare('SELECT COUNT(*) AS c FROM memories WHERE kind=? AND status IN (\'active\',\'conflict\')').get(kind)?.c ?? 0;
    if (n <= cap) continue;
    const excess = n - cap;
    // 少被提及的优先淘汰（同频次再比重要性、最后比时间）
    const victims = db.prepare(`SELECT id, rid FROM memories WHERE kind=? AND status IN ('active','conflict')
      ORDER BY COALESCE(mention_count,1) ASC, importance ASC, COALESCE(last_access, created_at) ASC LIMIT ?`).all(kind, excess);
    for (const v of victims) {
      db.prepare("UPDATE memories SET status='archived', updated_at=? WHERE id=?").run(now(), v.id);
      ftsDelete(db, v.rid);
    }
  }
}

/**
 * 重要性时间衰减（手册 §2.5）。
 * 基准：每天 ×0.99；频率感知：最近 30 天访问过且访问 ≥10 次的，衰减速度减半。
 * 用 meta 表记上次衰减日期，重复调用不会重复扣分。
 */
export function decayImportance(db, at = now()) {
  const day = new Date(at).toISOString().slice(0, 10);
  const last = db.prepare("SELECT v FROM meta WHERE k='last_decay_day'").get()?.v;
  if (last === day) return { skipped: true, day };
  const days = last ? Math.max(1, Math.min(30, Math.round((at - Date.parse(`${last}T00:00:00`)) / DAY))) : 1;

  const rows = db.prepare("SELECT id, importance, access_count, last_access, mention_count FROM memories WHERE status IN ('active','conflict')").all();
  const upd = db.prepare('UPDATE memories SET importance = ? WHERE id = ?');
  let touched = 0;
  for (const r of rows) {
    const hot = Number(r.access_count ?? 0) >= 10 && Number(r.last_access ?? 0) > at - 30 * DAY;
    // 提及频次越高，衰减越慢：
    //   提过 1 次 → 0.99/天（半衰期 69 天）
    //   提过 3 次 → 约 0.996/天（半衰期 172 天）
    //   提过 6 次以上 → 0.998/天（半衰期 344 天，封顶）
    const mentions = Math.max(1, Number(r.mention_count ?? 1));
    const freqK = Math.max(0.2, 1 / (1 + 0.5 * Math.min(mentions - 1, 5)));
    const factor = Math.pow(0.99, days * (hot ? 0.5 : 1) * freqK);
    const next = Math.max(0.01, Number(r.importance ?? 0.5) * factor);
    if (next !== r.importance) { upd.run(next, r.id); touched += 1; }
  }
  db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES ('last_decay_day', ?)").run(day);
  return { day, days, touched, total: rows.length };
}

/** 维护：衰减 → 归档（importance<0.3 且 30 天没被想起）→ 180 天后冷归档删除。 */
export function maintain(db, cfg, at = now()) {
  const decay = decayImportance(db, at);
  const coldDays = Number(cfg.memory?.maintain?.archiveAfterDays ?? 30) * DAY;
  const purgeDays = Number(cfg.memory?.maintain?.purgeArchivedAfterDays ?? 180) * DAY;
  let archived = 0, purged = 0;

  const weak = db.prepare(`SELECT id, rid FROM memories
    WHERE status IN ('active','conflict') AND importance < 0.3
      AND COALESCE(last_access, created_at) < ? AND created_at < ?`).all(at - coldDays, at - coldDays);
  for (const r of weak) {
    db.prepare("UPDATE memories SET status='archived', archived_at=?, updated_at=? WHERE id=?").run(at, at, r.id);
    ftsDelete(db, r.rid);
    archived += 1;
  }

  const dying = db.prepare('SELECT * FROM memories WHERE status=\'archived\' AND COALESCE(archived_at, updated_at) < ?').all(at - purgeDays);
  if (dying.length) {
    const file = path.join(cfg.system.dataRoot, 'memory', 'archive', `${new Date(at).toISOString().slice(0, 10)}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, dying.map((r) => JSON.stringify({ ...r, embedding: undefined })).join('\n') + '\n', 'utf8');
    for (const r of dying) {
      ftsDelete(db, r.rid);
      db.prepare('DELETE FROM memories WHERE id=?').run(r.id);
      purged += 1;
    }
  }
  return { decay, archived, purged, caps: enforceCaps(db, cfg) ?? null };
}

export const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
