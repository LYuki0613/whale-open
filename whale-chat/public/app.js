// 鲸窝 · 聊天客户端
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const S = { me: { name: '我', avatar: null }, her: { name: '小助手', avatar: null }, stickers: [], messages: [], busy: false };

// ── 访问口令（走公网隧道时需要）─────────────────────────────────────────
// 打开链接时带 ?k=xxx 会存下来；之后所有 /api 请求自动带上，SSE 也一样。
const TOKEN = (() => {
  const fromUrl = new URLSearchParams(location.search).get('k');
  if (fromUrl) { try { localStorage.setItem('whale.k', fromUrl); } catch {} return fromUrl; }
  try { return localStorage.getItem('whale.k') || ''; } catch { return ''; }
})();

const withToken = (u) => {
  if (!TOKEN || typeof u !== 'string' || !u.startsWith('/')) return u;
  return u + (u.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(TOKEN);
};
const rawFetch = window.fetch.bind(window);
window.fetch = (u, o) => rawFetch(withToken(u), o);

const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB');
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const timeText = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

function avatarHtml(who, extra) {
  const a = S[who];
  const cls = 'av' + (extra ? ' ' + extra : '');
  if (a?.avatar?.url) return `<div class="${cls}"><img src="${a.avatar.url}" alt=""></div>`;
  return `<div class="${cls}">${esc((a?.name ?? '?').slice(0, 1))}</div>`;
}

// ── 视图切换 ────────────────────────────────────────────────────────────
$$('.tab').forEach((btn) => btn.addEventListener('click', () => {
  $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${btn.dataset.view}`));
  if (btn.dataset.view === 'chat') $('#input').focus();
}));

// ── 消息渲染 ────────────────────────────────────────────────────────────
function bubbleInner(m) {
  if (m.kind === 'image' && m.file) return `<img class="photo" src="${m.file.url}" alt="">`;
  if (m.kind === 'sticker' && m.file) return `<img class="sticker" src="${m.file.url}" alt="">`;
  if (m.kind === 'video' && m.file) return `<video src="${m.file.url}" controls preload="metadata"></video>`;
  if (m.kind === 'file' && m.file) {
    return `<div class="fname">📎 ${esc(m.file.name)}</div><div class="fsize">${fmtSize(m.file.size)} · 点一下下载</div>`;
  }
  return esc(m.text);
}

function renderMessage(m, animate) {
  const row = document.createElement('div');
  row.className = 'msg ' + (m.role === 'me' ? 'me' : 'her');
  const who = m.role === 'me' ? 'me' : 'her';
  row.innerHTML = avatarHtml(who) + `<div class="bubble">${bubbleInner(m)}</div>`;
  if (m.kind === 'file' && m.file) {
    row.querySelector('.bubble').addEventListener('click', () => window.open(m.file.url, '_blank'));
  }
  if (animate) row.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 180 });
  $('#log').appendChild(row);
  $('#log').scrollTop = $('#log').scrollHeight;
}

function renderAll() {
  $('#log').innerHTML = '';
  let lastMin = '';
  for (const m of S.messages) {
    const t = timeText(m.at);
    if (t !== lastMin) {
      lastMin = t;
      const sep = document.createElement('div');
      sep.className = 'time-sep';
      sep.textContent = t;
      $('#log').appendChild(sep);
    }
    renderMessage(m, false);
  }
}

function showTyping(on) {
  let el = document.getElementById('typing');
  if (on && !el) {
    el = document.createElement('div');
    el.id = 'typing';
    el.className = 'typing';
    el.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span><span>她在想…</span>';
    $('#log').appendChild(el);
    $('#log').scrollTop = $('#log').scrollHeight;
  } else if (!on && el) el.remove();
}

// ── 头像/名字 ───────────────────────────────────────────────────────────
function setVersion(j) {
  const v = j?.appName ? j.appName + " v" + (j.version ?? "?") : ("v" + (j?.version ?? "?"));
  const el = document.getElementById('ver');
  if (el) el.textContent = "版本 " + (j?.version ?? "?") + (j?.appName ? " · " + j.appName : "");
  if (j?.appName) document.title = j.appName;
}

function paintWho() {
  $('#herName').textContent = S.her.name;
  $('#meName').textContent = S.me.name;
  $('#setHerName').value = S.her.name;
  $('#setMeName').value = S.me.name;
  const herAv = $('#herAvatar');
  herAv.innerHTML = S.her.avatar?.url ? `<img src="${S.her.avatar.url}" alt="">` : esc(S.her.name.slice(0, 1));
  const meAv = $('#meAvatar');
  meAv.innerHTML = S.me.avatar?.url ? `<img src="${S.me.avatar.url}" alt="">` : esc(S.me.name.slice(0, 1));
  if (S.her.avatar?.url) { $('#herAvatar').classList.add('sm'); }
}

// ── 数据加载 ────────────────────────────────────────────────────────────
async function bootstrap() {
  const r = await fetch('/api/bootstrap');
  const j = await r.json();
  S.me = j.me; S.her = j.her; S.stickers = j.stickers ?? []; S.messages = j.messages ?? [];
  setVersion(j);
  paintWho();
  renderAll();
  renderStickers();
  renderMoments(j.moments ?? []);
  $('#conn').textContent = j.agentReady ? '已连接' : '本体未连接';
}

// ── 发送 ────────────────────────────────────────────────────────────────
async function send() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text || S.busy) return;
  input.value = '';
  input.style.height = 'auto';
  await fetch('/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
}

$('#btnSend').addEventListener('click', send);
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('#input').addEventListener('input', (e) => {
  const el = e.target;
  el.style.height = 'auto';
  el.style.height = Math.min(150, el.scrollHeight) + 'px';
});

// ── 选文件：PC 用原生对话框，浏览器用 input ─────────────────────────────
function pickFiles({ accept = '*/*', multiple = false } = {}) {
  // PC 客户端：走 Electron 原生对话框（最可靠，不会因为窗口状态弹不出来）
  if (window.whaleNative?.isDesktop) {
    return window.whaleNative.pickFiles({ accept, multiple }).then((list) =>
      (list ?? []).map((f) => {
        const bin = atob(f.base64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
        return new File([arr], f.name, { type: f.mime });
      }));
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(input);
    let done = false;
    const finish = (files) => {
      if (done) return;
      done = true;
      try { input.remove(); } catch {}
      resolve(files);
    };
    // 注意：不能用「窗口重新获得焦点」当作取消信号——手机上选完文件时
    // 焦点会先回来，会把已经选好的文件当成「取消」丢掉（这就是"选了没反应"）。
    input.addEventListener('change', () => finish([...(input.files ?? [])]));
    input.addEventListener('cancel', () => finish([]));
    setTimeout(() => finish([]), 120000);
    input.click();
  });
}

// ── 消息通知 ────────────────────────────────────────────────────────────
// 电脑：窗口不在前面时弹右下角。手机：走原生悬浮通知（WebView 的 Notification API 不可靠）。
function notifyBody(msg) {
  if (msg.kind === 'sticker') return '[表情]';
  if (msg.kind === 'image') return '[图片]';
  if (msg.kind === 'video') return '[视频]';
  if (msg.kind === 'file') return '[文件] ' + (msg.file?.name ?? '');
  return String(msg.text ?? '').slice(0, 120);
}

let lastNotifyAt = 0;
function maybeNotify(msg) {
  if (msg.role !== 'her') return;
  if (Date.now() - lastNotifyAt < 800) return;
  lastNotifyAt = Date.now();
  const body = notifyBody(msg);
  window.__notified = (window.__notified || 0) + 1;

  // Android：交给原生发通知（前台时原生会自己忽略）
  if (window.WhaleNotify?.post) {
    try { window.WhaleNotify.post(S.her.name, body); } catch {}
    return;
  }

  // 桌面 Electron：窗口不在前面才弹
  if (window.whaleNative?.notify) {
    const away = document.hidden || !document.hasFocus();
    if (away) window.whaleNative.notify({ title: S.her.name, body });
    return;
  }

  // 普通浏览器（手机浏览器打开时）：用标准通知
  if ('Notification' in window && document.hidden) {
    if (Notification.permission === 'granted') new Notification(S.her.name, { body });
    else if (Notification.permission === 'default') Notification.requestPermission();
  }
}

function toast(msg) {  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:84px;transform:translateX(-50%);padding:8px 16px;border-radius:8px;background:rgba(0,0,0,.84);color:#e6e6e6;border:1px solid rgba(255,255,255,.12);font-size:13px;z-index:99;transition:opacity .25s';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 2400);
}

// ── 上传 ────────────────────────────────────────────────────────────────
async function upload(file) {
  const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!r.ok) throw new Error('上传被拒 HTTP ' + r.status);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error ?? '上传失败');
  return j.file;
}

// 把客户端错误报到服务端，手机上出问题时能查
function reportError(where, err) {
  try {
    fetch('/api/client-log', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ where, message: String(err?.message ?? err), ua: navigator.userAgent, at: Date.now() }),
    });
  } catch {}
}
window.addEventListener('error', (e) => reportError('window', e?.message ?? e?.error));
window.addEventListener('unhandledrejection', (e) => reportError('promise', e?.reason));

async function sendFiles(files) {
  for (const f of files) {
    try {
      const up = await upload(f);
      const kind = f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : 'file';
      await fetch('/api/message/file', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileId: up.id, kind }),
      });
    } catch (e) {
      toast('发文件失败：' + e.message); reportError('sendFiles', e);
    }
  }
}

$('#btnFile').addEventListener('click', async () => {
  const files = await pickFiles({ multiple: true });
  if (!files.length) { toast('没有选到文件'); return; }
  toast('已选择 ' + files.length + ' 个，正在发送…');
  sendFiles(files);
});
$('#btnImage').addEventListener('click', async () => {
  const files = await pickFiles({ accept: 'image/*,video/*', multiple: true });
  if (!files.length) { toast('没有选到图片'); return; }
  toast('已选择 ' + files.length + ' 个，正在发送…');
  sendFiles(files);
});

// 拖拽发送
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) sendFiles([...e.dataTransfer.files]);
});

// 粘贴图片
document.addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === 'file');
  if (items.length) {
    e.preventDefault();
    sendFiles(items.map((i) => i.getAsFile()).filter(Boolean));
  }
});

// ── 表情 ────────────────────────────────────────────────────────────────
function renderStickers() {
  const popItems = S.stickers.map((s) =>
    `<img src="${s.file.url}" data-id="${s.fileId}" title="${esc(s.name)}" alt="">`).join('');
  $('#stickerPop').innerHTML = `
    <div class="sp-head">
      <span>表情</span>
      <button class="sp-close" id="spClose" aria-label="关闭">×</button>
    </div>
    <div class="sp-grid">${popItems}</div>`;
  $('#spClose')?.addEventListener('click', () => $('#stickerPop').classList.remove('on'));

  $('#stickerGrid').innerHTML = S.stickers.map((s) => `
    <div class="cell">
      <img src="${s.file.url}" alt="">
      <button class="del" data-id="${s.id}">×</button>
    </div>`).join('');
  $$('#stickerGrid .del').forEach((b) => b.addEventListener('click', async () => {
    await fetch('/api/stickers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remove: Number(b.dataset.id) }) });
    bootstrap();
  }));
}

$('#stickerPop').addEventListener('click', async (e) => {
  const id = e.target?.dataset?.id;
  if (!id) return;
  await fetch('/api/message/file', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId: Number(id), kind: 'sticker' }),
  });
  $('#stickerPop').classList.remove('on');
});

$('#btnSticker').addEventListener('click', (e) => {
  e.stopPropagation();
  const p = $('#stickerPop');
  if (!S.stickers.length) { alert('还没有表情，去「表情」里加几张'); return; }
  p.classList.toggle('on');
});

// 点空白处 / 按 Esc 收起表情栏
document.addEventListener('click', (e) => {
  const pop = $('#stickerPop');
  if (!pop.classList.contains('on')) return;
  if (pop.contains(e.target) || e.target.closest('#btnSticker')) return;
  pop.classList.remove('on');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#stickerPop').classList.remove('on');
});

$('#btnAddSticker').addEventListener('click', async () => {
  const files = await pickFiles({ accept: 'image/*', multiple: true });
  if (!files.length) { toast('没有选到图片'); return; }
  toast('正在添加 ' + files.length + ' 个表情…');
  let n = 0;
  for (const f of files) {
    try {
      const up = await upload(f);
      await fetch('/api/stickers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ add: true, fileId: up.id, name: f.name }) });
      n += 1;
    } catch (e) { toast('添加失败：' + e.message); }
  }
  if (n) toast(`已添加 ${n} 个表情`);
  bootstrap();
});

// ── 朋友圈 ──────────────────────────────────────────────────────────────
function avatarMarkup(who) {
  const p = S[who];
  if (p?.avatar?.url) return '<div class="m-av"><img src="' + p.avatar.url + '" alt=""></div>';
  return '<div class="m-av">' + esc((p?.name ?? '?').slice(0, 1)) + '</div>';
}

function renderMoments(list) {
  if (!list.length) {
    $('#momentList').innerHTML = '<p class="hint">还没有朋友圈。她发的时候会自己出现在这里。</p>';
    return;
  }
  $('#momentList').innerHTML = list.map((m) => {
    const who = m.by === 'her' ? 'her' : 'me';
    const name = who === 'her' ? S.her.name : S.me.name;
    const pics = m.files.length
      ? '<div class="pics">' + m.files.map((f) => f.mime.startsWith('image/')
          ? '<img src="' + f.url + '" alt="">'
          : '<a href="' + f.url + '" target="_blank">' + esc(f.name) + '</a>').join('') + '</div>'
      : '';
    const likes = (m.likes ?? []);
    const likeLine = likes.length
      ? '<div class="m-likes">❤️ ' + likes.map((x) => (x === 'her' ? esc(S.her.name) : esc(S.me.name))).join('、') + '</div>'
      : '';
    const comments = (m.comments ?? []);
    const commentLines = comments.length
      ? '<div class="m-comments">' + comments.map((c) => {
          const cn = c.by === 'her' ? S.her.name : S.me.name;
          return '<div class="m-comment"><b>' + esc(cn) + '</b>：' + esc(c.text) + '</div>';
        }).join('') + '</div>'
      : '';
    return '<div class="moment" data-id="' + m.id + '">'
      + '<div class="m-head">' + avatarMarkup(who)
      + '<div><div class="m-name">' + esc(name) + '</div>'
      + '<div class="meta">' + new Date(m.at).toLocaleString('zh-CN') + '</div></div></div>'
      + '<div class="body">' + (esc(m.text) || '<span class="hint">（只发了图）</span>') + '</div>'
      + pics + likeLine + commentLines
      + '<div class="m-actions">'
      + '<button class="m-like" data-id="' + m.id + '">' + (likes.includes('me') ? '❤️ 已赞' : '🤍 赞') + '</button>'
      + '<button class="m-cc" data-id="' + m.id + '">💬 评论</button>'
      + '<button class="m-del" data-id="' + m.id + '">🗑 删除</button>'
      + '</div>'
      + '<div class="m-ccbox" id="ccbox-' + m.id + '" hidden>'
      + '<input class="m-input" data-id="' + m.id + '" placeholder="说点什么…" />'
      + '</div>'
      + '</div>';
  }).join('');

  $$('#momentList .m-like').forEach((b) => b.addEventListener('click', async () => {
    await fetch('/api/moment/like', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: Number(b.dataset.id) }) });
    bootstrap();
  }));
  $$('#momentList .m-cc').forEach((b) => b.addEventListener('click', () => {
    const box = document.getElementById('ccbox-' + b.dataset.id);
    if (box) { box.hidden = !box.hidden; box.querySelector('input')?.focus(); }
  }));
  $$('#momentList .m-del').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('删除这条朋友圈？评论和点赞会一起删掉。')) return;
    await fetch('/api/moment/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: Number(b.dataset.id) }) });
    toast('已删除');
    bootstrap();
  }));
  $$('#momentList .m-input').forEach((inp) => inp.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    await fetch('/api/moment/comment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: Number(inp.dataset.id), text }) });
    bootstrap();
  }));
}

$('#btnPost').addEventListener('click', () => {
  const mask = $('#mask'), modal = $('#modal');
  modal.innerHTML = `
    <h3>发朋友圈</h3>
    <textarea id="postText" placeholder="想说什么…"></textarea>
    <div style="margin-top:10px"><button class="ghost" id="postPic">加图片</button> <span id="postPics" class="hint"></span></div>
    <div class="row"><button class="ghost" id="postCancel">取消</button><button class="send" id="postGo">发布</button></div>`;
  mask.classList.add('on'); modal.classList.add('on');
  let fileIds = [];
  $('#postPic').onclick = async () => {
    const files = await pickFiles({ accept: 'image/*', multiple: true });
    for (const f of files) {
      const up = await upload(f);
      fileIds.push(up.id);
    }
    $('#postPics').textContent = `已选 ${fileIds.length} 张`;
  };
  const close = () => { mask.classList.remove('on'); modal.classList.remove('on'); };
  $('#postCancel').onclick = close;
  $('#postGo').onclick = async () => {
    const text = $('#postText').value.trim();
    await fetch('/api/moment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, fileIds }) });
    close();
    bootstrap();
  };
});

// ── 设置 ────────────────────────────────────────────────────────────────
async function saveSetting(k, v) {
  await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [k]: v }) });
  bootstrap();
}
$('#setHerName').addEventListener('change', (e) => saveSetting('her.name', e.target.value.trim() || '小助手'));
$('#setMeName').addEventListener('change', (e) => saveSetting('me.name', e.target.value.trim() || '我'));
$('#btnHerAvatar').onclick = () => pickAvatar('her');
$('#btnMeAvatar').onclick = () => pickAvatar('me');

// 通知设置：手机跳到系统页面，电脑直接提示
$('#btnNotifyTest').onclick = () => {
  if (window.WhaleNotify?.test) {
    try {
      const s = JSON.parse(window.WhaleNotify.status());
      toast('权限:' + s.permitted + ' 开关:' + s.enabled + ' 重要性:' + s.importance);
    } catch {}
    window.WhaleNotify.test();
    return;
  }
  if (window.whaleNative?.notify) {
    window.whaleNative.notify({ title: '鲸窝', body: '这是测试通知' });
    return;
  }
  toast('这个环境不支持测试通知');
};

$('#btnNotifySettings').onclick = () => {
  if (window.WhaleNotify?.openNotifySettings) { window.WhaleNotify.openNotifySettings(); return; }
  if (window.whaleNative?.notify) { toast('电脑端通知已开启：窗口不在前面时会弹'); return; }
  if ('Notification' in window) {
    Notification.requestPermission().then((p) => toast('通知权限：' + p));
    return;
  }
  toast('这个环境不支持通知设置');
};
async function pickAvatar(who) {
  const files = await pickFiles({ accept: 'image/*' });
  const f = files[0];
  if (!f) { toast('没有选到图片'); return; }
  try {
    toast('正在上传头像…');
    const up = await upload(f);
    await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [`${who}.avatar`]: up.id }) });
    S[who].avatar = up.file ?? up;
    paintWho();
    renderAll();
    toast('头像已更新');
  } catch (e) {
    toast('换头像失败：' + e.message);
  }
}

// ── 实时事件 ────────────────────────────────────────────────────────────
function connect() {
  const es = new EventSource(withToken('/api/events'));
  es.onopen = () => { $('#conn').textContent = '已连接'; };
  es.onerror = () => { $('#conn').textContent = '重连中…'; };
  es.onmessage = (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    if (d.type === 'message') {
      S.messages.push(d.message);
      renderMessage(d.message, true);
      maybeNotify(d.message);
    } else if (d.type === 'typing') {
      showTyping(d.on);
    } else if (d.type === 'settings') {
      bootstrap();
    } else if (d.type === 'moments') {
      bootstrap();
    } else if (d.type === 'stickers') {
      bootstrap();
    }
  };
}

// 触屏设备：输入框提示不写 Enter
if (matchMedia('(max-width: 760px)').matches) {
  const inp = document.getElementById('input');
  if (inp) inp.placeholder = '说点什么…';
}

bootstrap();
connect();

// 深链接：/#moments、/#stickers、/#settings 直接打开对应页
const gotoView = (location.hash || '').slice(1);
if (['chat', 'moments', 'stickers', 'settings'].includes(gotoView)) {
  const btn = document.querySelector('[data-view="' + gotoView + '"]');
  if (btn) btn.click();
}

$('#input').focus();
