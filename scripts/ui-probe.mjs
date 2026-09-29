// UI end-to-end probe: boots the real panel in headless Chromium via CDP and
// verifies what only a browser can verify — boot cleanliness, WS connection,
// every panel switching, session replay rendering real bubbles, cron rows.
// Screenshots land in ui-shots/ next to this script for human review.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const CHROME = process.env.CHROME_EXE
  || path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1223', 'chrome-win64', 'chrome.exe');
const PORT = 39990;
const CDP_PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}`;

const waitPort = (port, timeoutMs) => new Promise((resolve) => {
  const deadline = Date.now() + timeoutMs;
  const tryOnce = () => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); if (Date.now() > deadline) return resolve(false); setTimeout(tryOnce, 250); });
  };
  tryOnce();
});

const httpGet = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers }, (r) => {
    let b = '';
    r.on('data', (c) => { b += c; });
    r.on('end', () => resolve({ status: r.statusCode, body: b }));
  }).on('error', reject);
});

// ---------- fixture: scratch home with a project, a session, a cron job ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-uiprobe-'));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-uiproj-'));
fs.writeFileSync(path.join(proj, 'calc.py'), 'print(1/0)\n');
const cfgDir = path.join(home, '.pi-workbench');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
  projects: [{ path: proj, name: '验收项目' }],
  lang: 'zh', theme: 'dark',
}));
fs.writeFileSync(path.join(cfgDir, 'cron.json'), JSON.stringify({
  jobs: [{ id: 'job-ui', name: '每日问候', kind: 'daily', time: '03:00', prompt: '问个好', enabled: true }],
}));
const sessDir = path.join(home, '.pi', 'agent', 'sessions', encodeURIComponent(proj));
fs.mkdirSync(sessDir, { recursive: true });
const sessFile = path.join(sessDir, 'ui-session.jsonl');
const msg = (id, role, text, parentId) => JSON.stringify({
  id, parentId: parentId || undefined, type: 'message', timestamp: '2026-09-29T00:00:0' + id.slice(-1) + 'Z',
  message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
});
fs.writeFileSync(sessFile, [
  JSON.stringify({ type: 'session', cwd: proj, id: 'ui-session' }),
  msg('m1', 'user', '帮我看看这个项目为什么崩溃'),
  msg('m2', 'assistant', '我看了：calc.py 在除以零。加一个除数检查就好了。', 'm1'),
].join('\n') + '\n');
fs.writeFileSync(path.join(home, '.pi', 'agent', 'models.json'), JSON.stringify({ providers: {} }));

// ---------- start server ----------
const server = spawn(process.execPath, [path.resolve('server.mjs')], {
  cwd: process.cwd(),
  env: { ...process.env, PIWB_PORT: String(PORT), HOME: home, USERPROFILE: home },
  stdio: ['ignore', 'pipe', 'pipe'],
});

// ---------- start chromium ----------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-uichrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + profile, '--no-first-run', '--disable-gpu',
  '--window-size=1480,940', 'about:blank',
], { stdio: 'ignore' });

const shots = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'ui-shots');
fs.mkdirSync(shots, { recursive: true });

let ws; // CDP websocket
let msgId = 0;
const pending = new Map();
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const evaluate = async (expr, sid) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) throw new Error('page eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) process.exitCode = 1;
};

try {
  if (!fs.existsSync(CHROME)) throw new Error('chrome not found: ' + CHROME);
  if (!await waitPort(PORT, 20000)) throw new Error('server port never opened');

  // attach CDP
  for (let i = 0; i < 40; i++) {
    try {
      const list = JSON.parse((await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`)).body);
      const page = list.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        break;
      }
    } catch { /* chrome booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ws) throw new Error('CDP never came up');
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  const { sessionId: sid } = await cdp('Target.attachToTarget', { targetId: (await cdp('Target.getTargets')).targetInfos.find((t) => t.type === 'page').targetId, flatten: true });

  // console errors + boot errors collector
  const consoleErrors = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    }
  });

  await cdp('Page.navigate', { url: BASE + '/' }, sid);
  await new Promise((r) => setTimeout(r, 3500)); // boot: fetch config/kernel, ws connect

  // 1. boot cleanliness
  const bootErrors = await evaluate('window.__bootErrors ? JSON.stringify(window.__bootErrors) : "[]"', sid);
  check('启动无错误', bootErrors === '[]', bootErrors);
  const dot = await evaluate("document.querySelector('#conn-dot') ? document.querySelector('#conn-dot').className : 'missing'", sid);
  check('WS 已连接（conn-dot on）', String(dot).includes('on'), dot);

  // 2. project tree rendered with our fixture project + session
  const projName = await evaluate("!![...document.querySelectorAll('#rail *')].find((el) => el.textContent === '验收项目')", sid);
  check('项目树渲染（验收项目）', projName === true);

  // 3. open the seeded session → replay renders real bubbles
  await evaluate("(() => { const el = [...document.querySelectorAll('.session-item, .conv-line, [data-file]')].find((e) => e.textContent.includes('ui-session') || e.dataset.title); if (el) { el.click(); return 'clicked'; } return 'not-found'; })()", sid);
  await new Promise((r) => setTimeout(r, 6000)); // spawn pi + get_entries + renderReplay
  const bubbles = await evaluate("document.querySelectorAll('#timeline .msg').length", sid);
  check('会话回放渲染气泡', bubbles >= 2, bubbles + ' bubbles');
  const hasUser = await evaluate("!![...document.querySelectorAll('#timeline .msg')].find((m) => m.textContent.includes('帮我看看这个项目为什么崩溃'))", sid);
  check('回放含用户消息', hasUser === true);
  const hasAssistant = await evaluate("!![...document.querySelectorAll('#timeline .msg')].find((m) => m.textContent.includes('除数检查'))", sid);
  check('回放含助手回复', hasAssistant === true);

  // 4. every rail panel switches on click and renders without exceptions
  const panels = await evaluate("[...document.querySelectorAll('.rail-item[data-panel]')].map((b) => b.dataset.panel)", sid);
  let panelFails = [];
  for (const p of panels) {
    await evaluate(`(() => { const b = document.querySelector('.rail-item[data-panel="' + ${JSON.stringify(p)} + '"]'); if (b) b.click(); })()`, sid);
    await new Promise((r) => setTimeout(r, 700));
    const vis = await evaluate(`(() => { const el = document.querySelector('#panel-${p}'); return el ? !el.classList.contains('hidden') : 'no-panel'; })()`, sid);
    if (vis !== true) panelFails.push(p + ':' + vis);
  }
  check('全部面板可切换（' + panels.length + ' 个）', panelFails.length === 0, panelFails.join(',') || 'all visible');
  check('面板切换无 console error', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));

  // 5. cron panel shows the seeded job row
  await evaluate(`document.querySelector('.rail-item[data-panel="cron"]').click()`, sid);
  await new Promise((r) => setTimeout(r, 900));
  const cronRow = await evaluate("!!document.body.textContent.includes('每日问候')", sid);
  check('定时任务行渲染（每日问候）', cronRow === true);

  // 6. screenshots for human review
  await evaluate(`document.querySelector('.rail-item[data-panel="workbench"]')?.click()`, sid);
  await new Promise((r) => setTimeout(r, 900));
  const shot1 = await cdp('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(shots, 'workbench-replay.png'), Buffer.from(shot1.data, 'base64'));
  // cron lives in the config view's rail: switch the top nav first, then its rail item
  await evaluate(`document.querySelector('.tn-view[data-view="config"]').click()`, sid);
  await new Promise((r) => setTimeout(r, 500));
  await evaluate(`document.querySelector('.rail-item[data-panel="cron"]')?.click()`, sid);
  await new Promise((r) => setTimeout(r, 900));
  const shot2 = await cdp('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(shots, 'panel-cron.png'), Buffer.from(shot2.data, 'base64'));
  await evaluate(`document.querySelector('.rail-item[data-panel="models"]')?.click()`, sid);
  await new Promise((r) => setTimeout(r, 1200));
  const shot3 = await cdp('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(shots, 'panel-models.png'), Buffer.from(shot3.data, 'base64'));
  // advanced view: usage dashboard
  await evaluate(`document.querySelector('.tn-view[data-view="advanced"]').click()`, sid);
  await new Promise((r) => setTimeout(r, 500));
  await evaluate(`document.querySelector('.rail-item[data-panel="usage"]')?.click()`, sid);
  await new Promise((r) => setTimeout(r, 1500));
  const shot4 = await cdp('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(shots, 'panel-usage.png'), Buffer.from(shot4.data, 'base64'));
  check('截图落盘', fs.existsSync(path.join(shots, 'workbench-replay.png')), shots);

  console.log(process.exitCode ? 'UI PROBE: FAILURES ABOVE' : 'UI PROBE ALL PASS');
} catch (e) {
  console.error('UI PROBE ERROR:', e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch { /* gone */ }
  try { chrome.kill(); } catch { /* gone */ }
  try { server.kill(); } catch { /* gone */ }
  await new Promise((r) => setTimeout(r, 800));
  for (const d of [home, proj, profile]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows handles */ } }
}
