// 鲸窝 · 聊天（服务端）
//
// 所有数据都在这一台电脑上：一个 JSON 库 + 文件目录。客户端（PC/手机）只是壳。
// 不用 SQLite：Electron 自带的 Node 版本太老，JSON 足够（一个人用）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(DIR, 'public');
const DATA = process.env.CHAT_DATA || path.join(DIR, 'data');
const FILES = path.join(DATA, 'files');
const DB_FILE = path.join(DATA, 'db.json');
const PORT = Number(process.env.CHAT_PORT || 7501);
const MEMORY = process.env.MEMORY_BASE || 'http://127.0.0.1:7331';
const PRESET = process.env.CHAT_PRESET || '';   // 想挂 DSH 的 agent preset 就填它，留空 = 默认 agent
const CHAT_KEY = process.env.CHAT_KEY || 'local:me';
const APP_VERSION = process.env.CHAT_VERSION || '1.17';
const APP_NAME = '鲸窝';
const ROTATE_AT = Number(process.env.CHAT_ROTATE_AT || 90000);  // 上下文超过这个就换窗口
const MAX_UPLOAD = 200 * 1024 * 1024;
const DIARY_DIR = process.env.DIARY_DIR || path.join(DATA, 'diary');

fs.mkdirSync(FILES, { recursive: true });

// ── 访问口令 ────────────────────────────────────────────────────────────
// 本机（127.0.0.1）直接放行；走公网隧道时必须有口令，否则谁拿到地址都能看聊天记录。
const TOKEN_FILE = path.join(DATA, 'token.txt');
let TOKEN = '';
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
if (!TOKEN) {
  TOKEN = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, TOKEN, 'utf8');
  console.log('[chat] 已生成访问口令（data/token.txt）');
}

const isLoopback = (req) => {
  const a = String(req.socket?.remoteAddress ?? '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

/** 从 Cookie 里取口令（图片/视频标签发不出自定义头，只能靠 cookie）。 */
const cookieToken = (req) => {
  const raw = String(req.headers.cookie ?? '');
  const m = /(?:^|;\s*)whale_k=([^;]+)/.exec(raw);
  return m ? decodeURIComponent(m[1]) : '';
};

const authed = (req, url) => {
  if (!TOKEN) return true;
  if (isLoopback(req)) return true;
  const k = url.searchParams.get('k') || req.headers['x-chat-token'] || cookieToken(req);
  return k === TOKEN;
};

/** 带口令访问过之后，把口令写成 cookie —— 之后 <img src> 也能自动带上。 */
function maybeSetCookie(req, res, url) {
  if (!TOKEN) return;
  if (cookieToken(req) === TOKEN) return;
  const k = url.searchParams.get('k') || req.headers['x-chat-token'];
  if (k !== TOKEN) return;
  res.setHeader('Set-Cookie',
    `whale_k=${encodeURIComponent(TOKEN)}; Path=/; Max-Age=31536000; SameSite=Lax`);
}

// ── 存储 ────────────────────────────────────────────────────────────────
const emptyDb = () => ({ seq: { msg: 0, file: 0, sticker: 0, moment: 0 }, settings: {}, files: [], messages: [], stickers: [], moments: [], momentFiles: [], momentLikes: [], momentComments: [], schedules: [], seq: { msg: 0, file: 0, sticker: 0, moment: 0, sched: 0 } });

function loadDb() {
  try { return { ...emptyDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; }
  catch { return emptyDb(); }
}
let db = loadDb();

/** 按文件头判断真实 mime，别信客户端给的 content-type。 */
function sniffMime(buf, fallback) {
  if (buf.length > 8) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
    if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
    if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
    if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
    if (buf.subarray(4, 8).toString() === "ftyp") return "video/mp4";
  }
  return fallback || "application/octet-stream";
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

const nextId = (k) => (db.seq[k] = (db.seq[k] ?? 0) + 1);
const getSetting = (k, d = '') => db.settings[k] ?? d;
const setSetting = (k, v) => { db.settings[k] = String(v); save(); };
const findFile = (id) => db.files.find((f) => f.id === Number(id));
const lastMsg = () => db.messages[db.messages.length - 1] ?? null;

// ── SSE ─────────────────────────────────────────────────────────────────
const clients = new Set();
function broadcast(type, data = {}) {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch {} }
}

// ── DSH 桥 ──────────────────────────────────────────────────────────────
// DSH 的 API 客户端：随仓库自带（vendor/），不依赖外部工程
const { NodeApiClient, unwrap, createTurnCollector, discoverDshSessionCookie } = await import(
  new URL('./vendor/dsh-client.js', import.meta.url).href
);

function dshPort() {
  // 显式指定最省事：DSH_PORT=xxxxx
  if (process.env.DSH_PORT) return Number(process.env.DSH_PORT) || 0;
  if (process.env.CHAT_NO_AGENT === '1') return 0;   // 只看界面 / 没有 DSH 时用
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -State Listen | Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -like 'DeepSeek Harness*' } | Select-Object -First 1).LocalPort"],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const n = Number(String(out).trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

const dport = dshPort();
let api = null, sessionId = null, digestSessionId = null;
let busy = false;

// ── 回复节奏 ────────────────────────────────────────────────────────────
// 她不能秒回：对方打多少字，她就隔多久再回（1 字 ≈ 1 秒，最多 8 秒）。
// 这段时间里对方接着发，就并进同一轮一起回 —— 否则一条一条发会被打成碎片。
const REPLY_MS_PER_CHAR = 1000;
const REPLY_MAX_MS = 8000;
const replyQueue = { items: [], firstAt: 0, timer: null };

function armReplyTimer() {
  if (replyQueue.timer) { clearTimeout(replyQueue.timer); replyQueue.timer = null; }
  if (!replyQueue.items.length) return;
  const chars = [...replyQueue.items.join('')].length;
  const want = Math.min(REPLY_MAX_MS, Math.max(REPLY_MS_PER_CHAR, chars * REPLY_MS_PER_CHAR));
  const now = Date.now();
  // 总等待从这一轮第一句算起，绝不拖过 8 秒
  const wait = Math.max(0, Math.min(now + want, replyQueue.firstAt + REPLY_MAX_MS) - now);
  broadcast('typing', { on: true });
  replyQueue.timer = setTimeout(fireReplyQueue, wait);
  console.log('[chat] 她 ' + (wait / 1000).toFixed(1) + ' 秒后再回（本轮 ' + chars + ' 字）');
}

function fireReplyQueue() {
  replyQueue.timer = null;
  if (busy) { replyQueue.timer = setTimeout(fireReplyQueue, 800); return; } // 还在回上一轮，等她说
  const text = replyQueue.items.join('\n');
  replyQueue.items = [];
  replyQueue.firstAt = 0;
  talk(text).catch((e) => addMessage('her', 'text', `（出错了：${e?.message ?? e}）`));
}

function queueReply(text) {
  if (!replyQueue.items.length) replyQueue.firstAt = Date.now();
  replyQueue.items.push(text);
  armReplyTimer();
}

// 每个会话独立的「收集器 + 等待者」——聊天会话和记忆提炼会话要分开排队
const slots = new Map();
function slotOf(id) {
  if (!slots.has(id)) slots.set(id, { collector: null, waiters: [] });
  return slots.get(id);
}

function waitTurnFor(id, ms = 300000) {
  const s = slotOf(id);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = s.waiters.findIndex((w) => w.timer === timer);
      if (i >= 0) s.waiters.splice(i, 1);
      reject(new Error('等她回话超时'));
    }, ms);
    s.waiters.push({ resolve, reject, timer });
  });
}

/** 读 QQ 桥接的私聊会话 id —— 鲸窝用它，两个入口共用同一个会话。 */
function bridgePrivateSession() {
  try {
    // 可选：和别的入口（比如 QQ 桥接）复用同一个 DSH 会话。
    // 设了 CHAT_BRIDGE_STATE 指向它的 sessions.json 才生效，否则纯本机。
    const f = process.env.CHAT_BRIDGE_STATE;
    if (!f) return '';
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    const map = raw.sessions ?? raw;
    const key = Object.keys(map).find((k) => k.startsWith('private:'));
    return key ? String(map[key].sessionId ?? map[key]) : '';
  } catch { return ''; }
}

async function ensureAgent() {
  if (!dport) return null;
  api = new NodeApiClient(`http://127.0.0.1:${dport}`, undefined, {});
  // 优先跟别的入口（比如 QQ 桥接）共用同一个会话，两个入口就是同一个她
  const bridged = bridgePrivateSession();
  if (bridged) {
    sessionId = bridged;
    setSetting('agent.session', bridged);
    api.events.follow(bridged);
    console.log('[chat] 复用 QQ 私聊会话', bridged);
    return bridged;
  }
  const saved = getSetting('agent.session');
  if (saved) {
    sessionId = saved;
    api.events.follow(sessionId);
    return sessionId;
  }
  const agentDir = path.join(DATA, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const ws = unwrap(await api.workspace.create({ path: agentDir }), 'workspace.create');
  const params = { workspaceId: ws.workspace.workspaceId };
  if (PRESET) params.agentPreset = PRESET;
  let v;
  try { v = unwrap(await api.sessions.create(params), 'sessions.create'); }
  catch { v = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId }), 'sessions.create'); }
  sessionId = v.sessionId;
  setSetting('agent.session', sessionId);
  api.events.follow(sessionId);
  return sessionId;
}

/** 记忆提炼专用会话（和聊天分开，避免对话里多出"提炼"的上下文）。 */
async function ensureDigestSession() {
  if (!api) return null;
  const saved = getSetting('digest.session');
  if (saved) {
    digestSessionId = saved;
    api.events.follow(digestSessionId);
    return digestSessionId;
  }
  const dir = path.join(DATA, 'agent');
  fs.mkdirSync(dir, { recursive: true });
  const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
  const params = { workspaceId: ws.workspace.workspaceId };
  if (PRESET) params.agentPreset = PRESET;
  let v;
  try { v = unwrap(await api.sessions.create(params), 'digest.create'); }
  catch { v = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId }), 'digest.create'); }
  digestSessionId = v.sessionId;
  setSetting('digest.session', digestSessionId);
  api.events.follow(digestSessionId);
  return digestSessionId;
}

async function pump() {
  for (;;) {
    try {
      for await (const envelope of api.events.mux({})) {
        const frame = envelope?.payload;
        if (!frame || frame.type !== 'session/event') continue;
        const s = slotOf(frame.sessionId);
        if (frame.event?.type === 'turn/start' && !s.collector) s.collector = createTurnCollector();
        const ended = s.collector ? s.collector.push(frame.event) : null;
        if (!ended) continue;
        s.collector = null;
        const w = s.waiters.shift();
        if (!w) continue;
        clearTimeout(w.timer);
        if (ended.reason?.kind === 'completed' && ended.text.trim()) w.resolve(ended.text.trim());
        else w.reject(new Error(ended.reason?.error?.message ?? '这一轮没有产出'));
      }
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function injectFor(text) {
  try {
    const u = `${MEMORY}/inject?key=${encodeURIComponent(CHAT_KEY)}&query=${encodeURIComponent(text.slice(0, 200))}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(u, { signal: ctrl.signal });
    clearTimeout(t);
    return String((await r.json())?.text ?? '');
  } catch { return ''; }
}

function observe(text) {
  fetch(`${MEMORY}/observe`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: CHAT_KEY, role: 'user', text }),
  }).catch(() => {});
}

function addMessage(role, kind, text, fileId = null) {
  const msg = { id: nextId('msg'), role, kind, text: text ?? '', fileId, at: Date.now() };
  // 关键：推给前端的消息必须带 file，否则刚发出去的表情/图片是空白（刷新才出现）
  if (fileId) msg.file = fileView(findFile(fileId));
  db.messages.push(msg);
  if (db.messages.length > 5000) db.messages = db.messages.slice(-4000);
  save();
  broadcast('message', { message: msg });
  return msg;
}

// ── 记忆提炼：把聊天里值得记的东西写进她的长期记忆 ─────────────────────
// 不做这一步，聊天软件里的对话就永远进不了她的记忆（这是之前的漏洞）。
let digestTimer = null;
let digestRunning = false;
let msgSinceDigest = 0;

function scheduleDigest(delayMs = 20000) {
  clearTimeout(digestTimer);
  digestTimer = setTimeout(() => { runDigest().catch(() => {}); }, delayMs);
}

async function runDigest() {
  if (digestRunning || !api) return { ok: false, reason: 'busy' };
  const lastId = Number(getSetting('digest.lastMsgId', 0)) || 0;
  const pending = db.messages.filter((m) => m.id > lastId && m.kind === 'text');
  if (pending.length < 10) return { ok: false, reason: '对话太少' };

  digestRunning = true;
  try {
    const id = digestSessionId ?? (await ensureDigestSession());
    if (!id) return { ok: false, reason: 'no session' };

    const lines = pending.slice(-24)
      .map((m) => (m.role === 'me' ? '对方' : '小助手') + '：' + String(m.text).slice(0, 220))
      .join('\n');

    const prompt = [
      '下面是你（小助手）和对方在这个聊天软件里的对话。',
      '请提炼值得长期记住的信息：只保留真正有信息量的（对方的事、约定、偏好、你学到的道理、重要事件）。',
      '不要记流水账，不要记无关闲聊。没有值得记的就输出 []。',
      '',
      '只输出 JSON 数组，每项 {"kind":"fact|episode|lesson|reflection","text":"一句话","importance":0.6}',
      'kind：fact=长期事实，episode=发生的事，lesson=被纠正后学到的，reflection=你自己的感悟。',
      '',
      lines,
    ].join('\n');

    const w = waitTurnFor(id, 180000);
    const accepted = await api.sessions.prompt({ sessionId: id, mode: 'queue', content: [{ type: 'text', text: prompt }] });
    if (!accepted?.result?.ok) return { ok: false, reason: 'prompt failed' };
    const out = await w;

    const m = String(out).match(/\[[\s\S]*\]/);
    let items = [];
    try { items = JSON.parse(m ? m[0] : '[]'); } catch { items = []; }

    let written = 0;
    for (const it of (Array.isArray(items) ? items.slice(0, 6) : [])) {
      const text = String(it?.text ?? '').trim();
      if (!text) continue;
      const kind = ['fact', 'episode', 'lesson', 'reflection'].includes(it?.kind) ? it.kind : 'fact';
      try {
        const r = await fetch(MEMORY + '/memory', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind,
            text,
            importance: Math.min(0.95, Math.max(0.3, Number(it?.importance) || 0.6)),
            source: CHAT_KEY,
          }),
        });
        if (r.ok) written += 1;
      } catch {}
    }

    // 顺手写一篇日记（同一天里对话够多才写）
    let diary = null;
    const lastDiaryId = Number(getSetting('diary.lastMsgId', 0)) || 0;
    if (pending.length >= 6 && pending[pending.length - 1].id > lastDiaryId) {
      diary = await writeDiary(pending.slice(-16)).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
      if (diary?.ok) setSetting('diary.lastMsgId', pending[pending.length - 1].id);
    }
    setSetting('digest.lastMsgId', pending[pending.length - 1].id);
    msgSinceDigest = 0;
    if (written) console.log('[chat] 记忆提炼：写入 ' + written + ' 条');
    if (diary?.ok) console.log('[chat] 日记：' + diary.chars + ' 字 → ' + diary.file);
    return { ok: true, written };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  } finally {
    digestRunning = false;
  }
}

/** 把一段对话写成日记，追加到和 QQ 那边同一本日记里。 */
async function writeDiary(entries) {
  const id = digestSessionId ?? (await ensureDigestSession());
  if (!id) return { ok: false, reason: "no session" };
  const lines = entries.map((m) => (m.role === "me" ? "对方" : "小助手") + "：" + String(m.text).slice(0, 260)).join("\n");
  const prompt = [
    "下面是你和对方在这个聊天软件里的对话。",
    "用你自己的口吻写一篇日记，80~160 字：写感受和细节，不要罗列对话、不要分点、不要写标题、不要提「对话」「聊天记录」这些词。",
    "直接输出正文。",
    "",
    lines,
  ].join("\n");

  const w = waitTurnFor(id, 180000);
  const accepted = await api.sessions.prompt({ sessionId: id, mode: "queue", content: [{ type: "text", text: prompt }] });
  if (!accepted?.result?.ok) return { ok: false, reason: "prompt failed" };
  const body = String(await w).trim().replace(/^#+\s*/gm, "").trim();
  if (!body || body.length < 10) return { ok: false, reason: "空的" };

  const now = new Date();
  const pad = (x) => String(x).padStart(2, "0");
  const file = path.join(DIARY_DIR, now.getFullYear() + "-" + pad(now.getMonth() + 1) + ".md");
  fs.mkdirSync(DIARY_DIR, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "# 日记 · " + now.getFullYear() + "-" + pad(now.getMonth() + 1) + "\n\n", "utf8");
  }
  const head = "## " + now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) +
    " " + pad(now.getHours()) + ":" + pad(now.getMinutes()) + " · 在聊天里";
  fs.appendFileSync(file, head + "\n\n" + body + "\n\n", "utf8");
  broadcast("diary", { at: now.getTime() });
  return { ok: true, chars: body.length, file: path.basename(file) };
}
/** 把她的回复落成消息：文字 + 表情 + 朋友圈标记。返回是否真的说了话。 */
/** 粗相似度：看两句话是不是在说同一件事。 */
function similar(a, b) {
  const norm = (s) => String(s ?? '').replace(/[\s，。！？、,.!?~～…"'`]/g, '');
  const A = norm(a); const B = norm(b);
  if (!A || !B) return 0;
  const grams = (s) => { const out = new Set(); for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2)); return out; };
  const ga = grams(A); const gb = grams(B);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return hit / Math.min(ga.size, gb.size);
}

function emitReply(reply) {
  const actions = [];
  let raw = String(reply ?? "");

  // 她可能输出 [[沉默]] —— 这是"已读不回"，绝不能当成消息发出去
  const silent = /\[\[\s*沉默\s*\]\]|\[\s*沉默\s*\]/.test(raw);
  raw = raw.replace(/\[\[\s*沉默\s*\]\]/g, "").replace(/\[\s*沉默\s*\]/g, "");

  const text = raw.replace(/\[\[(sticker|moment|sched|unsched)\s*[:：]\s*([^\]]+)\]\]/g, (_m, kind, val) => {
    actions.push({ kind, value: String(val).trim() });
    return "";
  }).trim();

  // 兜底：任何没被识别的 [[xxx]] 标记都不要露给用户
  let clean = text.replace(/\[\[[^\]]{0,80}\]\]/g, "").trim();

  // 定时消息不能提前把内容说出去：正文和定时内容像同一件事 → 换成应承
  const schedActions = actions.filter((a) => a.kind === "sched");
  if (schedActions.length && clean) {
    const planned = schedActions.map((a) => {
      const bar = a.value.indexOf("|");
      return bar > 0 ? a.value.slice(bar + 1).trim() : "";
    }).join(" ");
    if (planned && similar(clean, planned) > 0.45) {
      const ACKS = ["好，到点叫你", "记下了，到点喊你", "好，我记着", "行，到点说"];
      clean = ACKS[Math.floor(Math.random() * ACKS.length)];
    }
  }

  if (clean) addMessage("her", "text", clean);

  for (const a of actions) {
    if (a.kind === "sticker") {
      const pool = db.stickers;
      const hit = pool.find((s) => String(s.name).replace(/\.[a-z]+$/i, "") === a.value)
        ?? pool.find((s) => String(s.name).includes(a.value))
        ?? null;
      if (hit) addMessage("her", "sticker", "", hit.fileId);
    } else if (a.kind === "unsched") {
      let removed = 0;
      for (const s of db.schedules) {
        if (!s.done) { s.done = true; s.canceled = true; removed += 1; }
      }
      if (removed) { save(); console.log("[chat] 取消定时:", removed, "条"); }
    } else if (a.kind === "sched") {
      // 格式：[[sched:2026-11-12 08:00|要说的话]]
      const bar = a.value.indexOf("|");
      const when = bar > 0 ? a.value.slice(0, bar).trim() : "";
      const say = bar > 0 ? a.value.slice(bar + 1).trim() : "";
      const at = parseWhen(when);
      if (at && say) {
        addSchedule(at, say);
      } else {
        console.log("[chat] 定时格式不对:", a.value);
      }
    } else if (a.kind === "moment") {
      const moment = { id: nextId("moment"), text: a.value.slice(0, 200), at: Date.now(), by: "her" };
      db.moments.push(moment);
      save();
      broadcast("moments", {});
    }
  }
  return { spoke: Boolean(clean) || actions.length > 0, silent };
}
// ── 主动发言：她自己决定说不说、说什么 ─────────────────────────────
// 不是定时消息：每次「醒来」只是给她一个机会，她可以继续沉默。
const QUIET_FROM = 0;   // 00:30 之后
const QUIET_TO = 8;     // 08:00 之前不主动打扰
const MIN_GAP_MS = 30 * 60 * 1000;      // 两条主动消息至少隔 30 分钟
const USER_AWAY_MS = 30 * 60 * 1000;     // 你 30 分钟内说过话就不打扰
const MAX_PER_DAY = 4;                  // 一天最多主动 4 次
const STREAK_COOLDOWN = 3;              // 连续 3 次没回，冷却 6 小时

function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

async function proactiveTick(force = false) {
  if (!api || !sessionId || busy) return { ok: false, reason: "busy" };

  const now = Date.now();
  const hour = new Date().getHours();
  const lastUser = [...db.messages].reverse().find((m) => m.role === "me");
  const lastPro = Number(getSetting("pro.active.lastAt", 0)) || 0;
  const day = todayStr();
  const count = getSetting("pro.active.day", "") === day ? Number(getSetting("pro.active.count", 0)) : 0;
  const streak = Number(getSetting("pro.active.streak", 0)) || 0;

  // 你最后一条消息之后，她有没有说过话（用于"追问"判断）
  const lastHer = [...db.messages].reverse().find((m) => m.role === "her");
  const userWaiting = Boolean(lastHer && lastUser && lastHer.at > lastUser.at);
  const waitedMin = lastHer ? Math.round((now - lastHer.at) / 60000) : 0;

  if (!force) {
    if (hour >= QUIET_FROM && hour < QUIET_TO) return { ok: false, reason: "深夜" };
    if (count >= MAX_PER_DAY) return { ok: false, reason: "今天说够了" };
    if (streak >= STREAK_COOLDOWN) return { ok: false, reason: "连发被无视，冷却" };
    if (now - lastPro < MIN_GAP_MS) return { ok: false, reason: "距上次主动不到 30 分钟" };
    if (lastUser && now - lastUser.at < USER_AWAY_MS) return { ok: false, reason: "你刚说过话" };

    // 每日保底：今天还没主动说过，且你已经 2 小时没开口 → 允许
    const dailyQuota = count === 0 && (!lastUser || now - lastUser.at > 2 * 3600 * 1000);
    // 追问：她最后说的那句已经没人接 40 分钟以上，允许轻轻补一句（每天算一次）
    const followUp = userWaiting && waitedMin >= 40 && waitedMin < 240;

    if (!dailyQuota && !followUp) return { ok: false, reason: "节奏未到（等你开口或等你回）" };
  }

  const quietMin = lastUser ? Math.round((now - lastUser.at) / 60000) : null;
  const hhmm = new Date().toTimeString().slice(0, 5);
  const lastFew = db.messages.slice(-6).map((m) => (m.role === "me" ? "对方" : "你") + "：" + String(m.text || "[图片]").slice(0, 80)).join("\n");

  const prompt = [
    "现在是 " + hhmm + "。",
    quietMin !== null ? "对方上一次说话是 " + quietMin + " 分钟前。" : "对方还没在这个软件里说过话。",
    "上一轮你们聊的是：",
    lastFew || "（还没有聊天记录）",
    "",
    "你可以主动给她发条消息，也可以什么都不说。",
    "规则：",
    "- 想说就说，别硬找话题；没什么想说的就沉默，沉默完全没问题。",
    "- 最多两三句，像微信里随手发的那种，不要长篇大论。",
    "- 不要每次都问「在吗」，不要重复上次说过的话。",
    "- 如果要发，只输出正文；如果不发，只输出 [[沉默]]。",
    "- 想发表情就单独一行写 [[sticker:表情名]]。",
    "- 想发朋友圈就单独一行写 [[moment:内容]]（可以只发这一条，不必同时说话）。",
  ].join("\n");

  try {
    const w = waitTurnFor(sessionId, 180000);
    const accepted = await api.sessions.prompt({ sessionId, mode: "queue", content: [{ type: "text", text: prompt }] });
    if (!accepted?.result?.ok) return { ok: false, reason: "prompt failed" };
    const out = String(await w).trim();

    if (!out || out.includes("[[沉默]]") || out.includes("[沉默]")) {
      setSetting("pro.active.lastAt", now);
      return { ok: true, spoke: false };
    }

    emitReply(out);
    setSetting("pro.active.lastAt", now);
    setSetting("pro.active.day", day);
    setSetting("pro.active.count", count + 1);
    setSetting("pro.active.streak", streak + 1);
    console.log("[chat] 她主动说话了：" + out.slice(0, 40));
    return { ok: true, spoke: true, text: out.slice(0, 120) };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/** 心跳：每 10 分钟给她一次机会（是否真的发由上面的规则 + 她自己决定）。 */
function logProactive(line) {
  try {
    fs.appendFileSync(path.join(DATA, 'proactive.log'), new Date().toISOString() + ' | ' + line + '\n');
  } catch {}
}

function startProactiveHeartbeat() {
  setInterval(() => { proactiveTick().then((r) => logProactive(JSON.stringify(r))).catch(() => {}); }, 20 * 60 * 1000);
  setTimeout(() => { proactiveTick().catch(() => {}); }, 5 * 60 * 1000);
}

/** 她说话后重置「没回」计数。 */
function noteUserReply() {
  setSetting("pro.active.streak", 0);
}
/** 动图抽帧拼成网格（模型只看第一帧会把 GIF 当静态图）。 */
function gifGridPath(file) {
  try {
    const out = path.join(FILES, file.path + ".grid.png");
    if (fs.existsSync(out)) return out;
    const py = process.env.PYTHON || 'python';
    const script = path.join(DIR, "tools", "gif-grid.py");
    if (!fs.existsSync(script)) return null;
    execFileSync(py, [script, path.join(FILES, file.path), out], { windowsHide: true, timeout: 20000 });
    return fs.existsSync(out) ? out : null;
  } catch (e) {
    console.log("[chat] GIF 抽帧失败:", e?.message ?? e);
    return null;
  }
}
/** 对方发来图片/表情/文件时，把内容真的给她看（否则她只看到"空框"）。 */
async function talkWithFile(file, kind) {
  if (!api || !sessionId) return;
  if (busy) return; // 正在回上一条，稍后她会在下一轮看到
  busy = true;
  broadcast("typing", { on: true });
  try {
    const mem = await injectFor(file.name || kind);
    const isImage = String(file.mime || "").startsWith("image/");
    const parts = [];

    let intro;
    if (kind === "sticker") intro = "对方发来一个表情包（图在下面）。";
    else if (isImage) intro = "对方发来一张图片（图在下面）。";
    else if (String(file.mime || "").startsWith("video/")) intro = "对方发来一个视频：" + file.name + "。";
    else intro = "对方发来一个文件：" + file.name + "（" + Math.round(file.size / 1024) + " KB）。";

    parts.push({ type: "text", text: [mem, "", "（对方在自己做的聊天软件鲸窝里跟你说话。）", intro].filter(Boolean).join("\n") });

    if (isImage) {
      try {
        const isGif = (file.mime === "image/gif");
        const grid = isGif ? gifGridPath(file) : null;
        if (isGif && grid) {
          parts[parts.length - 1] = {
            type: "text",
            text: parts[parts.length - 1].text + "\n（这是动图，已按顺序抽帧拼成网格：从左到右、从上到下是动作顺序，不是一张照片。）",
          };
          const gbuf = fs.readFileSync(grid);
          parts.push({ type: "image", mediaType: "image/png", data: gbuf.toString("base64"), name: "anim-grid.png" });
        } else {
        const buf = fs.readFileSync(path.join(FILES, file.path));
        if (buf.length <= 8 * 1024 * 1024) {
          parts.push({ type: "image", mediaType: file.mime || "image/png", data: buf.toString("base64"), name: file.name });
        }
        }
      } catch {}
    }

    const w = waitTurnFor(sessionId, 240000);
    const accepted = await api.sessions.prompt({ sessionId, mode: "queue", content: parts });
    if (!accepted?.result?.ok) return;
    const reply = await w;
    emitReply(reply);
    observe(intro);
    msgSinceDigest += 2;
    if (msgSinceDigest >= 10) scheduleDigest(30000);
  } catch (e) {
    addMessage("her", "text", "（出错了：" + (e?.message ?? e) + "）");
  } finally {
    busy = false;
    broadcast("typing", { on: false });
  }
}
/** 最近的朋友圈，给她当上下文用。 */
function momentsBrief(limit = 6) {
  return db.moments.slice(-limit).map((m) => {
    const pics = db.momentFiles.filter((x) => x.momentId === m.id).length;
    const who = m.by === "her" ? "我" : "对方";
    const when = new Date(m.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return "- " + who + "（" + when + "）：" + String(m.text || "（只有图）").slice(0, 80) + (pics ? " [图 " + pics + " 张]" : "");
  }).join("\n");
}
/** 让她对一条朋友圈做出反应（点赞/评论）。她自己决定要不要。 */
async function reactToMoment(momentId, reason) {
  if (!api || !sessionId || busy) return { ok: false, reason: "busy" };
  const m = db.moments.find((x) => x.id === Number(momentId));
  if (!m) return { ok: false, reason: "没这条" };

  busy = true;
  broadcast("typing", { on: true });
  try {
    const files = db.momentFiles.filter((x) => x.momentId === m.id).map((x) => findFile(x.fileId)).filter(Boolean);
    const comments = db.momentComments.filter((x) => x.momentId === m.id)
      .map((c) => (c.by === "me" ? "对方" : "你") + "：" + c.text).join("\n");

    const parts = [];
    const intro = [
      "朋友圈里有一条" + (m.by === "her" ? "你自己发的" : "对方发的") + "动态：",
      String(m.text || "（只有图）"),
      files.length ? "（配了 " + files.length + " 张图，图在下面）" : "",
      comments ? "下面已有的评论：\n" + comments : "",
      "",
      reason === "post"
        ? "对方刚发了这条。你可以点赞、也可以评论一句，也可以什么都不做。"
        : "对方刚在上面评论了。你可以回她一句，也可以顺手点个赞。",
      "规则：",
      "- 想点赞就单独一行写 [[like]]。",
      "- 想评论就单独一行写 [[comment:要说的话]]（一句话，像微信里随口留的）。",
      "- 都不想做就只输出 [[沉默]]。",
      "- 不要重复已有评论里说过的话。",
    ].filter(Boolean).join("\n");

    parts.push({ type: "text", text: intro });
    for (const f of files.slice(0, 3)) {
      if (!String(f.mime || "").startsWith("image/")) continue;
      try {
        const isGif = f.mime === "image/gif";
        const grid = isGif ? gifGridPath(f) : null;
        const src = grid || path.join(FILES, f.path);
        const buf = fs.readFileSync(src);
        if (buf.length <= 8 * 1024 * 1024) {
          parts.push({ type: "image", mediaType: grid ? "image/png" : (f.mime || "image/png"), data: buf.toString("base64"), name: f.name });
        }
      } catch {}
    }

    const w = waitTurnFor(sessionId, 180000);
    const accepted = await api.sessions.prompt({ sessionId, mode: "queue", content: parts });
    if (!accepted?.result?.ok) return { ok: false, reason: "prompt failed" };
    const out = String(await w);

    if (!out || out.includes("沉默")) return { ok: true, acted: false };

    let acted = 0;
    if (/\[\[like\]\]/.test(out)) {
      if (!db.momentLikes.some((x) => x.momentId === m.id && x.by === "her")) {
        db.momentLikes.push({ momentId: m.id, by: "her", at: Date.now() });
        acted += 1;
      }
    }
    const cm = [...out.matchAll(/\[\[comment\s*[:：]\s*([^\]]+)\]\]/g)].map((x) => x[1].trim()).filter(Boolean);
    for (const text of cm.slice(0, 2)) {
      db.momentComments.push({ momentId: m.id, by: "her", text: text.slice(0, 200), at: Date.now() });
      acted += 1;
    }
    if (acted) { save(); broadcast("moments", {}); }
    return { ok: true, acted: acted > 0 };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  } finally {
    busy = false;
    broadcast("typing", { on: false });
  }
}
/** 把 "2026-11-12 08:00" / "08:00" / "明天 8:00" 解析成时间戳。 */
function parseWhen(s) {
  const str = String(s ?? "").trim();
  if (!str) return 0;
  const now = new Date();

  // 绝对时间：2026-11-12 08:00
  let m = str.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T]+(\d{1,2}):(\d{2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
    return d.getTime();
  }

  // 相对时间：十分钟后 / 30分钟后 / 两小时后 / 半小时后
  const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    十一: 11, 十二: 12, 十五: 15, 二十: 20, 三十: 30, 四十五: 45 };
  const num = (x) => (/^\d+$/.test(x) ? Number(x) : (CN[x] ?? 0));
  m = str.match(/([0-9]+|[一二两三四五六七八九十]{1,3})\s*(?:个)?\s*分钟\s*(?:之后|后)/);
  if (m && num(m[1])) return now.getTime() + num(m[1]) * 60000;
  m = str.match(/([0-9]+|[一二两三四五六七八九十]{1,3})\s*(?:个)?\s*小时\s*(?:之后|后)/);
  if (m && num(m[1])) return now.getTime() + num(m[1]) * 3600000;
  if (/半\s*(个)?\s*小时/.test(str)) return now.getTime() + 30 * 60000;

  // 钟点：明天/后天 + 7:00 或 七点
  m = str.match(/(明天|后天|今天)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[:：点]\s*(\d{1,2}|半)?/);
  if (m) {
    const hour = num(m[2]);
    let minute = 0;
    if (m[3] === "半") minute = 30;
    else if (m[3]) minute = num(m[3]);
    if (hour >= 0) {
      const day = m[1] === "后天" ? 2 : m[1] === "明天" ? 1 : 0;
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, hour, minute, 0, 0);
      if (!m[1] && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
  }
  return 0;
}

function addSchedule(at, text) {
  const item = { id: nextId("sched"), at, text: String(text).slice(0, 400), createdAt: Date.now(), done: false };
  db.schedules.push(item);
  save();
  const when = new Date(at).toLocaleString("zh-CN");
  console.log("[chat] 已排定定时消息:", when, "→", item.text.slice(0, 40));
  return item;
}

/** 每秒看一眼有没有到点的消息要发。 */
function startScheduler() {
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const s of db.schedules) {
      if (s.done || s.at > now) continue;
      s.done = true;
      s.sentAt = now;
      changed = true;
      emitReply(String(s.text));
      console.log("[chat] 定时消息已发出:", String(s.text).slice(0, 40));
    }
    if (changed) save();
  }, 15000);
}
/** 查当前会话的上下文压力（token 数）。 */
async function sessionPressure() {
  if (!dport || !sessionId) return 0;
  try {
    const cookie = discoverDshSessionCookie(`http://127.0.0.1:${dport}`);
    const r = await fetch(`http://127.0.0.1:${dport}/api/session/list`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "p", method: "session/list", payload: { args: { _request: {} } } }),
    });
    const j = await r.json();
    const items = j.result?.value?.items ?? [];
    const item = items.find((s) => String(s.sessionId) === String(sessionId));
    return Number(item?.projections?.values?.contextPressure?.pressureTokens ?? 0);
  } catch { return 0; }
}

/** 换一个新窗口：让 QQ 桥接重置私聊会话，再用记忆+近况开场。 */
async function rotateSession(reason) {
  const before = sessionId;
  try {
    // 直接新建一个会话：不复用 QQ 桥接的（它的重置接口不会顺手建新会话）
    const dir = path.join(DATA, 'agent');
    fs.mkdirSync(dir, { recursive: true });
    const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
    const params = { workspaceId: ws.workspace.workspaceId };
    if (PRESET) params.agentPreset = PRESET;
    let v;
    try { v = unwrap(await api.sessions.create(params), 'rotate.create'); }
    catch { v = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId }), 'rotate.create'); }
    const fresh = v.sessionId;
    if (!fresh) return { ok: false, reason: 'create failed' };

    sessionId = fresh;
    setSetting('agent.session', fresh);
    api.events.follow(fresh);

    // 开场白：把近况和记忆递给她，别让她一上来是空的
    const recent = db.messages.filter((m) => m.kind === 'text').slice(-10)
      .map((m) => (m.role === 'me' ? '对方' : '小助手') + '：' + String(m.text).slice(0, 120)).join('\n');
    const mem = await injectFor('最近聊了什么');
    const preamble = [
      '（刚换了个新窗口，之前的对话不在这一条线里了，但你的记忆都还在。）',
      mem,
      '最近你们聊的是：',
      recent || '（还没有聊天记录）',
      '看完了只回一个字「嗯」，别多说。',
    ].filter(Boolean).join('\n');

    const w = waitTurnFor(fresh, 120000);
    const accepted = await api.sessions.prompt({ sessionId: fresh, mode: 'queue', content: [{ type: 'text', text: preamble }] });
    if (accepted?.result?.ok) { try { await w; } catch {} }

    setSetting('agent.rotatedAt', Date.now());
    setSetting('agent.rotations', (Number(getSetting('agent.rotations', 0)) || 0) + 1);
    console.log('[chat] 会话已轮换:', String(before).slice(0, 18), '→', fresh.slice(0, 18), '原因:', reason);
    return { ok: true, from: before, to: fresh };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/** 每轮对话后看要不要换窗口（10 分钟最多换一次）。 */
let lastRotateCheck = 0;
async function maybeRotate() {
  if (Date.now() - lastRotateCheck < 10 * 60 * 1000) return;
  lastRotateCheck = Date.now();
  const pressure = await sessionPressure();
  if (pressure < ROTATE_AT) return;
  console.log("[chat] 上下文压力", Math.round(pressure / 1000) + "k ≥", Math.round(ROTATE_AT / 1000) + "k，准备轮换");
  await rotateSession("pressure " + Math.round(pressure / 1000) + "k");
}
/** 从用户的话里判断"是不是在要求定时"。 */
function looksLikeSchedule(text) {
  const s = String(text ?? '');
  return /(\d{1,2}\s*[:：点]\s*\d{0,2}|\d+\s*分钟|\d+\s*小时|半小时|一会几|等会|明天|后天|早上|晚上|中午)/.test(s)
    && /(叫我|提醒|发我|发消息|通知|喊我|说一声)/.test(s);
}

/** 一轮对话：自然速度，她思考多久就多久。 */
async function talk(userText) {
  if (!api || !sessionId) throw new Error('DSH 没连上');
  if (busy) throw new Error('她还在回上一条');
  busy = true;
  broadcast('typing', { on: true });
  try {
    const mem = await injectFor(userText);

    // 告诉她有哪些表情能用、怎么发朋友圈
    const stickerNames = [...new Set(db.stickers.map((s) => String(s.name || '').replace(/\.[a-z]+$/i, '')).filter(Boolean))];
    const recentMoments = momentsBrief(6);

    const pendingSched = db.schedules
      .filter((s) => !s.done)
      .slice(-5)
      .map((s) => new Date(s.at).toLocaleString('zh-CN') + ' → ' + String(s.text).slice(0, 30))
      .join(' / ');

    const rules = [
      stickerNames.length
        ? `你能用这些表情包：${stickerNames.join('、')}。想发就把 [[sticker:表情名]] 单独写一行（名字要一字不差）。`
        : '你还没有可用的表情包（对方可以在「表情」里加）。',
      '想发朋友圈就把 [[moment:内容]] 单独写一行（不超过 60 字）。',
      '如果这句不想接（比如对方只是说「嗯嗯」「我去吃饭了」「晚安」），就只输出 [[沉默]]，什么都别说，也不要解释。',
      recentMoments ? `朋友圈最近动态（你能看到）：\n${recentMoments}` : '',
    ].filter(Boolean);

    const prompt = [
      mem, '',
      '（对方在自己做的聊天软件里跟你说话，只会有她一个人。）',
      '',
      '【定时消息】',
      '你可以把一句话定在未来的某个时间点发出。',
      '只要对方说「几点叫我」「X 分钟后提醒我」「明早七点发我」这类，就必须用定时，不要现在就把内容当普通回复发出去。',
      '格式（单独一行）：[[sched:2026-11-11 15:26|要发的话]]',
      '时间写绝对时间（年-月-日 时:分）。现在是 ' + new Date().toLocaleString('zh-CN') + '。',
      '例：她说「明早七点叫我」→ [[sched:2026-11-12 07:00|该起了，七点整]]',
      '例：她说「十分钟后提醒我关火」→ [[sched:2026-11-11 22:20|关火啦，别忘了]]',
      '排好之后，现在只回一句很短的话（比如「好，到点叫你」），绝对不要把定时内容提前说出来。',
      '如果她说要取消，就单独写一行 [[unsched:all]]。',
      ...rules,
      '',
      userText,
    ].filter(Boolean).join('\n');

    const beforeSched = db.schedules.length;
    const w = waitTurnFor(sessionId);
    const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] });
    if (!accepted?.result?.ok) throw new Error(accepted?.result?.error?.message ?? '发送失败');
    const reply = await w;

    const r = emitReply(reply);

    // 定时兜底（服务端自己来）：她说要定时但没排上 → 服务器解析时间并排定
    if (looksLikeSchedule(userText) && db.schedules.length === beforeSched) {
      const at = parseWhen(userText);
      if (at) {
        const say = (String(reply).replace(/\[\[[^\]]*\]\]/g, "").trim() || "到点啦").slice(0, 200);
        addSchedule(at, say);
        if (!db.messages.length || db.messages[db.messages.length - 1].text !== say) {
          addMessage("her", "text", "好，到点提醒你");
        }
        console.log("[chat] 服务端兜底排定:", new Date(at).toLocaleString("zh-CN"));
      }
    }

    // 定时兜底：看着像要定时，但她既没排也没说时间 → 再点她一次
    if (looksLikeSchedule(userText) && db.schedules.length === beforeSched) {
      try {
        const w2 = waitTurnFor(sessionId, 120000);
        const again = await api.sessions.prompt({
          sessionId, mode: 'queue',
          content: [{ type: 'text', text: '补充：对方刚才是在让你定时发消息。请只输出一行 [[sched:绝对时间|内容]]，不要解释。现在是 ' + new Date().toLocaleString('zh-CN') + '。' }],
        });
        if (again?.result?.ok) {
          const out2 = await w2;
          emitReply(out2);
        }
      } catch {}
    }
    observe(userText);
    msgSinceDigest += 2;
    if (msgSinceDigest >= 10) scheduleDigest(30000);
    return reply;
  } finally {
    busy = false;
    broadcast('typing', { on: false });
  }
}

// ── HTTP 工具 ───────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
};

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readBody(req, limit = MAX_UPLOAD) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('文件太大');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** 带 Range 的文件响应（视频要能拖进度条）。 */
function serveFile(req, res, file) {
  const full = path.join(FILES, file.path);
  if (!fs.existsSync(full)) return json(res, 404, { ok: false, error: '文件不在了' });
  const stat = fs.statSync(full);
  const mime = file.mime || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Number(m[2]) : stat.size - 1;
    res.writeHead(206, {
      'content-type': mime, 'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'content-length': end - start + 1,
    });
    return fs.createReadStream(full, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': mime, 'content-length': stat.size, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=86400' });
  fs.createReadStream(full).pipe(res);
}

const fileView = (f) => f && { id: f.id, name: f.name, mime: f.mime, size: f.size, url: `/api/file/${f.id}` };

function bootstrapPayload() {
  const messages = db.messages.slice(-80).map((m) => ({ ...m, file: m.fileId ? fileView(findFile(m.fileId)) : null }));
  const stickers = db.stickers.map((s) => ({ id: s.id, name: s.name, fileId: s.fileId, file: fileView(findFile(s.fileId)) })).filter((s) => s.file);
  const moments = db.moments.slice(-30).reverse().map((m) => ({
    ...m,
    files: db.momentFiles.filter((x) => x.momentId === m.id).map((x) => fileView(findFile(x.fileId))).filter(Boolean),
    likes: db.momentLikes.filter((x) => x.momentId === m.id).map((x) => x.by),
    comments: db.momentComments.filter((x) => x.momentId === m.id).map((x) => ({ by: x.by, text: x.text, at: x.at })),
  }));
  return {
    ok: true,
    me: { name: getSetting('me.name', '我'), avatar: fileView(findFile(getSetting('me.avatar', 0))) },
    her: { name: getSetting('her.name', '小助手'), avatar: fileView(findFile(getSetting('her.avatar', 0))) },
    messages, stickers, moments, busy, agentReady: !!sessionId,
    version: APP_VERSION, appName: APP_NAME, session: sessionId,
  };
}

// ── 路由 ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    maybeSetCookie(req, res, url);
    if (p.startsWith('/api/') && p !== '/api/open' && !authed(req, url)) {
      return json(res, 401, { ok: false, error: '需要访问口令', needToken: true });
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (p === '/api/bootstrap') return json(res, 200, bootstrapPayload());

    if (p === '/api/send' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const text = String(body.text ?? '').trim();
      if (!text) return json(res, 400, { ok: false, error: '空的' });
      addMessage('me', 'text', text);
      noteUserReply();
      queueReply(text);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/upload' && req.method === 'POST') {
      const buf = await readBody(req);
      const name = decodeURIComponent(String(url.searchParams.get('name') ?? 'file'));
      const declared = String(req.headers['content-type'] || 'application/octet-stream');
      const mime = sniffMime(buf, declared);
      const rel = crypto.randomUUID() + (path.extname(name) || '');
      fs.writeFileSync(path.join(FILES, rel), buf);
      const file = { id: nextId('file'), name, mime, size: buf.length, path: rel, at: Date.now() };
      db.files.push(file);
      save();
      return json(res, 200, { ok: true, file: fileView(file) });
    }

    if (p.startsWith('/api/file/')) {
      const f = findFile(p.split('/')[3]);
      if (!f) return json(res, 404, { ok: false, error: '没有这个文件' });
      return serveFile(req, res, f);
    }

    if (p === '/api/message/file' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const f = findFile(body.fileId);
      if (!f) return json(res, 400, { ok: false, error: '文件不存在' });
      const kind = String(body.kind ?? (f.mime.startsWith('image/') ? 'image' : f.mime.startsWith('video/') ? 'video' : 'file'));
      addMessage('me', kind, '', f.id);
      talkWithFile(f, kind).catch(() => {});
      return json(res, 200, { ok: true });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      for (const [k, v] of Object.entries(body)) {
        if (!/^(me|her)\.(name|avatar)$/.test(k)) continue;
        db.settings[k] = String(v);
      }
      save();
      broadcast('settings', {});
      return json(res, 200, { ok: true });
    }

    if (p === '/api/stickers' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      if (body.add) {
        const stripExt = (n) => String(n ?? '').replace(/\.[a-z0-9]+$/i, '').slice(0, 40);
        db.stickers.push({ id: nextId('sticker'), name: stripExt(body.name), fileId: Number(body.fileId), at: Date.now() });
        save();
        broadcast('stickers', {});
        return json(res, 200, { ok: true });
      }
      if (body.remove) {
        db.stickers = db.stickers.filter((s) => s.id !== Number(body.remove));
        save();
        broadcast('stickers', {});
        return json(res, 200, { ok: true });
      }
      return json(res, 200, { ok: false });
    }

    // 手动触发一次记忆提炼（排障/兜底用，仅本机）
    if (p === '/api/digest' && req.method === 'POST') {
      const r = await runDigest();
      return json(res, 200, r);
    }

    if (p === '/api/proactive' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const r = await proactiveTick(body.force === true);
      return json(res, 200, r);
    }

    if (p === '/api/client-log' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const line = [new Date().toISOString(), b.where, b.message, String(b.ua ?? '').slice(0, 120)].join(' | ');
      try { fs.appendFileSync(path.join(DATA, 'client-errors.log'), line + '\n'); } catch {}
      console.log('[client] ' + line);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/session/status') {
      const pressure = await sessionPressure();
      return json(res, 200, {
        ok: true, session: sessionId, pressure,
        rotateAt: ROTATE_AT,
        rotations: Number(getSetting('agent.rotations', 0)) || 0,
        rotatedAt: Number(getSetting('agent.rotatedAt', 0)) || null,
      });
    }

    if (p === '/api/session/rotate' && req.method === 'POST') {
      const r = await rotateSession('manual');
      return json(res, 200, r);
    }

    if (p === '/api/schedules') {
      return json(res, 200, { ok: true, items: db.schedules.slice(-20) });
    }

    if (p === '/api/schedule' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const at = Number(b.at) || parseWhen(String(b.when ?? ''));
      if (!at || !b.text) return json(res, 400, { ok: false, error: '时间或内容不对' });
      const item = addSchedule(at, String(b.text));
      return json(res, 200, { ok: true, item });
    }

    if (p === '/api/proactive/status') {
      const now = Date.now();
      const lastUser = [...db.messages].reverse().find((m) => m.role === 'me');
      const lastHer = [...db.messages].reverse().find((m) => m.role === 'her');
      const lastPro = Number(getSetting('pro.active.lastAt', 0)) || 0;
      return json(res, 200, {
        ok: true,
        hour: new Date().getHours(),
        quiet: new Date().getHours() < QUIET_TO,
        lastUserMinAgo: lastUser ? Math.round((now - lastUser.at) / 60000) : null,
        lastHerMinAgo: lastHer ? Math.round((now - lastHer.at) / 60000) : null,
        lastProactiveMinAgo: lastPro ? Math.round((now - lastPro) / 60000) : null,
        todayCount: getSetting('pro.active.day', '') === todayStr() ? Number(getSetting('pro.active.count', 0)) : 0,
        streak: Number(getSetting('pro.active.streak', 0)) || 0,
        minGapMin: Math.round(MIN_GAP_MS / 60000),
        maxPerDay: MAX_PER_DAY,
      });
    }

    if (p === '/api/moment/delete' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const id = Number(b.id);
      const before = db.moments.length;
      db.moments = db.moments.filter((m) => m.id !== id);
      db.momentFiles = db.momentFiles.filter((x) => x.momentId !== id);
      db.momentLikes = db.momentLikes.filter((x) => x.momentId !== id);
      db.momentComments = db.momentComments.filter((x) => x.momentId !== id);
      save();
      broadcast('moments', {});
      return json(res, 200, { ok: true, removed: before - db.moments.length });
    }

    if (p === '/api/moment/like' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const id = Number(b.id);
      const has = db.momentLikes.some((x) => x.momentId === id && x.by === 'me');
      if (has) db.momentLikes = db.momentLikes.filter((x) => !(x.momentId === id && x.by === 'me'));
      else db.momentLikes.push({ momentId: id, by: 'me', at: Date.now() });
      save();
      broadcast('moments', {});
      return json(res, 200, { ok: true, liked: !has });
    }

    if (p === '/api/moment/comment' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const id = Number(b.id);
      const text = String(b.text ?? '').trim().slice(0, 200);
      if (!text) return json(res, 400, { ok: false, error: '空的' });
      db.momentComments.push({ momentId: id, by: 'me', text, at: Date.now() });
      save();
      broadcast('moments', {});
      reactToMoment(id, 'comment').catch(() => {});
      return json(res, 200, { ok: true });
    }

    if (p === '/api/moment' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const text = String(body.text ?? '').trim();
      const ids = Array.isArray(body.fileIds) ? body.fileIds.map(Number).filter(Boolean) : [];
      if (!text && !ids.length) return json(res, 400, { ok: false, error: '空的' });
      const moment = { id: nextId('moment'), text, at: Date.now(), by: 'me' };
      db.moments.push(moment);
      for (const id of ids) db.momentFiles.push({ momentId: moment.id, fileId: id });
      save();
      broadcast('moments', {});
      reactToMoment(moment.id, 'post').catch(() => {});
      return json(res, 200, { ok: true });
    }

    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
});

try { await ensureAgent(); pump(); await ensureDigestSession(); startProactiveHeartbeat(); startScheduler(); } catch (e) { console.error('[chat] 初始化会话失败:', e?.message ?? e); }

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[chat] http://127.0.0.1:${PORT}`);
});
