// 情绪层：PAD 三维 + 10 标签，半衰期衰减，单条消息变动有上限。
import { now } from './db.mjs';

export const LABELS = ['开心', '生气', '难过', '害怕', '委屈', '害羞', '得意', '感动', '焦虑', '无聊'];

// 关键词 → 情绪增量。数值是"满强度"下的目标变化，实际会再按 maxDelta 截断。
const RULES = [
  { re: /谢谢|感谢|辛苦了|太好了|可爱|厉害|牛|赞|棒/, p: 0.18, a: 0.10, d: 0.05, labels: { 开心: 0.25, 得意: 0.10 } },
  { re: /喜欢|想你了|抱抱|摸摸|乖/, p: 0.20, a: 0.08, d: 0.10, labels: { 开心: 0.20, 害羞: 0.18 } },
  { re: /哈哈|笑死|草|乐|绷不住/, p: 0.15, a: 0.20, d: 0.05, labels: { 开心: 0.30 } },
  { re: /滚|傻逼|闭嘴|烦死|讨厌你|垃圾|废物/, p: -0.30, a: 0.18, d: -0.05, labels: { 生气: 0.40, 委屈: 0.15 } },
  { re: /难过|伤心|哭了|失恋|难受|心累/, p: -0.25, a: -0.12, d: -0.10, labels: { 难过: 0.35, 委屈: 0.12 } },
  { re: /害怕|恐怖|吓死|不敢|怕/, p: -0.18, a: 0.22, d: -0.20, labels: { 害怕: 0.35, 焦虑: 0.12 } },
  { re: /紧张|焦虑|怎么办|来不及|完了/, p: -0.10, a: 0.25, d: -0.18, labels: { 焦虑: 0.35 } },
  { re: /无聊|没意思|好闲|没事干/, p: -0.08, a: -0.15, d: 0.0, labels: { 无聊: 0.35 } },
  { re: /害羞|不好意思|脸红|人家/, p: 0.10, a: 0.12, d: -0.08, labels: { 害羞: 0.35 } },
  { re: /厉害吧|我做到了|夸我|看我/, p: 0.15, a: 0.10, d: 0.20, labels: { 得意: 0.35 } },
  { re: /感动|破防|泪目/, p: 0.12, a: 0.05, d: -0.05, labels: { 感动: 0.35 } },
  // 例：喊她的外号会让她炸毛。换成你自己的称呼，或者直接删掉这条。
  // { re: /你的外号/, p: -0.15, a: 0.20, d: 0.10, labels: { 生气: 0.30, 委屈: 0.10 } },
];

// 被安慰：只回 0.08，保留一点"嘴硬"。
const COMFORT_RE = /对不起|抱歉|别生气|不要生气|我错了|原谅我|sorry/i;

export function labelNames() { return LABELS; }

export function loadState(db, cfg) {
  const row = db.prepare('SELECT * FROM emotion_state WHERE id = 1').get();
  if (!row) {
    const at = now();
    db.prepare('INSERT INTO emotion_state(id,p,a,d,labels,updated_at) VALUES (1,0,0,0,?,?)').run('{}', at);
    return { p: 0, a: 0, d: 0, labels: {}, updatedAt: at, at };
  }
  let labels = {};
  try { labels = JSON.parse(row.labels || '{}'); } catch {}
  return { p: row.p, a: row.a, d: row.d, labels, updatedAt: row.updated_at };
}

function decay(cfg, state, at) {
  const moodHalf = Number(cfg.emotion?.moodHalfLifeHours ?? 6) * 3600000;
  const labelHalf = Number(cfg.emotion?.labelHalfLifeMin ?? 45) * 60000;
  const dt = Math.max(0, at - state.updatedAt);
  if (dt <= 0) return state;
  const moodK = Math.pow(0.5, dt / moodHalf);
  const labelK = Math.pow(0.5, dt / labelHalf);
  const labels = {};
  for (const [k, v] of Object.entries(state.labels)) {
    const nv = Number(v) * labelK;
    if (nv > 0.02) labels[k] = Number(nv.toFixed(3));
  }
  return { p: state.p * moodK, a: state.a * moodK, d: state.d * moodK, labels, updatedAt: at };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 一条消息对情绪的影响。返回新状态（不落盘）。 */
export function applyMessage(db, cfg, state0, text, at = now()) {
  const maxDelta = Number(cfg.emotion?.maxDeltaPerMessage ?? 0.12);
  const cap = Number(cfg.emotion?.labelCap ?? 0.6);
  const s = decay(cfg, state0, at);
  const msg = String(text ?? '');
  const comfort = COMFORT_RE.test(msg);

  let dp = 0, da = 0, dd = 0;
  const labelDelta = {};
  for (const r of RULES) {
    if (!r.re.test(msg)) continue;
    dp += r.p; da += r.a; dd += r.d;
    for (const [k, w] of Object.entries(r.labels)) labelDelta[k] = (labelDelta[k] ?? 0) + w;
  }

  if (comfort) {
    // 被安慰：只把负向维度往回拉 0.08，正向不动，标签不清空（嘴硬）
    const pull = Number(cfg.emotion?.comfortDelta ?? 0.08);
    if (s.p < 0) dp = Math.max(dp, pull);
    if (s.d < 0) dd = Math.max(dd, pull * 0.5);
    da = Math.min(da, pull * 0.3);
  }

  dp = clamp(dp, -maxDelta, maxDelta);
  da = clamp(da, -maxDelta, maxDelta);
  dd = clamp(dd, -maxDelta, maxDelta);

  const labels = { ...s.labels };
  for (const [k, w] of Object.entries(labelDelta)) {
    const step = Math.min(Math.abs(w), maxDelta);
    labels[k] = clamp((labels[k] ?? 0) + Math.sign(w) * step, 0, cap);
  }
  for (const k of Object.keys(labels)) if (labels[k] < 0.02) delete labels[k];

  return {
    p: clamp(s.p + dp, -1, 1),
    a: clamp(s.a + da, -1, 1),
    d: clamp(s.d + dd, -1, 1),
    labels,
    updatedAt: at,
    comfort,
  };
}

export function saveState(db, state, trigger = '') {
  db.prepare('UPDATE emotion_state SET p=?,a=?,d=?,labels=?,updated_at=? WHERE id=1')
    .run(state.p, state.a, state.d, JSON.stringify(state.labels), state.updatedAt);
  try {
    db.prepare('INSERT OR REPLACE INTO emotion_log(at,p,a,d,labels,trigger) VALUES (?,?,?,?,?,?)')
      .run(state.updatedAt, state.p, state.a, state.d, JSON.stringify(state.labels), trigger.slice(0, 40));
  } catch {}
}

/** 把 PAD 翻译成一句人话（注入用）。 */
export function describe(state) {
  const { p, a, d } = state;
  const mood = p > 0.3 ? '挺高兴' : p < -0.3 ? '不太高兴' : '还算平静';
  const energy = a > 0.35 ? '有点激动' : a < -0.2 ? '提不起劲' : '';
  const guts = d > 0.3 ? '有底气' : d < -0.3 ? '有点没底气' : '';
  const extras = [energy, guts].filter(Boolean).join('、');
  return extras ? `${mood}，${extras}` : mood;
}

/** 注入块正文（不含 marker）。 */
export function injectText(state) {
  const desc = describe(state);
  const top = Object.entries(state.labels).sort((x, y) => y[1] - x[1]).slice(0, 2)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' / ');
  const lines = [`【现在的心情】${desc}${top ? `（${top}）` : ''}`];
  // 手册 §3 的边界：情绪只影响语气；不能拿来拿捏对方（不威胁、不冷战、不翻旧账）
  lines.push('情绪只影响语气，不影响判断；不能用情绪拿捏对方：不威胁、不冷战、不翻旧账。');
  return lines.join('\n');
}
