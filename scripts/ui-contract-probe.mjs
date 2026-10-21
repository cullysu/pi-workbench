// ui-contract-probe.mjs — browser-level REVERSE tests for the front-end state
// contracts from the v1.2.6 review. ui-probe screenshots and chat-e2e streaming
// don't cover these; each case asserts a behavior must NOT happen (or must).
//
//   T1 import isolation: with an import view open, submit must be refused and no
//      open/prompt frame may reach the wire
//   T2 escape answers confirm: dismissing an extension confirm sends
//      { confirmed: false } instead of leaving a timeout-less extension waiting
//
// Same CDP pattern as chat-e2e (playwright is not a dependency of this repo).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws'); // the global WebSocket (undici) lacks .once — the ws package is the repo's own dependency

const CHROME = process.env.CHROME_EXE
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1223', 'chrome-win64', 'chrome.exe');
// Ports are picked by the OS (port 0) so a leftover instance can never be mistaken
// for this probe's server or CDP endpoint. (v1.4.1 review #4)
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const PORT = await freePort(); // server port — OS-assigned, not the fixed 39991
const CDP_PORT = await freePort(); // chrome CDP — OS-assigned, not the fixed 9341
const BASE = `http://127.0.0.1:${PORT}`;
const USERTMP = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : os.tmpdir();
fs.mkdirSync(USERTMP, { recursive: true });

const waitPort = (port, timeoutMs) => new Promise((resolve) => {
  const deadline = Date.now() + timeoutMs;
  const tryOnce = () => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); if (Date.now() > deadline) return resolve(false); setTimeout(tryOnce, 250); });
  };
  tryOnce();
});

let ws, msgId = 0;
const pending = new Map();
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++msgId;
  const t = setTimeout(() => { pending.delete(id); reject(new Error('cdp ' + method + ' timed out')); }, 30000);
  pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const evaluate = async (expr, sid) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) throw new Error('page eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' — ' + detail));
  if (!ok) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kids = [];

// Scratch HOME / project / chrome profile are registered here and removed by ONE
// function called from finally and from the process hooks: the watchdog's exit(2)
// and an uncaught throw skip finally, and each skipped run used to leave the dirs
// behind on the self-hosted runner. exit() may only do sync work. The bounded retry
// is sync on purpose: a killed chrome needs ~1s to release its profile handles, so a
// single rmSync attempt right after kill() fails with EPERM. (v1.4.1 review #9)
const TMP_DIRS = [];
let tmpCleaned = false;
function cleanupTmpDirs() {
  if (tmpCleaned) return;
  tmpCleaned = true;
  const retryUntil = Date.now() + 3000;
  const pending = TMP_DIRS.slice();
  while (pending.length) {
    for (let i = pending.length - 1; i >= 0; i--) {
      try { fs.rmSync(pending[i], { recursive: true, force: true }); pending.splice(i, 1); } catch { /* windows may still hold a handle — retry below */ }
    }
    if (!pending.length || Date.now() > retryUntil) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); // sync sleep (no timers inside exit)
  }
  for (const d of pending) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* give up: a live chrome still owns it */ } }
}
process.on('exit', cleanupTmpDirs);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanupTmpDirs(); process.exit(1); });
}

setTimeout(() => { console.log('GLOBAL WATCHDOG: 240s cap hit'); process.exit(2); }, 240000).unref();

try {
  const home = fs.mkdtempSync(path.join(USERTMP, 'piwb-uc-'));
  const proj = fs.mkdtempSync(path.join(USERTMP, 'piwb-ucp-'));
  TMP_DIRS.push(home, proj); // register before any write: a throw below must still clean up
  const cfgDir = path.join(home, '.pi-workbench');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    projects: [{ path: proj, name: '契约探针' }], lang: 'zh', theme: 'dark',
  }));

  const server = spawn(process.execPath, [path.resolve('server.mjs')], {
    cwd: process.cwd(),
    env: { ...process.env, PIWB_EMBED_TOKEN: '1', PIWB_PORT: String(PORT), HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  kids.push(server);
  if (!(await waitPort(PORT, 15000))) throw new Error('server never listened');

  const profile = fs.mkdtempSync(path.join(USERTMP, 'piwb-ucc-'));
  TMP_DIRS.push(profile); // registered as soon as it exists (v1.4.1 review #9)
  const chromeLog = fs.openSync(path.join(USERTMP, 'ui-contract-chrome.log'), 'w');
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile, '--no-first-run', '--disable-gpu',
    '--no-sandbox', '--window-size=1480,940', 'about:blank',
  ], { stdio: ['ignore', chromeLog, chromeLog] });
  kids.push(chrome);

  const deadline = Date.now() + 20000;
  let pages;
  for (;;) {
    try {
      const t = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json());
      pages = t.filter((p) => p.type === 'page');
      if (pages.length) break;
    } catch { /* chrome still booting */ }
    if (Date.now() > deadline) throw new Error('chrome never exposed /json');
    await sleep(300);
  }
  ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    setTimeout(() => reject(new Error('cdp ws open timeout')), 10000);
  });
  // the response router — without it every cdp() call waits forever
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
  });
  ws.once('close', () => { for (const [, p] of pending) p.reject(new Error('cdp socket closed')); pending.clear(); });

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: BASE + '/' });
  await sleep(2500); // app boot + ws connect

  // instrument the wire: record every frame the page actually sends
  await evaluate(`(() => {
    window.__sentFrames = [];
    // prototype-level patch: one shot covers the live socket AND every reconnect.
    // (The earlier per-instance property hijack destroyed state.ws — the accessor
    // replaced the data property and the app then read ws === undefined.)
    const proto = Object.getPrototypeOf(window.__wb.state.ws);
    if (!proto.__sentFramesPatched) {
      proto.__sentFramesPatched = true;
      const orig = proto.send;
      proto.send = function (data) {
        try { window.__sentFrames.push(JSON.parse(data)); } catch { window.__sentFrames.push({ raw: String(data) }); }
        return orig.call(this, data);
      };
    }
  })()`);

  // T1: import isolation — an open import view must refuse submission and emit nothing
  await evaluate(`(() => { window.__wb.state.importView = true; })()`);
  await evaluate(`(() => {
    const el = document.querySelector('#input');
    el.value = '这条不该被发送';
    document.querySelector('#btn-send').click();
  })()`);
  await sleep(600);
  const t1 = await evaluate(`(() => ({
    status: document.querySelector('#statusline')?.textContent || '',
    frames: (window.__sentFrames || []).filter((f) => f.type === 'open' || (f.type === 'rpc' && f.data?.type === 'prompt')),
    rawHasText: JSON.stringify(window.__sentFrames || []).includes('这条不该被发送'),
  }))()`);
  check('T1 import view blocks submission with an explanation',
    String(t1.status).includes('只读') && t1.frames.length === 0 && !t1.rawHasText,
    JSON.stringify({ status: t1.status, frames: t1.frames, rawHasText: t1.rawHasText }));
  await evaluate(`(() => { window.__wb.state.importView = false; })()`);

  // T2: Escape on an extension confirm answers { confirmed: false } on the wire
  await evaluate(`(() => { window.__wb.uiRequest({ id: 'uc-1', method: 'confirm', title: '契约探针', message: '确认？' }); })()`);
  await sleep(300);
  const modalShown = await evaluate(`(() => !document.querySelector('#modal-backdrop')?.classList.contains('hidden'))()`);
  check('T2a extension confirm dialog opens via uiRequest', modalShown);
  // canary: a direct send through the app's own ws must land in __sentFrames
  const canary = await evaluate(`(() => {
    try { window.__wb.state.ws.send(JSON.stringify({ type: 'probe-canary' })); return 'sent'; }
    catch (e) { return 'throw: ' + e.message; }
  })()`);
  await sleep(200);
  const canarySeen = await evaluate(`(() => (window.__sentFrames || []).some((f) => f.type === 'probe-canary'))()`);
  check('T2-pre canary frame is captured by the wire patch', canary === 'sent' && canarySeen, canary + ' seen=' + canarySeen);
  await evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
  await sleep(400);
  const t2 = await evaluate(`(() => ({
    modalHidden: document.querySelector('#modal-backdrop')?.classList.contains('hidden'),
    reply: (window.__sentFrames || []).filter((f) => f.type === 'rpc' && f.data?.type === 'extension_ui_response' && f.data?.id === 'uc-1').pop(),
    wsPatched: window.__wb.state.ws ? !!window.__wb.state.ws.__patched : null,
    wsReady: window.__wb.state.wsReady,
  }))()`);
  check('T2b dismissing confirm replies { confirmed: false } on the wire',
    t2.modalHidden && t2.reply?.data?.confirmed === false, JSON.stringify(t2));

  const pageErrors = await evaluate(`(() => window.__bootErrors ? window.__bootErrors.length : -1)()`);
  check('no boot errors on the page', pageErrors === 0, 'bootErrors=' + pageErrors);
} catch (e) {
  console.log('PROBE ERROR:', (e && e.message) || e);
  process.exitCode = 1;
} finally {
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  await sleep(300);
  cleanupTmpDirs(); // same function as the exit hooks (v1.4.1 review #9)
}
