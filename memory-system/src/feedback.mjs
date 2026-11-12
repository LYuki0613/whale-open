// 反馈层：纠正检测与降权、每日体检、评估（recall@1 / recall@3 / MRR）。
import path from 'node:path';
import fs from 'node:fs';
import { now, uid } from './db.mjs';
import { search } from './scoring.mjs';
import { remember } from './memory.mjs';
import { embedText } from './embed.mjs';

const DAY = 86400000;

/** 用户是否在纠正我们。返回命中的模式或 null。 */
export function detectCorrection(cfg, text) {
  if (cfg.feedback?.enabled === false || cfg.feedback?.corrections?.enabled === false) return null;
  const t = String(text ?? '');
  for (const p of cfg.feedback?.corrections?.patterns ?? []) if (t.includes(p)) return p;
  return null;
}

/**
 * 用户说"不是/记错了"：把上次注入的记忆全部降权，并记一条 lesson。
 */
export function applyCorrection(db, cfg, { key, quote, at = now() }) {
  const penalty = Number(cfg.feedback?.corrections?.penalty ?? 0.15);
  let ids = [];
  try {
    const row = db.prepare('SELECT ids, at FROM last_injected WHERE key = ?').get(key);
    if (row && at - row.at < 30 * 60000) ids = JSON.parse(row.ids || '[]');
  } catch {}

  let touched = 0;
  for (const id of ids) {
    try {
      db.prepare('UPDATE memories SET importance = MAX(0, importance * (1 - ?)), updated_at = ? WHERE id = ?').run(penalty, at, id);
      touched += 1;
    } catch {}
  }
  try {
    db.prepare('INSERT OR REPLACE INTO corrections(id,at,target_memory,quote,delta,note) VALUES (?,?,?,?,?,?)')
      .run(uid(), at, ids.join(','), String(quote ?? '').slice(0, 200), -penalty, `命中「${String(quote ?? '').slice(0, 20)}」`);
  } catch {}

  // 写一条 lesson，避免下次再犯。
  // 必须走 remember() 而不是裸 INSERT：裸 INSERT 不会写 mem_fts，
  // 那条记忆会永远搜不到（实测漏了一条 lesson，关键词检索完全查不到它）。
  try {
    remember(db, cfg, {
      kind: 'lesson',
      text: `用户纠正过我：${String(quote ?? '').slice(0, 80)}`,
      importance: 0.8,
      valence: -0.2,
      confidence: 0.9,
      source: 'feedback',
      meta: { corrected: ids.length },
    }, { at });
  } catch {}

  return { ids, touched, penalty };
}

/** 每日体检：重复 / 孤儿 / 僵尸 / 冲突。 */
export function healthCheck(db, cfg, at = now()) {
  const report = { at, duplicate: [], orphan: [], zombie: [], conflict: [], counts: {} };
  try {
    report.counts = Object.fromEntries(
      db.prepare("SELECT kind, COUNT(*) AS c FROM memories WHERE status IN ('active','conflict') GROUP BY kind").all()
        .map((r) => [r.kind, r.c])
    );
  } catch {}

  // 僵尸：从没被访问过且超过 30 天
  try {
    report.zombie = db.prepare("SELECT id, kind, text FROM memories WHERE status='active' AND access_count = 0 AND created_at < ? LIMIT 50").all(at - 30 * DAY);
  } catch {}
  // 孤儿：没有任何实体关联且 90 天未访问
  try {
    report.orphan = db.prepare(`SELECT m.id, m.kind, m.text FROM memories m
      LEFT JOIN memory_entities e ON e.memory_id = m.id
      WHERE e.memory_id IS NULL AND m.status='active' AND COALESCE(m.last_access, m.created_at) < ? LIMIT 50`).all(at - 90 * DAY);
  } catch {}
  // 冲突：仍在 conflict 状态
  try {
    report.conflict = db.prepare("SELECT id, kind, text, conflict_with FROM memories WHERE status='conflict' LIMIT 50").all();
  } catch {}
  // 重复：同 kind 里逐对比较（只查最近 300 条，避免 O(n²) 爆炸）
  try {
    const rows = db.prepare("SELECT id, kind, text FROM memories WHERE status='active' ORDER BY created_at DESC LIMIT 300").all();
    const jac = (a, b) => {
      const A = new Set([...a].filter(Boolean)), B = new Set([...b].filter(Boolean));
      let i = 0; for (const x of A) if (B.has(x)) i += 1;
      return A.size && B.size ? i / (A.size + B.size - i) : 0;
    };
    const bigrams = (s) => { const c = [...s]; const o = []; for (let i = 0; i < c.length - 1; i += 1) o.push(c[i] + c[i + 1]); return o; };
    const seen = new Set();
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        if (rows[i].kind !== rows[j].kind) continue;
        if (jac(bigrams(rows[i].text), bigrams(rows[j].text)) >= 0.92) {
          const k = `${rows[i].id}|${rows[j].id}`;
          if (!seen.has(k)) { seen.add(k); report.duplicate.push({ a: rows[i].id, b: rows[j].id }); }
          if (report.duplicate.length > 30) break;
        }
      }
    }
  } catch {}

  // 落盘报告
  try {
    const dir = path.join(cfg.system.dataRoot, 'feedback', 'reports');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date(at).toISOString().slice(0, 10)}.md`);
    const line = (title, arr) => `## ${title}（${arr.length}）\n${arr.slice(0, 10).map((x) => `- ${x.text ?? `${x.a} ↔ ${x.b}`}`).join('\n') || '- 无'}\n`;
    const md = `# 记忆体检 ${new Date(at).toLocaleString('zh-CN')}\n\n` +
      `分类计数：${JSON.stringify(report.counts)}\n\n` +
      line('重复', report.duplicate) + line('孤儿', report.orphan) + line('僵尸', report.zombie) + line('冲突', report.conflict);
    fs.writeFileSync(file, md, 'utf8');
    report.file = file;
  } catch {}

  return report;
}

/** 评估：对评估集跑 recall@1 / recall@3 / MRR。 */
export async function evaluate(db, cfg, at = now()) {
  const rows = db.prepare('SELECT * FROM eval_set').all();
  if (!rows.length) return { n: 0, recall1: 0, recall3: 0, mrr: 0, note: '评估集为空，先跑 cli eval seed' };
  let r1 = 0, r3 = 0, mrr = 0;
  const details = [];
  for (const q of rows) {
    let expected = [];
    try { expected = JSON.parse(q.expected); } catch {}
    if (!Array.isArray(expected) || !expected.length) continue;
    let qvec = null;
    if (cfg.memory?.embed?.mode === 'onnx') { try { qvec = await embedText(cfg, q.query); } catch {} }
    const hits = search(db, cfg, q.query, { limit: 20, at, qvec });
    const ids = hits.map((h) => h.id);
    const idx = ids.findIndex((id) => expected.includes(id));
    if (idx === 0) r1 += 1;
    if (idx >= 0 && idx < 3) r3 += 1;
    if (idx >= 0) mrr += 1 / (idx + 1);
    details.push({ query: q.query, rank: idx + 1 || null, top: hits.slice(0, 3).map((h) => String(h.text).slice(0, 40)) });
  }
  const n = details.length || 1;
  const out = { n: details.length, recall1: r1 / n, recall3: r3 / n, mrr: mrr / n, details };
  try {
    db.prepare('INSERT OR REPLACE INTO eval_runs(at,n,recall1,recall3,mrr,cfg) VALUES (?,?,?,?,?,?)')
      .run(at, out.n, out.recall1, out.recall3, out.mrr, JSON.stringify(cfg.memory?.weights ?? {}));
  } catch {}
  return out;
}
