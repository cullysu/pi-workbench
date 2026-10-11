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
