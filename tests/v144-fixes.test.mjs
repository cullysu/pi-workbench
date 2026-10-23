// tests/v144-fixes.test.mjs — regression locks for the v1.4.3 review (wave 33).
//
// Every lock here was written to fail against the pre-fix code. The two that could not be
// exercised through a module boundary were moved behind one (lib/outbound-fetch.mjs,
// lib/schema.mjs) precisely so that a future refactor cannot silently un-fix them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fetchJsonCapped, assertHttpUrl, isLocalUrlHostname } from '../lib/outbound-fetch.mjs';
import {
  modelsDocProblem, routingDocProblem, providerRowProblem, normalizeRoutingDoc,
} from '../lib/schema.mjs';
import { createProviders } from '../lib/providers.mjs';
import { createBackupTerminal } from '../lib/backup-terminal.mjs';
import { createFailover } from '../lib/failover.mjs';
import { createSources } from '../lib/sources.mjs';
import { createZip } from '../zip.mjs';

// ---------- helpers ----------
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `piwb-v144-${tag}-`));
const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve({ s, port: s.address().port }));
});
// undici keeps its sockets alive, so a plain close() waits forever on a connection whose
// body we abandoned (the redirect-refusal test throws before reading it). Drop the
// connections first, then close.
const close = (s) => new Promise((resolve) => {
  try { s.closeAllConnections?.(); } catch { /* older node */ }
  s.close(() => resolve());
});

// ---------- review #1: redirects must not carry provider credentials ----------
test('#1 a cross-origin redirect drops every provider-supplied credential header', async () => {
  // the reviewer's canaries, verbatim in spirit: vendor spellings the old deny-list missed
  const seen = {};
  const target = await listen((req, res) => {
    seen.subscription = req.headers['ocp-apim-subscription-key'] ?? null;
    seen.authToken = req.headers['x-auth-token'] ?? null;
    seen.clientSecret = req.headers['x-client-secret'] ?? null;
    seen.authorization = req.headers.authorization ?? null;
    seen.accept = req.headers.accept ?? null; // a request-shaped header must survive
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  // second listener on a DIFFERENT port = different origin
  const redirector = await listen((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${target.port}/v1/models` });
    res.end();
  });
  try {
    const { r } = await fetchJsonCapped(`http://127.0.0.1:${redirector.port}/v1/models`, {
      headers: {
        'Ocp-Apim-Subscription-Key': 'custom-secret-canary',
        'x-auth-token': 'token-secret-canary',
        'x-client-secret': 'client-secret-canary',
        authorization: 'Bearer bearer-secret-canary',
        accept: 'application/json',
      },
    });
    assert.equal(r.status, 200);
  } finally {
    await close(redirector.s); await close(target.s);
  }
  assert.equal(seen.subscription, null, 'Ocp-Apim-Subscription-Key must not cross an origin change');
  assert.equal(seen.authToken, null, 'X-Auth-Token must not cross an origin change');
  assert.equal(seen.clientSecret, null, 'X-Client-Secret must not cross an origin change');
  assert.equal(seen.authorization, null, 'Authorization must not cross an origin change');
  assert.equal(seen.accept, 'application/json', 'request-shaped headers survive the hop (positive control)');
});

test('#1b a SAME-origin redirect keeps the credentials (the request was addressed there)', async () => {
  let seen = null;
  const { s, port } = await listen((req, res) => {
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { location: '/final' }); return res.end(); }
    seen = { key: req.headers['ocp-apim-subscription-key'] ?? null };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  try {
    await fetchJsonCapped(`http://127.0.0.1:${port}/redirect`, { headers: { 'Ocp-Apim-Subscription-Key': 'same-origin-key' } });
  } finally { await close(s); }
  assert.equal(seen.key, 'same-origin-key', 'a same-origin hop must not strip what the origin already owns');
});

// ---------- review #11: the local-target policy holds on every hop ----------
test('#11 PIWB_DISALLOW_LOCAL_URLS is enforced on the redirect target, not just the first URL', async () => {
  const internal = await listen((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"secret":"internal"}'); });
  const redirector = await listen((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${internal.port}/latest/meta-data/` });
    res.end();
  });
  const env = { PIWB_DISALLOW_LOCAL_URLS: '1' };
  try {
    // the redirector is on loopback, but so is the target — the LOOP policy keys on the
    // HOST, and 127.0.0.1 is local regardless of which port. With the policy on, a public
    // provider bouncing to loopback must be refused at the hop.
    await assert.rejects(
      () => fetchJsonCapped(`http://127.0.0.1:${redirector.port}/`, { headers: {} }, 2e6, env),
      /refused by PIWB_DISALLOW_LOCAL_URLS/,
      'a hop that lands on a local address is refused when the policy is on',
    );
  } finally { await close(redirector.s); await close(internal.s); }
});

test('#11b the predicate itself classifies the ranges the review listed', () => {
  for (const h of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '172.16.0.9', '::1', 'localhost', 'foo.local']) {
    assert.equal(isLocalUrlHostname(h), true, `${h} must classify as local`);
  }
  for (const h of ['example.com', '8.8.8.8', '203.0.113.9']) {
    assert.equal(isLocalUrlHostname(h), false, `${h} must NOT classify as local`);
  }
  assert.equal(assertHttpUrl('file:///etc/passwd'), null, 'non-http(s) schemes stay refused');
});

// ---------- review #2: split-form MCP arg secrets ----------
test('#2 the split argv form ("--token", "secret") is masked, not just the inline form', async () => {
  const { scrubArgSecrets } = await import('../lib/mcp-scrub.mjs');
  assert.deepEqual(
    scrubArgSecrets(['--token', 'separate-secret-canary']),
    ['--token', '***'],
    'the flag must consume and mask its successor',
  );
  assert.deepEqual(
    scrubArgSecrets(['--api-key=inline-canary', 'serve']),
    ['--api-key=***', 'serve'],
  );
  assert.deepEqual(
    scrubArgSecrets(['-H', 'Authorization: Bearer canary', '--verbose']),
    ['-H', '***', '--verbose'],
    '-H/--header carry a token in a real MCP config',
  );
  assert.deepEqual(
    scrubArgSecrets(['--port', '8080', '--name', 'files']),
    ['--port', '8080', '--name', 'files'],
    'non-credential flags and their values must survive intact',
  );
});

// ---------- review #3 / #4: the restore door uses the same deep validators ----------
test('#3 a restored models.json with a null model row is refused', () => {
  assert.match(String(modelsDocProblem({ providers: { p: { baseUrl: 'http://example', models: [null] } } })), /every model must be an object/);
  assert.equal(modelsDocProblem({ providers: { p: { models: [{ id: 'm1' }] } } }), null);
  // and the failover consumer that used to throw now cannot see such a row
  const row = providerRowProblem('p', { models: [null] });
  assert.ok(row, 'the row validator rejects it too — one rule, both doors');
});

test('#4 a routing document with deep bad types is refused, and normalisation drops the row', () => {
  assert.match(String(routingDocProblem({ providers: { p: { keyEnvs: 1 } } })), /keyEnvs must be an array of strings/);
  assert.match(String(routingDocProblem({ providers: { p: null } })), /must be an object/);
  assert.match(String(routingDocProblem({ routes: { p: null } })), /legacy routing migration/);
  assert.match(String(routingDocProblem({ chains: [['a/b', 3]] })), /non-empty model id string/);
  // what the loader does with a file that predates the gate
  const norm = normalizeRoutingDoc({ providers: { p: { keyEnvs: 1 }, ok: { keyEnvs: ['$K'] } }, chains: [['x/y', 1]] });
  assert.equal(Object.hasOwn(norm.providers, 'p'), false, 'the poisoned provider row is dropped, not thrown on');
  assert.deepEqual(norm.providers.ok.keyEnvs, ['$K']);
  assert.deepEqual(norm.chains, [], 'a chain with a non-string entry is dropped whole');
});

test('#4b failover survives a routing file that carries the bad shapes (the crash the review hit)', () => {
  const root = tmp('failover');
  const routingFile = path.join(root, 'routing.json');
  fs.writeFileSync(routingFile, JSON.stringify({ providers: { p: { keyEnvs: 1 }, q: null }, chains: [['p/m1']], state: 1 }));
  const modelsFile = path.join(root, 'models.json');
  fs.writeFileSync(modelsFile, JSON.stringify({ providers: { p: { models: [{ id: 'm1' }] } } }));
  const fo = createFailover({
    SECRET_ENV: {}, readJson: (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } },
    loadRouting: () => normalizeRoutingDoc((() => { try { return JSON.parse(fs.readFileSync(routingFile, 'utf8')); } catch { return null; } })()),
    saveRouting: () => {}, PI_MODELS: modelsFile,
  });
  // the old code threw `TypeError: routing.providers[p].keyEnvs is not iterable`
  assert.deepEqual(fo.keyEnvsFor('p'), []);
  assert.doesNotThrow(() => fo.providerCooled('p'));
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- review #7: a rollback must not claim success it did not achieve ----------
test('#7 a rollback that cannot delete a leftover target reports rollbackFailed', () => {
  const root = tmp('providers');
  const models = path.join(root, 'models.json');
  const routing = path.join(root, 'routing.json');
  fs.writeFileSync(models, JSON.stringify({ providers: { keep: { models: [{ id: 'm1' }] } } }));
  // routing.json does NOT exist before the save — so the pre-image is "absent", and a
  // rollback has to DELETE it. The reviewer's EISDIR: the delete is refused because
  // something (a directory, or an AV lock) now occupies the path.
  const injectable = {
    ...fs,
    unlinkSync: (p) => {
      if (String(p).endsWith('routing.json')) { const e = new Error('EISDIR: illegal operation on a directory, unlink'); e.code = 'EISDIR'; throw e; }
      return fs.unlinkSync(p);
    },
    renameSync: (from, to) => {
      // the routing write lands, then the config write (the last one) dies — leaving the
      // routing file to be rolled back
      if (String(to).endsWith('config.json')) { const e = new Error('ENOSPC: no space left on device, rename'); e.code = 'ENOSPC'; throw e; }
      return fs.renameSync(from, to);
    },
  };
  const providers = createProviders({
    MODELS_FILE: models, ROUTING_FILE: routing, CFG_FILE: path.join(root, 'config.json'),
    readJson: (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } },
    atomicWrite: (f, data) => { const t = `${f}.tmp-${Math.random().toString(36).slice(2)}`; injectable.writeFileSync(t, data); injectable.renameSync(t, f); },
    isSafeKey: (k) => typeof k === 'string' && k.length > 0 && !['__proto__', 'constructor', 'prototype'].includes(k),
    fs: injectable,
  });
  let err = null;
  try {
    // save() writes models + routing (testModel) + config (defaultModel); the config write fails
    providers.save({ name: 'keep', provider: { models: [{ id: 'm1' }] }, testModel: 'keep/m1', defaultModel: 'keep/m1' });
  } catch (e) { err = e; }
  assert.ok(err, 'the save must fail');
  assert.ok(Array.isArray(err.rollback), 'the error carries a rollback list');
  assert.ok(err.rollback.length >= 1, `a refused unlink must be reported, not swallowed: ${JSON.stringify(err.rollback)}`);
  assert.match(String(err.detail), /回滚失败|磁盘可能处于部分更新状态/, 'and the message must not claim a clean rollback');
  assert.doesNotMatch(String(err.detail), /^已回滚到修改前的状态$/, 'the old lie is the whole finding');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- review #9: usage aggregation must not touch the prototype ----------
test('#9 a __proto__ model/provider name cannot write onto Object.prototype', () => {
  const home = tmp('usage');
  const sessions = path.join(home, 'sessions', 'proj');
  fs.mkdirSync(sessions, { recursive: true });
  const rows = [
    { type: 'model_change', provider: '__proto__' },
    { type: 'message', timestamp: new Date().toISOString(), message: { role: 'assistant', model: '__proto__', usage: { input: 10, output: 5 } } },
    { type: 'message', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'constructor', usage: { input: 7, output: 3 } } },
  ];
  fs.writeFileSync(path.join(sessions, 's.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const sources = createSources({
    PI_SESSIONS: path.join(home, 'sessions'), CODEX_SESSIONS: path.join(home, 'codex'), CLAUDE_PROJECTS: path.join(home, 'claude'),
    OMP_SESSIONS: path.join(home, 'omp'), GROK_DIR: path.join(home, 'grok'), HOME: home, DatabaseSync: null,
    kbPrice: () => null, loadConfig: () => ({ projects: [{ path: home }] }),
  });
  const before = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
  const sum = sources.usageSummary();
  const after = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
  assert.equal(after, before, 'Object.prototype must be untouched by a hostile session file');
  assert.equal(Object.prototype.ok, undefined, 'no aggregation field leaked onto the prototype');
  // the totals still counted the tokens, under a labelled bucket
  assert.equal(sum.ok, 2, 'both assistant turns are still counted');
  assert.equal(sum.input, 17);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------- review #12: deleting a provider must take its routing metadata too ----------
test('#12 provider removal sweeps routing.providers[name] in the same commit', () => {
  const root = tmp('remove');
  const files = { models: path.join(root, 'models.json'), routing: path.join(root, 'routing.json'), cfg: path.join(root, 'config.json') };
  fs.writeFileSync(files.models, JSON.stringify({ providers: { dead: { models: [{ id: 'm1' }] }, alive: { models: [{ id: 'm2' }] } } }));
  fs.writeFileSync(files.routing, JSON.stringify({ providers: { dead: { enabled: false, keyEnvs: ['$K'], testModel: 'dead/m1' }, alive: { enabled: true } }, chains: [['dead/m1', 'alive/m2']] }));
  fs.writeFileSync(files.cfg, JSON.stringify({ defaultModel: 'dead/m1' }));
  const providers = createProviders({
    MODELS_FILE: files.models, ROUTING_FILE: files.routing, CFG_FILE: files.cfg,
    readJson: (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } },
    atomicWrite: (f, data) => { const t = `${f}.tmp`; fs.writeFileSync(t, data); fs.renameSync(t, f); },
    isSafeKey: (k) => typeof k === 'string' && !['__proto__', 'constructor', 'prototype'].includes(k),
  });
  const out = providers.remove('dead');
  const routing = JSON.parse(fs.readFileSync(files.routing, 'utf8'));
  assert.equal(Object.hasOwn(routing.providers, 'dead'), false, 'routing metadata must not outlive the provider');
  assert.deepEqual(routing.chains, [['alive/m2']], 'and neither may its chain entries');
  assert.ok(out.swept.includes('路由元数据'));
  assert.ok(out.swept.includes('默认模型'));
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- review #14: a null block inside content must not 500 the list ----------
test('#14 a session with {"content":[null]} is read, not crashed on', () => {
  const home = tmp('nullblock');
  const ses = path.join(home, 'sessions', 'p');
  fs.mkdirSync(ses, { recursive: true });
  fs.writeFileSync(path.join(ses, 's.jsonl'), [
    JSON.stringify({ type: 'session', cwd: home }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: [null] } }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
  ].join('\n') + '\n');
  const sources = createSources({
    PI_SESSIONS: path.join(home, 'sessions'), CODEX_SESSIONS: path.join(home, 'codex'), CLAUDE_PROJECTS: path.join(home, 'claude'),
    OMP_SESSIONS: path.join(home, 'omp'), GROK_DIR: path.join(home, 'grok'), HOME: home, DatabaseSync: null,
    kbPrice: () => null, loadConfig: () => ({ projects: [] }),
  });
  const info = sources.piSessionInfo(path.join(ses, 's.jsonl'));
  assert.ok(info, 'the file still lists');
  assert.equal(info.cwd, home);
  assert.doesNotThrow(() => sources.sessionTree(path.join(ses, 's.jsonl')));
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------- review #15: the scan budget is applied during the walk ----------
test('#15 the session list reports truncation instead of pretending to be complete', () => {
  const home = tmp('walk');
  const ses = path.join(home, 'sessions');
  fs.mkdirSync(ses, { recursive: true });
  fs.writeFileSync(path.join(ses, 'a.jsonl'), JSON.stringify({ type: 'session', cwd: home }) + '\n');
  const sources = createSources({
    PI_SESSIONS: ses, CODEX_SESSIONS: path.join(home, 'codex'), CLAUDE_PROJECTS: path.join(home, 'claude'),
    OMP_SESSIONS: path.join(home, 'omp'), GROK_DIR: path.join(home, 'grok'), HOME: home, DatabaseSync: null,
    kbPrice: () => null, loadConfig: () => ({ projects: [] }),
  });
  const sum = sources.usageSummary();
  assert.equal(typeof sum.walkCapped, 'boolean', 'the walk budget is surfaced, not silent');
  assert.equal(sum.walkCapped, false, 'a small tree is not reported as capped');
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------- review #8: backup retention ----------
test('#8 a keys-free export leaves no plaintext .redacted.json intermediates behind', async () => {
  const home = tmp('bkret');
  const cfgDir = path.join(home, '.pi-workbench');
  const piAgent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(piAgent, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ projects: [{ path: home }], relaySecret: 'relay-canary' }));
  fs.writeFileSync(path.join(cfgDir, 'routing.json'), JSON.stringify({ chains: [] }));
  fs.writeFileSync(path.join(piAgent, 'models.json'), JSON.stringify({ providers: { p: { baseUrl: 'http://x', apiKey: 'sk-live-canary', models: [{ id: 'm' }] } } }));
  fs.writeFileSync(path.join(piAgent, 'settings.json'), JSON.stringify({ apiKey: 'settings-canary' }));
  const bt = createBackupTerminal({
    CFG_DIR: cfgDir, HOME: home, CFG_FILE: path.join(cfgDir, 'config.json'), ROUTING_FILE: path.join(cfgDir, 'routing.json'),
    CRON_FILE: path.join(cfgDir, 'cron.json'), MODEL_META_FILE: path.join(cfgDir, 'model-meta.json'), PI_MODELS: path.join(piAgent, 'models.json'),
    PI_SETTINGS: path.join(piAgent, 'settings.json'), PI_SKILLS: path.join(home, '.agents', 'skills'),
    CODEX_SESSIONS: path.join(home, '.codex'), CLAUDE_PROJECTS: path.join(home, '.claude'), VERSION: 'test',
    listSkills: () => ({ skills: [] }), createZip, readZip: () => [], spawn: () => {}, fs, path,
  });
  const out = await bt.exportBackupZip(true);
  assert.ok(fs.existsSync(out.path));
  const leftovers = fs.readdirSync(path.join(cfgDir, 'backups')).filter((n) => n.endsWith('.redacted.json'));
  assert.deepEqual(leftovers, [], `redaction intermediates must not survive the export: ${leftovers.join(', ')}`);
  fs.rmSync(home, { recursive: true, force: true });
});

test('#8b a failed import does not leave a credential snapshot for a backup that never applied', async () => {
  const home = tmp('bkfail');
  const cfgDir = path.join(home, '.pi-workbench');
  const piAgent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(piAgent, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ projects: [{ path: home }] }));
  fs.writeFileSync(path.join(cfgDir, 'routing.json'), JSON.stringify({ chains: [] }));
  fs.writeFileSync(path.join(piAgent, 'models.json'), JSON.stringify({ providers: { p: { apiKey: 'sk-live', models: [{ id: 'm' }] } } }));
  const bt = createBackupTerminal({
    CFG_DIR: cfgDir, HOME: home, CFG_FILE: path.join(cfgDir, 'config.json'), ROUTING_FILE: path.join(cfgDir, 'routing.json'),
    CRON_FILE: path.join(cfgDir, 'cron.json'), MODEL_META_FILE: path.join(cfgDir, 'model-meta.json'), PI_MODELS: path.join(piAgent, 'models.json'),
    PI_SETTINGS: path.join(piAgent, 'settings.json'), PI_SKILLS: path.join(home, '.agents', 'skills'),
    CODEX_SESSIONS: path.join(home, '.codex'), CLAUDE_PROJECTS: path.join(home, '.claude'), VERSION: 'test',
    listSkills: () => ({ skills: [] }), createZip, readZip: () => [{ name: 'pi-agent/models.json', data: Buffer.from('{"providers":{"p":{"models":[null]}}}') }],
    spawn: () => {}, fs, path,
  });
  const badZip = path.join(home, 'bad.zip');
  fs.writeFileSync(badZip, createZip([{ name: 'pi-agent/models.json', data: Buffer.from('{"providers":{"p":{"models":[null]}}}') }]));
  await assert.rejects(() => bt.importBackupZip(badZip), /models/);
  const snaps = fs.existsSync(path.join(cfgDir, 'backups')) ? fs.readdirSync(path.join(cfgDir, 'backups')).filter((n) => n.startsWith('pre-import-')) : [];
  assert.deepEqual(snaps, [], `a refused import must not keep a credential snapshot: ${snaps.join(', ')}`);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------- review #10: the models probe must survive a child that dies before stdin ----------
test('#10 the models probe cannot take the whole server down via stdin EPIPE', async () => {
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // a "pi" that exits immediately: the probe's write to stdin then hits a dead pipe, and
  // the stream error used to reach the global uncaughtException handler, which exits the
  // server. Refuse to leak the process is the finding; the test asserts survivability.
  const dyingCli = path.join(tmp('epipe'), 'dying.mjs');
  fs.mkdirSync(path.dirname(dyingCli), { recursive: true });
  fs.writeFileSync(dyingCli, 'process.exit(0);\n');
  const home = tmp('epipe-home');
  const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: { ...process.env, PIWB_EMBED_TOKEN: '1', PIWB_PORT: String(port), PIWB_PI_CLI: dyingCli, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // keep the child's stderr in the failure message — a crash shows up there first
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  try {
    const deadline = Date.now() + 20000;
    let token = '';
    while (Date.now() < deadline) {
      try {
        const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
        const m = page.match(/__API_TOKEN = "([0-9a-f]+)"/);
        if (m) { token = m[1]; break; }
      } catch { /* server still booting */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(token, 'server started');
    // one probe call is enough: the EPIPE happens on the FIRST write to the dying child.
    // (each call waits out the probe's own 20s budget, so two would double the suite time
    // for no extra signal)
    const r = await fetch(`http://127.0.0.1:${port}/api/models/available`, { headers: { 'x-api-token': token } });
    assert.equal(r.status, 200, 'the probe must answer 200, not crash the server');
    // the server is still alive and answering
    const k = await fetch(`http://127.0.0.1:${port}/api/kernel`, { headers: { 'x-api-token': token } });
    assert.equal(k.status, 200, 'the server survived the dying probe children' + (stderr ? ' | stderr: ' + stderr.slice(0, 400) : ''));
  } finally {
    try { child.kill(); } catch { /* already gone */ }
  }
  fs.rmSync(home, { recursive: true, force: true });
  const epipeDir = path.dirname(dyingCli);
  if (fs.existsSync(epipeDir)) fs.rmSync(epipeDir, { recursive: true, force: true });
});
