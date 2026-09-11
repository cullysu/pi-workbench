// Pi Workbench — Electron main process.
// Spawns the bundled node runtime (server.mjs) and loads its UI in the window.
const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn, exec } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const PORT = 32123;
let serverChild = null;
let mainWindow = null;
let quitting = false;
let serverRestarts = 0;

const LOG_FILE = path.join(app.getPath('userData'), 'server.log');
function appendLog(line) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`); } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const appRoot = app.isPackaged ? path.join(app.getPath('userData'), 'runtime') : path.join(__dirname, 'pkg-build');
const runtimeZip = app.isPackaged ? path.join(process.resourcesPath, 'runtime.zip') : null;
const NODE_CANDIDATES = [
  path.join(appRoot, 'node.exe'),
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Program Files (x86)\\nodejs\\node.exe',
];
const nodeExe = NODE_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
const serverJs = path.join(appRoot, 'server.mjs');

// First boot / upgrade: extract the bundled runtime zip (Windows tar.exe, fast).
// Version stamp decides whether a re-extract is needed; user data lives elsewhere.
function ensureRuntime() {
  if (!runtimeZip) return Promise.resolve();
  const stamp = path.join(appRoot, '.version');
  const ver = app.getVersion();
  const valid = fs.existsSync(path.join(appRoot, 'server.mjs')) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === ver;
  if (valid) return Promise.resolve();
  try { fs.rmSync(appRoot, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(appRoot, { recursive: true });
  return new Promise((resolve, reject) => {
    const p = spawn(path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe'), ['-xf', runtimeZip, '-C', appRoot], { windowsHide: true });
    p.on('exit', (code) => {
      if (code === 0) { try { fs.writeFileSync(stamp, ver); } catch {} resolve(); }
      else reject(new Error('runtime extract failed: ' + code));
    });
    p.on('error', reject);
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); resolve(false); });
  });
}

function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

async function startServer() {
  if (await portOpen(PORT)) return;
  if (!nodeExe || !fs.existsSync(serverJs)) {
    throw new Error('找不到 node 或 server.mjs');
  }
  serverChild = spawn(nodeExe, [serverJs], {
    cwd: appRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PIWB_PARENT_PID: String(process.pid) },
  });
  serverChild.stdout.on('data', () => {});
  serverChild.stderr.on('data', (c) => appendLog('server stderr: ' + String(c).trim()));
  serverChild.on('exit', async (code) => {
    serverChild = null;
    if (quitting || code === 0) return;
    appendLog(`server exited unexpectedly (code ${code})`);
    // the port may still be served by another process, or the death may be transient —
    // give it a grace period, then auto-restart twice before bothering the user
    await sleep(1500);
    if (quitting || (await portOpen(PORT))) return;
    if (mainWindow && serverRestarts < 2) {
      serverRestarts++;
      appendLog(`auto-restarting server (attempt ${serverRestarts})`);
      try { await startServer(); return; } catch (e) { appendLog('restart failed: ' + e.message); }
    }
    dialog.showErrorBox('Pi Workbench', `后台服务异常退出（code ${code}）。日志：${LOG_FILE}`);
    app.quit();
  });
}

function killServer() {
  if (!serverChild) return;
  const pid = serverChild.pid;
  try { exec(`taskkill /pid ${pid} /T /F`); } catch {}
  try { serverChild.kill(); } catch {}
  serverChild = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#ffffff',
    title: 'Pi Workbench',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // keyboard/IME need the OS focus to actually land in the window — show() alone
  // leaves focus on the previous app, which kills Ctrl+C/V, Win+V and the IME popup
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.focus();
  });
  mainWindow.on('focus', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.focus(); });
  // right-click: Electron ships no context menu — build one so paste/copy work by mouse
  mainWindow.webContents.on('context-menu', (e, params) => {
    if (!mainWindow) return;
    const f = params.editFlags || {};
    const items = [
      { role: 'undo', label: '撤销', enabled: f.canUndo },
      { role: 'redo', label: '重做', enabled: f.canRedo },
      { type: 'separator' },
      { role: 'cut', label: '剪切', enabled: f.canCut },
      { role: 'copy', label: '复制', enabled: f.canCopy },
      { role: 'paste', label: '粘贴', enabled: f.canPaste },
      { role: 'selectAll', label: '全选', enabled: f.canSelectAll },
    ];
    if (params.linkURL) {
      items.push({ type: 'separator' }, { label: '在浏览器打开链接', click: () => shell.openExternal(params.linkURL) });
    }
    const { Menu } = require('electron');
    Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // explicit edit menu so Ctrl+C/X/V/A/Z accelerators are wired even with the bar hidden
  const { Menu } = require('electron');
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }, { role: 'windowMenu' }]));
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try { await ensureRuntime(); } catch (e) {
      dialog.showErrorBox('Pi Workbench', '运行时解压失败：' + e.message);
      app.quit();
      return;
    }
    try { await startServer(); } catch (e) {
      dialog.showErrorBox('Pi Workbench', '本地服务启动失败：' + e.message);
      app.quit();
      return;
    }
    const ok = await waitPort(PORT, 30000);
    if (!ok) {
      dialog.showErrorBox('Pi Workbench', '本地服务启动失败（127.0.0.1:32123 超时）。请重新启动应用。');
      app.quit();
      return;
    }
    createWindow();
  });

  app.on('before-quit', () => { quitting = true; killServer(); });
  app.on('quit', () => killServer());
  app.on('window-all-closed', () => { quitting = true; killServer(); app.quit(); });
}
