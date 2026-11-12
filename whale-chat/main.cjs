// 鲸窝 · 桌面外壳
//
// 启动时先确保本地服务在跑（7501），再加载界面。
// 服务本身是 node 脚本，用 ELECTRON_RUN_AS_NODE 让它以 node 身份跑，不弹黑框。
const { app, BrowserWindow, shell, Menu, ipcMain, dialog, Notification, Tray, nativeImage } = require('electron');
const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const PORT = 7501;
let win = null;
let serverProc = null;

function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: PORT });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(600);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function ensureServer() {
  if (await portOpen()) return true;
  const script = path.join(__dirname, 'server.mjs');
  // 用自带 Node 24 跑服务：Electron 的 Node 20 没有原生 WebSocket，接不上 DSH 事件流
  const bundled = path.join(process.resourcesPath, 'runtime', 'node.exe');
  const nodeExe = fs.existsSync(bundled) ? bundled : process.execPath;
  serverProc = spawn(nodeExe, [script], {
    cwd: __dirname,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, CHAT_PORT: String(PORT), CHAT_DATA: process.env.CHAT_DATA || path.join(app.getPath('userData'), 'data') },
  });
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (await portOpen()) return true;
  }
  return false;
}

// 原生选文件：PC 端用它，避免网页 input 在某些窗口状态下弹不出来
ipcMain.handle('pick-files', async (_e, opts) => {
  const filters = opts.accept === 'image/*'
    ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
    : [{ name: '所有文件', extensions: ['*'] }];
  const res = await dialog.showOpenDialog({
    properties: opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    filters,
  });
  if (res.canceled || !res.filePaths?.length) return [];
  const out = [];
  for (const fp of res.filePaths) {
    try {
      const buf = fs.readFileSync(fp);
      const ext = path.extname(fp).toLowerCase();
      const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.webp': 'image/webp', '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.webm': 'video/webm',
        '.mp3': 'audio/mpeg' })[ext] || 'application/octet-stream';
      out.push({ name: path.basename(fp), mime, base64: buf.toString('base64') });
    } catch {}
  }
  return out;
});

// Windows 任务栏通知需要固定的 AppUserModelID，否则不弹
app.setAppUserModelId('鲸窝');

/** 右下角弹一条通知；点击回到窗口。 */
function showNotification(payload) {
  if (!Notification.isSupported()) return false;
  const n = new Notification({
    title: String(payload?.title ?? '鲸窝'),
    body: String(payload?.body ?? '').slice(0, 220),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    silent: false,
    timeoutType: 'default',
  });
  n.on('click', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  n.show();
  return true;
}

ipcMain.handle('notify', (_e, payload) => showNotification(payload ?? {}));
ipcMain.handle('win-state', () => ({
  focused: win ? win.isFocused() : false,
  minimized: win ? win.isMinimized() : false,
  visible: win ? win.isVisible() : false,
}));

let tray = null;

/** 托盘：关掉窗口后还在这儿，点一下回来。 */
function createTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico'));
    tray = new Tray(img.resize({ width: 16, height: 16 }));
    tray.setToolTip('鲸窝');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开鲸窝', click: () => { if (win) { win.show(); win.focus(); } } },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', () => { if (win) { win.show(); win.focus(); } });
  } catch (e) {
    console.log('[tray] 创建失败:', e?.message ?? e);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 620,
    backgroundColor: '#121212', title: '鲸窝',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  Menu.setApplicationMenu(null);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(`http://127.0.0.1:${PORT}/`);

  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

app.whenReady().then(async () => {
  const ok = await ensureServer();
  if (!ok) {
    const { dialog } = require('electron');
    dialog.showErrorBox('服务没起来', '本地服务启动失败（端口 7501）。\n请检查 DSH 是否在运行。');
  }
  createWindow();
  createTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => { try { serverProc?.kill(); } catch {} });
