// audit-gate.mjs — dependency audit as a REAL gate with an explicit, reviewable baseline.
//
// v1.4.3 review #27: `npm audit --audit-level=high` on the dev tree runs with
// `continue-on-error: true`, so the pipeline keeps building installers while the tree
// carries known highs. That is a release signal nobody can act on. The advisories cannot
// be fixed from here (they arrive through @earendil-works/pi-coding-agent and playwright,
// and the suggested `audit fix --force` would downgrade pi to a version that does not
// exist), so the honest shape is:
//
//   * every high/critical advisory must be NAMED in scripts/audit-baseline.json with a
//     reason — a new one fails the build immediately;
//   * a baseline entry that no longer appears is reported so the list cannot rot;
//   * the shipped trees (root production deps, runtime lock) stay a hard zero-tolerance
//     gate in the workflow itself.
//
// Usage: node scripts/audit-gate.mjs [--json-out <file>]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = path.join(root, 'scripts', 'audit-baseline.json');

let raw = '';
try {
  // audit must run against the official registry: npm mirrors often proxy the bulk-advisory
  // endpoint with a 404/501 ("not implemented"), which the old CI step read as a clean tree.
  raw = execFileSync('npm', ['audit', '--json', '--registry=https://registry.npmjs.org'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, npm_config_registry: 'https://registry.npmjs.org' } });
} catch (e) {
  raw = e.stdout || ''; // npm audit exits 1 when advisories exist; the JSON is still on stdout
}
let report;
try { report = JSON.parse(raw); } catch {
  // an audit that cannot even produce JSON (offline registry, missing lockfile) must not be
  // read as "clean" — that is the failure mode this whole script exists to prevent
  if (!raw.trim()) {
    console.error('audit-gate: npm audit produced no output (offline or registry failure) — treating as UNVERIFIED, not clean');
    process.exit(2);
  }
  console.error('audit-gate: npm audit output was not JSON; head follows');
  console.error(raw.slice(0, 800));
  process.exit(2);
}

const SEV = new Set(['high', 'critical']);
const found = new Map();
for (const [name, info] of Object.entries(report.vulnerabilities || {})) {
  for (const via of info.via || []) {
    if (!via || typeof via !== 'object') continue;
    if (!SEV.has(String(via.severity))) continue;
    const id = via.url || `npm:${name}:${via.source ?? 'unknown'}`;
    found.set(`${name}|${id}`, { package: name, id, title: via.title || '' });
  }
}
const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : { entries: [] };
const allowed = new Map((baseline.entries || []).map((e) => [`${e.package}|${e.id}`, e]));

const unexpected = [...found.values()].filter((f) => !allowed.has(`${f.package}|${f.id}`));
const stale = [...allowed.keys()].filter((k) => !found.has(k));

const counts = report.metadata?.vulnerabilities || {};
console.log(`audit-gate: ${counts.high || 0} high, ${counts.critical || 0} critical in the full tree; ` +
  `${found.size} high/critical advisories named, ${allowed.size} baselined`);

if (stale.length) {
  console.log(`audit-gate: ${stale.length} baseline entr${stale.length === 1 ? 'y is' : 'ies are'} no longer reported — remove from scripts/audit-baseline.json:`);
  for (const k of stale) console.log('  stale: ' + k);
}
if (unexpected.length) {
  console.error(`audit-gate: FAILED — ${unexpected.length} high/critical advisory(ies) not covered by the baseline:`);
  for (const f of unexpected) console.error(`  - ${f.package}: ${f.title || ''} ${f.id}`);
  console.error('Fix it, or add a justified entry to scripts/audit-baseline.json.');
  process.exit(1);
}
console.log('audit-gate: ok — no high/critical advisory outside the reviewed baseline');
