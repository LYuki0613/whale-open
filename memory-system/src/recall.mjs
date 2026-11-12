// 注入装配：把各层正文包成带唯一 marker 的块，按固定顺序拼接，受总字数预算约束。
//
// 幂等：追加前先用 marker 正则把所有旧块删掉（重复注入不会堆积）。
import { search } from './scoring.mjs';
import { loadState as loadEmotion, injectText as emotionText, describe } from './emotion.mjs';
import { computeStyle, styleInjectText } from './expression.mjs';
import { embedText } from './embed.mjs';
import { jaccard } from './memory.mjs';
import { now } from './db.mjs';

export const MARKER_RE = /⟦MEM:([a-z]+):v1⟧[\s\S]*?⟦\/MEM:\1:v1⟧/g;
const ORDER = ['feedback', 'recall', 'emotion', 'style', 'life'];
const BUDGET = { feedback: 60, recall: 500, emotion: 120, style: 130, life: 100 };

export function stripBlocks(text) {
  return String(text ?? '').replace(MARKER_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function renderBlock(name, body) {
  const t = String(body ?? '').trim();
  if (!t) return '';
  const budget = BUDGET[name] ?? 200;
  const clipped = [...t].length > budget ? [...t].slice(0, budget).join('') + '…' : t;
  return `⟦MEM:${name}:v1⟧\n${clipped}\n⟦/MEM:${name}:v1⟧`;
}

/**
 * 生成注入段落。所有层都关 / 没有内容时返回空串。
 * @returns {{ text: string, ids: string[], parts: object }}
 */
export async function buildInjection(db, cfg, { key, query, at = now() } = {}) {
  if (cfg.system?.enabled === false) return { text: '', ids: [], parts: {} };
  const parts = {};
  const ids = [];

  // 1) recall（记忆层）
  if (cfg.memory?.enabled !== false && query) {
    try {
      let qvec = null;
      if (cfg.memory?.embed?.mode === 'onnx') {
        try { qvec = await embedText(cfg, query); } catch {}
      }
      // 手册 §2.4：私聊 2 条、群聊 1 条，门槛 0.45；结果相似度 ≥0.82 只留一条。
      const isPrivate = String(key ?? '').startsWith('private:');
      const minScore = Number(cfg.memory?.recall?.minScore ?? 0.45);
      const maxCount = isPrivate
        ? Number(cfg.memory?.recall?.privateCount ?? 2)
        : Number(cfg.memory?.recall?.groupCount ?? 1);
      const dedupSim = Number(cfg.memory?.recall?.dedupSimilarity ?? 0.82);

      const hits = search(db, cfg, query, { limit: 8, qvec });
      const picked = [];
      for (const h of hits) {
        if (h.score < minScore) continue;
        if (picked.some((p) => jaccard(p.text, h.text) >= dedupSim)) continue;
        picked.push(h);
        if (picked.length >= maxCount) break;
      }
      if (picked.length) {
        const lines = picked.map((h) => {
          const flag = h.status === 'conflict' ? '（和另一条有出入）' : '';
          return `· ${String(h.text).slice(0, 80)}（重要 ${Number(h.importance).toFixed(1)}）${flag}`;
        });
        parts.recall = `【我记得的事】\n${lines.join('\n')}`;
        ids.push(...picked.map((h) => h.id));
      }
    } catch {}
  }

  // 2) emotion
  if (cfg.emotion?.enabled !== false && cfg.emotion?.inject !== false) {
    try {
      const st = loadEmotion(db, cfg);
      const body = emotionText(st);
      if (body) parts.emotion = body;
    } catch {}
  }

  // 3) style（每 refreshHours 算一次，缓存进 style_stats）
  if (cfg.expression?.enabled !== false && cfg.expression?.style?.enabled !== false) {
    try {
      const refreshMs = Number(cfg.expression.style.refreshHours ?? 6) * 3600000;
      const last = db.prepare('SELECT * FROM style_stats ORDER BY at DESC LIMIT 1').get();
      let stats = last;
      if (!last || at - last.at > refreshMs) {
        const s = computeStyle(db, Number(cfg.expression.style.sampleSize ?? 300));
        if (s) {
          db.prepare('INSERT OR REPLACE INTO style_stats(at,n,median_len,no_punct_rate,particles,emoji_rate) VALUES (?,?,?,?,?,?)')
            .run(at, s.n, s.medianLen, s.noPunctRate, JSON.stringify(s.particles), s.emojiRate);
          stats = { at, n: s.n, median_len: s.medianLen, no_punct_rate: s.noPunctRate, particles: JSON.stringify(s.particles), emoji_rate: s.emojiRate };
        }
      }
      if (stats) {
        const parsed = { n: stats.n, medianLen: stats.median_len, noPunctRate: stats.no_punct_rate, particles: JSON.parse(stats.particles || '[]'), emojiRate: stats.emoji_rate };
        const body = styleInjectText(parsed);
        if (body) parts.style = body;
      }
    } catch {}
  }

  // 4) life（生活层当前活动）
  if (cfg.life?.enabled !== false) {
    try {
      const row = db.prepare('SELECT activity, interest, note FROM life_log ORDER BY at DESC LIMIT 1').get();
      if (row && at - (db.prepare('SELECT at FROM life_log ORDER BY at DESC LIMIT 1').get()?.at ?? 0) < 3600000) {
        parts.life = `【你刚才在干嘛】${row.activity}${row.interest ? `（${row.interest}）` : ''}${row.note ? `，${row.note}` : ''}。`;
      }
    } catch {}
  }

  // 5) feedback（上一轮被纠正过就提醒一句）
  if (cfg.feedback?.enabled !== false) {
    try {
      const c = db.prepare("SELECT * FROM corrections WHERE at > ? ORDER BY at DESC LIMIT 1").get(at - 3600000);
      if (c) parts.feedback = '【提醒】对方刚纠正过你一次，那条记忆已被降权，别再当事实说。';
    } catch {}
  }

  const blocks = ORDER.map((n) => (parts[n] ? renderBlock(n, parts[n]) : '')).filter(Boolean);
  if (!blocks.length) return { text: '', ids, parts };

  const maxChars = Number(cfg.system?.injectMaxChars ?? 1200);
  let out = `【记忆注入（临时，可丢）】\n${blocks.join('\n')}`;
  if ([...out].length > maxChars) {
    // 超预算时从后往前砍（quality 最低的块先没）
    for (let i = blocks.length - 1; i >= 0 && [...out].length > maxChars; i -= 1) {
      const trimmed = blocks.slice(0, i).join('\n');
      out = trimmed ? `【记忆注入（临时，可丢）】\n${trimmed}` : '';
    }
  }
  return { text: out, ids, parts };
}

/** 把 query 从最近消息拼出来（桥接调用时用）。 */
export function buildQuery(messages, limit = 6) {
  const arr = (messages ?? []).slice(-limit).map((m) => String(m.text ?? m.plain ?? '').trim()).filter(Boolean);
  return arr.join('\n').slice(0, 600);
}

export { describe };
