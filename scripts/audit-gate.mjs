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
    // v1.4.4 review: the key was package+advisory only. The same GHSA reaching a DIFFERENT
    // installed version (or a different physical path) is a different exposure — a broad
    // key lets an old "dev-only, reviewed" entry silently cover a new arrival. Version and
    // the dependency range npm reports are part of the identity now.
    // v1.4.4 note: npm's `vulnerabilities[name].range` is the INSTALLED-impact range
    // ("2.0.0 - 2.3.0") while `via.range` is the ADVISORY range (">=2.0.0 <2.4.0") — the two
    // wordings differ, so a baseline written from one cannot match a key built from the
    // other. Key on the advisory range; the baseline records the same string.
    const range = String(via.range || '');
    const key = `${name}|${id}|${range}`;
    found.set(key, { package: name, id, range, title: via.title || '', severity: String(via.severity) });
  }
}
const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : { entries: [] };
// a baseline entry may pin the range or leave it open (`range` absent = any range), so an
// advisory that moves to a new installed range is reported instead of silently covered
// one advisory can cover several installed RANGES (npm reports one line per major), so a
// baseline legitimately carries several entries with the same package+id and different
// ranges — the map must hold ALL of them, keyed package|id -> [entries], not the last one.
const allowed = new Map();
for (const e of baseline.entries || []) {
  const k = `${e.package}|${e.id}`;
  if (!allowed.has(k)) allowed.set(k, []);
  allowed.get(k).push(e);
}
const matchBaseline = (f) => {
  const candidates = allowed.get(`${f.package}|${f.id}`) || [];
  for (const e of candidates) {
    if (e.range === undefined || e.range === f.range) return e;
  }
  return null;
};

const unexpected = [...found.values()].filter((f) => !matchBaseline(f));
const usedKeys = new Set([...found.values()].map((f) => `${f.package}|${f.id}`));
const stale = [...allowed.keys()].filter((k) => !usedKeys.has(k));

const counts = report.metadata?.vulnerabilities || {};
const metaHigh = Number(counts.high || 0) + Number(counts.critical || 0);
console.log(`audit-gate: ${counts.high || 0} high, ${counts.critical || 0} critical in the full tree; ` +
  `${found.size} high/critical advisories named, ${allowed.size} baselined`);

// v1.4.4 review: the script printed metadata's totals but never compared them with what it
// had collected, so a change in npm's report SHAPE (via entries becoming strings) would
// shrink `found` to zero and turn the gate green while the tree was unchanged. If the
// metadata count and the named count disagree, the report was not understood — fail open
// is not an option for an audit gate.
const foundPackages = new Set([...found.values()].map((f) => f.package)).size;
if (metaHigh > 0 && found.size === 0) {
  console.error(`audit-gate: FAILED — npm reports ${metaHigh} high/critical but this script collected 0 named advisories.`);
  console.error('The report shape changed; fix scripts/audit-gate.mjs before trusting this gate.');
  process.exit(2);
}
if (metaHigh > 0 && foundPackages === 0) {
  console.error('audit-gate: FAILED — high/critical count present but no package attributed');
  process.exit(2);
}

if (stale.length) {
  // v1.4.4 review: a stale entry only printed a note, so if the same advisory came back
  // later the OLD "reviewed" conclusion silently re-applied. Removing the entry is the
  // reviewer's action; until then the gate must not pass while the baseline over-claims.
  console.error(`audit-gate: FAILED — ${stale.length} baseline entr${stale.length === 1 ? 'y is' : 'ies are'} no longer reported. Delete from scripts/audit-baseline.json:`);
  for (const k of stale) console.error('  stale: ' + k);
  process.exit(1);
}
if (unexpected.length) {
  console.error(`audit-gate: FAILED — ${unexpected.length} high/critical advisory(ies) not covered by the baseline:`);
  for (const f of unexpected) console.error(`  - ${f.package}@${f.range || '?'}: ${f.title || ''} ${f.id}`);
  console.error('Fix it, or add a justified entry to scripts/audit-baseline.json.');
  process.exit(1);
}
console.log('audit-gate: ok — no high/critical advisory outside the reviewed baseline');
