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
let serverStartedAt = 0;

const LOG_FILE = path.join(app.getPath('userData'), 'server.log');
function appendLog(line) {
  try { console.log('[app] ' + line); } catch { /* stdout mirror so headless CI sees it in app.log */ }
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); // userData may not exist yet on a fresh/failed boot
    if (fs.statSync(LOG_FILE).size > 2e6) fs.writeFileSync(LOG_FILE, '');
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* the GUI must never crash over its own log — the console mirror above still survives */
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('[main] booted, electron', process.versions.electron, 'platform', process.platform);
const appRoot = app.isPackaged ? path.join(app.getPath('userData'), 'runtime') : path.join(__dirname, 'pkg-build');
const runtimeZip = app.isPackaged ? path.join(process.resourcesPath, 'runtime.zip') : null;
const IS_WIN = process.platform === 'win32';
const NODE_CANDIDATES = IS_WIN ? [
  path.join(appRoot, 'node.exe'),
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Program Files (x86)\\nodejs\\node.exe',
] : [
  path.join(appRoot, 'node'),
  '/usr/bin/node',
  '/usr/local/bin/node',
  '/opt/homebrew/bin/node',
];
const nodeExe = NODE_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } })
  || (() => { // version managers / per-user installs: resolve node from PATH as a last resort
    try { return require('child_process').execSync(IS_WIN ? 'where node.exe' : 'sh -c "command -v node"', { encoding: 'utf8', timeout: 5000 }).split(/\r?\n/)[0].trim(); } catch { return null; }
  })();
const serverJs = path.join(appRoot, 'server.mjs');

// Minimal zip reader (same format as zip.mjs): EOCD scan + central directory +
// inflateRaw. Inlined because the packaged app must never depend on a file
// outside its own entry for boot-critical work.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function cjsReadZip(buf) {
  // caps mirror zip.mjs readZip — this input ships with the app, but the guard is free
  const MAX_ENTRIES = 50000;
  const MAX_TOTAL_UNCOMPRESSED = 1024 * 1024 * 1024;
  let totalUncompressed = 0;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('not a zip (no EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_ENTRIES) throw new Error('zip has too many entries (' + count + ')');
  let ptr = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(ptr + 10);
    const csize = buf.readUInt32LE(ptr + 20);
    const crc = buf.readUInt32LE(ptr + 16);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    const l = localOffset;
    const lNameLen = buf.readUInt16LE(l + 26);
    const lExtraLen = buf.readUInt16LE(l + 28);
    const dataStart = l + 30 + lNameLen + lExtraLen;
    const payload = buf.subarray(dataStart, dataStart + csize);
    const data = method === 0 ? Buffer.from(payload) : require('zlib').inflateRawSync(payload);
    totalUncompressed += data.length;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) throw new Error('zip expands beyond 1GB — refusing');
    if (crc32(data) !== crc) throw new Error('crc mismatch for ' + name);
    out.push({ name, data });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
// First boot / upgrade: extract the bundled runtime zip (Windows tar.exe, fast).
// Version stamp decides whether a re-extract is needed; user data lives elsewhere.
function ensureRuntime() {
  if (!runtimeZip) return Promise.resolve();
  const stamp = path.join(appRoot, '.version');
  // signature = app version + runtime zip identity, so a rebuilt installer with the
  // same version still re-extracts (the old version-only stamp skipped stale runtimes)
  let sig = app.getVersion();
  try { const st = fs.statSync(runtimeZip); sig += `|${st.size}|${Math.floor(st.mtimeMs)}`; } catch { /* missing zip: keep the version-only signature */ }
  const valid = fs.existsSync(path.join(appRoot, 'server.mjs')) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === sig;
  if (valid) return Promise.resolve();
  try {
    fs.rmSync(appRoot, { recursive: true, force: true });
  } catch (err) {
    // force only forgives ENOENT — EBUSY/EPERM (AV scan, an Explorer window, a
    // lingering node whose parent-watchdog hasn't fired yet) must abort here, or
    // tar extracts over a half-removed tree and the stamp certifies the mix as fresh
    appendLog('ensureRuntime rm failed: ' + err.message);
    throw new Error('旧运行时清理失败（可能有文件被占用）: ' + err.message);
  }
  fs.mkdirSync(appRoot, { recursive: true });
  // Extract with our own zip reader — no PATH dependence at all. This used to shell
  // out to tar.exe/unzip, which broke inside AppImages: AppRun prepends APPDIR/usr/bin
  // to PATH, so the spawned `unzip` resolved to something inside the AppImage and
  // exited 80 with no output. readZip is the same primitive the backup feature uses.
  return (async () => {
    const entries = cjsReadZip(fs.readFileSync(runtimeZip));
    let realRoot = appRoot;
    try { realRoot = fs.realpathSync(appRoot); } catch { /* fresh dir not yet on disk: lexical is all we have */ }
    for (const entry of entries) {
      const rel = entry.name.split('/').join(path.sep);
      const dest = path.join(appRoot, rel);
      if (!path.resolve(dest).startsWith(path.resolve(appRoot) + path.sep)) throw new Error('zip-slip blocked: ' + entry.name);
      if (realRoot !== appRoot && !path.resolve(dest).startsWith(realRoot + path.sep)) throw new Error('zip-slip via symlinked root blocked: ' + entry.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.data);
    }
    try { fs.writeFileSync(stamp, sig); } catch { /* stamp failure only costs a re-extract next boot */ }
  })();
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); resolve(false); });
  });
}

// the port alone is not identity — a foreign process on 32123 must not get its UI
// loaded into the shell; the workbench answers an unauthenticated /api/kernel with
// a plain-text "403 ... forbidden", which is a cheap handshake to verify
function isWorkbenchPort(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = '';
    const done = (v) => { try { s.destroy(); } catch { /* already gone */ } resolve(v); };
    s.setTimeout(1500);
    s.once('connect', () => s.write('GET /api/kernel HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n'));
    s.on('data', (c) => { buf += String(c); if (buf.length > 4096) done(buf.includes('403') && buf.includes('forbidden')); });
    s.once('end', () => done(buf.includes('403') && buf.includes('forbidden')));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
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

// Runtime manifest check: CI writes manifest.json (sha256 per runtime file) at
// assembly time; after extraction we re-hash and refuse to spawn on drift. A
// v1.1.2-class assembly omission must die here loudly, not as ERR_MODULE_NOT_FOUND.
function verifyRuntimeManifest() {
  const mfPath = path.join(appRoot, 'manifest.json');
  if (!fs.existsSync(mfPath)) return null; // dev run — nothing to check
  const { createHash } = require('node:crypto');
  let mf;
  try { mf = JSON.parse(fs.readFileSync(mfPath, 'utf8')); } catch (e) {
    return { total: 0, bad: ['manifest unreadable: ' + e.message] };
  }
  const bad = [];
  const entries = Object.entries(mf.files || {});
  for (const [rel, want] of entries) {
    let ok = false;
    try {
      const buf = fs.readFileSync(path.join(appRoot, rel));
      ok = buf.length === want.size && createHash('sha256').update(buf).digest('hex') === want.sha256;
    } catch { ok = false; }
    if (!ok && bad.length < 8) bad.push(rel);
    else if (!ok) bad.push('…');
  }
  return { total: entries.length, bad };
}

async function startServer() {
  if (await portOpen(PORT)) {
    if (await isWorkbenchPort(PORT)) return; // our own previous instance
    throw new Error('端口 ' + PORT + ' 已被其它程序占用');
  }
  if (!nodeExe || !fs.existsSync(serverJs)) {
    // diagnostics for headless CI boot failures: which candidates were checked
    const seen = NODE_CANDIDATES.map((cand) => cand + '=' + (() => { try { return fs.existsSync(cand); } catch { return 'ERR'; } })()).join(', ');
    appendLog('startServer: nodeExe=' + String(nodeExe) + ' serverJs=' + serverJs + ' exists=' + fs.existsSync(serverJs) + ' candidates: ' + seen);
    throw new Error('找不到 node 或 server.mjs (candidates: ' + seen + ')');
  }
  serverChild = spawn(nodeExe, [serverJs], {
    cwd: appRoot,
    windowsHide: true,
    detached: !IS_WIN, // own process group on POSIX so killServer can signal the whole tree
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PIWB_PARENT_PID: String(process.pid) },
  });
  serverStartedAt = Date.now();
  serverChild.on('error', (err) => appendLog('server spawn error: ' + err.message));
  serverChild.stdout.on('data', () => {});
  serverChild.stderr.on('data', (c) => appendLog('server stderr: ' + String(c).trim()));
  serverChild.on('exit', async (code) => {
    serverChild = null;
    if (quitting || code === 0) return;
    appendLog(`server exited unexpectedly (code ${code})`);
    // the port may still be served by another process, or the death may be transient —
    // give it a grace period, then auto-restart twice before bothering the user
    await sleep(1500);
    if (quitting) return;
    if (await portOpen(PORT)) {
      if (await isWorkbenchPort(PORT)) return; // a healthy instance is serving again
      appendLog('the port is held by a foreign process after the crash');
    }
    if (Date.now() - serverStartedAt > 5 * 60000) serverRestarts = 0; // a long stable run resets the restart budget
    if (serverRestarts < 2) {
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
  if (serverChild.exitCode !== null || serverChild.signalCode) { serverChild = null; return; } // already dead — never force-kill a possibly recycled pid
  const pid = serverChild.pid;
  if (IS_WIN) {
    try { exec(`taskkill /pid ${pid} /T /F`); } catch { /* pid may already be gone */ }
  } else {
    // the server was spawned detached with its own process group — one signal takes down the whole tree, pi grandchildren included
    try { process.kill(-pid, 'SIGTERM'); } catch { /* group may already be gone */ }
  }
  try { serverChild.kill(); } catch { /* teardown is best-effort */ }
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
  mainWindow.loadURL(`http://127.0.0.1:${PORT}`).catch((err) => {
    // the server can die between waitPort and this load — an unhandled rejection
    // here would bypass every friendly dialog above
    appendLog('FATAL loadURL: ' + err.message);
    dialog.showErrorBox('Pi Workbench', '界面加载失败。请重新启动应用。');
    app.quit();
  });
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

  console.log('[main] requesting single-instance lock + whenReady');
  app.whenReady().then(async () => {
    console.log('[main] whenReady fired');
    console.log('[main] calling ensureRuntime');
    try { await ensureRuntime(); } catch (e) {
      appendLog('FATAL ensureRuntime: ' + e.message);
      dialog.showErrorBox('Pi Workbench', '运行时解压失败：' + e.message);
      app.quit();
      return;
    }
    console.log('[main] ensureRuntime done');
    const mf = verifyRuntimeManifest();
    if (mf) {
      if (mf.bad.length) {
        appendLog('FATAL manifest verify: ' + mf.bad.join(', ') + ' (of ' + mf.total + ')');
        dialog.showErrorBox('Pi Workbench', '运行时文件校验失败（安装可能损坏，请重新安装）：\n' + mf.bad.join('\n'));
        app.quit();
        return;
      }
      appendLog('manifest verified: ' + mf.total + ' files');
    }
    try { await startServer(); } catch (e) {
      appendLog('FATAL startServer: ' + e.message);
      dialog.showErrorBox('Pi Workbench', '本地服务启动失败：' + e.message);
      app.quit();
      return;
    }
    console.log('[main] server spawned, waiting port', PORT);
    const ok = await waitPort(PORT, 30000);
    if (!ok) {
      appendLog('FATAL waitPort timeout — server never listened on ' + PORT);
      dialog.showErrorBox('Pi Workbench', '本地服务启动失败（127.0.0.1:32123 超时）。请重新启动应用。');
      app.quit();
      return;
    }
    console.log('[main] port open, creating window');
    createWindow();
  });

  app.on('before-quit', () => { quitting = true; killServer(); });
  app.on('quit', () => killServer());
  app.on('window-all-closed', () => { quitting = true; killServer(); app.quit(); });
}
