// Failover chain E2E at the API/WS level (the browser path is chat-e2e.mjs — this
// one verifies the server-side chain semantics the UI drives):
//
//   failA — /chat/completions always 500        (chain head, default model)
//   failB — /chat/completions always 429
//   okC  — streams "1 加 1 等于 2。"
//   chain: [failA/m1, failB/m2, okC/m3]
//
// Pass criteria:
//   1. real pi errors on failA and the error surfaces as a pi-event
//   2. /api/routing/fail walks the chain: failA→failB→okC
//   3. a cooled middle hop is skipped: after cooling failB, next(failA) = okC
//   4. auth-shaped failures cool the key, not the model (401 branch)
//   5. reopening the tab on okC streams a real reply through pi (mock hit counted)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = 39987;
const BASE = `http://127.0.0.1:${PORT}`;
const REPLY = '1 加 1 等于 2。';

const waitPort = (port, timeoutMs) => new Promise((resolve) => {
  const deadline = Date.now() + timeoutMs;
  const tryOnce = () => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); if (Date.now() > deadline) return resolve(false); setTimeout(tryOnce, 250); });
  };
  tryOnce();
});

function mockProvider(mode, hits) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url.includes('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
        }
        if (mode === 'fail500') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"mock primary down"}}'); }
        if (mode === 'fail429') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"mock rate limited"}}'); }
        hits.chat++;
        const stream = /"stream"\s*:\s*true/.test(body);
        res.writeHead(200, stream ? { 'content-type': 'text/event-stream' } : { 'content-type': 'application/json' });
        if (!stream) {
          return res.end(JSON.stringify({ id: 'ok', choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 8 } }));
        }
        const chunk = (delta, finish) => 'data: ' + JSON.stringify({ id: 'ok', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish ?? null }] }) + '\n\n';
        res.write(chunk({ role: 'assistant' }));
        for (const piece of ['1 加', ' 1 等于', ' 2。']) res.write(chunk({ content: piece }));
        res.write(chunk({}, 'stop'));
        res.end('data: [DONE]\n\n');
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
}

const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kids = [];
let child = null;
let ws = null;
setTimeout(() => { console.log('GLOBAL WATCHDOG: 240s cap hit'); process.exit(2); }, 240000).unref();

try {
  const hits = { chat: 0 };
  const [{ server: sA, port: portA }, { server: sB, port: portB }, { server: sC, port: portC }] =
    await Promise.all([mockProvider('fail500', hits), mockProvider('fail429', hits), mockProvider('ok', hits)]);
  kids.push(sA, sB, sC);
  console.log('stage: mocks up on', portA, portB, portC);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-fo-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-fop-'));
  const cfgDir = path.join(home, '.pi-workbench');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
  const provider = (port, key) => ({
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: key, api: 'openai-completions',
    models: [{ id: 'm1', name: 'Mock ' + port, contextWindow: 128000, maxTokens: 4096 }],
  });
  fs.writeFileSync(path.join(home, '.pi', 'agent', 'models.json'), JSON.stringify({
    providers: { failA: provider(portA, 'sk-a'), failB: provider(portB, 'sk-b'), okC: provider(portC, 'sk-c') },
  }));
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    projects: [{ path: proj, name: '回退链验收' }], lang: 'zh', theme: 'dark', defaultModel: 'failA/m1',
  }));

  child = spawn(process.execPath, [path.resolve('server.mjs')], {
    cwd: process.cwd(),
    env: { ...process.env, PIWB_EMBED_TOKEN: '1', PIWB_PORT: String(PORT), HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!(await waitPort(PORT, 15000))) throw new Error('server never listened');
  const page = await fetch(BASE + '/').then((r) => r.text());
  const token = (page.match(/__API_TOKEN = "([0-9a-f]+)"/) || [])[1];
  if (!token) throw new Error('token not found in served html');
  const api = (p, body, method = body === undefined ? 'GET' : 'POST') => fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

  const routing = await api('/api/routing', { chains: [['failA/m1', 'failB/m2', 'okC/m3']], providers: { failA: { enabled: true }, failB: { enabled: true }, okC: { enabled: true } } });
  check('routing chain registered', routing.status === 200 && routing.data?.chains?.[0]?.length === 3, JSON.stringify(routing.data?.chains));

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${token}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 10000);
  });
  const events = [];
  ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
  const waitEvent = async (pred, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error('timeout waiting for ' + label);
      await sleep(200);
    }
  };

  // tab on the failing head provider — real pi spawns
  ws.send(JSON.stringify({ type: 'open', tabId: 'fo-1', cwd: proj, model: 'failA/m1' }));
  await waitEvent((e) => e.type === 'opened' && e.tabId === 'fo-1', 20000, 'opened');
  console.log('stage: tab opened on failA/m1');

  // 1) real provider failure surfaces
  ws.send(JSON.stringify({ type: 'rpc', tabId: 'fo-1', data: { id: 'p1', type: 'prompt', message: '1+1=?' } }));
  const errEv = await waitEvent((e) => e.type === 'pi-event' && e.tabId === 'fo-1' &&
    JSON.stringify(e.data || {}).includes('mock primary down'), 45000, 'failA error event');
  check('pi surfaces the failA 500 as an error event', !!errEv);

  // 2) chain walk
  let r = await api('/api/routing/fail', { model: 'failA/m1', error: '500 mock primary down', tabId: 'fo-1' });
  check('failA -> next is failB/m2', r.data?.next === 'failB/m2', JSON.stringify(r.data));

  // 3) cooled middle hop is skipped
  await api('/api/routing/fail', { model: 'failB/m2', error: '429 mock rate limited', tabId: 'fo-1' });
  r = await api('/api/routing/fail', { model: 'failA/m1', error: '500 mock primary down', tabId: 'fo-1' });
  check('cooled failB skipped -> next is okC/m3', r.data?.next === 'okC/m3', JSON.stringify(r.data));

  // 4) auth-shaped failure takes the key path: the MODEL is not cooled (a literal-key
  // provider has no rotation pool, so no cooldown appears) and the chain still reaches okC
  r = await api('/api/routing/fail', { model: 'okC/m3', error: '401 invalid api key', tabId: 'fo-1' });
  check('401 branch: model not cooled (key path taken), chain end -> next null',
    r.data?.next === null && r.data?.cooldown === null, JSON.stringify(r.data));
  r = await api('/api/routing/fail', { model: 'failA/m1', error: '500 mock primary down', tabId: 'fo-1' });
  check('okC still reachable after its 401 (key cooled, not model)', r.data?.next === 'okC/m3', JSON.stringify(r.data));
  // clear okC state so step 5 can run clean
  await api('/api/routing/ok', { model: 'okC/m3' });

  // 5) reopen on okC and get a real streamed reply through pi
  ws.send(JSON.stringify({ type: 'close', tabId: 'fo-1' }));
  await waitEvent((e) => e.type === 'pi-exit' && e.tabId === 'fo-1', 15000, 'pi-exit');
  ws.send(JSON.stringify({ type: 'open', tabId: 'fo-2', cwd: proj, model: 'okC/m3' }));
  await waitEvent((e) => e.type === 'opened' && e.tabId === 'fo-2', 20000, 'opened fo-2');
  ws.send(JSON.stringify({ type: 'rpc', tabId: 'fo-2', data: { id: 'p2', type: 'prompt', message: '1+1=?' } }));
  const reply = await waitEvent((e) => e.type === 'pi-event' && e.tabId === 'fo-2' &&
    JSON.stringify(e.data || {}).includes('2。'), 60000, 'streamed reply from okC');
  check('real streamed reply via okC through pi', !!reply);

  check('okC mock actually hit by pi', hits.chat >= 1, 'hits=' + hits.chat);

  ws.close();
  console.log(process.exitCode ? 'FAILOVER E2E FAILED' : 'FAILOVER E2E ALL PASS');
} catch (e) {
  console.error('PROBE ERROR:', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* gone */ }
  try {
    if (process.platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else child?.kill();
  } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 500));
  for (const k of kids) { try { k.close(); } catch { /* mock already closed */ } }
}
