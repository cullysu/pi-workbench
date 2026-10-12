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
  // 6c: a deferred daily still fires after its 2-minute window
  const j3 = { id: 'job-daily', kind: 'daily', time: '03:00', prompt: 'x', enabled: true, deferDay: new Date().toISOString().slice(0, 10) };
  cronState.jobs.push(j3);
  check('deferred daily stays eligible outside its window', cron.runCronJob(j3) === true && j3.deferDay === null && j3.lastRunDay === new Date().toISOString().slice(0, 10).replace(/-/g, '-') || j3.lastRunDay, JSON.stringify({ defer: j3.deferDay, day: j3.lastRunDay }));
}

// 7) backup: restore must not graft this machine's key onto a DIFFERENT endpoint; exclude-keys backup strips error text
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  const cfgDir = path.join(root, '.pi-workbench');
  // current machine state: provA at OLD endpoint with a key
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ providers: {
    provA: { baseUrl: 'https://old.example/v1', apiKey: 'sk-live-machine-key', headers: { authorization: 'Bearer sk-live-hdr' } },
  } }));
  let routing = { chains: [], providers: {}, state: { cooldowns: { 'provA#key0': { until: Date.now() + 60000, error: '401 Bearer sk-secret-in-error' } } } };
  fs.writeFileSync(path.join(root, 'routing.json'), JSON.stringify(routing));
  const bt = createBackupTerminal({ CFG_DIR: cfgDir, HOME: root, CFG_FILE: path.join(root, 'config.json'), ROUTING_FILE: path.join(root, 'routing.json'), CRON_FILE: path.join(root, 'cron.json'), MODEL_META_FILE: path.join(root, 'mm.json'), PI_MODELS: path.join(root, 'models.json'), PI_SETTINGS: path.join(root, 'settings.json'), PI_SKILLS: path.join(root, 'skills.json'), CODEX_SESSIONS: path.join(root, 'codex'), CLAUDE_PROJECTS: path.join(root, 'claude'), VERSION: 'test', listSkills: () => ({ skills: [] }), createZip, readZip, spawn: () => ({ on: () => {}, stdin: { write: () => {} } }), fs, path });
  const z = createZip([{ name: 'pi-agent/models.json', data: Buffer.from(JSON.stringify({ providers: {
    provA: { baseUrl: 'https://new.example/v1' }, // SAME name, DIFFERENT endpoint, no key (redacted backup)
  } })) }]);
  fs.writeFileSync(path.join(root, 'move.zip'), z);
  await bt.importBackupZip(path.join(root, 'move.zip'));
  const after = JSON.parse(fs.readFileSync(path.join(root, 'models.json'), 'utf8'));
  check('restore does NOT graft the machine key onto a moved endpoint', after.providers.provA.apiKey === undefined && after.providers.provA.baseUrl === 'https://new.example/v1', JSON.stringify(after.providers.provA));
  const rep = await bt.exportBackupZip(true);
  const entries = readZip(fs.readFileSync(rep.path));
  const routingEntry = entries.find((e) => e.name === 'workbench/routing.json');
  const rdoc = JSON.parse(routingEntry.data.toString('utf8'));
  const errText = rdoc.state?.cooldowns?.['provA#key0']?.error || '';
  check('exclude-keys backup strips cooldown error text', !errText.includes('sk-secret-in-error'), errText);
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
