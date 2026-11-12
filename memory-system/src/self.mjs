// 本体（Self）：这个进程里的「她」只有一份，各个入口（QQ / 桌面 / 其它）只是她伸出去的分体。
//
// 职责边界：
//   · 本体 = 人格（只读）+ 记忆 + 情绪 + 生活 + 主动性（想不想说话）
//   · 分体 = 通道适配器（QQ / 桌面 UI / 未来的其它入口），只负责"把话送到"
// 所以"心情好时主动分享"这个决定必须发生在本体，不能写在桥接里。
import { now } from './db.mjs';
import { loadState as loadEmotion, describe } from './emotion.mjs';

const DAY = 86400000;
const HOUR = 3600000;

/** 本体身份（不写人格文件，纯粹是运行时的自我描述）。 */
export function identity(db, cfg) {
  const created = db.prepare("SELECT v FROM meta WHERE k='self_created_at'").get()?.v;
  if (!created) {
    const at = String(now());
    db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES ('self_created_at', ?)").run(at);
  }
  const channels = db.prepare('SELECT id, kind, label, last_seen FROM channels ORDER BY last_seen DESC').all();
  return {
    name: cfg?.self?.name || '本体',
    version: '1.0',
    createdAt: Number(created ?? now()),
    dataRoot: cfg.system.dataRoot,
    channels: channels.map((c) => ({
      ...c,
      online: Number(c.last_seen ?? 0) > now() - 5 * 60000,
    })),
    role: '本体：人格 + 记忆 + 情绪 + 生活 + 主动性；QQ 等通道是她的分体',
  };
}

/** 分体上线/心跳登记。 */
export function touchChannel(db, { id, kind = 'qq', label = '' }, at = now()) {
  if (!id) return null;
  db.prepare(`INSERT INTO channels(id,kind,label,last_seen) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, kind = excluded.kind, label = excluded.label`)
    .run(String(id), String(kind), String(label).slice(0, 40), at);
  return { id, kind, at };
}

function lastShare(db) {
  const row = db.prepare("SELECT v FROM meta WHERE k='last_share_at'").get();
  const n = Number(db.prepare("SELECT v FROM meta WHERE k='share_count'").get()?.v ?? 0);
  return { at: Number(row?.v ?? 0), count: n };
}

/** 最近一次生活活动（作为分享素材）。 */
export function latestActivity(db) {
  const row = db.prepare('SELECT activity, interest, note, at FROM life_log ORDER BY at DESC LIMIT 1').get();
  if (!row) return null;
  if (now() - Number(row.at) > 12 * HOUR) return null;
  return row;
}

/**
 * 要不要主动分享。
 * 手册 §4：心情好时 30% 概率主动分享，6 小时冷却。
 */
export function shareDecision(db, cfg, at = now(), { force = false } = {}) {
  const state = loadEmotion(db, cfg);
  const share = cfg.life?.share ?? {};
  const prob = Number(share.probability ?? 0.3);
  const moodMin = Number(share.moodMin ?? 0.3);
  const cooldown = Number(share.cooldownHours ?? 6) * HOUR;
  const { at: lastAt, count } = lastShare(db);

  const activity = latestActivity(db);
  const material = activity
    ? `${activity.activity}${activity.interest && activity.interest !== activity.activity ? `（${activity.interest}）` : ''}${activity.note ? `，${activity.note}` : ''}`
    : null;

  const block = (reason) => ({ ok: false, reason, mood: { p: state.p, labels: state.labels }, cooldownLeftMs: Math.max(0, lastAt + cooldown - at), material });

  if (state.p < moodMin) return block(`心情不够好（P=${state.p.toFixed(2)} < ${moodMin}）`);
  if (at - lastAt < cooldown) return block(`冷却中（还差 ${Math.round((lastAt + cooldown - at) / 60000)} 分钟）`);
  if (!force && Math.random() > prob) return block(`掷骰子没中（概率 ${prob}）`);

  return {
    ok: true,
    reason: force ? '手动触发' : `心情好（P=${state.p.toFixed(2)}）+ 概率命中`,
    mood: { p: state.p, a: state.a, d: state.d, desc: describe(state), labels: state.labels },
    material,
    sinceLastShareMs: lastAt ? at - lastAt : null,
    shareCount: count,
  };
}

/** 记录一次分享（本体侧归档 + 每日统计）。 */
export function recordShare(db, cfg, { channel = 'qq', text = '', at = now() } = {}) {
  db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES ('last_share_at', ?)").run(String(at));
  const n = Number(db.prepare("SELECT v FROM meta WHERE k='share_count'").get()?.v ?? 0) + 1;
  db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES ('share_count', ?)").run(String(n));
  try {
    db.prepare('INSERT INTO share_log(at, channel, text) VALUES (?,?,?)').run(at, channel, String(text).slice(0, 500));
    const day = new Date(at).toISOString().slice(0, 10);
    db.prepare('INSERT OR REPLACE INTO daily_stats(day,key,value) VALUES (?,?,?)').run(day, 'shares', n);
  } catch {}
  return { at, count: n };
}

/** 本体全景（给 UI / 桥接看）。 */
export function selfSnapshot(db, cfg, at = now()) {
  const id = identity(db, cfg);
  const state = loadEmotion(db, cfg);
  const { at: lastAt, count } = lastShare(db);
  const activity = latestActivity(db);
  const decision = shareDecision(db, cfg, at);
  return {
    identity: id,
    mood: { ...state, desc: describe(state) },
    lastActivity: activity,
    share: {
      lastAt: lastAt || null,
      count,
      cooldownLeftMs: Math.max(0, lastAt + Number(cfg.life?.share?.cooldownHours ?? 6) * HOUR - at),
      nextPossible: decision.ok ? '现在就可以' : decision.reason,
    },
    layers: {
      memory: cfg.memory?.enabled !== false, emotion: cfg.emotion?.enabled !== false,
      life: cfg.life?.enabled !== false, expression: cfg.expression?.enabled !== false,
      feedback: cfg.feedback?.enabled !== false,
    },
  };
}
