// scripts/ui-a11y-probe.mjs — browser-level assertions for the v1.3.9 review's
// keyboard / responsive / offline-queue items (P3-17 rail width, P3-18 dropdown
// keyboarding, P2-2 offline queue honesty).
//
// Why a browser and not a unit test: every one of these is a statement about what
// the RENDERED document does — where focus lands, which width a media query
// resolves to, whether a refused send left the text in the textarea. jsdom has no
// layout and no focus model, so a unit test for these would assert the source text
// back to itself. This drives real Chromium through CDP, same harness shape as
// chat-e2e / ui-contract-probe.
//
// Ports are OS-assigned: the fixed-port version of chat-e2e collided on CI and made
// the whole gate flaky.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

// CHROME_EXE wins (CI sets it from the browser Playwright just downloaded); otherwise
// ask the pinned playwright package where its browser lives, and only then fall back to
// a hard path. Resolving through the package keeps the local default and CI on the same
// browser build instead of two hand-maintained guesses.
const CHROME = process.env.CHROME_EXE
  || (() => {
    try {
      const { chromium } = require('playwright');
      const p = chromium.executablePath();
      if (p && fs.existsSync(p)) return p;
    } catch { /* playwright present but browser not downloaded — fall through */ }
    return path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1223', 'chrome-win64', 'chrome.exe');
  })();
const USERTMP = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : os.tmpdir();
fs.mkdirSync(USERTMP, { recursive: true });

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const waitPort = (port, timeoutMs) => new Promise((resolve) => {
  const deadline = Date.now() + timeoutMs;
  const tryOnce = () => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); if (Date.now() > deadline) return resolve(false); setTimeout(tryOnce, 250); });
  };
  tryOnce();
});

let ws;
let msgId = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  const t = setTimeout(() => { pending.delete(id); reject(new Error('cdp ' + method + ' timed out')); }, 30000);
  pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' — ' + detail));
  if (!ok) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = async (k) => {
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: KEYCODE[k] || 0 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: KEYCODE[k] || 0 });
};
const KEYCODE = { Escape: 27, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, Enter: 13, Space: 32 };

const kids = [];
// v1.4.2 review E5: shared scratch-dir cleanup — the watchdog's process.exit(2) skips
// finally, so a hung run used to leave a scratch HOME/project/chrome-profile behind.
const TMP_DIRS = [];
let tmpCleaned = false;
function cleanupTmpDirs() {
  if (tmpCleaned) return;
  tmpCleaned = true;
  if (!TMP_DIRS.length) return;
  const retryUntil = Date.now() + 3000;
  const pending = TMP_DIRS.slice();
  while (pending.length) {
    for (let i = pending.length - 1; i >= 0; i--) {
      try { fs.rmSync(pending[i], { recursive: true, force: true }); pending.splice(i, 1); } catch { /* windows may hold a handle — retry below */ }
    }
    if (!pending.length || Date.now() > retryUntil) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); // sync sleep (no timers inside exit)
  }
  for (const d of pending) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* give up */ } }
}
process.on('exit', cleanupTmpDirs);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanupTmpDirs(); process.exit(1); });
}
setTimeout(() => { console.log('GLOBAL WATCHDOG: 240s cap hit'); process.exit(2); }, 240000).unref();

try {
  const PORT = await freePort();
  const CDP_PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;

  const home = fs.mkdtempSync(path.join(USERTMP, 'piwb-a11y-'));
  const proj = fs.mkdtempSync(path.join(USERTMP, 'piwb-a11yp-'));
  TMP_DIRS.push(home, proj);
  const cfgDir = path.join(home, '.pi-workbench');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    projects: [{ path: proj, name: '可访问性探针' }], lang: 'zh', theme: 'dark',
  }));

  const server = spawn(process.execPath, [path.resolve('server.mjs')], {
    cwd: process.cwd(),
    env: { ...process.env, PIWB_EMBED_TOKEN: '1', PIWB_PORT: String(PORT), HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  kids.push(server);
  if (!(await waitPort(PORT, 15000))) throw new Error('server never listened');

  const profile = fs.mkdtempSync(path.join(USERTMP, 'piwb-a11yc-'));
  // v1.4.2 review E5: this probe was also missed by the v1.4.1 cleanup wave — the watchdog's
  // process.exit(2) skips finally, so a hung run left a scratch HOME/project/chrome-profile.
  TMP_DIRS.push(profile);
  const chromeLog = fs.openSync(path.join(USERTMP, 'ui-a11y-chrome.log'), 'w');
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile, '--no-first-run', '--disable-gpu',
    '--no-sandbox', '--window-size=1480,940', 'about:blank',
  ], { stdio: ['ignore', chromeLog, chromeLog] });
  kids.push(chrome);

  let pages;
  const deadline = Date.now() + 20000;
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
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
  });
  ws.once('close', () => { for (const [, p] of pending) p.reject(new Error('cdp socket closed')); pending.clear(); });

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: BASE + '/' });
  await sleep(2500);

  // ---------- P3-18: model menu is a real menu, operable from the keyboard ----
  // seed two models so the menu has rows to walk
  await evaluate(`(() => {
    window.__wb.state.modelsAvailable = [
      { provider: 'p1', id: 'model-a' }, { provider: 'p1', id: 'model-b' }, { provider: 'p1', id: 'model-c' },
    ];
    window.__wb.state.selModel = 'p1/model-a';
  })()`);
  await evaluate(`document.querySelector('#model-chip').click()`);
  await sleep(300);
  const m1 = await evaluate(`(() => {
    const menu = document.querySelector('.wb-dropdown');
    if (!menu) return { menu: false };
    const rows = [...menu.querySelectorAll('.dd-item')];
    return {
      menu: true,
      role: menu.getAttribute('role'),
      rowRole: rows[0] && rows[0].getAttribute('role'),
      rowCount: rows.length,
      focusIsRow: rows.includes(document.activeElement),
      checkedFocus: document.activeElement === rows.find((r) => r.getAttribute('aria-checked') === 'true'),
      tabIndexes: rows.map((r) => r.tabIndex),
    };
  })()`);
  check('P3-18 the model menu opens with role=menu and role=menuitem rows',
    m1.menu && m1.role === 'menu' && m1.rowRole === 'menuitem' && m1.rowCount === 3,
    JSON.stringify(m1));
  check('P3-18 focus lands on the current selection, not the document body',
    m1.focusIsRow === true && m1.checkedFocus === true, JSON.stringify(m1));
  check('P3-18 rows are programmatically focusable (tabindex=-1) so arrow keys have a roving origin',
    Array.isArray(m1.tabIndexes) && m1.tabIndexes.every((t) => t === -1), JSON.stringify(m1.tabIndexes));

  const before = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.wb-dropdown .dd-item')];
    return rows.indexOf(document.activeElement);
  })()`);
  await key('ArrowDown');
  await sleep(120);
  const afterDown = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.wb-dropdown .dd-item')];
    return { at: rows.indexOf(document.activeElement), label: document.activeElement && document.activeElement.textContent };
  })()`);
  check('P3-18 ArrowDown moves focus to the next menuitem',
    afterDown.at === (before + 1) % m1.rowCount, JSON.stringify({ before, afterDown }));

  await key('End');
  await sleep(120);
  const atEnd = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.wb-dropdown .dd-item')];
    return rows.indexOf(document.activeElement);
  })()`);
  check('P3-18 End jumps to the last menuitem', atEnd === m1.rowCount - 1, 'at=' + atEnd);

  await key('Escape');
  await sleep(200);
  const esc = await evaluate(`(() => ({
    gone: !document.querySelector('.wb-dropdown'),
    focusOnChip: document.activeElement === document.querySelector('#model-chip'),
  }))()`);
  check('P3-18 Escape closes the menu and returns focus to the anchor',
    esc.gone === true && esc.focusOnChip === true, JSON.stringify(esc));

  // ---------- P3-17: the rail follows the breakpoint, and the drawer too -----
  // the drawer is display:none until opened, and a hidden element measures 0 — so
  // open it first, or this check would "pass" the sibling question by measuring nothing
  const wide = await evaluate(`(() => {
    document.querySelector('#btn-logs').click();
    const cs = getComputedStyle(document.documentElement);
    return { railW: cs.getPropertyValue('--rail-w').trim(), rail: document.querySelector('#rail').getBoundingClientRect().width };
  })()`);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 820, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const narrow = await evaluate(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const rail = document.querySelector('#rail').getBoundingClientRect().width;
    const drawer = document.querySelector('#log-drawer');
    return {
      railW: cs.getPropertyValue('--rail-w').trim(), rail,
      drawerW: drawer && !drawer.classList.contains('hidden') ? drawer.getBoundingClientRect().width : null,
      inlineW: document.querySelector('#rail').style.width,
    };
  })()`);
  await cdp('Emulation.clearDeviceMetricsOverride');
  await sleep(300);
  check('P3-17 the rail is 220px wide on a wide viewport',
    wide.railW === '220px' && Math.round(wide.rail) === 220, JSON.stringify(wide));
  check('P3-17 a narrow viewport moves --rail-w to 176px AND the rail actually shrinks',
    narrow.railW === '176px' && Math.round(narrow.rail) === 176, JSON.stringify(narrow));
  check('P3-17 the wide-viewport inline width does not survive the breakpoint',
    !narrow.inlineW || narrow.inlineW === '176px', 'inline=' + narrow.inlineW);
  check('P3-17 the log drawer follows the same variable (it is a sibling, not a child)',
    narrow.drawerW !== null && Math.abs(narrow.drawerW - (820 - 176)) <= 2, 'drawer=' + narrow.drawerW);

  // ---------- P2-2: a refused send keeps the draft, and says so -------------
  const refused = await evaluate(`(async () => {
    const st = window.__wb.state;
    try { st.ws.close(); } catch {}
    for (let i = 0; i < 40 && st.wsReady; i++) await new Promise((r) => setTimeout(r, 100));
    // fill the bounded queue with frames that must never be silently dropped
    let accepted = 0;
    for (let i = 0; i < 260; i++) { if (window.__wb.rpcTo({ type: 'adopt', tabId: 'fill-' + i })) accepted++; else break; }
    const sent = window.__wb.rpcTo({ type: 'prompt', message: 'x' });
    return {
      wsReady: st.wsReady,
      accepted,
      sent,
      status: document.querySelector('#statusline').textContent,
    };
  })()`);
  check('P2-2 rpcTo returns false when the offline queue is full',
    refused.wsReady === false && refused.sent === false,
    JSON.stringify(refused));
  check('P2-2 the refusal is reported in the status line, not swallowed',
    /未能入队/.test(String(refused.status)) && /离线队列已满/.test(String(refused.status)),
    'status=' + refused.status);

  // and the composer itself: a refused submit must leave the text where it was
  const draft = await evaluate(`(async () => {
    const el = document.querySelector('#input');
    el.value = '这条草稿不能丢';
    document.querySelector('#btn-send').click();
    await new Promise((r) => setTimeout(r, 400));
    return { value: el.value, status: document.querySelector('#statusline').textContent };
  })()`);
  check('P2-3 a refused send leaves the draft in the composer',
    draft.value === '这条草稿不能丢', JSON.stringify(draft));

  const bootErrors = await evaluate(`(() => window.__bootErrors ? window.__bootErrors.length : -1)()`);
  check('no boot errors on the page', bootErrors === 0, 'bootErrors=' + bootErrors);
} catch (e) {
  console.log('PROBE ERROR:', (e && e.message) || e);
  process.exitCode = 1;
} finally {
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  await sleep(300);
  cleanupTmpDirs(); // same function as the exit hooks — one cleanup path (v1.4.2 review E5)
}
