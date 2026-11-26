// 五子棋（前端独立模块，不依赖 app.js 内部状态）
// 棋盘 15×15；你执黑先行，她执白。她的棋由本地启发式 AI 走（不花模型钱、不用等），
// 下完一局才向服务端要一句"她的话"。

const SIZE = 15;
const EMPTY = 0, BLACK = 1, WHITE = 2;

const state = {
  board: [],
  turn: BLACK,
  over: false,
  winner: 0,
  moves: 0,
  hist: [],
  canvas: null,
  ctx: null,
  cell: 0,
  pad: 0,
  thinking: false,
};

function idx(x, y) { return y * SIZE + x; }
function inside(x, y) { return x >= 0 && y >= 0 && x < SIZE && y < SIZE; }

function reset() {
  state.board = Array.from({ length: SIZE * SIZE }, () => EMPTY);
  state.turn = BLACK;
  state.over = false;
  state.winner = 0;
  state.moves = 0;
  state.hist = [];
  state.thinking = false;
  paint();
  setStatus('你先走（黑棋）');
}

function setStatus(t) {
  const el = document.getElementById('gomokuStatus');
  if (el) el.textContent = t;
}

/** 画棋盘 */
function paint() {
  const c = state.canvas;
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = c.getBoundingClientRect();
  const w = rect.width || 320;
  c.width = Math.round(w * dpr);
  c.height = Math.round(w * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  const pad = Math.max(10, Math.round(w * 0.045));
  const cell = (w - pad * 2) / (SIZE - 1);
  state.cell = cell;
  state.pad = pad;

  g.clearRect(0, 0, w, w);
  // 底板
  g.fillStyle = 'rgba(232,196,138,.14)';
  g.fillRect(0, 0, w, w);
  // 网格
  g.strokeStyle = 'rgba(255,255,255,.28)';
  g.lineWidth = 1;
  for (let i = 0; i < SIZE; i += 1) {
    const p = pad + i * cell;
    g.beginPath(); g.moveTo(pad, p); g.lineTo(pad + cell * (SIZE - 1), p); g.stroke();
    g.beginPath(); g.moveTo(p, pad); g.lineTo(p, pad + cell * (SIZE - 1)); g.stroke();
  }
  // 星位
  g.fillStyle = 'rgba(255,255,255,.55)';
  for (const [x, y] of [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]]) {
    g.beginPath();
    g.arc(pad + x * cell, pad + y * cell, Math.max(1.6, cell * 0.07), 0, Math.PI * 2);
    g.fill();
  }
  // 棋子
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const v = state.board[idx(x, y)];
      if (!v) continue;
      const cx = pad + x * cell;
      const cy = pad + y * cell;
      const r = cell * 0.42;
      const grad = g.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.2, cx, cy, r);
      if (v === BLACK) { grad.addColorStop(0, '#5a5a5a'); grad.addColorStop(1, '#0a0a0a'); }
      else { grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, '#c9c9c9'); }
      g.fillStyle = grad;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 0.7; g.stroke();
    }
  }
  // 最后一手标记
  const last = state.hist[state.hist.length - 1];
  if (last) {
    const cx = pad + last.x * cell;
    const cy = pad + last.y * cell;
    g.strokeStyle = 'rgba(47,181,90,.9)';
    g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, cell * 0.17, 0, Math.PI * 2); g.stroke();
  }
}

function place(x, y, who) {
  state.board[idx(x, y)] = who;
  state.hist.push({ x, y, who });
  state.moves += 1;
}

function checkWin(x, y, who) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of dirs) {
    let n = 1;
    for (const s of [1, -1]) {
      let cx = x + dx * s, cy = y + dy * s;
      while (inside(cx, cy) && state.board[idx(cx, cy)] === who) {
        n += 1; cx += dx * s; cy += dy * s;
      }
    }
    if (n >= 5) return true;
  }
  return false;
}

/** 一段方向上的形状分：数连续子 + 两端是否被堵 */
function lineScore(x, y, dx, dy, who, add) {
  let count = 0;
  let openEnds = 0;
  // 正向
  let cx = x + dx, cy = y + dy;
  while (inside(cx, cy) && state.board[idx(cx, cy)] === who) { count += 1; cx += dx; cy += dy; }
  if (inside(cx, cy) && state.board[idx(cx, cy)] === EMPTY) openEnds += 1;
  // 反向
  cx = x - dx; cy = y - dy;
  while (inside(cx, cy) && state.board[idx(cx, cy)] === who) { count += 1; cx -= dx; cy -= dy; }
  if (inside(cx, cy) && state.board[idx(cx, cy)] === EMPTY) openEnds += 1;

  const n = count + (add ? 1 : 0);
  if (n >= 5) return 10000000;
  if (n === 4) return openEnds >= 2 ? 500000 : openEnds === 1 ? 40000 : 0;
  if (n === 3) return openEnds >= 2 ? 18000 : openEnds === 1 ? 1200 : 0;
  if (n === 2) return openEnds >= 2 ? 900 : openEnds === 1 ? 90 : 0;
  if (n === 1) return openEnds >= 2 ? 40 : 8;
  return 0;
}

function scoreAt(x, y, who) {
  let s = 0;
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    s += lineScore(x, y, dx, dy, who, true);
  }
  return s;
}

function nearStone(x, y) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const nx = x + dx, ny = y + dy;
      if (inside(nx, ny) && state.board[idx(nx, ny)] !== EMPTY) return true;
    }
  }
  return false;
}

function aiPick() {
  if (state.moves === 0) return { x: 7, y: 7 };
  let best = null;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (state.board[idx(x, y)] !== EMPTY) continue;
      if (!nearStone(x, y)) continue;
      // 进攻 + 防守，防守略保守
      const mine = scoreAt(x, y, WHITE);
      const foe = scoreAt(x, y, BLACK);
      const score = mine * 1.05 + foe;
      if (!best || score > best.score) best = { x, y, score };
    }
  }
  return best || { x: 7, y: 7 };
}

function endGame(who) {
  state.over = true;
  state.winner = who;
  if (who === BLACK) setStatus('你赢了 🎉');
  else if (who === WHITE) setStatus('她赢了');
  else setStatus('平局');
  reportResult(who);
}

function reportResult(who) {
  const whoStr = who === BLACK ? 'me' : who === WHITE ? 'her' : 'draw';
  fetch('/api/game/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ who: whoStr, moves: state.moves }),
  }).then((r) => r.json()).then((j) => {
    if (j?.said) {
      const el = document.getElementById('gomokuTalk');
      if (el) el.textContent = '她：' + j.said;
    }
  }).catch(() => {});
}

/** 盘面转成文本给她看 */
function boardText() {
  const map = { 0: '.', 1: '●', 2: '○' };
  const rows = [];
  for (let y = 0; y < SIZE; y += 1) {
    let r = '';
    for (let x = 0; x < SIZE; x += 1) r += map[state.board[idx(x, y)]];
    rows.push(r);
  }
  return rows.join('\n');
}

/** 问她走哪一步（同一条会话 = 同一份记忆和人格）；失败返回 null */
async function askHer() {
  try {
    const r = await fetch('/api/game/gomoku/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ board: boardText() }),
    });
    const j = await r.json();
    if (j?.ok && inside(j.x, j.y) && state.board[idx(j.x, j.y)] === EMPTY) return { x: j.x, y: j.y };
  } catch {}
  return null;
}

async function aiTurn() {
  if (state.over || state.thinking) return;
  state.thinking = true;
  setStatus('她在想…');
  const t0 = Date.now();

  let p = await askHer();
  const left = 800 - (Date.now() - t0);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
  if (!p) p = aiPick();   // 她没给出合法落子时本地兜底，保证棋局不卡住

  if (state.board[idx(p.x, p.y)] !== EMPTY) { state.thinking = false; return; }
  place(p.x, p.y, WHITE);
  paint();
  state.thinking = false;
  if (checkWin(p.x, p.y, WHITE)) { endGame(WHITE); return; }
  if (state.moves >= SIZE * SIZE) { endGame(0); return; }
  state.turn = BLACK;
  setStatus('轮到你');
}

function onClick(ev) {
  if (state.over || state.turn !== BLACK || state.thinking) return;
  const rect = state.canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const py = ev.clientY - rect.top;
  const x = Math.round((px - state.pad) / state.cell);
  const y = Math.round((py - state.pad) / state.cell);
  if (!inside(x, y) || state.board[idx(x, y)] !== EMPTY) return;
  place(x, y, BLACK);
  paint();
  if (checkWin(x, y, BLACK)) { endGame(BLACK); return; }
  if (state.moves >= SIZE * SIZE) { endGame(0); return; }
  state.turn = WHITE;
  aiTurn();
}

function undo() {
  if (!state.hist.length) return;
  // 回退两步（你 + 她），让轮次回到你
  for (let k = 0; k < 2 && state.hist.length; k += 1) {
    const m = state.hist.pop();
    state.board[idx(m.x, m.y)] = EMPTY;
    state.moves -= 1;
  }
  state.over = false;
  state.winner = 0;
  state.turn = BLACK;
  state.thinking = false;
  paint();
  setStatus('悔棋了，轮到你');
}

export function mount() {
  const c = document.getElementById('gomokuBoard');
  if (!c) return;
  state.canvas = c;
  reset();
  c.onclick = onClick;
  const btnReset = document.getElementById('gomokuReset');
  const btnUndo = document.getElementById('gomokuUndo');
  if (btnReset) btnReset.onclick = () => reset();
  if (btnUndo) btnUndo.onclick = () => undo();
  window.addEventListener('resize', () => paint());
}

window.Gomoku = { mount };
