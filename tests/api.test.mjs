// API-level tests: spawn server.mjs against an isolated HOME on a scratch port,
// then exercise every endpoint group. No user data is touched (USERPROFILE/HOME
// point at a temp dir for the child process).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PORT = 39944;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.dirname(fileURLToPath(import.meta.url));

let child = null;
let tmpHome = '';
let tmpProj = '';
let backupZip = '';

let TOKEN = '';
const hdrs = () => (TOKEN ? { 'x-api-token': TOKEN } : {});
const get = (p, timeout = 15000) => fetch(BASE + p, { headers: hdrs(), signal: AbortSignal.timeout(timeout) });
const req = async (p, body, method = body === undefined ? 'GET' : 'POST', timeout = 20000) => {
  const opts = { method, signal: AbortSignal.timeout(timeout), headers: hdrs() };
  if (method === 'POST') {
    opts.headers = { 'content-type': 'application/json', ...hdrs() };
    opts.body = JSON.stringify(body ?? {});
  }
  const r = await fetch(BASE + p, opts);
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
};

function waitPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error('server did not start'));
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

test.before(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-test-home-'));
  tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-test-proj-'));
  fs.mkdirSync(path.join(tmpHome, '.pi', 'agent', 'sessions', 'proj'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, '.pi', 'agent', 'sessions', 'proj', 'fake-session.jsonl'),
    JSON.stringify({ type: 'session', cwd: tmpProj }) + '\n',
  );
  fs.mkdirSync(path.join(tmpHome, '.pi', 'agent', 'models'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.pi', 'agent', 'models.json'), JSON.stringify({ providers: {} }));
  fs.mkdirSync(path.join(tmpHome, '.agents', 'skills', 'demo-skill'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.agents', 'skills', 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: test skill for the workbench suite\n---\n# Demo\n');

  child = spawn(process.execPath, [path.join(ROOT, '..', 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PIWB_EMBED_TOKEN: '1', PIWB_PORT: String(PORT), HOME: tmpHome, USERPROFILE: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (c) => process.env.PIWB_TEST_DEBUG && process.stderr.write(c));
  await waitPort(PORT);
  // scrape the per-boot token out of the served index.html
  const page = await fetch(BASE + '/').then((r) => r.text());
  const m = page.match(/__API_TOKEN = "([0-9a-f]+)"/);
  assert.ok(m, 'token embedded in served html');
  TOKEN = m[1];
});

test.after(async () => {
  if (child) {
    // tree kill on Windows: the server's spawned children (pi) inherit the stdio
    // pipe handles, so killing only the server leaves the suite waiting on a pipe
    // that stays open until the grandchild dies. Absolute path — a mangled/POSIX
    // PATH must not turn this into a silent ENOENT.
    try {
      if (process.platform === 'win32') {
        const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else child.kill();
    } catch { /* already exited */ }
    await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); });
  }
  for (const dir of [tmpHome, tmpProj]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may still hold a handle */ }
  }
});

test('kernel reports shape and uses scratch home', async () => {
  const { status, data } = await req('/api/kernel');
  assert.equal(status, 200);
  assert.ok('pi' in data, 'pi version field present'); // null when pi package not installed (CI)
  assert.ok(String(data.node).startsWith('v'));
  assert.equal(data.secrets.relay, false, 'no relaySecret configured in scratch home');
  assert.ok(data.paths.config.includes(path.basename(tmpHome)), 'config path inside scratch home');
});

test('token auth: /api without or with wrong token is rejected, valid token passes', async () => {
  const anon = await fetch(BASE + '/api/kernel').then((r) => r.status);
  assert.equal(anon, 403, 'missing token rejected');
  const bad = await fetch(BASE + '/api/kernel', { headers: { 'x-api-token': 'deadbeef' } }).then((r) => r.status);
  assert.equal(bad, 403, 'wrong token rejected');
  const good = await req('/api/kernel');
  assert.equal(good.status, 200, 'correct token accepted');
  const page = await fetch(BASE + '/').then((r) => r.status);
  assert.equal(page, 200, 'static page stays reachable (it carries the fresh token)');
});

test('ws upgrade without token is destroyed', async () => {
  const upgraded = await new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    const reqText = [
      'GET /ws HTTP/1.1',
      'Host: x',
      'Upgrade: websocket',
      'Connection: Upgrade',
      '',
      '',
    ].join('\r\n');
    s.on('data', (d) => { resolve(d.toString().includes('101')); s.destroy(); });
    s.on('error', () => resolve(false));
    s.on('connect', () => s.write(reqText));
    setTimeout(() => { try { s.destroy(); } catch { /* socket may be gone */ } resolve(false); }, 3000);
  });
  assert.equal(upgraded, false, 'bare ws upgrade must not complete');
});

test('config: defaults, post persists, projects dedupe case-insensitively', async () => {
  let r = await req('/api/config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.projects, []);

  r = await req('/api/config', { theme: 'dark' });
  assert.equal(r.data.theme, 'dark');

  r = await req('/api/projects/add', { path: tmpProj, name: 'proj' });
  assert.equal(r.status, 200);
  assert.equal(r.data.projects.length, 1);
  if (fs.existsSync(tmpProj.toLowerCase() === tmpProj ? tmpProj.toUpperCase() : tmpProj.toLowerCase())) {
    // case-insensitive filesystem (windows/mac): a case variant must not duplicate
    const flipped = tmpProj.toLowerCase() === tmpProj ? tmpProj.toUpperCase() : tmpProj.toLowerCase();
    r = await req('/api/projects/add', { path: flipped, name: 'proj2' });
    assert.equal(r.data.projects.length, 1, 'case variant not duplicated');
  } else {
    r = await req('/api/projects/add', { path: tmpProj, name: 'proj-again' });
    assert.equal(r.data.projects.length, 1, 'exact duplicate not added');
  }

  r = await req('/api/projects/add', { path: path.join(tmpProj, 'no-such-dir'), name: 'x' });
  assert.equal(r.status, 400);

  r = await req('/api/projects/remove', { path: tmpProj });
  assert.equal(r.data.projects.length, 0);
  await req('/api/projects/add', { path: tmpProj, name: 'proj' });
});

test('models: get/post roundtrip', async () => {
  const doc = { providers: { mock: { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', models: [{ id: 'm-1' }] } } };
  let r = await req('/api/models', doc);
  assert.equal(r.status, 200);
  r = await req('/api/models');
  assert.equal(r.data.providers.mock.api, 'openai-completions');
});

test('skills: seeded skill discovered, toggle persists both ways', async () => {
  let r = await req('/api/skills');
  assert.equal(r.status, 200);
  const demo = r.data.skills.find((s) => s.name === 'demo-skill');
  assert.ok(demo, 'demo-skill discovered');
  assert.equal(demo.enabled, true);
  assert.match(demo.body, /# Demo/);

  r = await req('/api/skills', { name: 'demo-skill', enabled: false });
  assert.deepEqual(r.data.disabled, ['demo-skill']);
  r = await req('/api/skills');
  assert.equal(r.data.skills.find((s) => s.name === 'demo-skill').enabled, false);
  r = await req('/api/skills', { name: 'demo-skill', enabled: true });
  assert.deepEqual(r.data.disabled, []);
});

test('sessions: list + delete with guards', async () => {
  let r = await req('/api/sessions/pi?cwd=' + encodeURIComponent(tmpProj));
  assert.equal(r.status, 200);
  assert.ok(r.data.sessions.length >= 1);
  const file = r.data.sessions[0].file;

  r = await req('/api/sessions/delete', { path: file });
  assert.equal(r.status, 200);
  assert.equal(fs.existsSync(file), false);

  r = await req('/api/sessions/delete', { path: file });
  assert.equal(r.status, 404);
  r = await req('/api/sessions/delete', { path: path.join(ROOT, 'package.json') });
  assert.equal(r.status, 400, 'outside sessions root rejected');
  r = await req('/api/sessions/delete', { path: path.join(tmpHome, '.pi', 'agent', 'sessions', 'evil.txt') });
  assert.equal(r.status, 400, 'non-jsonl rejected');
  r = await req('/api/sessions/delete', {});
  assert.equal(r.status, 400);
});

test('routing: defaults + chains persist', async () => {
  let r = await req('/api/routing');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.chains, [], 'no personal default chains');
  r = await req('/api/routing', { chains: [['mock/m-1']] });
  assert.deepEqual(r.data.chains, [['mock/m-1']]);
  r = await req('/api/routing');
  assert.deepEqual(r.data.chains, [['mock/m-1']]);
});

test('usage + migrate shapes', async () => {
  let r = await req('/api/usage');
  assert.equal(r.status, 200);
  assert.ok('days' in r.data);
  r = await req('/api/migrate/scan');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.sources) && r.data.sources.length >= 5);
});

test('backup: export zip then import restores', async () => {
  let r = await req('/api/backup/export', {});
  assert.equal(r.status, 200);
  backupZip = r.data.path;
  assert.ok(fs.existsSync(backupZip));
  assert.ok(fs.statSync(backupZip).size > 100);
  r = await req('/api/backup/import', { path: backupZip });
  assert.equal(r.status, 200);
  assert.ok(r.data.restored.length >= 1);
  assert.ok(r.data.backup, 'pre-import snapshot recorded');

  r = await req('/api/backup/import', { path: '' });
  assert.equal(r.status, 400);
  r = await req('/api/backup/import', { path: 'C:\\definitely\\missing.zip' });
  assert.equal(r.status, 400);
});

test('term: exec works on windows, guards on empty', { skip: process.platform !== 'win32' ? 'windows only (uses ComSpec)' : false }, async () => {
  let r = await req('/api/term/exec', { cwd: '', cmd: 'echo test-ok' });
  assert.equal(r.status, 200);
  assert.match(r.data.out, /test-ok/);
  r = await req('/api/term/exec', { cwd: '', cmd: '' });
  assert.equal(r.status, 400);
});

test('files: list requires known project, traversal blocked', async () => {
  let r = await req('/api/files/list');
  assert.equal(r.status, 400);
  r = await req('/api/files/list?root=' + encodeURIComponent(tmpProj) + '&path=' + encodeURIComponent('..\\..\\..'));
  assert.equal(r.status, 400, 'escape beyond project root rejected');
});

test('mcp config: roundtrip and validation', async () => {
  let r = await req('/api/mcp/config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.mcpServers, {}, 'empty by default');
  r = await req('/api/mcp/config', { mcpServers: { fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } } });
  assert.equal(r.status, 200);
  r = await req('/api/mcp/config');
  assert.ok(r.data.mcpServers.fs.command);
  r = await req('/api/mcp/config', { mcpServers: { bad: { args: ['x'] } } });
  assert.equal(r.status, 400, 'server without command rejected');
});

test('mcp bridge install: copies extension into scratch extensions dir', { timeout: 120000 }, async () => {
  // pre-seed the dep the endpoint checks for — otherwise it fires a background
  // `npm install` that outlives the suite and races the tmpdir cleanup
  const seed = path.join(tmpHome, '.pi', 'agent', 'extensions', 'mcp-bridge', 'node_modules', 'typebox');
  fs.mkdirSync(seed, { recursive: true });
  const r = await req('/api/mcp/install', {});
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  const dest = path.join(tmpHome, '.pi', 'agent', 'extensions', 'mcp-bridge', 'mcp-bridge.js');
  assert.equal(fs.existsSync(dest), true, 'bridge file installed');
  const src = fs.readFileSync(path.join(ROOT, '..', 'extensions', 'mcp-bridge.js'), 'utf8');
  assert.equal(fs.readFileSync(dest, 'utf8'), src);
});

test('cron is a real endpoint now, mcp stays gone', async () => {
  const cron = await req('/api/cron');
  assert.equal(cron.status, 200);
  assert.ok(Array.isArray(cron.data.jobs), 'jobs array');
  assert.equal((await req('/api/mcp')).status, 404);
});

test('cronPiArgs builds flags-only argv (real call, not source regex)', async () => {
  const {cronPiArgs} = await import('../lib/cron-args.mjs');
  const args = cronPiArgs({prompt: 'x', model: 'p/m'});
  assert.deepEqual(args, ['-p', 'x', '--model', 'p/m']);
  assert.ok(!args.some((a) => a.endsWith('.js')), 'argv must be flags-only (no embedded paths)');
  assert.ok(args.filter((a) => a === '-p').length === 1);
});

test('session export returns the transcript, not an empty file', async () => {
  const dir = path.join(tmpHome, '.pi', 'agent', 'sessions', 'export-proj');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'roll-test.jsonl');
  const rows = [
    { type: 'message', message: { role: 'user', content: '第一行提问\n' } },
    { type: 'message', message: { role: 'assistant', content: '回答正文\n' } },
  ];
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const res = await get('/api/session/export?path=' + encodeURIComponent(f));
  assert.equal(res.status, 200);
  const text = await res.text();   // 本文件的 get() 返回原始 Response，只有 req() 会解析
  assert.match(text, /## User/, '导出里没有用户段：NL 曾被写成字面反斜杠+n，每行 JSON 都从转义处被切碎');
  assert.match(text, /第一行提问/);
  assert.match(text, /回答正文/);
});

test('static assets and 404', async () => {
  for (const p of ['/', '/app.js', '/style.css', '/dropdowns.js']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
  }
  assert.equal((await req('/api/definitely-missing')).status, 404);
});
test('cron scheduler actually ticks: a due job is spawned without waiting for run-now', async () => {
  const { createCron } = await import('../lib/cron.mjs');
  const cronFile = path.join(tmpHome, 'cron-tick.json');
  const jobs = [{ id: 'job-tick', name: 'tick-me', kind: 'interval', everyMin: 0.01, prompt: 'hello', enabled: true }];
  fs.writeFileSync(cronFile, JSON.stringify({ jobs }));
  let spawned = 0;
  const engine = createCron({
    CRON_FILE: cronFile, CRON_RUNS_DIR: path.join(tmpHome, 'cron-tick-runs'), HOME: tmpHome,
    SECRET_ENV: {}, PI_CLI: 'pi-cli', cronPiArgs: () => ['-p', 'x'], broadcast: () => {},
    readJson: (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } },
    saveJson: (f, d) => { fs.writeFileSync(f, JSON.stringify(d)); },
    spawn: () => { spawned++; const fake = { on: () => {}, stdin: { write: () => {} } }; return fake; },
  });
  engine.tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(spawned >= 1, 'tick() must spawn a due job — the scheduler interval went missing once already');
});

test('factory ctx guards: wiring drift crashes at boot, not silently at 9am', async () => {
  const { createFailover } = await import('../lib/failover.mjs');
  assert.throws(() => createFailover({ SECRET_ENV: {}, readJson: () => null, loadRouting: () => ({}), saveRouting: () => {} }),
    /missing ctx\.PI_MODELS/, 'failover without PI_MODELS must throw loudly');
});

test('malformed POST cannot wipe models.json', async () => {
  const modelsPath = path.join(tmpHome, '.pi', 'agent', 'models.json');
  const before = fs.readFileSync(modelsPath, 'utf8');
  const r = await req('/api/models', { garbage: true });
  assert.equal(r.status, 400, 'body without providers must be rejected');
  assert.equal(fs.readFileSync(modelsPath, 'utf8'), before, 'models.json untouched');
});

test('cron routes reject junk job ids before path.join', async () => {
  const r = await req('/api/cron/lastlog', { id: '..' + path.sep + '..' + path.sep + 'evil' });
  assert.equal(r.status, 400, 'traversal id rejected');
});
test('aider import parses a real-shaped chat history (fixture)', async () => {
  fs.writeFileSync(path.join(tmpHome, '.aider.chat.history.md'), [
    '# aider chat history',
    '',
    '#### User',
    '帮我修这个报错',
    'Traceback (most recent call last): ...',
    '',
    '#### Assistant',
    '把除数检查加上就好了',
    '',
  ].join('\n') + '\n', 'utf8');
  const list = await req('/api/import/aider');
  assert.equal(list.status, 200);
  const hit = (list.data.sessions || []).find((x) => x.file && x.file.includes('.aider.chat.history.md'));
  assert.ok(hit, 'history file discovered in scratch HOME');
  const r = await req('/api/import/aider/read?path=' + encodeURIComponent(hit.file));
  assert.equal(r.status, 200);
  const msgs = (r.data.entries || []).filter((x) => x.kind === 'message');
  assert.equal(msgs.length, 2, 'user + assistant, no folding');
  assert.equal(msgs[0].role, 'user');
  assert.match(msgs[0].text, /帮我修这个报错/);
  assert.equal(msgs[1].role, 'assistant');
});

test('api keys are write-only: GET masks, POST sentinel preserves', async () => {
  const file = path.join(tmpHome, '.pi', 'agent', 'models.json');
  fs.writeFileSync(file, JSON.stringify({ providers: { provA: { baseUrl: 'http://x/v1', apiKey: 'sk-real-secret', models: [{ id: 'm1' }] }, provB: { baseUrl: 'http://y/v1', apiKey: '$MY_ENV', models: [] } } }));
  let r = await req('/api/models');
  assert.equal(r.status, 200);
  assert.equal(r.data.providers.provA.apiKey, '***', 'literal key masked');
  assert.equal(r.data.providers.provB.apiKey, '$MY_ENV', 'env ref stays readable');
  // round-trip the masked doc: the stored key must survive untouched
  r = await req('/api/models', { providers: r.data.providers });
  assert.equal(r.status, 200);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.providers.provA.apiKey, 'sk-real-secret', 'sentinel round-trip preserved the real key');
  // a typed key replaces; an empty sentinel with no stored key deletes the field
  r = await req('/api/models', { providers: { provA: { baseUrl: 'http://x/v1', apiKey: 'sk-new' }, provB: { baseUrl: 'http://y/v1' } } });
  assert.equal(r.status, 200);
  const stored2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored2.providers.provA.apiKey, 'sk-new');
  assert.equal('apiKey' in stored2.providers.provB, false, 'sentinel with no stored key deletes the field');
});

const PI_CLI_LOCAL = path.join(ROOT, '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
test('ws adopt: foreign tabs are invisible until explicitly adopted', { skip: !fs.existsSync(PI_CLI_LOCAL) ? 'needs the pi package (the tab must survive its owner)' : false }, async () => {
  // second connection cannot see or steer the tab the first connection owns
  const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${TOKEN}`);
  await new Promise((res, rej) => { ws2.once('open', res); ws2.once('error', rej); });
  const frames2 = [];
  ws2.on('message', (raw) => { try { frames2.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
  // register the scratch project, then open a real tab from the MAIN connection (child)
  await req('/api/config', { projects: [{ path: tmpProj, name: 'p' }] });
  const ws1 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${TOKEN}`);
  await new Promise((res, rej) => { ws1.once('open', res); ws1.once('error', rej); });
  const frames1 = [];
  ws1.on('message', (raw) => { try { frames1.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
  const wait = async (pred, ms, label) => {
    const dl = Date.now() + ms;
    for (;;) {
      const f = frames1.find(pred) || frames2.find(pred);
      if (f) return f;
      if (Date.now() > dl) throw new Error('timeout: ' + label);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  ws1.send(JSON.stringify({ type: 'open', tabId: 'adopt-1', cwd: tmpProj }));
  await wait((f) => f.type === 'opened' && f.tabId === 'adopt-1', 20000, 'opened');
  // foreign connection: no pi-event frames arrive, rpc denied
  ws2.send(JSON.stringify({ type: 'rpc', tabId: 'adopt-1', data: { id: 'x1', type: 'get_entries' } }));
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(frames2.some((f) => f.type === 'rpc-denied' && f.tabId === 'adopt-1'), 'foreign rpc denied');
  assert.ok(!frames2.some((f) => f.type === 'pi-event' && f.tabId === 'adopt-1'), 'foreign connection gets no tab frames');
  // owner dies -> frames stop for everyone; adopter must claim explicitly
  ws1.close();
  await new Promise((r) => setTimeout(r, 700));
  ws2.send(JSON.stringify({ type: 'adopt', tabId: 'adopt-1' }));
  await wait((f) => f.type === 'adopted' && f.tabId === 'adopt-1', 5000, 'adopted');
  ws2.send(JSON.stringify({ type: 'rpc', tabId: 'adopt-1', data: { id: 'x2', type: 'get_entries' } }));
  await wait((f) => f.type === 'pi-event' && f.tabId === 'adopt-1', 30000, 'frames flow to adopter');
  ws2.send(JSON.stringify({ type: 'close', tabId: 'adopt-1' }));
  await wait((f) => f.type === 'pi-exit' && f.tabId === 'adopt-1', 15000, 'adopter can close');
  ws2.close();
});
