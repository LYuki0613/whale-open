// 记忆层 HTTP 服务（仅 127.0.0.1）。
//
// 设计原则：**失败开放**。桥接侧调用都带 300ms 超时，本服务挂掉/超时都只是
// 「这轮没有注入」，绝不影响聊天本身。
import http from 'node:http';
import { loadConfig, openDb, ensureDirs, now, CONFIG_FILE } from './db.mjs';
import fsx from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MINDSEA_PUBLIC = path.join(HERE, '..', 'mindsea', 'public');
import { remember, maintain } from './memory.mjs';
import { toFtsText } from './bigram.mjs';
import { search } from './scoring.mjs';
import { buildInjection } from './recall.mjs';
import { embedText, warmup, embedStatus } from './embed.mjs';
import { loadState, applyMessage, saveState, injectText } from './emotion.mjs';
import { addSample, computeStyle, cleanup } from './expression.mjs';
import { detectCorrection, applyCorrection, healthCheck, evaluate } from './feedback.mjs';
import { pickActivity, finishActivity, writeNote, decayInterests, seedInterests } from './life.mjs';
import { verify } from './persona-guard.mjs';
import { identity, touchChannel, shareDecision, recordShare, selfSnapshot } from './self.mjs';
import { getScene } from './mindsea.mjs';
import { transcribeFile, isAudio } from './transcribe.mjs';

let cfg = loadConfig();
ensureDirs(cfg);
const db = openDb(cfg);
seedInterests(db);
if (cfg.memory?.embed?.mode === 'onnx') warmup(cfg);

const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve({}); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    // 只接受本机回环
    const ra = req.socket.remoteAddress ?? '';
    if (!(ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1')) return send(res, 403, { ok: false, error: '仅允许本机访问' });

    // ── 记忆海（内置 3d-memory-sea，数据来自本库）─────────────────────
    if (p === '/api/scene' && req.method === 'GET') {
      try {
        return send(res, 200, getScene(db, cfg));
      } catch (error) {
        return send(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    }
    if (p === '/api/rebuild' && req.method === 'POST') {
      try {
        return send(res, 200, getScene(db, cfg, { rebuild: true }));
      } catch (error) {
        return send(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    }
    if (p === '/mindsea' || p === '/mindsea/' || p.startsWith('/mindsea/')) {
      const rel = p === '/mindsea' || p === '/mindsea/' ? 'index.html' : p.slice('/mindsea/'.length);
      const file = path.join(MINDSEA_PUBLIC, rel.replace(/\.\./g, ''));
      try {
        const body = fsx.readFileSync(file);
        const ext = path.extname(file).toLowerCase();
        const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' }[ext] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'content-length': body.length });
        return res.end(body);
      } catch {
        return send(res, 404, { ok: false, error: '记忆海页面不存在' });
      }
    }

    // ── 本体：她是唯一的，通道只是分体 ────────────────────────────────
    if (p === '/self' && req.method === 'GET') {
      return send(res, 200, { ok: true, ...selfSnapshot(db, cfg) });
    }
    if (p === '/self/channel' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, { ok: true, ...touchChannel(db, b) });
    }
    if (p === '/self/share-check' && (req.method === 'POST' || req.method === 'GET')) {
      const b = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
      return send(res, 200, { ok: true, ...shareDecision(db, cfg, now(), { force: b.force === true || b.force === 'true' }) });
    }
    // 本体：现在主动说一句（决定在本体，送达交给 QQ 分体）
    if (p === '/self/share' && req.method === 'POST') {
      const b = await readBody(req);
      const d = shareDecision(db, cfg, now(), { force: true });
      if (!d.ok) return send(res, 200, { ok: false, reason: d.reason, ...d });
      // 主动分享需要一个「投递端」：原作者用的是 QQ 桥接的本地控制台，
      // 开源版不绑定任何实现，配 config.self.shareUrl（或环境变量 SHARE_URL）即可，
      // 随便一个能接 POST 的服务都行。没配就明确拒绝，不要静默卡住。
      const shareUrl = cfg.self?.shareUrl || process.env.SHARE_URL;
      if (!shareUrl) return send(res, 200, { ok: false, reason: '没有配置投递端（config.self.shareUrl / SHARE_URL）' });
      let token = '';
      const tokenFile = cfg.self?.consoleTokenFile || process.env.SHARE_TOKEN_FILE;
      if (tokenFile) { try { token = fsx.readFileSync(tokenFile, 'utf8').trim(); } catch {} }
      try {
        const r = await fetch(shareUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-console-token': token },
          body: JSON.stringify({ material: b.material ?? d.material, mood: d.mood, dryRun: b.dryRun === true }),
        });
        const j = await r.json().catch(() => ({}));
        return send(res, 200, { ok: !!j.ok, ...j, decision: d.reason });
      } catch (error) {
        return send(res, 200, { ok: false, reason: '分体未连接：' + String(error?.message ?? error) });
      }
    }
    if (p === '/self/shares' && req.method === 'GET') {
      const rows = db.prepare('SELECT at, channel, text FROM share_log ORDER BY at DESC LIMIT 20').all();
      return send(res, 200, { ok: true, items: rows });
    }
    if (p === '/self/share-record' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, { ok: true, ...recordShare(db, cfg, { channel: b.channel ?? 'qq', text: b.text ?? '' }) });
    }

    // ── 供桌面 UI 使用的端点 ───────────────────────────────────────────
    if (p === '/config' && req.method === 'GET') {
      return send(res, 200, {
        ok: true,
        system: { enabled: cfg.system.enabled !== false, injectMaxChars: cfg.system.injectMaxChars },
        memory: { embed: { mode: cfg.memory.embed.mode }, write: { summarizeEveryMessages: cfg.memory.write.summarizeEveryMessages }, maintain: { mergeCosine: cfg.memory.maintain.mergeCosine } },
        emotion: { maxDeltaPerMessage: cfg.emotion.maxDeltaPerMessage },
        layers: {
          memory: cfg.memory?.enabled !== false, emotion: cfg.emotion?.enabled !== false,
          life: cfg.life?.enabled !== false, expression: cfg.expression?.enabled !== false,
          feedback: cfg.feedback?.enabled !== false,
        },
      });
    }
    if (p === '/config' && req.method === 'POST') {
      const patch = await readBody(req);
      const raw = JSON.parse(fsx.readFileSync(CONFIG_FILE, 'utf8'));
      // 只允许改这几组，防止 UI 误写任意字段
      if (patch.system?.enabled !== undefined) raw.system.enabled = !!patch.system.enabled;
      if (patch.system?.injectMaxChars !== undefined) raw.system.injectMaxChars = Number(patch.system.injectMaxChars) || 1200;
      if (patch.memory?.enabled !== undefined) raw.memory.enabled = !!patch.memory.enabled;
      if (patch.memory?.embed?.mode && ['onnx', 'off', 'http'].includes(patch.memory.embed.mode)) raw.memory.embed.mode = patch.memory.embed.mode;
      if (patch.memory?.write?.summarizeEveryMessages !== undefined) raw.memory.write.summarizeEveryMessages = Math.max(3, Number(patch.memory.write.summarizeEveryMessages) || 30);
      if (patch.memory?.maintain?.mergeCosine !== undefined) raw.memory.maintain.mergeCosine = Math.min(0.999, Math.max(0.5, Number(patch.memory.maintain.mergeCosine) || 0.92));
      if (patch.emotion?.enabled !== undefined) raw.emotion.enabled = !!patch.emotion.enabled;
      if (patch.emotion?.maxDeltaPerMessage !== undefined) raw.emotion.maxDeltaPerMessage = Math.min(1, Math.max(0.01, Number(patch.emotion.maxDeltaPerMessage) || 0.12));
      if (patch.expression?.enabled !== undefined) raw.expression.enabled = !!patch.expression.enabled;
      if (patch.feedback?.enabled !== undefined) raw.feedback.enabled = !!patch.feedback.enabled;
      if (patch.life?.enabled !== undefined) raw.life.enabled = !!patch.life.enabled;
      if (patch.layers && typeof patch.layers === 'object') {
        for (const [k, v] of Object.entries(patch.layers)) {
          if (['memory', 'emotion', 'life', 'expression', 'feedback'].includes(k) && raw[k]) raw[k].enabled = !!v;
        }
      }
      fsx.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n', 'utf8');
      cfg = loadConfig();
      return send(res, 200, { ok: true });
    }
    if (p === '/reload' && req.method === 'POST') {
      cfg = loadConfig();
      return send(res, 200, { ok: true, at: now() });
    }
    if (p === '/restart' && req.method === 'POST') {
      send(res, 200, { ok: true, note: '正在重启' });
      const cli = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'cli.mjs');
      setTimeout(() => {
        try {
          const child = spawn(process.execPath, [cli, 'serve'], { detached: true, stdio: 'ignore', cwd: path.dirname(cli) });
          child.unref();
        } catch {}
        process.exit(0);
      }, 400);
      return;
    }
    if (p === '/persona/verify') {
      const r = verify(cfg);
      return send(res, 200, r);
    }
    if (p === '/style') {
      const st = computeStyle(db, Number(cfg.expression?.style?.sampleSize ?? 300));
      const { styleInjectText } = await import('./expression.mjs');
      return send(res, 200, { ok: true, stats: st, text: st ? styleInjectText(st) : '' });
    }
    if (p === '/memory/list') {
      const n = Math.min(300, Math.max(1, Number(url.searchParams.get('n')) || 50));
      const kind = String(url.searchParams.get('kind') ?? '').trim();
      const rows = kind
        ? db.prepare("SELECT id,kind,text,importance,valence,status,created_at,mention_count FROM memories WHERE kind=? AND status IN ('active','conflict') ORDER BY created_at DESC LIMIT ?").all(kind, n)
        : db.prepare("SELECT id,kind,text,importance,valence,status,created_at,mention_count FROM memories WHERE status IN ('active','conflict') ORDER BY created_at DESC LIMIT ?").all(n);
      return send(res, 200, { ok: true, items: rows });
    }

    if (p === '/health') {
      const counts = Object.fromEntries(
        db.prepare("SELECT kind, COUNT(*) AS c FROM memories WHERE status IN ('active','conflict') GROUP BY kind").all().map((r) => [r.kind, r.c])
      );
      const pv = verify(cfg);
      return send(res, 200, {
        ok: true, enabled: cfg.system.enabled !== false, at: now(),
        counts, emotion: loadState(db, cfg), persona: { ok: pv.ok, changed: pv.changed?.length ?? 0, reason: pv.reason ?? null },
        embed: embedStatus(),
        layers: {
          memory: cfg.memory?.enabled !== false, emotion: cfg.emotion?.enabled !== false,
          life: cfg.life?.enabled !== false, expression: cfg.expression?.enabled !== false,
          feedback: cfg.feedback?.enabled !== false,
        },
      });
    }

    // 每来一条消息：更新情绪 + 语料样本 + 计数
    if (p === '/observe' && req.method === 'POST') {
      const b = await readBody(req);
      const at = Number(b.at) || now();
      const key = String(b.key ?? '');
      const text = String(b.text ?? '');
      const isSelf = b.isSelf === true;
      if (!isSelf && text) {
        addSample(db, key, text, at, Number(cfg.expression?.style?.sampleSize ?? 300));
        const st = applyMessage(db, cfg, loadState(db, cfg), text, at);
        saveState(db, st, text);
      }
      let counter = 0;
      try {
        db.prepare('INSERT INTO msg_counters(key,n,updated_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET n = n + 1, updated_at = excluded.updated_at').run(key, at);
        counter = db.prepare('SELECT n FROM msg_counters WHERE key=?').get(key)?.n ?? 0;
      } catch {}
      const correction = !isSelf ? detectCorrection(cfg, text) : null;
      if (correction) applyCorrection(db, cfg, { key, quote: text, at });
      const every = Number(cfg.memory?.write?.summarizeEveryMessages ?? 12);
      console.log(`[observe] key=${key} self=${isSelf} 计数=${counter} 纠正=${correction ?? '-'} 情绪P=${loadState(db, cfg).p.toFixed(2)}`);
      return send(res, 200, {
        ok: true, counter, needSummary: !isSelf && counter % every === 0,
        correction, emotion: loadState(db, cfg),
      });
    }

    // 取注入块
    if (p === '/inject' && (req.method === 'POST' || req.method === 'GET')) {
      const b = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
      const at = Number(b.at) || now();
      const out = await buildInjection(db, cfg, { key: String(b.key ?? ''), query: String(b.query ?? ''), at });
      if (out.ids.length && b.key) {
        try {
          db.prepare('INSERT OR REPLACE INTO last_injected(key,ids,at) VALUES (?,?,?)').run(String(b.key), JSON.stringify(out.ids), at);
        } catch {}
      }
      // 只记行数与块名，不记内容（内容可能含群聊原文）
      console.log(`[inject] key=${b.key} q=${String(b.query ?? '').length}字 命中=${out.ids.length} 块=${Object.keys(out.parts).join(',') || '-'} 长度=${[...out.text].length}`);
      return send(res, 200, { ok: true, text: out.text, ids: out.ids, parts: Object.keys(out.parts) });
    }

    // 写记忆
    if (p === '/memory' && req.method === 'POST') {
      const b = await readBody(req);
      const at = Number(b.at) || now();
      let vec = null;
      if (cfg.memory?.embed?.mode === 'onnx') { try { vec = await embedText(cfg, String(b.text ?? '')); } catch {} }
      const r = remember(db, cfg, b, { at, vec, embedFn: vec ? () => vec : null });
      return send(res, 200, { ok: r.action !== 'rejected', embedded: !!vec, ...r });
    }

    // 检索
    if (p === '/memory/search') {
      const q = String(url.searchParams.get('q') ?? '');
      const k = Math.min(50, Math.max(1, Number(url.searchParams.get('k')) || 8));
      const kinds = (url.searchParams.get('kinds') ?? '').split(',').filter(Boolean);
      let qvec = null;
      if (cfg.memory?.embed?.mode === 'onnx') { try { qvec = await embedText(cfg, q); } catch {} }
      const hits = search(db, cfg, q, { limit: k, kinds: kinds.length ? kinds : null, qvec });
      return send(res, 200, { ok: true, n: hits.length, hits: hits.map((h) => ({ id: h.id, kind: h.kind, text: h.text, score: Number(h.score.toFixed(3)), status: h.status, parts: h.parts })) });
    }

    // 发送前清洗
    if (p === '/cleanup' && req.method === 'POST') {
      const b = await readBody(req);
      const mood = loadState(db, cfg);
      return send(res, 200, { ok: true, text: cleanup(String(b.text ?? ''), cfg, mood) });
    }

    // 情绪
    if (p === '/emotion') {
      const st = loadState(db, cfg);
      return send(res, 200, { ok: true, state: st, text: injectText(st) });
    }

    // 生活层 tick
    if (p === '/life/tick' && req.method === 'POST') {
      const at = now();
      decayInterests(db, at);
      const pick = pickActivity(db, cfg, at);
      finishActivity(db, cfg, pick, at);
      return send(res, 200, { ok: true, pick });
    }

    // 笔记
    if (p === '/life/note' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, writeNote(db, cfg, { text: b.text, long: b.long === true }));
    }

    // 语音转写（本地 faster-whisper）
    if (p === '/transcribe' && req.method === 'POST') {
      const b = await readBody(req);
      const file = String(b.file ?? '');
      if (!file || !isAudio(file)) return send(res, 400, { ok: false, error: '不是支持的音频文件' });
      const r = await transcribeFile(file, { model: cfg.audio?.model });
      return send(res, 200, r);
    }

    // 维护
    if (p === '/maintain' && req.method === 'POST') {
      return send(res, 200, { ok: true, ...maintain(db, cfg) });
    }

    // ── 记忆压缩（学会淡忘：先把碎片揉小，再谈记住）───────────────
    // 每日：规则压缩，不调模型。把当天低重要性的碎片揉成一段，原件归档。
    if (p === '/compact' && req.method === 'POST') {
      const b = await readBody(req);
      const hours = Math.min(168, Math.max(1, Number(b.hours) || 24));
      const maxImp = Math.min(0.9, Math.max(0.1, Number(b.maxImportance) || 0.55));
      const since = now() - hours * 3600000;
      const rows = db.prepare(`SELECT id, kind, text, importance FROM memories
        WHERE status='active' AND created_at >= ? AND importance <= ? AND access_count <= 2
          AND kind IN ('episode','reflection') ORDER BY created_at`).all(since, maxImp);
      if (rows.length < 3) return send(res, 200, { ok: true, merged: 0, reason: `碎片只有 ${rows.length} 条，不值得压` });
      const parts = rows.map((r) => String(r.text).trim().replace(/[。；]$/, '').slice(0, 60));
      let text = `这段时间的一些小事：${parts.join('；')}`;
      if ([...text].length > 380) text = [...text].slice(0, 378).join('') + '…';
      const imp = Math.min(0.6, Math.max(...rows.map((r) => Number(r.importance) || 0.4)) * 0.9);
      const para = remember(db, cfg, {
        kind: 'episode', text, importance: imp, source: 'compact:daily',
        meta: { mergedFrom: rows.map((r) => r.id), mergedCount: rows.length, compact: 'daily' },
      });
      if (para.action === 'rejected') return send(res, 500, { ok: false, error: para.reason });
      const arch = db.prepare("UPDATE memories SET status='archived', archived_at=?, updated_at=? WHERE id=?");
      for (const r of rows) arch.run(now(), now(), r.id);
      const cnt = db.prepare('SELECT COUNT(*) AS c FROM memories WHERE id = ?').get(para.id);
      if (cnt?.c) {
        const rid = db.prepare('SELECT rid FROM memories WHERE id=?').get(para.id).rid;
        db.prepare('DELETE FROM mem_fts WHERE rowid=?').run(rid);
        db.prepare('INSERT OR REPLACE INTO mem_fts(rowid,bigram) VALUES (?,?)').run(rid, toFtsText(text));
      }
      return send(res, 200, { ok: true, merged: rows.length, into: para.id, chars: [...text].length });
    }

    // 每周压缩的候选：交给桥接那侧调模型做真正的抽象
    if (p === '/compact/candidates' && req.method === 'GET') {
      const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 7));
      const limit = Math.min(80, Math.max(5, Number(url.searchParams.get('limit')) || 40));
      const rows = db.prepare(`SELECT id, kind, text, importance, created_at FROM memories
        WHERE status IN ('active','conflict') AND kind IN ('episode','reflection','skill')
          AND created_at <= ? AND importance <= 0.75
        ORDER BY created_at ASC LIMIT ?`).all(now() - days * 86400000, limit);
      return send(res, 200, { ok: true, count: rows.length, items: rows });
    }

    if (p === '/compact/archive' && req.method === 'POST') {
      const b = await readBody(req);
      const ids = Array.isArray(b.ids) ? b.ids : [];
      const arch = db.prepare("UPDATE memories SET status='archived', archived_at=?, updated_at=? WHERE id=? AND status IN ('active','conflict')");
      let n = 0;
      for (const id of ids) { try { n += arch.run(now(), now(), id).changes ?? 0; } catch {} }
      return send(res, 200, { ok: true, archived: n });
    }

    // ── 每月：记忆文本备份（给"下一代"读的）─────────────────────────
    if (p === '/backup/text' && req.method === 'POST') {
      const dir = path.join(cfg.system.dataRoot, 'backups', 'text');
      fsx.mkdirSync(dir, { recursive: true });
      const month = new Date().toISOString().slice(0, 7);
      const rows = db.prepare(`SELECT id, kind, text, importance, valence, created_at, last_access, access_count, status, source, meta
        FROM memories ORDER BY kind, importance DESC`).all();
      const kindName = { episode: '事件', fact: '事实', reflection: '反思', skill: '技能', lesson: '道理' };
      const lines = [
        `# 记忆备份 · ${month}`,
        '',
        `导出时间：${new Date().toLocaleString('zh-CN')}`,
        `共 ${rows.length} 条（含已归档）。这文件是给"下一代"读的：换掉程序，记忆还在。`,
        '',
      ];
      const byKind = {};
      for (const r of rows) (byKind[r.kind] ??= []).push(r);
      for (const [kind, list] of Object.entries(byKind)) {
        lines.push(`## ${kindName[kind] ?? kind}（${list.length}）`, '');
        for (const r of list) {
          const d = new Date(r.created_at).toISOString().slice(0, 10);
          lines.push(`- [${d}] (${r.status}, 重要 ${Number(r.importance).toFixed(2)}, 想起 ${r.access_count} 次) ${r.text}`);
        }
        lines.push('');
      }
      const mdFile = path.join(dir, `${month}.md`);
      const jsonFile = path.join(dir, `${month}.jsonl`);
      fsx.writeFileSync(mdFile, lines.join(String.fromCharCode(10)), 'utf8');
      fsx.writeFileSync(jsonFile, rows.map((r) => JSON.stringify(r)).join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
      return send(res, 200, { ok: true, month, count: rows.length, files: [mdFile, jsonFile] });
    }

    // 每日治理：衰减 → 归档 → 体检 → 报表
    if (p === '/daily' && req.method === 'POST') {
      const m = maintain(db, cfg);
      const hc = healthCheck(db, cfg);
      const day = new Date().toISOString().slice(0, 10);
      const counts = Object.fromEntries(
        db.prepare("SELECT kind, COUNT(*) AS c FROM memories WHERE status IN ('active','conflict') GROUP BY kind").all().map((r) => [r.kind, r.c])
      );
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const put = db.prepare('INSERT OR REPLACE INTO daily_stats(day,key,value) VALUES (?,?,?)');
      put.run(day, 'memories_total', total);
      for (const [k, v] of Object.entries(counts)) put.run(day, 'memories_' + k, v);
      put.run(day, 'archived', m.archived ?? 0);
      put.run(day, 'purged', m.purged ?? 0);
      put.run(day, 'conflicts_open', hc.conflict?.length ?? 0);
      put.run(day, 'duplicates', hc.duplicate?.length ?? 0);
      // 无界表清理（不清理的话，情绪日志一天 200+ 条，一年就是 8 万条）
      const cut30 = now() - 30 * 86400000;
      const cut90 = now() - 90 * 86400000;
      db.prepare('DELETE FROM emotion_log WHERE at < ?').run(cut30);
      db.prepare('DELETE FROM life_log WHERE at < ?').run(cut90);
      db.prepare('DELETE FROM working_notes WHERE expires_at < ?').run(now());
      db.prepare('DELETE FROM daily_stats WHERE day < ?').run(new Date(now() - 365 * 86400000).toISOString().slice(0, 10));
      return send(res, 200, { ok: true, day, decay: m.decay, archived: m.archived, purged: m.purged, health: { duplicate: hc.duplicate.length, orphan: hc.orphan.length, zombie: hc.zombie.length, conflict: hc.conflict.length }, counts, report: hc.file });
    }

    // 体检
    if (p === '/healthcheck' && req.method === 'POST') {
      return send(res, 200, { ok: true, ...healthCheck(db, cfg) });
    }

    // 评估
    if (p === '/eval') {
      return send(res, 200, { ok: true, ...(await evaluate(db, cfg)) });
    }

    return send(res, 404, { ok: false, error: `未知路径 ${p}` });
  } catch (error) {
    return send(res, 500, { ok: false, error: String(error?.message ?? error) });
  }
});

const port = Number(cfg.system.httpPort ?? 7331);
server.listen(port, '127.0.0.1', () => {
  console.log(`[dsh-memory] listening http://127.0.0.1:${port}  data=${cfg.system.dataRoot}`);
});
