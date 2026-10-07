// WS integration probe: exercise the resurrected event path end-to-end on the
// server half — open a tab (spawns real pi --mode rpc), assert the opened frame,
// replay rpc and pi-event fanout all flow. One-shot probe, not part of the suite
// (it needs the pi package installed).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';

const PORT = 39998;
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-wsprobe-'));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-wsproj-'));
const child = spawn(process.execPath, [path.resolve('server.mjs')], {
  cwd: process.cwd(),
  env: { ...process.env, PIWB_EMBED_TOKEN: '1', PIWB_PORT: String(PORT), HOME: home, USERPROFILE: home },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let failed = false;
try {
  // scrape the per-boot token
  let token = null;
  for (let i = 0; i < 60 && !token; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const page = await fetch(BASE + '/').then((r) => r.text());
      token = (page.match(/__API_TOKEN = "([0-9a-f]+)"/) || [])[1] || null;
    } catch { /* not up yet */ }
  }
  if (!token) throw new Error('server did not serve index');
  const up = await waitPort(PORT, 5000);
  if (!up) throw new Error('port never opened');

  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${token}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 10000);
  });
  ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });

  // the server only spawns pi inside registered projects — register the scratch one first
  await fetch(`${BASE}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-token': token },
    body: JSON.stringify({ projects: [{ path: proj, name: 'probe' }] }),
  });

  // open a tab with a real project dir — the server spawns pi --mode rpc
  ws.send(JSON.stringify({ type: 'open', tabId: 'probe-1', cwd: proj }));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no opened frame in 20s')), 20000);
    const iv = setInterval(() => {
      const f = events.find((e) => e.type === 'opened' && e.tabId === 'probe-1');
      if (f) { clearInterval(iv); clearTimeout(t); resolve(f); }
    }, 100);
  });
  console.log('opened frame OK');

  // rpc through the tab: pi must answer with response frames fanned out as pi-event
  ws.send(JSON.stringify({ type: 'rpc', tabId: 'probe-1', data: { id: 'probe-entries', type: 'get_entries' } }));
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await new Promise((r) => setTimeout(r, 200));
    const ev = events.find((e) => e.type === 'pi-event' && e.tabId === 'probe-1' && e.data?.type === 'response' && e.data?.command === undefined);
    const anyResponse = events.find((e) => e.type === 'pi-event' && e.tabId === 'probe-1' && e.data?.type === 'response');
    if (anyResponse) { console.log('pi-event response fanout OK (first response frame arrived)'); break; }
    if (ev) break;
  }
  const piEvents = events.filter((e) => e.type === 'pi-event' && e.tabId === 'probe-1');
  if (!piEvents.length) { failed = true; console.error('FAIL: no pi-event frames fanned out'); }
  else console.log('pi-event frames:', piEvents.length, '(types:', [...new Set(piEvents.map((e) => e.data?.type))].join(','), ')');

  // session-file discovery (attachPiReader's live hook)
  const sf = events.find((e) => e.type === 'pi-session-file');
  console.log('pi-session-file:', sf ? 'OK (' + sf.sessionFile + ')' : 'not emitted (pi may not create a session for get_entries only)');

  // adopt semantics: a second connection is blind to the tab while its owner lives;
  // after the owner's socket dies, only an explicit adopt reattaches (and grants rpc/close)
  const events2 = [];
  const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${token}`);
  await new Promise((resolve, reject) => { ws2.once('open', resolve); ws2.once('error', reject); setTimeout(() => reject(new Error('ws2 open timeout')), 10000); });
  ws2.on('message', (raw) => { try { events2.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
  ws2.send(JSON.stringify({ type: 'rpc', tabId: 'probe-1', data: { id: 'x0', type: 'get_entries' } }));
  await new Promise((r) => setTimeout(r, 1200));
  if (events2.some((e) => e.type === 'rpc-denied' && e.tabId === 'probe-1')) console.log('foreign rpc denied OK');
  else { failed = true; console.error('FAIL: foreign rpc was not denied'); }
  if (events2.some((e) => e.type === 'pi-event' && e.tabId === 'probe-1')) { failed = true; console.error('FAIL: foreign connection received tab frames'); }
  else console.log('foreign connection gets no tab frames OK');

  // owner socket dies — the tab keeps running, frames stop until the explicit adopt
  ws.close();
  await new Promise((r) => setTimeout(r, 800));
  ws2.send(JSON.stringify({ type: 'adopt', tabId: 'probe-1' }));
  const adoptDeadline = Date.now() + 5000;
  while (Date.now() < adoptDeadline && !events2.some((e) => e.type === 'adopted' && e.tabId === 'probe-1')) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (events2.some((e) => e.type === 'adopted' && e.tabId === 'probe-1')) console.log('adopt handshake OK');
  else { failed = true; console.error('FAIL: no adopted frame'); }

  // close semantics via the adopter: synthetic pi-exit is gone; the real exit must
  // arrive after close (Windows kill is async — pi teardown can take a few seconds)
  ws2.send(JSON.stringify({ type: 'rpc', tabId: 'probe-1', data: { id: 'x1', type: 'get_entries' } }));
  const rpcDeadline = Date.now() + 30000;
  while (Date.now() < rpcDeadline && !events2.some((e) => e.type === 'pi-event' && e.tabId === 'probe-1')) {
    await new Promise((r) => setTimeout(r, 300));
  }
  if (events2.some((e) => e.type === 'pi-event' && e.tabId === 'probe-1')) console.log('frames flow to adopter OK');
  else { failed = true; console.error('FAIL: no frames after adopt'); }

  events2.length = 0;
  ws2.send(JSON.stringify({ type: 'close', tabId: 'probe-1' }));
  const deadline = Date.now() + 10000;
  let exits = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    exits = events2.filter((e) => e.type === 'pi-exit' && e.tabId === 'probe-1');
    if (exits.length) break;
  }
  if (exits.length !== 1) { failed = true; console.error('FAIL: expected exactly 1 pi-exit after close, got', exits.length); }
  else console.log('close → exactly one real pi-exit OK (' + Math.round((Date.now() - deadline + 10000) / 100) / 10 + 's)');

  ws2.close();
  if (failed) process.exitCode = 1;
  else console.log('WS PROBE ALL PASS');
} catch (e) {
  console.error('PROBE ERROR:', e.message);
  process.exitCode = 1;
} finally {
  // tree kill on Windows: spawned pi children inherit the stdio pipe handles, so
  // killing only the server would leave the probe hanging on an open pipe.
  // Absolute path — a mangled/POSIX PATH must not turn this into a silent ENOENT.
  try {
    if (process.platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else child.kill();
  } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* windows may hold a handle */ }
  try { fs.rmSync(proj, { recursive: true, force: true }); } catch { /* ditto */ }
}
