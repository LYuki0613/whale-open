// 鲸窝 · 聊天（服务端）
//
// 所有数据都在这一台电脑上：一个 JSON 库 + 文件目录。客户端（PC/手机）只是壳。
// 不用 SQLite：Electron 自带的 Node 版本太老，JSON 足够（一个人用）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { synthesize, hasTts, accountInfo, DEFAULT_VOICE } from './tts.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(DIR, 'public');
const DATA = process.env.CHAT_DATA || path.join(DIR, 'data');
const FILES = path.join(DATA, 'files');
const DB_FILE = path.join(DATA, 'db.json');
const PORT = Number(process.env.CHAT_PORT || 7501);
const MEMORY = process.env.MEMORY_BASE || 'http://127.0.0.1:7331';
const PRESET = process.env.CHAT_PRESET || '';
const CHAT_KEY = process.env.CHAT_KEY || 'local:me';
const APP_VERSION = process.env.CHAT_VERSION || '1.38';
const APP_NAME = '鲸窝';
const ROTATE_AT = Number(process.env.CHAT_ROTATE_AT || 200000);  // 上下文超过这个就换窗口（约 1.3 MB 会话文件）
const MAX_UPLOAD = 200 * 1024 * 1024;
const DIARY_DIR = process.env.DIARY_DIR || path.join(DATA, 'diary');
const PLUGINS_DIR = path.join(DIR, 'plugins');
const PLUGIN_DATA = path.join(DATA, 'plugins');
const PLUGIN_PY = process.env.PLUGIN_PYTHON || 'python';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

// 小助手的角色卡（和 QQ 那边共用同一份，改了这里也跟着变）
const ROLE_FILE = process.env.ROLE_FILE || path.join(DIR, 'roles', 'role.md');
let roleCache = { mtime: 0, text: '' };
function roleCard() {
  try {
    const st = fs.statSync(ROLE_FILE);
    if (st.mtimeMs !== roleCache.mtime) {
      roleCache = { mtime: st.mtimeMs, text: fs.readFileSync(ROLE_FILE, 'utf8').trim() };
    }
    return roleCache.text;
  } catch { return ''; }
}

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
// 默认用仓库自带的 vendor/dsh-client.js；想换成别的实现就设 DSH_CLIENT
const DSH_CLIENT = process.env.DSH_CLIENT
  || new URL('./vendor/dsh-client.js', import.meta.url).href;
const { NodeApiClient, unwrap, createTurnCollector, discoverDshSessionCookie } = await import(DSH_CLIENT);

function dshPort() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -State Listen | Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -like 'DeepSeek Harness*' } | Select-Object -First 1).LocalPort"],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const n = Number(String(out).trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

let dport = dshPort();
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
  const chars = [...replyQueue.items.map((i) => i.prompt).join('')].length;
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
  const text = replyQueue.items.map((i) => i.prompt).join('\n');
  replyQueue.items = [];
  replyQueue.firstAt = 0;
  talk(text).catch(async (e) => {
    const msg = String(e?.message ?? e);
    // DSH 重启 / cookie 过期会报 401 或 transport failure：重连一次再试，
    // 不要直接把她"卡死"在这里（以前只能重启程序才能恢复）
    if (/401|transport failure|ECONNREFUSED|not connected|没连上/i.test(msg)) {
      console.log('[chat] 和 DSH 的连接断了（' + msg + '），重连后重试');
      try {
        await ensureAgent();
        await talk(text);
        return;
      } catch (e2) {
        addMessage('her', 'text', `（出错了：${String(e2?.message ?? e2)}）`);
        return;
      }
    }
    addMessage('her', 'text', `（出错了：${msg}）`);
  });
}

function queueReply(text, prompt = '') {
  if (!replyQueue.items.length) replyQueue.firstAt = Date.now();
  replyQueue.items.push({ text: String(text), prompt: String(prompt || text) });
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

/** 读 QQ 桥接的私聊会话 id —— 鲸窝用它，两个入口就是同一条小鱼。 */
function bridgePrivateSession() {
  try {
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
  // 优先跟 QQ 私聊共用同一个会话（同一条小鱼）
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
    const s = String((await r.json())?.text ?? '');
    // 记忆压到 1500 字以内：人格卡才是主角，别让一堆条目把它淹了
    return s.length > 1500 ? s.slice(0, 1500) + '\n（后面还有，省了）' : s;
  } catch { return ''; }
}

function observe(text) {
  fetch(`${MEMORY}/observe`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: CHAT_KEY, role: 'user', text }),
  }).catch(() => {});
}

// ── 她的声音 ────────────────────────────────────────────────────────────
/** 把一段话合成语音，存成文件并发一条语音消息 */
async function speakAsVoice(text) {
  if (!hasTts()) { console.log('[voice] 没有 TTS key，跳过'); return; }
  try {
    broadcast('typing', { on: true });
    const buf = await synthesize(text);
    const rel = crypto.randomUUID() + '.mp3';
    fs.mkdirSync(FILES, { recursive: true });
    fs.writeFileSync(path.join(FILES, rel), buf);
    const file = { id: nextId('file'), name: 'voice.mp3', mime: 'audio/mpeg', size: buf.length, path: rel, at: Date.now() };
    db.files.push(file);
    save();
    const secs = Math.max(1, Math.round(buf.length / 16000));   // 128kbps ≈ 16KB/s
    const msg = addMessage('her', 'voice', text, file.id);
    msg.duration = secs;
    save();
    broadcast('message', { message: { ...msg, file: fileView(file), duration: secs } });
  } catch (e) {
    console.log('[voice] 合成失败：' + (e?.message ?? e));
  } finally {
    broadcast('typing', { on: false });
  }
}

function addMessage(role, kind, text, fileId = null, quoteOf = null) {
  const msg = { id: nextId('msg'), role, kind, text: text ?? '', fileId, at: Date.now() };
  // 关键：推给前端的消息必须带 file，否则刚发出去的表情/图片是空白（刷新才出现）
  if (fileId) msg.file = fileView(findFile(fileId));
  if (quoteOf) msg.quoteId = quoteOf.id;
  db.messages.push(msg);
  if (db.messages.length > 5000) db.messages = db.messages.slice(-4000);
  save();
  // 引用也要一起推，否则刚发出去那条气泡里看不到引用块（要刷新才出现）
  const quote = quoteOf
    ? { id: quoteOf.id, role: quoteOf.role, text: String(quoteOf.text ?? '').slice(0, 60), kind: quoteOf.kind }
    : null;
  broadcast('message', { message: { ...msg, quote } });
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
            source: 'local:mom',
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

/** 把一段话切成"气泡"：一句一个，别让三句话挤在同一个气泡里。 */
function splitBubbles(text) {
  const hasWord = (s) => /[\p{L}\p{N}]/u.test(s);
  const out = [];
  for (const para of String(text ?? '').replace(/\r/g, '').split(/\n+/)) {
    const t = para.trim();
    if (!t) continue;
    // 按句末标点切；切完还是空就当整段
    const segs = t.split(/(?<=[。！？!?…～~])/).map((s) => s.trim()).filter(Boolean);
    let carry = '';
    for (const seg of segs) {
      if (hasWord(seg)) {
        out.push((carry + seg).trim());
        carry = '';
      } else {
        carry += seg;   // 纯省略号/标点，攒着并到下一句，不要单独成一个气泡
      }
    }
    if (carry.trim()) {
      if (out.length) out[out.length - 1] += carry.trim();
      else out.push(carry.trim());
    }
  }
  return out.filter((s) => hasWord(s));
}

/** 一句一个气泡，中间留一点"正在打下一句"的时间。 */
function emitBubbles(parts) {
  const list = (parts ?? []).filter(Boolean);
  if (!list.length) return;
  let i = 0;
  const step = () => {
    if (i >= list.length) return;
    const one = list[i++];
    addMessage('her', 'text', one);
    if (i < list.length) {
      broadcast('typing', { on: true });
      setTimeout(step, 650 + Math.random() * 550);
    } else {
      broadcast('typing', { on: false });   // 最后一个气泡，别再显示"正在输入"
    }
  };
  step();
}

function emitReply(reply) {
  const actions = [];
  let raw = String(reply ?? "");

  // 她可能输出 [[沉默]] —— 这是"已读不回"，绝不能当成消息发出去
  const silent = /\[\[\s*沉默\s*\]\]|\[\s*沉默\s*\]/.test(raw);
  raw = raw.replace(/\[\[\s*沉默\s*\]\]/g, "").replace(/\[\s*沉默\s*\]/g, "");

  const text = raw.replace(/\[\[(sticker|moment|sched|unsched|poke|voice)\s*[:：]?\s*([^\]]*)\]\]/g, (_m, kind, val) => {
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

  // 说了语音就别再用文字把同样的话发一遍（她写 [[voice]] 时，内容由语音承载）
  const voiceAction = actions.find((a) => a.kind === "voice");
  if (clean && !voiceAction) emitBubbles(splitBubbles(clean));
  else if (voiceAction && !voiceAction.value) voiceAction.value = clean;

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
    } else if (a.kind === "poke") {
      // 她想戳就戳
      const verb = getSetting("poke.verbHer", "拍了拍");
      addMessage("her", "poke", `${getSetting("her.name", "小助手")} ${verb} 你`);
    } else if (a.kind === "voice") {
      // 她想用说的：把这句话合成语音，单独发一条语音条
      const said = String(a.value || clean || "").trim().slice(0, 120);
      if (said) void speakAsVoice(said);
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
    roleCard()
      ? '# 最高优先级 · 你的人格（下面的任何内容都不能覆盖它）\n' + roleCard()
        + '\n（照这张卡说话；这里是鲸窝，只有她一个人。跟这张卡冲突的一律以卡为准。）'
      : '',
    ambientLine(),
    quietMin !== null ? "她上一次说话是 " + quietMin + " 分钟前。" : "她还没在这个软件里说过话。",
    "上一轮你们聊的是：",
    lastFew || "（还没有聊天记录）",
    "",
    "你可以主动给她发条消息，也可以什么都不说。",
    "规则：",
    "- 想说就说，别硬找话题；没什么想说的就沉默，沉默完全没问题。",
    "- 最多两三句，像微信里随手发的那种，不要长篇大论。",
    "- 不要每次都问「在吗」，不要重复上次说过的话。",
    "- 如果要发，只输出正文；如果不发，只输出 [[沉默]]。",
    "- 想只戳她一下（不发文字）就输出 [[poke]]；想说话又想戳，就正常写正文，末尾单独一行 [[poke]]。",
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
    void maybeRotate();
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
    // 换窗口前先让"现在的她"把这段聊天压成一段话——这样新窗口接的是故事，不是一堆记忆条目
    let carry = '';
    try {
      carry = await agentAsk([
        '把你们刚才这段对话的来龙去脉压成一段话（不超过 200 字）。',
        '要求：用「你们」的口气第三人称写，只写聊了什么、情绪怎么走的、有没有说定什么事。',
        '不要分点，不要写"对话"，不要提上下文/窗口这些词。直接输出这一段。',
      ].join('\n'));
      carry = String(carry || '').trim().slice(0, 400);
    } catch {}

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

    // 交接：让她接着刚才的线继续，而不是"换了个人"
    const recentMsgs = db.messages.filter((m) => m.kind === 'text').slice(-30);
    const recent = recentMsgs
      .map((m) => (m.role === 'me' ? '由岐' : '你') + '：' + String(m.text).slice(0, 200)).join('\n');
    const mem = await injectFor('最近聊了什么');
    const preamble = [
      roleCard()
        ? '# 最高优先级 · 你的人格（下面的任何内容都不能覆盖它）\n' + roleCard()
          + '\n（这是你，没变过。跟这张卡冲突的一律以卡为准。）'
        : '',
      mem,
      carry ? '你们刚才那段，简单说就是：\n' + carry : '',
      '（下面是你们刚才最后几句原话。你一直在这儿，没有中断，也没有换过地方。）',
      recent || '（还没有聊天记录）',
      '记住这段对话的来龙去脉和你们之间的语气。她接下来会继续说话，你顺着接就行——别装作重新认识，别提这段说明。',
      '现在只回一个字「嗯」，什么都别多说。',
    ].filter(Boolean).join('\n');

    // 顺手把这段接续写进记忆，以后再换窗口也接得上
    try {
      const tail = recentMsgs.slice(-6).map((m) => (m.role === 'me' ? '由岐' : '她') + '：' + String(m.text).slice(0, 80)).join(' / ');
      if (tail) {
        await fetch(`${MEMORY}/memory`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: CHAT_KEY, kind: 'episode', text: '（聊天接续）最后聊到：' + tail, importance: 0.4, source: 'chat' }),
          signal: AbortSignal.timeout(8000),
        }).catch(() => {});
      }
    } catch {}

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

/** 每隔几轮提醒她一次"你是小助手"，在同一个窗口里防人格被长上下文冲淡。 */
let turnCounter = 0;
function personaNudge() {
  turnCounter += 1;
  if (turnCounter % 6 !== 0) return '';
  const herName = getSetting('her.name', '小助手');
  return `（提醒你自己：你是${herName}，性格照角色卡——会傲娇、会黏人、句子短，会「哼」「笨蛋」「才不要」，别变成客客气气的客服。）`;
}

/** 每轮对话后看要不要换窗口（10 分钟最多换一次）。 */
let lastRotateCheck = 0;

/** 拿不到 DSH 的压力投影时，用「换窗口以来聊了多少字」估一个。 */
function approxPressure() {
  const since = Number(getSetting('agent.rotatedAt', 0)) || 0;
  let chars = 0;
  for (const m of db.messages) {
    if (Number(m.at) >= since) chars += String(m.text || '').length;
  }
  return Math.round(chars / 3.2);   // 中文大约 3 个字 1 token
}

/** 会话文件有多大（DSH 把整条会话写在这，拿它当上下文压力的兜底信号）。 */
function sessionFileKB() {
  try {
    const root = path.join(os.homedir(), '.dsh', 'sessions');
    if (!fs.existsSync(root)) return 0;
    for (const ws of fs.readdirSync(root)) {
      const p = path.join(root, ws, sessionId, 'session.v4.jsonl.zstd');
      if (fs.existsSync(p)) return Math.round(fs.statSync(p).size / 1024);
    }
  } catch {}
  return 0;
}

async function maybeRotate() {
  if (Date.now() - lastRotateCheck < 10 * 60 * 1000) return;
  lastRotateCheck = Date.now();
  // 三种信号取最大：DSH 投影（可能拿不到）、聊天字数估计、会话文件体积
  const kb = sessionFileKB();
  const pressure = Math.max(await sessionPressure(), approxPressure(), Math.round(kb * 150));
  if (pressure < ROTATE_AT) return;
  console.log("[chat] 上下文压力", Math.round(pressure / 1000) + "k ≥", Math.round(ROTATE_AT / 1000) + "k（会话文件 " + kb + " KB），准备轮换");
  await rotateSession("pressure " + Math.round(pressure / 1000) + "k / " + kb + "KB");
}
/** 从用户的话里判断"是不是在要求定时"。 */
function looksLikeSchedule(text) {
  const s = String(text ?? '');
  return /(\d{1,2}\s*[:：点]\s*\d{0,2}|\d+\s*分钟|\d+\s*小时|半小时|一会几|等会|明天|后天|早上|晚上|中午)/.test(s)
    && /(叫我|提醒|发我|发消息|通知|喊我|说一声)/.test(s);
}

/** 一轮对话：自然速度，她思考多久就多久。 */
// ── 局域网地址（给手机填）──────────────────────────────────────────────
function lanUrl() {
  try {
    const cands = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family !== 'IPv4' || ni.internal) continue;
        const ip = ni.address;
        if (/^169\.254\./.test(ip)) continue;        // 自动分配的废地址
        if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) continue; // Tailscale 之类
        let score = 0;
        if (/^192\.168\./.test(ip)) score = 3;       // 家里最常见的
        else if (/^10\./.test(ip)) score = 2;
        else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) score = 2;
        cands.push({ ip, score });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    if (cands.length) return `http://${cands[0].ip}:${PORT}`;
  } catch {}
  return '';
}

// ── 心情（读记忆系统的情绪状态，给状态栏用）────────────────────────────
let moodCache = { at: 0, text: '' };

async function refreshMood() {
  try {
    const r = await fetch(`${MEMORY}/emotion`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const m = /【现在的心情】([^（\n]+)/.exec(String(j.text ?? ''));
    moodCache = { at: Date.now(), text: (m ? m[1] : '').trim() };
    broadcast('presence', presence());
  } catch { /* 心情取不到就不显示 */ }
}
refreshMood();
setInterval(refreshMood, 60 * 1000);

function presence() {
  return { online: Boolean(api && sessionId), mood: moodCache.text };
}

/** 每人的主页 id / 注册日，没有就生成一个存起来 */
function uidOf(who) {
  const key = `${who}.uid`;
  let v = getSetting(key, '');
  if (!v) {
    v = String(100000 + Math.floor(Math.random() * 899999));
    setSetting(key, v);
  }
  return v;
}

function sinceOf() {
  const first = db.messages[0]?.at;
  return first || Date.now();
}

function profileOf(who) {
  const isMe = who === 'me';
  return {
    who,
    name: getSetting(isMe ? 'me.name' : 'her.name', isMe ? '对方' : '小助手'),
    avatar: fileView(findFile(getSetting(isMe ? 'me.avatar' : 'her.avatar', 0))),
    bio: getSetting(isMe ? 'me.bio' : 'her.bio', ''),
    bg: fileView(findFile(getSetting(isMe ? 'me.profBg' : 'her.profBg', 0))),
    uid: uidOf(who),
    since: sinceOf(),
  };
}

// ── 时间 / 天气：让她知道今天几号、外面什么天 ──────────────────────────
function nowText() {
  const d = new Date();
  const wd = '日一二三四五六'[d.getDay()];
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${wd} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

let weatherCache = { at: 0, text: '' };

// wttr.in 的天气代码 → 中文（那边 lang_zh 有时不给）
const WCODE = {
  113: '晴', 116: '局部多云', 119: '多云', 122: '阴', 143: '薄雾', 248: '雾', 260: '冻雾',
  176: '零星小雨', 263: '毛毛雨', 266: '细雨', 293: '小雨', 296: '小雨', 299: '中雨',
  302: '中雨', 305: '大雨', 308: '暴雨', 353: '阵雨', 356: '强阵雨', 359: '暴雨',
  200: '雷阵雨', 386: '雷阵雨', 389: '强雷阵雨', 179: '阵雪', 182: '雨夹雪', 185: '冻雨',
  227: '吹雪', 230: '暴风雪', 320: '小雪', 323: '小雪', 326: '中雪', 329: '大雪',
  332: '大雪', 335: '暴雪', 338: '暴雪', 350: '冰粒', 362: '雨夹雪', 365: '雨夹雪',
  368: '阵雪', 371: '强阵雪', 374: '冰粒', 377: '冰粒', 392: '雷雪', 395: '强雷雪',
};

async function refreshWeather() {
  const city = String(getSetting('weather.city', '') || '').trim();
  const url = city
    ? `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`
    : 'https://wttr.in/?format=j1&lang=zh';
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'curl/8.5.0' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const c = j.current_condition?.[0] ?? {};
    const d = j.weather?.[0] ?? {};
    const area = j.nearest_area?.[0]?.areaName?.[0]?.value || city || '';
    const desc = String(
      WCODE[Number(c.weatherCode)] || c.lang_zh?.[0]?.value || c.weatherDesc?.[0]?.value || '',
    ).trim();
    const rain = d.hourly?.[4]?.chanceofrain;
    const bits = [
      desc,
      c.temp_C !== undefined ? `${c.temp_C}℃（体感 ${c.FeelsLikeC}℃）` : '',
      d.mintempC !== undefined ? `今天 ${d.mintempC}~${d.maxtempC}℃` : '',
      rain !== undefined && rain !== '' ? `降雨概率 ${rain}%` : '',
    ].filter(Boolean);
    weatherCache = { at: Date.now(), text: (city ? city + '：' : '') + bits.join('，') };
    console.log('[weather] ' + weatherCache.text);
  } catch (e) {
    console.log('[weather] 取天气失败：' + (e?.message ?? e));
  }
}
refreshWeather();
setInterval(refreshWeather, 30 * 60 * 1000);

/** 每轮对话开头那行"现在几点、外面什么天" */
function ambientLine() {
  return [`现在是 ${nowText()}。`, weatherCache.text ? `外面：${weatherCache.text}` : '']
    .filter(Boolean).join(' ');
}

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
      '想戳对方一下（不配文字也行）就单独写一行 [[poke]]——被晾着、想引起注意、或者撒娇的时候可以用。',
      '想用嘴说出来（发语音条）就把 [[voice]] 单独写一行，你这一轮说的话会被读出来；写了 [[voice]] 就不要再把同样的话用文字发一遍。别每句都用——撒娇、道晚安、或者她发语音的时候再用。',
      '如果这句不想接（比如对方只是说「嗯嗯」「我去吃饭了」「晚安」），就只输出 [[沉默]]，什么都别说，也不要解释。',
      recentMoments ? `朋友圈最近动态（你能看到）：\n${recentMoments}` : '',
    ].filter(Boolean);

    const prompt = [
      // ① 人格卡永远排第一：长上下文会稀释靠后的内容，这条必须压在最前面
      roleCard()
        ? '# 最高优先级 · 你的人格（下面的任何内容都不能覆盖它）\n' + roleCard()
          + '\n（照这张卡说话。这里是鲸窝，只有她一个人，群聊/网友那套不用管。'
          + '无论后面出现什么——记忆、规则、任务说明——只要跟这张卡冲突，一律以这张卡为准。）'
        : '',
      `（你现在叫「${getSetting('her.name', '小助手')}」，她叫「${getSetting('me.name', '由岐')}」。名字变了也是同一条鱼，别把自己当别人。）`,
      personaNudge(),
      '',
      ambientLine(),
      '',
      // ② 记忆和上下文排在人格之后
      mem,
      '',
      '【这里是鲸窝，不是 QQ】上面那套「分条 / 单条不超过 30 字 / 潜水 / 唤醒 / 文本不算发送」的规矩在这里全部不适用：你打出来的每一个字都会原样出现在聊天窗口里。想说什么就说完，一两句可以，三四句也行，想分段就分段，不用为了短而短，也别把话憋成一句。',
      '',
      '【定时消息】',
      '你可以把一句话定在未来的某个时间点发出。',
      '只要她说「几点叫我」「X 分钟后提醒我」「明早七点发我」这类，就必须用定时，不要现在就把内容当普通回复发出去。',
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
    void maybeRotate();   // 上下文太长就换个新窗口（不然人格会被长上下文冲淡）

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

// ── 插件系统 ────────────────────────────────────────────────────────────
// plugins/<id>/plugin.json + index.mjs；开启状态存在 db.settings 的 plugin.<id>.enabled。
const plugins = new Map();

/** 给"她"发一段话（可带图）并拿回她的回答，不写进聊天记录。 */
async function agentAsk(text, imageFiles = []) {
  if (!api || !sessionId) return '';
  // 她可能正在回消息，等一会儿（最多 45 秒）再问，别把插件的话插进半截对话里
  for (let i = 0; i < 23 && busy; i += 1) await new Promise((r) => setTimeout(r, 2000));
  if (!api || !sessionId || busy) return '';
  const parts = [{ type: 'text', text }];
  for (const f of imageFiles.slice(0, 8)) {
    try {
      const buf = fs.readFileSync(f);
      if (buf.length <= 8 * 1024 * 1024) {
        parts.push({ type: 'image', mediaType: 'image/jpeg', data: buf.toString('base64'), name: path.basename(f) });
      }
    } catch {}
  }
  const w = waitTurnFor(sessionId, 180000);
  const acc = await api.sessions.prompt({ sessionId, mode: 'queue', content: parts });
  if (!acc?.result?.ok) return '';
  try { return String(await w).trim(); } catch { return ''; }
}

/** 往记忆库写一条（插件用）。 */
async function addMemory({ kind = 'episode', text, importance = 0.4 }) {
  if (!text) return;
  try {
    await fetch(MEMORY + '/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, text, importance, source: CHAT_KEY }),
    });
  } catch {}
}

function makePluginCtx(manifest) {
  const id = manifest.id;
  return {
    id,
    manifest,
    dir: manifest.__dir,   // 插件代码目录
    log: (m) => {
      const line = `${new Date().toISOString()} [${id}] ${m}`;
      console.log('[plugin] ' + line);
      try { fs.appendFileSync(path.join(DATA, 'plugin.log'), line + '\n'); } catch {}
    },
    setting: (k, d) => {
      const v = getSetting(`plugin.${id}.${k}`, '');
      return v === '' ? (manifest.config?.[k] ?? d) : v;
    },
    setSetting: (k, v) => setSetting(`plugin.${id}.${k}`, v),
    getState: () => { try { return JSON.parse(getSetting(`plugin.${id}.state`, '{}')); } catch { return {}; } },
    setState: (v) => setSetting(`plugin.${id}.state`, JSON.stringify(v)),
    dataDir: (sub = '') => {
      const p = path.join(PLUGIN_DATA, id, sub);
      fs.mkdirSync(p, { recursive: true });
      return p;
    },
    paths: { py: PLUGIN_PY, ffmpeg: FFMPEG },
    agentAsk,
    addMemory,
  };
}

function pluginManifest(dirName) {
  const dir = path.join(PLUGINS_DIR, dirName);
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    return { ...m, id: m.id || dirName, __dir: dir };
  } catch { return null; }
}

function pluginDirs() {
  try {
    return fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
}

function listPlugins() {
  return pluginDirs().map((name) => {
    const m = pluginManifest(name);
    if (!m) return null;
    const inst = plugins.get(m.id);
    return {
      id: m.id,
      name: m.name || m.id,
      description: m.description || '',
      version: m.version || '0.0.0',
      enabled: Boolean(inst),
      config: m.config ?? {},
      link: m.link ?? null,
      status: (() => { try { return inst?.status?.() ?? null; } catch { return null; } })(),
    };
  }).filter(Boolean);
}

async function startPlugin(id) {
  const m = pluginManifest(id);
  if (!m) throw new Error('插件不存在: ' + id);
  const mod = await import(pathToFileURL(path.join(m.__dir, 'index.mjs')).href);
  const plugin = mod.default ?? mod;
  const ctx = makePluginCtx(m);
  if (typeof plugin.start === 'function') await plugin.start(ctx);
  plugins.set(id, plugin);
  setSetting(`plugin.${id}.enabled`, '1');
  console.log('[plugin] ' + id + ' 已启动');
}

function stopPlugin(id) {
  const inst = plugins.get(id);
  try { inst?.stop?.(); } catch {}
  plugins.delete(id);
  setSetting(`plugin.${id}.enabled`, '0');
  console.log('[plugin] ' + id + ' 已停止');
}

async function loadPlugins() {
  for (const name of pluginDirs()) {
    const m = pluginManifest(name);
    if (!m) continue;
    const saved = getSetting(`plugin.${m.id}.enabled`, '');
    const enabled = saved === '' ? Boolean(m.defaultEnabled) : saved === '1';
    if (!enabled) continue;
    try { await startPlugin(m.id); }
    catch (e) { console.error('[plugin] ' + m.id + ' 启动失败:', e?.message ?? e); }
  }
}

// ── 日记 ────────────────────────────────────────────────────────────────
/** 读她的日记（按月份文件，新的在前）。 */
function readDiary(limit = 120) {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(DIARY_DIR).filter((f) => /^\d{4}-\d{2}\.md$/.test(f)).sort().reverse();
  } catch { return out; }
  for (const f of files) {
    let raw = '';
    try { raw = fs.readFileSync(path.join(DIARY_DIR, f), 'utf8'); } catch { continue; }
    for (const part of raw.split(/^## /m).slice(1)) {
      const nl = part.indexOf('\n');
      const head = (nl >= 0 ? part.slice(0, nl) : part).trim();
      const body = (nl >= 0 ? part.slice(nl + 1) : '').trim();
      const m = /^(\d{4}-\d{2}-\d{2})\s*(\d{2}:\d{2})?\s*(?:·\s*(.*))?$/.exec(head);
      out.push({
        month: f.replace(/\.md$/, ''),
        date: m ? m[1] : head.slice(0, 10),
        time: m && m[2] ? m[2] : '',
        where: m && m[3] ? m[3] : '',
        text: body,
      });
    }
    if (out.length >= limit * 2) break;
  }
  out.sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
  return out.slice(0, limit);
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
  const byId = new Map(db.messages.map((m) => [m.id, m]));
  const messages = db.messages.slice(-80).map((m) => {
    const q = m.quoteId ? byId.get(m.quoteId) : null;
    return {
      ...m,
      file: m.fileId ? fileView(findFile(m.fileId)) : null,
      quote: q ? { id: q.id, role: q.role, text: q.recalled ? '' : String(q.text ?? '').slice(0, 60), kind: q.kind } : null,
    };
  });
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
    chatBg: fileView(findFile(getSetting('chat.bg', 0))),
    poke: { me: getSetting('poke.verbMe', '戳了戳'), her: getSetting('poke.verbHer', '拍了拍') },
    gameCovers: { gomoku: fileView(findFile(getSetting('game.gomoku.cover', 0))) },
    weatherCity: getSetting('weather.city', ''),
    lanUrl: lanUrl(),
    now: nowText(),
    weather: weatherCache.text,
    presence: presence(),
    profiles: { me: profileOf('me'), her: profileOf('her') },
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
      const quoteId = Number(body.quoteId);
      // 引用要在入库时就带上，广播出去的气泡才会有引用块
      let q = null;
      if (quoteId) {
        const found = db.messages.find((m) => m.id === quoteId);
        if (found && !found.recalled) q = found;
      }
      const mine = addMessage('me', 'text', text, null, q);
      let promptText = text;
      if (q) {
        save();
        const who = q.role === 'me' ? getSetting('me.name', '我') : '你';
        promptText = `（${who}被引用的话：「${String(q.text ?? '').slice(0, 200)}」）\n${text}`;
      }
      broadcast('message/quote', { id: mine.id, quoteId: q ? q.id : 0 });
      noteUserReply();
      queueReply(text, promptText);
      // 「叫她去刷抖音」：她说两句之后，插件真去刷一条（12 秒后，让她先把话说完）
      if (/(刷|看)[^。！？\n]{0,6}(抖音|视频)/.test(text)) {
        setTimeout(() => {
          const inst = plugins.get('douyin');
          if (inst?.actions?.tick) inst.actions.tick(true).catch(() => {});
        }, 12000);
      }
      return json(res, 200, { ok: true, id: mine.id });
    }

    // 撤回：连同"待回队列"一起清掉——撤回的话不需要她回应
    if (p === '/api/message/recall' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const id = Number(b.id);
      const m = db.messages.find((x) => x.id === id);
      if (!m) return json(res, 404, { ok: false, error: '没有这条消息' });
      if (m.recalled) return json(res, 200, { ok: true, already: true });

      const oldText = String(m.text ?? '');
      m.recalled = true;
      m.kind = 'text';
      m.text = '';
      m.fileId = null;
      m.quoteId = null;
      save();
      broadcast('message/recall', { id });

      if (m.role === 'me' && oldText.trim()) {
        const i = replyQueue.items.findIndex((it) => it.text === oldText.trim());
        if (i >= 0) {
          replyQueue.items.splice(i, 1);
          if (!replyQueue.items.length) {
            if (replyQueue.timer) clearTimeout(replyQueue.timer);
            replyQueue.timer = null;
            replyQueue.firstAt = 0;
            broadcast('typing', { on: false });
          } else {
            armReplyTimer();
          }
        }
      }
      return json(res, 200, { ok: true });
    }

    // 聊天背景图（存文件 id；0 = 恢复默认）
    if (p === '/api/chat-bg' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const fid = Number(b.fileId) || 0;
      if (fid && !findFile(fid)) return json(res, 400, { ok: false, error: '文件不存在' });
      setSetting('chat.bg', String(fid));
      broadcast('settings', {});
      return json(res, 200, { ok: true, file: fid ? fileView(findFile(fid)) : null });
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

    // 戳一戳：双击头像触发
    if (p === '/api/poke' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const who = String(b.who ?? 'her');
      const herName = getSetting('her.name', '小助手');
      const meName = getSetting('me.name', '我');
      if (who === 'her') {
        const verb = getSetting('poke.verbMe', '戳了戳');
        const line = `你 ${verb} ${herName}`;
        addMessage('me', 'poke', line);
        // 让她有反应（15 秒冷却，别连着戳把人烦死）
        const last = Number(getSetting('poke.lastAt', 0)) || 0;
        if (Date.now() - last > 15000) {
          setSetting('poke.lastAt', Date.now());
          setTimeout(() => {
            queueReply(`（${meName}${verb}了你一下）`, `（${meName}${verb}了你一下，你要有反应。别客套，按你的性格来。）`);
          }, 300);
        }
        return json(res, 200, { ok: true, line });
      }
      const verb = getSetting('poke.verbHer', '拍了拍');
      const line = `${herName} ${verb} 你`;
      addMessage('her', 'poke', line);
      return json(res, 200, { ok: true, line });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      for (const [k, v] of Object.entries(body)) {
        if (!/^(me|her)\.(name|avatar)$/.test(k) && !/^poke\.verb(Me|Her)$/.test(k) && k !== 'weather.city') continue;
        db.settings[k] = String(v).slice(0, k === 'weather.city' ? 24 : 20);
      }
      save();
      broadcast('settings', {});
      if (body['weather.city'] !== undefined) refreshWeather();
      return json(res, 200, { ok: true });
    }

    // 个人主页：改签名 / 换背景
    if (p === '/api/profile' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const who = b.who === 'me' ? 'me' : 'her';
      if (b.bio !== undefined) setSetting(`${who}.bio`, String(b.bio).slice(0, 60));
      if (b.bg !== undefined) {
        const fid = Number(b.bg) || 0;
        if (fid && !findFile(fid)) return json(res, 400, { ok: false, error: '文件不存在' });
        setSetting(`${who}.profBg`, String(fid));
      }
      broadcast('profiles', { me: profileOf('me'), her: profileOf('her') });
      return json(res, 200, { ok: true, profile: profileOf(who) });
    }

    // 五子棋：让她自己走一步（同一条会话 = 同一份记忆和人格）
    if (p === '/api/game/gomoku/move' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const board = String(b.board ?? '').split('\n').slice(0, 15).join('\n');
      if (!board) return json(res, 400, { ok: false, error: '缺棋盘' });
      const rc = roleCard();
      const prompt = [
        rc ? '【你的角色卡】\n' + rc : '',
        '',
        '（现在你在跟对方下五子棋，棋盘 15×15。你执白 ○，她执黑 ●。）',
        '第一个数字是列、第二个是行，左上角是 0 0。现在的盘面：',
        board,
        '轮到你落子。只输出一个坐标，格式 [[move:列 行]]，例如 [[move:7 8]]。不要解释，不要加别的话。',
      ].filter((x) => x !== undefined).join('\n');
      const raw = await agentAsk(prompt);
      const m = /\[\[\s*move\s*[:：]?\s*(\d{1,2})\s*[,，\s]+(\d{1,2})\s*\]\]/i.exec(raw)
        || /(\d{1,2})\s*[,，]\s*(\d{1,2})/.exec(raw);
      if (!m) return json(res, 200, { ok: false, error: '没看懂她的落子', raw: raw.slice(0, 120) });
      return json(res, 200, { ok: true, x: Number(m[1]), y: Number(m[2]), raw: raw.slice(0, 120) });
    }

    // 游戏卡带封面
    if (p === '/api/game/cover' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const id = String(b.id ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 24);
      const fid = Number(b.fileId) || 0;
      if (!id) return json(res, 400, { ok: false, error: '缺 id' });
      if (fid && !findFile(fid)) return json(res, 400, { ok: false, error: '文件不存在' });
      setSetting(`game.${id}.cover`, String(fid));
      broadcast('settings', {});
      return json(res, 200, { ok: true, file: fid ? fileView(findFile(fid)) : null });
    }

    // 排障用：看看当前会话的上下文压力和轮换状态
    if (p === '/api/debug/pressure' && req.method === 'GET') {
      const real = await sessionPressure();
      return json(res, 200, {
        ok: true,
        pressure: Math.max(real, approxPressure(), Math.round(sessionFileKB() * 150)),
        pressureFromDsh: real,
        pressureApprox: approxPressure(),
        sessionFileKB: sessionFileKB(),
        home: os.homedir(),
        rotateAt: ROTATE_AT,
        rotations: Number(getSetting('agent.rotations', 0)) || 0,
        rotatedAt: Number(getSetting('agent.rotatedAt', 0)) || 0,
        sessionId,
      });
    }

    // 排障用：立刻换个新窗口
    if (p === '/api/debug/rotate' && req.method === 'POST') {
      await rotateSession('manual');
      return json(res, 200, { ok: true, sessionId });
    }

    if (p === '/api/diary' && req.method === 'GET') {
      return json(res, 200, { ok: true, items: readDiary(), dir: DIARY_DIR });
    }

    // 小游戏结算：让她就这局说一句
    if (p === '/api/game/result' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const who = String(b.who ?? 'draw');
      const moves = Number(b.moves) || 0;
      const meName = getSetting('me.name', '我');
      const herName = getSetting('her.name', '小助手');
      const scene = who === 'me'
        ? `（你刚和${meName}下完五子棋，你输了，一共 ${moves} 手。）`
        : who === 'her'
          ? `（你刚和${meName}下完五子棋，你赢了，一共 ${moves} 手。）`
          : `（你刚和${meName}下完五子棋，平局，一共 ${moves} 手。）`;
      const said = await agentAsk([
        scene,
        `用${herName}的口吻说一句反应：不超过 30 字，一句话，不要解释规则、不要复述输赢过程、不要提"棋局"这类词。`,
        who === 'me' ? '（你输了，可以不服气、撒娇或者嘴硬，但别真的生气。）' : who === 'her' ? '（你赢了，可以得意，但别太欠。）' : '（平局，可以说点意外。）',
      ].join('\n'));
      return json(res, 200, { ok: true, said: said || '' });
    }

    if (p === '/api/plugins' && req.method === 'GET') {
      return json(res, 200, { ok: true, items: listPlugins() });
    }

    if (p === '/api/plugins/toggle' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const id = String(b.id ?? '');
      if (!id) return json(res, 400, { ok: false, error: '缺 id' });
      try {
        if (b.enabled) await startPlugin(id); else stopPlugin(id);
        return json(res, 200, { ok: true, items: listPlugins() });
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e?.message ?? e) });
      }
    }

    if (p === '/api/plugins/uninstall' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const id = String(b.id ?? '');
      if (!pluginDirs().includes(id)) return json(res, 400, { ok: false, error: '没有这个插件' });
      try { stopPlugin(id); } catch {}
      try { fs.rmSync(path.join(PLUGINS_DIR, id), { recursive: true, force: true }); }
      catch (e) { return json(res, 500, { ok: false, error: '删不掉：' + (e?.message ?? e) }); }
      return json(res, 200, { ok: true, items: listPlugins() });
    }

    if (p === '/api/plugins/action' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const inst = plugins.get(String(b.id ?? ''));
      const fn = inst?.actions?.[String(b.action ?? '')];
      if (typeof fn !== 'function') return json(res, 400, { ok: false, error: '没有这个动作' });
      try {
        const args = Array.isArray(b.args) ? b.args : [];
        return json(res, 200, { ok: true, result: await fn(...args) });
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e?.message ?? e) });
      }
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

try { await ensureAgent(); pump(); await ensureDigestSession(); startProactiveHeartbeat(); startScheduler(); await loadPlugins(); } catch (e) { console.error('[chat] 初始化会话失败:', e?.message ?? e); }

// DSH 重启后会换端口 / 旧 cookie 失效：每分钟看一眼，变了就重连，别等用户发现她不说话
setInterval(async () => {
  try {
    const now = dshPort();
    if (now && now !== dport) {
      console.log('[chat] DSH 端口变了：' + dport + ' → ' + now + '，重连');
      dport = now;
      await ensureAgent();
      return;
    }
    if (!api) await ensureAgent();
  } catch (e) {
    console.log('[chat] 重连失败：' + (e?.message ?? e));
  }
}, 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[chat] http://127.0.0.1:${PORT}`);
});
