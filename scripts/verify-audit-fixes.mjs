// verify HEAD against the v1.2.9 audit repros (cron budget, codex first sample,
// usage dimension consistency, backup member shapes)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createCron } from '../lib/cron.mjs';
import { createSources } from '../lib/sources.mjs';
import { ledger } from '../ledger.mjs';
import { createBackupTerminal } from '../lib/backup-terminal.mjs';
import { createZip, readZip } from '../zip.mjs';

const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' — ' + detail));
  if (!ok) process.exitCode = 1;
};

// 1) cron budget releases on settle
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  let cronState = { jobs: [] };
  const procs = [];
  const cron = createCron({ CRON_FILE: path.join(root, 'cron.json'), CRON_RUNS_DIR: path.join(root, 'runs'), HOME: root, SECRET_ENV: {}, PI_CLI: 'mock-pi', cronPiArgs: () => [], broadcast: () => {}, readJson: () => JSON.parse(JSON.stringify(cronState)), saveJson: (_, d) => { cronState = JSON.parse(JSON.stringify(d)); }, spawn: () => { const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); procs.push(p); return p; }, get knownProject() { return () => true; } });
  const spawned = [];
  for (let n = 1; n <= 4; n++) {
    const job = { id: `job-${n}`, kind: 'interval', everyMin: 1, prompt: 'x', enabled: true };
    cronState.jobs.push(job);
    const before = procs.length;
    const ok = cron.runCronJob(job);
    if (procs.length > before) procs.at(-1).emit('close', 0);
    spawned.push(!!ok);
  }
  check('cron budget releases on settle — all four spawn', spawned.every(Boolean), JSON.stringify(spawned));
  cron.shutdown();
}

// 2) codex ledger: the first cumulative sample is real usage
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  const roll = path.join(root, '.codex', 'sessions');
  fs.mkdirSync(roll, { recursive: true });
  const f = path.join(roll, 'r.jsonl');
  const ts = new Date().toISOString();
  fs.writeFileSync(f, [
    JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { cwd: root, timestamp: ts } }),
    JSON.stringify({ timestamp: ts, payload: { info: { model: 'gpt-x', total_token_usage: { input_tokens: 100, output_tokens: 30, cached_input_tokens: 15 } } } }),
    JSON.stringify({ timestamp: ts, payload: { info: { model: 'gpt-x', total_token_usage: { input_tokens: 150, output_tokens: 30, cached_input_tokens: 15 } } } }),
  ].join('\n') + '\n');
  const rep = ledger({ days: 30, engines: ['codex'], home: root });
  const cod = rep.byEngine.codex || { input: 0, output: 0, cached: 0 };
  check('codex ledger counts the FIRST total too (100+50=150)', cod.input === 150 && cod.output === 30 && cod.cached === 15, JSON.stringify(cod));
}

// 3) usage dimension consistency
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  const sess = path.join(root, 'pi-sessions');
  fs.mkdirSync(sess, { recursive: true });
  const day = new Date().toISOString();
  fs.writeFileSync(path.join(sess, 'f.jsonl'),
    JSON.stringify({ type: 'model_change', provider: 'fixture-provider', modelId: 'fixture-model' }) + '\n' +
    JSON.stringify({ type: 'message', timestamp: day, message: { role: 'assistant', model: 'fixture-model', usage: { input: 1000000, output: 1000000, cacheRead: 500000, cacheWrite: 250000 } } }) + '\n');
  const s = createSources({ PI_SESSIONS: sess, CODEX_SESSIONS: root, CLAUDE_PROJECTS: root, OMP_SESSIONS: root, GROK_DIR: root, HOME: root, DatabaseSync: null, kbPrice: (mk) => (mk === 'fixture-model' ? { in: 1, out: 2 } : null), loadConfig: () => ({ projects: [] }) });
  const u = s.usageSummary();
  const fp = u.providers['fixture-provider'] || {};
  const dayRow = Object.values(u.days)[0] || {};
  check('usage: provider rows carry cacheWrite', fp.cacheWrite === 250000, JSON.stringify(fp));
  check('usage: day rows fold costEst (total $3 = day $3)', dayRow.costEst === 3, JSON.stringify(dayRow.costEst));
}

// 4) backup: member-level shapes rejected
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  const bt = createBackupTerminal({ CFG_DIR: path.join(root, '.pi-workbench'), HOME: root, CFG_FILE: path.join(root, 'config.json'), ROUTING_FILE: path.join(root, 'routing.json'), CRON_FILE: path.join(root, 'cron.json'), MODEL_META_FILE: path.join(root, 'mm.json'), PI_MODELS: path.join(root, 'models.json'), PI_SETTINGS: path.join(root, 'settings.json'), PI_SKILLS: path.join(root, 'skills.json'), CODEX_SESSIONS: path.join(root, 'codex'), CLAUDE_PROJECTS: path.join(root, 'claude'), VERSION: 'test', listSkills: () => ({ skills: [] }), createZip, readZip, spawn: () => ({ on: () => {}, stdin: { write: () => {} } }), fs, path });
  // build a hostile zip: config.json = {} ; cron job without time
  const z = createZip([
    { name: 'workbench/config.json', data: Buffer.from('{}') },
    { name: 'workbench/cron.json', data: Buffer.from(JSON.stringify({ jobs: [{ id: 'j1', kind: 'daily', prompt: 'x' }] })) },
  ]);
  fs.writeFileSync(path.join(root, 'bad.zip'), z);
  let rejected = false, msg = '';
  try { await bt.importBackupZip(path.join(root, 'bad.zip')); } catch (e) { rejected = true; msg = e.message; }
  check('backup import rejects {} config and time-less daily', rejected, msg || 'accepted!');
}

// ---------- v1.3.3 audit contracts (wave 23) ----------

// 5) failover: ${NAME} env override uses the BARE env name; sameModelNewKey / providerCooledOut
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ providers: {
    provA: { baseUrl: 'https://a.example/v1', apiKey: '${KEY_A}', models: [{ id: 'm1' }, { id: 'm2' }] },
  } }));
  let routing = { chains: [['provA/m1', 'provB/m1']], providers: { provA: { enabled: true, keyEnvs: ['KEY_A', 'KEY_A2'] }, provB: { enabled: true, keyEnvs: [] } }, state: { cooldowns: {} } };
  const saveRouting = (d) => { routing = JSON.parse(JSON.stringify(d)); };
  const { createFailover } = await import('../lib/failover.mjs');
  const fo = createFailover({ SECRET_ENV: { KEY_A: 'fixture-a', KEY_A2: 'fixture-b' }, readJson: () => JSON.parse(fs.readFileSync(path.join(root, 'models.json'), 'utf8')), loadRouting: () => JSON.parse(JSON.stringify(routing)), saveRouting, PI_MODELS: path.join(root, 'models.json') });
  // cool KEY_A (index 0) the way a 401 would
  fo.coolKey('provA', 0, '401 unauthorized', 300);
  const ov = fo.envOverrideFor('provA');
  // semantics: pi reads KEY_A (the models.json ref) — the override must re-point THAT
  // name at the working key's value; the v1.3.3 bug wrote the literal name "{KEY_A}"
  const wroteBareName = ov && ov.KEY_A === 'fixture-b' && ov['{KEY_A}'] === undefined && ov.__keyIdx === 1;
  check('envOverrideFor writes the BARE env name for ${KEY} refs (rotation actually reaches pi)', wroteBareName, JSON.stringify(ov));
  check('sameModelNewKey sees the usable second key', fo.sameModelNewKey('provA/m1') === true);
  check('providerCooledOut false while one key still works', fo.providerCooledOut('provA') === false);
  fo.coolKey('provA', 1, '401 unauthorized', 300);
  check('providerCooledOut true when the whole pool is cooled', fo.providerCooledOut('provA') === true);
  check('providerCooledOut false for ambient-env providers', fo.providerCooledOut('provB') === false);
}

// 6) cron: default-model jobs get rotation wiring; cooled-out providers fail closed; deferred daily still runs
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  let cronState = { jobs: [] };
  let lastEnv = null;
  const cron = createCron({
    CRON_FILE: path.join(root, 'cron.json'), CRON_RUNS_DIR: path.join(root, 'runs'), HOME: root, SECRET_ENV: {}, PI_CLI: 'mock-pi',
    cronPiArgs: () => [], broadcast: () => {},
    readJson: () => JSON.parse(JSON.stringify(cronState)),
    saveJson: (_, d) => { cronState = JSON.parse(JSON.stringify(d)); },
    spawn: (_exe, _args, opts) => { lastEnv = opts.env; const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); setTimeout(() => p.emit('close', 0), 10); return p; },
    get knownProject() { return () => true; },
    get defaultModel() { return () => 'provA/m1'; },
    get envOverrideFor() { return (prov) => (prov === 'provA' ? { __keyIdx: 1, KEY_A2: 'fixture-b' } : null); },
    get providerCooledOut() { return (prov) => prov === 'provCooled'; },
  });
  // 6a: a job WITHOUT an explicit model still consults the default model's provider
  const j1 = { id: 'job-def', kind: 'interval', everyMin: 1, prompt: 'x', enabled: true };
  cronState.jobs.push(j1);
  check('cron default-model job consults envOverrideFor (rotation wired)', cron.runCronJob(j1) === true && lastEnv && lastEnv.KEY_A2 === 'fixture-b', JSON.stringify(lastEnv || {}));
  // 6b: an all-cooled provider refuses to launch
  const j2 = { id: 'job-cooled', kind: 'interval', everyMin: 1, prompt: 'x', enabled: true, model: 'provCooled/m1' };
  cronState.jobs.push(j2);
  check('cron refuses to launch a cooled-out provider (fail-closed keys)', cron.runCronJob(j2) === false && j2.lastStatus === 'keys cooled', j2.lastStatus);
  // 6c: THE REAL SCHEDULING SEQUENCE — intervals occupy both slots FIRST; a daily
  // coming due while they run must be deferred (BOTH of them), then actually fire
  // when a slot frees. Driven through tick(), reading persisted state (audit E01/#15)
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
    let cronState = { jobs: [] };
    const procs = [];
    const cron = createCron({
      CRON_FILE: path.join(root, 'cron.json'), CRON_RUNS_DIR: path.join(root, 'runs'), HOME: root, SECRET_ENV: {}, PI_CLI: 'mock-pi',
      cronPiArgs: () => [], broadcast: () => {},
      readJson: () => JSON.parse(JSON.stringify(cronState)),
      saveJson: (_, d) => { cronState = JSON.parse(JSON.stringify(d)); },
      spawn: () => { const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); procs.push(p); return p; }, // never settles: the slots stay busy
      get knownProject() { return () => true; },
      get defaultModel() { return () => null; },
      get providerCooledOut() { return () => false; },
    });
    const now = new Date();
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'); // due right now
    cronState.jobs = [
      { id: 'iv1', kind: 'interval', everyMin: 1, prompt: 'x', enabled: true },
      { id: 'iv2', kind: 'interval', everyMin: 1, prompt: 'x', enabled: true },
    ];
    cron.tick(); // both intervals spawn and hold the slots
    // the dailies come due while both intervals are still running
    cronState.jobs.push(
      { id: 'daily1', kind: 'daily', time: hhmm, prompt: 'x', enabled: true },
      { id: 'daily2', kind: 'daily', time: hhmm, prompt: 'x', enabled: true },
    );
    cron.tick(); // intervals running → skipped; dailies due but budget full → BOTH deferred, none spawned
    const j1 = cronState.jobs[2], j2 = cronState.jobs[3];
    check('full slots defer EVERY daily (not just the first), none spawned', !!j1.deferDay && !!j2.deferDay && procs.length === 2, JSON.stringify({ procs: procs.length, d1: j1.deferDay, d2: j2.deferDay }));
    for (const p of procs) p.emit('close', 0); // the intervals settle — slots free up
    cron.tick(); // the deferred dailies must actually fire now
    const fired1 = cronState.jobs[2], fired2 = cronState.jobs[3]; // tick() re-reads from disk — read the PERSISTED state, not the pre-tick copies
    check('deferred dailies fire on a later tick with free slots', procs.length === 4 && !!fired1.lastRunDay && !fired1.deferDay && !!fired2.lastRunDay, JSON.stringify({ procs: procs.length, defer: fired1.deferDay, day: fired1.lastRunDay }));
    cron.shutdown();
  }

  // 6d: a job interrupted by a restart must not double-start on the next ticks (audit #14)
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
    let cronState = { jobs: [] };
    const procs = [];
    const cron = createCron({
      CRON_FILE: path.join(root, 'cron.json'), CRON_RUNS_DIR: path.join(root, 'runs'), HOME: root, SECRET_ENV: {}, PI_CLI: 'mock-pi',
      cronPiArgs: () => [], broadcast: () => {},
      readJson: () => JSON.parse(JSON.stringify(cronState)),
      saveJson: (_, d) => { cronState = JSON.parse(JSON.stringify(d)); },
      spawn: () => { const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); procs.push(p); return p; }, // never settles
      get knownProject() { return () => true; },
      get defaultModel() { return () => null; },
      get providerCooledOut() { return () => false; },
    });
    // disk state as a crash left it: running:true (bootReset will clear) with a stale lastRunMs
    const j = { id: 'job-x', kind: 'interval', everyMin: 1, prompt: 'x', enabled: true, running: true, lastRunMs: Date.now() - 10 * 60000, lastStatus: 'running' };
    cronState.jobs = [j];
    cron.bootReset(cronState);
    cron.tick(); // tick 1: spawns, and running:true MUST reach disk
    const spawnedOnce = procs.length === 1 && cronState.jobs[0].running === true;
    cron.tick(); // tick 2: the persisted running flag must prevent a second spawn
    check('restart-interrupted interval spawns once, not twice (bootReset + persist)', spawnedOnce && procs.length === 1, JSON.stringify({ procs: procs.length, diskRunning: cronState.jobs[0].running }));
    cron.shutdown();
  }

  // 7) backup: restore must not graft this machine's key onto a DIFFERENT or UNKNOWN endpoint; exclude-keys backup strips error text and fails closed
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
    const cfgDir = path.join(root, '.pi-workbench');
    // current machine state: provA at OLD endpoint with a key; provB has a key but NO baseUrl (unknown trust domain)
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ providers: {
      provA: { baseUrl: 'https://old.example/v1', apiKey: 'sk-live-machine-key', headers: { authorization: 'Bearer sk-live-hdr' } },
      provB: { apiKey: 'sk-no-url-key', headers: { cookie: 'sk-cookie-secret' } },
    } }));
    let routing = { chains: [], providers: {}, state: { cooldowns: { 'provA#key0': { until: Date.now() + 60000, error: '401 Bearer sk-secret-in-error' } } } };
    fs.writeFileSync(path.join(root, 'routing.json'), JSON.stringify(routing));
    // a corrupt cron.json: unparseable lastOutput must NOT fall back to the raw file in a no-keys backup
    fs.writeFileSync(path.join(root, 'cron.json'), '{not json at all');
    const bt = createBackupTerminal({ CFG_DIR: cfgDir, HOME: root, CFG_FILE: path.join(root, 'config.json'), ROUTING_FILE: path.join(root, 'routing.json'), CRON_FILE: path.join(root, 'cron.json'), MODEL_META_FILE: path.join(root, 'mm.json'), PI_MODELS: path.join(root, 'models.json'), PI_SETTINGS: path.join(root, 'settings.json'), PI_SKILLS: path.join(root, 'skills.json'), CODEX_SESSIONS: path.join(root, 'codex'), CLAUDE_PROJECTS: path.join(root, 'claude'), VERSION: 'test', listSkills: () => ({ skills: [] }), createZip, readZip, spawn: () => ({ on: () => {}, stdin: { write: () => {} } }), fs, path });
    const z = createZip([{ name: 'pi-agent/models.json', data: Buffer.from(JSON.stringify({ providers: {
      provA: { baseUrl: 'https://new.example/v1' }, // SAME name, DIFFERENT endpoint, no key (redacted backup)
      provB: { baseUrl: 'https://fresh.example/v1' }, // old entry had NO baseUrl — unknown endpoint, key must not follow
    } })) }]);
    fs.writeFileSync(path.join(root, 'move.zip'), z);
    await bt.importBackupZip(path.join(root, 'move.zip'));
    const after = JSON.parse(fs.readFileSync(path.join(root, 'models.json'), 'utf8'));
    check('restore does NOT graft the machine key onto a moved endpoint', after.providers.provA.apiKey === undefined && after.providers.provA.baseUrl === 'https://new.example/v1', JSON.stringify(after.providers.provA));
    check('restore does NOT graft a key whose old baseUrl was UNKNOWN', after.providers.provB.apiKey === undefined, JSON.stringify(after.providers.provB));
    const rep = await bt.exportBackupZip(true);
    const entries = readZip(fs.readFileSync(rep.path));
    const routingEntry = entries.find((e) => e.name === 'workbench/routing.json');
    const rdoc = JSON.parse(routingEntry.data.toString('utf8'));
    const errText = rdoc.state?.cooldowns?.['provA#key0']?.error || '';
    check('exclude-keys backup strips cooldown error text', !errText.includes('sk-secret-in-error'), errText);
    // a corrupt cron.json must be OMITTED from a keys-free backup, never packed raw (audit #04)
    check('exclude-keys backup fails CLOSED on corrupt cron (no raw fallback)', !entries.some((e) => e.name === 'workbench/cron.json'), entries.map((e) => e.name).join(','));
    // Cookie-class headers must not survive a keys-free backup (audit #03)
    const modelsEntry = entries.find((e) => e.name === 'pi-agent/models.json');
    const mdoc = JSON.parse(modelsEntry.data.toString('utf8'));
    check('exclude-keys backup strips Cookie-class credential headers', !mdoc.providers.provB.headers?.cookie, JSON.stringify(mdoc.providers.provB.headers || {}));
    // export paths must be unique per call (audit #06)
    const rep2 = await bt.exportBackupZip(false);
    check('consecutive exports never share one zip path', rep.path !== rep2.path, rep.path);
  }

  // 7b) import rejects routing.json whose state is a scalar (audit #07)
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
    const cfgDir = path.join(root, '.pi-workbench');
    fs.mkdirSync(cfgDir, { recursive: true });
    const bt = createBackupTerminal({ CFG_DIR: cfgDir, HOME: root, CFG_FILE: path.join(root, 'config.json'), ROUTING_FILE: path.join(root, 'routing.json'), CRON_FILE: path.join(root, 'cron.json'), MODEL_META_FILE: path.join(root, 'mm.json'), PI_MODELS: path.join(root, 'models.json'), PI_SETTINGS: path.join(root, 'settings.json'), PI_SKILLS: path.join(root, 'skills.json'), CODEX_SESSIONS: path.join(root, 'codex'), CLAUDE_PROJECTS: path.join(root, 'claude'), VERSION: 'test', listSkills: () => ({ skills: [] }), createZip, readZip, spawn: () => ({ on: () => {}, stdin: { write: () => {} } }), fs, path });
    let rejected = false;
    try {
      const zbad = createZip([{ name: 'workbench/routing.json', data: Buffer.from('{"state":1,"chains":[null]}') }]);
      fs.writeFileSync(path.join(root, 'bad-routing.zip'), zbad);
      await bt.importBackupZip(path.join(root, 'bad-routing.zip'));
    } catch { rejected = true; }
    check('import rejects routing.json with scalar state / null chains', rejected, 'accepted!');
  }
}

// 8) session tree: a parent cycle must not hang the walk
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  const sess = path.join(root, 'pi-sessions');
  fs.mkdirSync(sess, { recursive: true });
  const f = path.join(sess, 'cycle.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ id: 'a', parentId: 'b', type: 'message', message: { role: 'user', content: 'x' } }),
    JSON.stringify({ id: 'b', parentId: 'a', type: 'message', message: { role: 'assistant', content: 'y' } }),
  ].join('\n') + '\n');
  const s = createSources({ PI_SESSIONS: sess, CODEX_SESSIONS: root, CLAUDE_PROJECTS: root, OMP_SESSIONS: root, GROK_DIR: root, HOME: root, DatabaseSync: null, kbPrice: () => null, loadConfig: () => ({ projects: [] }) });
  const t = s.sessionTree ? s.sessionTree(f) : null;
  check('session tree survives a parent cycle (no hang, path bounded)', !!t && t.activePath.length <= 2, JSON.stringify(t && t.activePath));
}

// ---------- v1.3.5 audit contracts (wave 25) ----------

// 9) F17/F19: a cooldown belongs to a CREDENTIAL, not to a pool position
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  const modelsFile = path.join(root, 'models.json');
  fs.writeFileSync(modelsFile, JSON.stringify({ providers: {
    p: { baseUrl: 'https://p.example/v1', apiKey: '$KEY_A', models: [{ id: 'm1' }] },
  } }));
  let routing = { chains: [], providers: { p: { enabled: true, keyEnvs: ['KEY_A', 'KEY_B'] } }, state: { cooldowns: {} } };
  const { createFailover } = await import('../lib/failover.mjs');
  const fo = createFailover({
    SECRET_ENV: { KEY_A: 'va', KEY_B: 'vb' },
    readJson: () => JSON.parse(fs.readFileSync(modelsFile, 'utf8')),
    loadRouting: () => JSON.parse(JSON.stringify(routing)),
    saveRouting: (d) => { routing = JSON.parse(JSON.stringify(d)); },
    PI_MODELS: modelsFile,
  });
  fo.coolKey('p', 0, '401 unauthorized', 300);
  check('F19 a cooldown is stored by env NAME, not by pool index',
    !!routing.state.cooldowns['p#env:KEY_A'] && !routing.state.cooldowns['p#key0'], JSON.stringify(routing.state.cooldowns));
  // reorder the pool behind the running tab's back: the cooled credential must follow
  // its NAME. The pre-1.3.6 index key would have pointed slot 0 at a different secret.
  routing.providers.p.keyEnvs = ['KEY_B', 'KEY_A'];
  const pk = fo.pickKey('p');
  check('F19 after a pool reorder the cooled credential is still the cooled one',
    !!pk && pk.env === 'KEY_B', JSON.stringify(pk));
  fo.clearCool('p/m1', 'KEY_B');
  check('F19 a success clears exactly the credential that answered',
    !!routing.state.cooldowns['p#env:KEY_A'] && !routing.state.cooldowns['p#env:KEY_B'], JSON.stringify(routing.state.cooldowns));
  // F17: a literal plaintext key has no rotation pool — and a 401 on it must still bite
  fs.writeFileSync(modelsFile, JSON.stringify({ providers: { p: { apiKey: 'sk-literal', models: [{ id: 'm1' }] } } }));
  check('F17 a literal-key provider advertises no rotation pool', fo.keyEnvsFor('p').length === 0, JSON.stringify(fo.keyEnvsFor('p')));
  fo.coolKey('p', 0, '401 unauthorized', 300);
  check('F17 a 401 on a literal key cools the literal slot (not a slot nothing reads)',
    !!routing.state.cooldowns['p#literal'], JSON.stringify(routing.state.cooldowns));
  check('F17 a cooled literal key is not offered as available', fo.providerHasKey('p') === false);
  fo.clearCool('p/m1', undefined);
  check('F17 a success re-arms the literal key', fo.providerHasKey('p') === true);
}

// 10) F18: a dangling PROVIDER is skipped — an unlisted MODEL is not (the audit scoped
// the claim to providers; pi, not this function, is the authority on model ids)
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  const modelsFile = path.join(root, 'models.json');
  fs.writeFileSync(modelsFile, JSON.stringify({ providers: {
    a: { baseUrl: 'https://a.example/v1', apiKey: 'sk-a', models: [{ id: 'm1' }] },
    b: { baseUrl: 'https://b.example/v1', apiKey: 'sk-b', models: [{ id: 'm1' }] }, // lists m1 only
  } }));
  let routing = { chains: [['a/m1', 'ghost/m9', 'b/m3']], providers: { a: { enabled: true }, b: { enabled: true } }, state: { cooldowns: {} } };
  const { createFailover } = await import('../lib/failover.mjs');
  const fo = createFailover({
    SECRET_ENV: {},
    readJson: () => JSON.parse(fs.readFileSync(modelsFile, 'utf8')),
    loadRouting: () => JSON.parse(JSON.stringify(routing)),
    saveRouting: (d) => { routing = JSON.parse(JSON.stringify(d)); },
    PI_MODELS: modelsFile,
  });
  check('F18 a chain entry naming a nonexistent PROVIDER is skipped',
    fo.nextInChain('a/m1') === 'b/m3', JSON.stringify(fo.nextInChain('a/m1')));
  // b exists but lists only m1 while the chain names b/m3 — that must NOT be skipped
  // (the first cut of this fix emptied the whole chain here; failover-e2e caught it)
  fs.writeFileSync(modelsFile, JSON.stringify({ providers: {
    a: { apiKey: 'sk-a', models: [{ id: 'm1' }] },
    b: { apiKey: 'sk-b', models: [{ id: 'm1' }] },
  } }));
  check('F18 an existing provider with an unlisted model is still offered',
    fo.nextInChain('a/m1') === 'b/m3', JSON.stringify(fo.nextInChain('a/m1')));
  routing.chains = [['a/m1', 'ghost/m9']];
  check('F18 nothing left but dangling entries → null (no phantom failover target)',
    fo.nextInChain('a/m1') === null, JSON.stringify(fo.nextInChain('a/m1')));
}

// 11) F09/F10/F11/F12/F13: one live run per job id across processes; a refused or
// failed launch must not burn the day
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  const runsDir = path.join(root, 'runs');
  const mk = (spawnFn, extra = {}) => createCron({
    CRON_FILE: path.join(root, 'cron.json'), CRON_RUNS_DIR: runsDir, HOME: root, SECRET_ENV: {}, PI_CLI: 'mock-pi',
    cronPiArgs: () => [], broadcast: () => {},
    readJson: () => ({ jobs: [] }), saveJson: () => {},
    spawn: spawnFn,
    get knownProject() { return () => true; },
    get defaultModel() { return () => null; },
    get providerCooledOut() { return () => false; },
    ...extra,
  });
  const live = () => { const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); return p; }; // never settles
  const cronA = mk(live);
  const cronB = mk(live); // a SECOND server process sharing CRON_RUNS_DIR
  const ja = { id: 'lock1', kind: 'interval', everyMin: 1, prompt: 'x', enabled: true };
  const jb = { id: 'lock1', kind: 'interval', everyMin: 1, prompt: 'x', enabled: true };
  check('F09/F10 instance A starts the job', cronA.runCronJob(ja) === true, ja.lastStatus);
  check('F09/F10 instance B refuses the same job id while the lock is held',
    cronB.runCronJob(jb) === false && jb.lastStatus === 'already running', jb.lastStatus);
  // the mode is POSIX-only: Windows ignores it and inherits the profile ACL instead
  if (process.platform !== 'win32') check('F09/F10 the lock file is private-by-default (0600)', (fs.statSync(path.join(runsDir, 'lock1.lock')).mode & 0o777) === 0o600, (fs.statSync(path.join(runsDir, 'lock1.lock')).mode & 0o777).toString(8));
  // F11: a spawn-prep failure must not consume today's daily window
  const cronThrow = mk(() => { throw new Error('boom'); });
  const hhmm = String(new Date().getHours()).padStart(2, '0') + ':' + String(new Date().getMinutes()).padStart(2, '0');
  const jd = { id: 'daily1', kind: 'daily', time: hhmm, prompt: 'x', enabled: true };
  check('F11 a failed spawn reports the failure', cronThrow.runCronJob(jd) === false && jd.lastStatus === 'spawn error', jd.lastStatus);
  check('F11 a failed spawn does NOT burn the day (lastRunDay untouched)', jd.lastRunDay === undefined, String(jd.lastRunDay));
  check('F11 the failed launch releases the run lock (no 30-min deadlock)',
    !fs.existsSync(path.join(runsDir, 'daily1.lock')));
  // F12/F13: a refused daily is DEFERRED (retries later today) instead of missing the day
  const jc = { id: 'daily2', kind: 'daily', time: hhmm, prompt: 'x', enabled: true, model: 'p/m1' };
  const cronCool = mk(live, { get modelCooled() { return () => true; }, get providerCooledOut() { return () => false; } });
  check('F13 a cooled model refuses the unattended run', cronCool.runCronJob(jc) === false && jc.lastStatus === 'model cooled', jc.lastStatus);
  const localDay = (d2) => `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}-${String(d2.getDate()).padStart(2, '0')}`;
  check('F12 a refused daily is deferred to retry today', jc.deferDay === localDay(new Date()), String(jc.deferDay));
  check('F12 a refused daily does not burn the day', jc.lastRunDay === undefined, String(jc.lastRunDay));
}

// 12) F26: the claude ledger keeps the LAST usage row for one api message id
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  const proj = path.join(root, '.claude', 'projects', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const ts = new Date().toISOString();
  const row = (id, input, output) => JSON.stringify({ timestamp: ts, cwd: '/w', message: { id, model: 'claude-x', usage: { input_tokens: input, output_tokens: output } } });
  fs.writeFileSync(path.join(proj, 'a.jsonl'), [
    row('msg_1', 100, 5), // the streaming partial row
    row('msg_2', 7, 3),   // a different call
    row('msg_1', 200, 40), // the final row for msg_1 — must WIN
  ].join('\n') + '\n');
  const rep = ledger({ days: 30, engines: ['claude'], home: root });
  const c = rep.byEngine.claude || { input: 0, output: 0 };
  check('F26 the claude ledger counts one row per api message id (last wins)',
    c.input === 207 && c.output === 43, JSON.stringify(c));
}

// 13) v1.3.6 review (wave 26): the five P2/P3 items — structural checks on the app
// source plus a behavioral check on collectProc's strict caps
{
  const repoRoot = path.resolve(path.dirname(decodeURI(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const io = fs.readFileSync(path.join(repoRoot, 'lib', 'io.mjs'), 'utf8');

  // P2-1: the composer must not clear the input before the open is confirmed; the
  // clear happens only at the point of no return, AFTER the open await
  const submitIdx = app.indexOf('async function submitPrompt');
  const clearIdx = app.indexOf("inputEl.value = '';", submitIdx);
  const openAwaitIdx = app.indexOf('await openPiSession({ isNew: true })', submitIdx);
  const tabIdGateIdx = app.indexOf('if (!state.tabId) return;', submitIdx);
  check('P2-1 submitPrompt clears the composer only after the open await + tabId gate',
    submitIdx > 0 && clearIdx > openAwaitIdx && openAwaitIdx > 0 && clearIdx > tabIdGateIdx && tabIdGateIdx > 0,
    `submit@${submitIdx} gate@${tabIdGateIdx} await@${openAwaitIdx} clear@${clearIdx}`);
  check('P2-1 a refused open reports failure and keeps the draft',
    app.includes('会话打开失败：') && app.includes('输入框内容已保留'), 'failure statusline missing');
  check('P2-1 openPiSession settles through one deferred (resolve + reject + backstop)',
    app.includes('function newOpenDeferred') && app.includes('function resolveOpen') && app.includes('function rejectOpen') && app.includes('等待会话打开确认超时'),
    'open deferred missing');

  // P2-2: the 200-cap queue drops only refresh-class RPC and refuses user-meaningful frames
  check('P2-2 wsSend drops only refresh-class RPC at the 200 cap',
    app.includes('DROPPABLE_RPC') && app.includes('未能入队') && !app.includes('最早的一条待发消息被丢弃'),
    'queue policy comment/behavior missing');

  // P3-3: a set-default site must not touch cfg/chip before the write is acknowledged.
  // Two sites, two shapes: the per-provider "设默认" button posts /api/config itself and
  // checks the ack; the provider form now sets the default inside the provider
  // transaction and only adopts it when the transaction reports defaulted=true.
  const setDefaultSites = app.split("api.post('/api/config', { defaultModel").length - 1;
  check('P3-3 every set-default site checks the ack before touching cfg/chip',
    setDefaultSites >= 1 && app.includes("'默认模型保存失败：'") &&
    /if \(r\.defaulted && state\.cfg\) \{[\s\S]{0,200}?state\.cfg\.defaultModel = def\.value/.test(app),
    `sites=${setDefaultSites}`);

  // P3-4: provider save works on a clone and reloads state from disk on partial failure
  check('P3-4 btn-prov-save clones modelsDoc and reloads config state on partial failure',
    app.includes('JSON.parse(JSON.stringify(state.modelsDoc))') && app.includes('async function reloadConfigState'),
    'clone or reloadConfigState missing');

  // P3-5: collectProc enforces caps at the CHUNK level, not just on settle
  check('P3-5 collectProc slices each stdout/stderr chunk to the remaining cap',
    io.includes('maxOut - out.length') && io.includes('maxErr - err.length') && io.includes('out.slice(0, maxOut)'),
    'chunk-level slicing missing');
}

// 14) v1.3.7 review (wave 27): the 14 items — source contracts for the ones that are
// structural, behavioral checks for every module that can be driven directly.
{
  const repoRoot = path.resolve(path.dirname(decodeURI(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const rd = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
  const app = rd(path.join('public', 'app.js'));
  const srv = rd('server.mjs');
  const cronSrc = rd(path.join('lib', 'cron.mjs'));
  const mcp = rd(path.join('extensions', 'mcp-bridge.js'));
  const ci = rd(path.join('.github', 'workflows', 'ci.yml'));

  // P1-2: the GUI admin token must not survive into ANY child environment
  check('P1-2 server scrubs PIWB_TOKEN from its own env after capture',
    /delete process\.env\.PIWB_TOKEN;/.test(srv) && srv.indexOf('delete process.env.PIWB_TOKEN') > srv.indexOf('const API_TOKEN = process.env.PIWB_TOKEN'),
    'capture-then-scrub missing');
  check('P1-2 MCP bridge strips the token before spawning a server',
    mcp.includes('delete e.PIWB_TOKEN'), 'bridge env strip missing');

  // P2-8: prototype-pollution gate on every request-supplied provider key
  check('P2-8 routing/models reject __proto__ and guard own properties',
    srv.includes('const isSafeKey') && srv.includes('isSafeKey(name)') && srv.includes('Object.hasOwn(routing.providers, name)'),
    'unsafe-key gate missing');

  // P2-7: malformed members are 400s, not 500s
  check('P2-7 cron/routing/models validate every member, not just the container',
    srv.includes('每个任务必须是对象') && srv.includes('must be an object') && srv.includes('every model needs a string id'),
    'member validation missing');

  // P2-6: imports are capped before the whole file is read
  check('P2-6 import refuses files over the byte cap and reports truncation',
    srv.includes('MAX_IMPORT_BYTES') && srv.includes('MAX_IMPORT_ENTRIES') && srv.includes('truncated'),
    'import cap missing');

  // P2-5: the cron lock descriptor is closed on both settle paths
  check('P2-5 cron closes the lock fd on settle and on spawn failure',
    (cronSrc.match(/fs\.closeSync\(lockFd\)/g) || []).length >= 2 && cronSrc.includes('lockFd = undefined;'),
    'lock fd close missing');

  // P2-3/P2-4: wsSend reports acceptance; the composer restores on refusal; opens resolve
  check('P2-3 wsSend reports whether the frame was accepted',
    /function wsSend\(obj\)[\s\S]{0,1600}?return true;/.test(app) && app.includes('if (!rpcTo(cmd))'),
    'wsSend receipt or composer restore missing');
  check('P2-4 the deferred resolves on opened/pi-session-file and rejects on denial',
    app.includes('function settleOpen') && /if \(msg\.type === 'opened'\) \{ resolveOpen\(msg\.tabId\); return; \}/.test(app) && app.includes('rejectOpen(msg.tabId'),
    'deferred settle wiring missing');

  // P2-9/P2-10: advanced save reloads memory; provider delete sweeps dangling refs
  check('P2-9 advanced JSON save reloads state.modelsDoc',
    /btn-models-save[\s\S]{0,900}?await loadModelsEditor\(\)/.test(app), 'modelsDoc not reloaded');
  // wave 28 moved the sweep into the server transaction, so the front end no longer
  // writes config.json / routing.json itself — it asks for the deletion and reports
  // what the server swept.
  check('P2-10 provider delete sweeps dangling refs in the same commit',
    app.includes("api.post('/api/provider/delete', { name })") &&
    /btn-prov-del[\s\S]{0,2600}?r\.swept/.test(app),
    'delete cleanup missing');

  // P3-13: numeric model fields must be escaped like every other attribute
  check('P3-13 contextWindow/maxTokens are escaped into the attribute',
    app.includes("esc(String(m.contextWindow == null ? '' : m.contextWindow))") && app.includes("esc(String(m.maxTokens == null ? '' : m.maxTokens))"),
    'attribute escaping missing');

  // P1-1: the mac build must assemble a runtime PER architecture — one darwin-x64 node
  // packed into both dmgs shipped an arm64 build that only ran under Rosetta.
  // The arch COMPARISON also has to speak lipo's vocabulary: the first version of this
  // guard compared the literal "x64" against lipo's "x86_64" and failed every x64 build.
  check('P1-1 macOS builds bundle a per-arch Node runtime and assert it',
    ci.includes('for arch in arm64 x64') && ci.includes('darwin-$arch.tar.xz') && ci.includes('lipo -archs') && ci.includes('pkg-runtime-$arch.zip'),
    'per-arch runtime assembly missing');
  check('P1-1 the arch assertions compare in lipo spelling (arm64 / x86_64)',
    ci.includes('case "$arch" in arm64) want=arm64 ;; x64) want=x86_64 ;; esac') && ci.includes('*"$want"*)'),
    'arch comparison still compares the literal package arch against lipo output');
  check('P1-1 each built dmg is unpacked and its bundled node arch verified',
    ci.includes('hdiutil attach') && ci.includes('runtime.zip') && ci.includes('got="$(lipo -archs "/tmp/rt-$arch/node")"'),
    'dmg arch verification missing');

  // P3-14: workflow actions pinned to immutable commits
  check('P3-14 CI actions are pinned to commit SHAs',
    !/@v\d+(\s|$)/m.test(ci) && /uses:\s*[^@\s]+@[0-9a-f]{40}/.test(ci),
    'mutable action tags still present');

  // P3-11: the Tauri shell must supervise its own server like Electron does
  const rs = rd(path.join('tauri', 'src', 'main.rs'));
  check('P3-11 Tauri restarts a crashed server within a restart budget',
    rs.includes('fn start_supervisor') && rs.includes('restarts >= 2') && rs.includes('start_supervisor(app.handle().clone()'),
    'tauri supervisor missing');
  check('P3-11 Tauri marks quitting so the supervisor cannot resurrect the server',
    rs.includes('static QUITTING') && rs.includes('QUITTING.store(true') && rs.includes('QUITTING.load'),
    'quit guard missing');

  // P3-12: the path check and the syscall must name the same (resolved) file
  check('P3-12 file APIs operate on the resolved path, not the client-supplied one',
    srv.includes('const resolveInside = (root, target)') &&
    (srv.match(/resolveInside\(/g) || []).length >= 5,
    'resolveInside not used at the call sites');
}

// 15) v1.3.8 review (wave 28): the five short-comings. Short-comings 1-3 are code
// problems and are driven for real; 4-5 are honest-scope statements and are recorded,
// not "fixed" by a patch.
{
  const repoRoot = path.resolve(path.dirname(decodeURI(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const rd = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
  const app = rd(path.join('public', 'app.js'));
  const srv = rd('server.mjs');
  const srcSrc = rd(path.join('lib', 'sources.mjs'));
  const provSrc = rd(path.join('lib', 'providers.mjs'));
  const ci = rd(path.join('.github', 'workflows', 'ci.yml'));

  // --- short-coming 1: a provider change is one commit, not a three-request sequence
  check('28-1 providers module owns the cross-file transaction',
    provSrc.includes('export function createProviders') && provSrc.includes('export class ProviderError') &&
    provSrc.includes('const CTX_KEYS = ') && provSrc.includes('function snapshot(') &&
    provSrc.includes('function restore(') && provSrc.includes('function commit('),
    'providers.mjs transaction surface missing');
  check('28-1 server routes provider save/delete through the transaction',
    srv.includes("import {createProviders, ProviderError} from './lib/providers.mjs'") &&
    srv.includes('createProviders({') &&
    srv.includes("['POST', '/api/provider/save', hProviderSave]") &&
    srv.includes("['POST', '/api/provider/delete', hProviderDelete]"),
    'server not wired to the provider transaction');
  // the route sweep caught this one: remove() takes the NAME, not the request body
  check('28-1 the delete handler passes the name, not the request object',
    srv.includes('providers.remove(name)') && !srv.includes('providers.remove({ name })'),
    'delete handler passes the body object to remove()');
  const saveIdx = app.indexOf("$('#btn-prov-save')");
  const delIdx = app.indexOf("$('#btn-prov-del')");
  const saveBody = app.slice(saveIdx, delIdx > saveIdx ? delIdx : saveIdx + 3000);
  check('28-1 the save handler makes ONE request instead of three',
    saveBody.includes("api.post('/api/provider/save'") &&
    !saveBody.includes("api.post('/api/routing'") && !saveBody.includes("api.post('/api/config'"),
    'save handler still writes the other two files itself');
  // bound the slice at the NEXT handler — a fixed-length window bleeds into the
  // advanced-JSON save below and blames this handler for its /api/models call
  const delEnd = app.indexOf("$('#", delIdx + 10);
  const delBody = app.slice(delIdx, delEnd > delIdx ? delEnd : delIdx + 2600);
  check('28-1 the delete handler makes ONE request instead of three',
    delBody.includes("api.post('/api/provider/delete'") &&
    !delBody.includes("api.post('/api/models'") && !delBody.includes("api.post('/api/config'"),
    'delete handler still cleans references with its own requests');
  check('28-1 a reported rollback failure re-reads disk instead of trusting memory',
    saveBody.includes('r.rollback') && saveBody.includes('await reloadConfigState()'),
    'failed-rollback path does not resync');

  // behavioral: a failure on the LAST write restores the earlier files, and a rollback
  // that itself fails is reported rather than swallowed.
  {
    const { createProviders, ProviderError } = await import('../lib/providers.mjs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-prov-'));
    const MODELS_FILE = path.join(tmp, 'models.json');
    const ROUTING_FILE = path.join(tmp, 'routing.json');
    const CFG_FILE = path.join(tmp, 'config.json');
    const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
    const realAtomic = (f, raw) => { fs.writeFileSync(f + '.tmp', raw); fs.renameSync(f + '.tmp', f); };
    const isSafeKey = (k) => typeof k === 'string' && k.length > 0 && !['__proto__', 'constructor', 'prototype'].includes(k);

    const before = {
      [MODELS_FILE]: JSON.stringify({ providers: { a: { models: [{ id: 'm1' }] } } }, null, 2),
      [ROUTING_FILE]: JSON.stringify({ chains: [['a/m1']] }, null, 2),
      [CFG_FILE]: JSON.stringify({ defaultModel: 'a/m1' }, null, 2),
    };
    for (const [f, raw] of Object.entries(before)) fs.writeFileSync(f, raw);
    // fail exactly once, on the commit phase only — otherwise the rollback itself would
    // hit the same injected fault and we could never observe a clean restore
    const bake = ({ failOn, failRollbackOn = null } = {}) => {
      let phase = 'commit';
      return createProviders({
        MODELS_FILE, ROUTING_FILE, CFG_FILE, readJson, isSafeKey,
        atomicWrite: (f, raw) => {
          if (phase === 'commit' && f === failOn) { phase = 'rollback'; throw new Error('disk full (simulated)'); }
          if (phase === 'rollback' && f === failRollbackOn) throw new Error('rollback also failed (simulated)');
          realAtomic(f, raw);
        },
      });
    };

    let err = null;
    try { bake({ failOn: CFG_FILE }).save({ name: 'a', provider: { models: [{ id: 'm2' }] }, testModel: 'a/m2', defaultModel: 'a/m2' }); }
    catch (e) { err = e; }
    const restored = Object.entries(before).every(([f, raw]) => fs.readFileSync(f, 'utf8') === raw);
    check('28-1 a mid-transaction write failure rolls every file back',
      err instanceof ProviderError && err.status === 500 && err.rollback.length === 0 &&
      err.detail === '已回滚到修改前的状态' && restored,
      'rollback did not restore the pre-images');

    // a rollback that cannot write must be REPORTED, not swallowed
    let err2 = null;
    try { bake({ failOn: CFG_FILE, failRollbackOn: MODELS_FILE }).save({ name: 'a', provider: { models: [] }, defaultModel: 'a/x' }); }
    catch (e) { err2 = e; }
    check('28-1 a rollback that itself fails is reported, not swallowed',
      err2 instanceof ProviderError && err2.rollback.length === 1 && /磁盘可能处于部分更新状态/.test(err2.detail || ''),
      'failed rollback was silent');

    // an "absent" file must come back absent, not as an empty object
    const neverRouting = path.join(tmp, 'never-routing.json');
    const absent = createProviders({
      MODELS_FILE, ROUTING_FILE: neverRouting, CFG_FILE, readJson, isSafeKey,
      atomicWrite: (f, raw) => {
        if (f === CFG_FILE) throw new Error('disk full (simulated)');
        realAtomic(f, raw);
      },
    });
    try { absent.save({ name: 'a', provider: { models: [] }, testModel: 'a/x', defaultModel: 'a/x' }); } catch { /* expected */ }
    check('28-1 rollback deletes a file that did not exist before the transaction',
      !fs.existsSync(neverRouting), 'rollback left a file the transaction had created');

    // deletion sweeps the references in the SAME commit
    const rm = bake().remove('a');
    check('28-1 deleting a provider sweeps defaultModel and chain entries in one commit',
      rm.existed === true && rm.swept.length === 2 &&
      readJson(CFG_FILE).defaultModel === null &&
      Object.keys(readJson(MODELS_FILE).providers).length === 0 &&
      JSON.stringify(readJson(ROUTING_FILE).chains) === '[]',
      `remove did not sweep: ${JSON.stringify({ swept: rm.swept, chains: readJson(ROUTING_FILE).chains })}`);

    // validation happens BEFORE the first byte is written
    const bad = bake();
    let err3 = null;
    try { bad.save({ name: '__proto__', provider: { models: [] } }); } catch (e) { err3 = e; }
    check('28-1 an unsafe provider name is refused before any write',
      err3 instanceof ProviderError && err3.status === 400 && !fs.readFileSync(MODELS_FILE, 'utf8').includes('__proto__'),
      'unsafe name was not refused up front');

    for (const f of Object.keys(before)) { try { fs.unlinkSync(f); } catch { /* cleanup */ } }
  }

  // --- short-coming 2: "run now" must report a refusal, not look like it ran
  check('28-2 the run-now button reports a refused run instead of resetting silently',
    app.includes("api.post('/api/cron/run-now'") && app.includes('立即运行被拒绝') && app.includes('r.ok === false'),
    'run-now answer still discarded');

  // --- short-coming 3: the usage cache is bounded by the window it serves
  check('28-3 the usage cache evicts entries outside the scanned window',
    srcSrc.includes('for (const key of [...usageCache.keys()]) if (!scanned.has(key)) usageCache.delete(key);') &&
    srcSrc.includes('const scanned = new Set(items.map((i) => i.f));'),
    'usage cache still grows without bound');
  check('28-3 the cache size is surfaced so the bound is visible',
    srcSrc.includes('total.cachedFiles = usageCache.size;'),
    'cache size not reported');

  // --- the release process itself: a version cannot disagree with itself again
  check('version identity is gated in CI, not discovered from an asset name',
    ci.includes('node scripts/assert-version.mjs'),
    'no version consistency gate');
  {
    // and the gate must actually fail on a tree where one manifest lags
    const { execFileSync } = await import('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-ver-'));
    // pretty-printed: the lockfile anchors are line-based, exactly like the real files
    const put = (rel, body) => {
      const f = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n');
    };
    put('package.json', { name: 'pi-workbench', version: '9.9.9' });
    put('runtime-package.json', { version: '9.9.9' });
    put('tauri/tauri.conf.json', { version: '9.9.9' });
    put('package-lock.json', { name: 'pi-workbench', version: '9.9.9', lockfileVersion: 3 });
    put('runtime-package-lock.json', { name: 'pi-workbench-runtime', version: '9.9.9', lockfileVersion: 3 });
    put('tauri/Cargo.toml', '[package]\nname = "pi-workbench"\nversion = "9.9.9"\n');
    put('tauri/Cargo.lock', '[[package]]\nname = "pi-workbench"\nversion = "9.9.9"\n');
    const runGate = () => {
      try {
        execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'assert-version.mjs'), tmp], { stdio: 'pipe' });
        return 0;
      } catch (e) { return e.status || 1; }
    };
    const consistent = runGate();
    put('tauri/Cargo.toml', '[package]\nname = "pi-workbench"\nversion = "9.9.8"\n');
    const drifted = runGate();
    check('the version gate passes a consistent tree and fails a drifted one',
      consistent === 0 && drifted === 1,
      `consistent=${consistent} drifted=${drifted}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}


