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

const PORT = 39944;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

let child = null;
let tmpHome = '';
let tmpProj = '';
let backupZip = '';

const get = (p, timeout = 15000) => fetch(BASE + p, { signal: AbortSignal.timeout(timeout) });
const req = async (p, body, method = body === undefined ? 'GET' : 'POST', timeout = 20000) => {
  const opts = { method, signal: AbortSignal.timeout(timeout) };
  if (method === 'POST') {
    opts.headers = { 'content-type': 'application/json' };
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
    env: { ...process.env, PIWB_PORT: String(PORT), HOME: tmpHome, USERPROFILE: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (c) => process.env.PIWB_TEST_DEBUG && process.stderr.write(c));
  await waitPort(PORT);
});

test.after(() => {
  if (child) { try { child.kill(); } catch {} }
  for (const dir of [tmpHome, tmpProj]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
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

test('term: exec works on windows, guards on empty', async () => {
  if (process.platform !== 'win32') return; // uses ComSpec
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

test('mcp bridge install: copies extension into scratch extensions dir', async () => {
  const r = await req('/api/mcp/install', {});
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  const dest = path.join(tmpHome, '.pi', 'agent', 'extensions', 'mcp-bridge', 'mcp-bridge.js');
  assert.equal(fs.existsSync(dest), true, 'bridge file installed');
  const src = fs.readFileSync(path.join(ROOT, '..', 'extensions', 'mcp-bridge.js'), 'utf8');
  assert.equal(fs.readFileSync(dest, 'utf8'), src);
});

test('removed placeholder endpoints stay gone', async () => {
  assert.equal((await req('/api/mcp')).status, 404);
  assert.equal((await req('/api/cron')).status, 404);
});

test('static assets and 404', async () => {
  for (const p of ['/', '/app.js', '/style.css', '/dropdowns.js']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
  }
  assert.equal((await req('/api/definitely-missing')).status, 404);
});
