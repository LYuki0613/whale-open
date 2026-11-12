// 检索打分：0.18·sem + 0.46·kw + 0.11·graph + 0.14·importance + 0.11·freshness
//
// 每一项先归一化到 [0,1] 再加权——直接混用 bm25 与余弦会被量纲压死。
import { toFtsQuery } from './bigram.mjs';
import { now, parseMeta } from './db.mjs';

const DAY = 86400000;

function halfLife(cfg, kind) {
  return (cfg.memory?.halfLifeDays?.[kind] ?? 60) * DAY;
}

function freshness(cfg, row, at) {
  const ref = Number(row.last_access ?? row.created_at ?? at);
  const delta = Math.max(0, at - ref);
  return Math.exp(-delta / halfLife(cfg, row.kind));
}

/** 关键词分数：按本次查询内最大 bm25 归一（bm25 越小越相关，取负号）。 */
function normalizeKeyword(hits) {
  if (!hits.length) return new Map();
  const raw = hits.map((h) => ({ rid: h.rid, s: -Number(h.s ?? 0) }));
  // 只命中 1 条时 min==max，归一化会把它算成 0（= 关键词完全没贡献）。
  // 单条命中恰恰是最精确的情况，必须给满分。
  if (raw.length === 1) return new Map([[raw[0].rid, 1]]);
  const max = Math.max(...raw.map((x) => x.s), 1e-9);
  const min = Math.min(...raw.map((x) => x.s));
  const span = max - min || 1;
  return new Map(raw.map((x) => [x.rid, (x.s - min) / span]));
}

/** 图谱分数：查询里提到的实体 → 关联记忆的边权和。 */
function graphScore(db, query, at) {
  const q = String(query ?? '');
  if (!q) return new Map();
  let ents = [];
  try {
    ents = db.prepare('SELECT id, name, COALESCE(mention_count,0) AS hits FROM entities').all().filter((e) => e.name && q.includes(e.name));
  } catch { return new Map(); }
  if (!ents.length) return new Map();
  const scores = new Map();
  const stmt = db.prepare('SELECT memory_id FROM memory_entities WHERE entity_id = ?');
  for (const e of ents) {
    // 实体热度：被提得越多的主题，关联记忆的图谱分越高（0.35 起步，随 log 增长到 1）
    const heat = Math.min(1, 0.35 + 0.15 * Math.log10(1 + Number(e.hits ?? 0)));
    let rows = [];
    try { rows = stmt.all(e.id); } catch { continue; }
    for (const r of rows) scores.set(r.memory_id, Math.min(1, (scores.get(r.memory_id) ?? 0) + 0.5 * heat));
  }
  return scores;
}

/**
 * 混合检索。返回按 score 降序的条目（已更新 last_access / access_count）。
 * embed.mode=off 时丢掉 sem 项，并把其余权重按比例放大，保证总分仍在 0..1。
 *
 * @param {Float32Array|null} qvec 查询向量（调用方先用 embed.mjs 算好；null = 不算语义）
 */
export function search(db, cfg, query, { limit = 8, kinds = null, at = now(), qvec = null } = {}) {
  const weights = { ...(cfg.memory?.weights ?? {}) };
  const ftsQ = toFtsQuery(query);
  let kw = new Map();
  if (ftsQ) {
    try {
      const hits = db.prepare(
        `SELECT rowid AS rid, bm25(mem_fts) AS s FROM mem_fts WHERE mem_fts MATCH ? ORDER BY s LIMIT 80`
      ).all(ftsQ);
      kw = normalizeKeyword(hits);
    } catch { kw = new Map(); }
  }

  const sem = new Map(); // 语义分：仅在给了查询向量且有存量向量时计算
  const graph = graphScore(db, query, at);

  // kw 的 key 是 rid（FTS rowid），sem/graph 的 key 是 memories.id —— 两种身份不能混查
  const rids = [...kw.keys()];
  const ids = [...new Set([...sem.keys(), ...graph.keys()])];
  const where = [];
  const args = [];
  if (rids.length) { where.push(`rid IN (${rids.map(() => '?').join(',')})`); args.push(...rids); }
  if (ids.length) { where.push(`id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
  let rows = [];
  if (where.length) {
    rows = db.prepare(`SELECT * FROM memories WHERE (${where.join(' OR ')}) AND status IN ('active','conflict')`).all(...args);
  }
  // 没有关键词命中时退化为按重要性/新鲜度取（保证永远有东西可选，但不硬凑太多）
  if (!rows.length) {
    rows = db.prepare(`SELECT * FROM memories WHERE status IN ('active','conflict') ORDER BY importance DESC LIMIT 40`).all();
  }
  if (kinds?.length) rows = rows.filter((r) => kinds.includes(r.kind));

  // 语义分：只对已加载的候选算（不是全库），1024 维点积在候选几十条时只要几毫秒
  if (qvec && qvec.length) {
    for (const r of rows) {
      if (!r.embedding) continue;
      const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
      let dot = 0, na = 0, nb = 0;
      const n = Math.min(v.length, qvec.length);
      for (let i = 0; i < n; i += 1) { dot += v[i] * qvec[i]; na += v[i] * v[i]; nb += qvec[i] * qvec[i]; }
      const d = Math.sqrt(na) * Math.sqrt(nb);
      sem.set(r.id, Math.max(0, Math.min(1, d ? dot / d : 0)));
    }
  }

  const w = { sem: weights.sem ?? 0.18, kw: weights.kw ?? 0.46, graph: weights.graph ?? 0.11, importance: weights.importance ?? 0.14, freshness: weights.freshness ?? 0.11 };
  // 没有查询向量（embed 关掉 / 模型没加载）时，sem 项归零，其余权重按比例放大。
  if (!qvec || !qvec.length) w.sem = 0;
  const sumW = Object.values(w).reduce((a, b) => a + b, 0) || 1;

  const scored = rows.map((r) => {
    const s = {
      sem: Number(sem.get(r.id) ?? 0),
      kw: Number(kw.get(r.rid) ?? 0),
      graph: Number(graph.get(r.id) ?? 0),
      importance: Math.max(0, Math.min(1, Number(r.importance ?? 0.5))),
      freshness: freshness(cfg, r, at),
    };
    let score = (s.sem * w.sem + s.kw * w.kw + s.graph * w.graph + s.importance * w.importance + s.freshness * w.freshness) / sumW;
    if (r.status === 'conflict') score *= 0.7; // 冲突条目降权，但仍可被召回（带标注）
    return { row: r, score, parts: s };
  }).sort((a, b) => b.score - a.score).slice(0, limit);

  const touch = db.prepare('UPDATE memories SET last_access = ?, access_count = access_count + 1, importance = MIN(1, importance + 0.02) WHERE id = ?');
  for (const x of scored) { try { touch.run(at, x.row.id); } catch {} }

  return scored.map((x) => ({ ...x.row, meta: parseMeta(x.row.meta), score: x.score, parts: x.parts }));
}
