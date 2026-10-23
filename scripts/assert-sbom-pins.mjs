// assert-sbom-pins.mjs — the shipped-runtime SBOM must carry the pinned fixed
// versions. This is the physical-tree gate: npm audit reads the lockfile's logical
// tree and went green while v1.2.4/5 physically shipped undici 8.9.0 — the SBOM
// reads what is actually in the box, so the assertion lives here.
import fs from 'node:fs';

const file = process.argv[2] || 'sbom-pi-workbench.cdx.json';
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const components = d.components || [];
// (v1.4.1 review #7) check EVERY physical copy, not one entry per name: a
// name -> version map let a newer duplicate shadow a stale nested copy, so the
// gate went green while an old version was still shipped.
const WANT = { undici: '8.11.2', 'brace-expansion': '5.0.12' };
const pathOf = (c) => (c.properties || []).find((p) => p && p.name === 'path')?.value;
let failed = false;
for (const [name, want] of Object.entries(WANT)) {
  const hits = components.filter((c) => c.name === name);
  if (hits.length === 0) {
    console.error(`SBOM pin assertion FAILED: ${name} is absent, want ${want}`);
    failed = true;
    continue;
  }
  const bad = hits.filter((c) => c.version !== want);
  if (bad.length) {
    failed = true;
    console.error(
      `SBOM pin assertion FAILED: ${name} must be ${want} at every path; ${bad.length}/${hits.length} copies differ:`,
    );
    for (const c of bad) console.error(`  - ${c.version} at ${pathOf(c) || c['bom-ref'] || '(no path property)'}`);
    const ok = hits.filter((c) => c.version === want);
    for (const c of ok) console.error(`  ok ${c.version} at ${pathOf(c) || c['bom-ref'] || '(no path property)'}`);
  }
}
if (failed) process.exit(1);
// v1.4.3 review #36: the pins above prove a FEW named packages are right; they say nothing
// about coverage. Compare the SBOM's component set against the lockfile the runtime was
// installed from — every package npm recorded must be described, at the same version, at
// the same physical path. That turns "the SBOM parsed" into "the SBOM accounts for the tree".
const lockFile = process.argv[3] || 'runtime-package-lock.json';
if (lockFile && fs.existsSync(lockFile)) {
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  // Which optional entries can exist on THIS machine. The runtime lock records the
  // platform variants of esbuild/rollup for every OS (aix, android, darwin, freebsd, linux,
  // win32 …); npm installs only the one that matches, so requiring all of them would fail
  // on every platform. The first cut of this gate did exactly that and went red on the
  // linux build with "169 expected, 136 described".
  const currentOs = process.platform;
  const currentCpu = process.arch;
  const applies = (list, value) => {
    if (!Array.isArray(list) || !list.length) return true; // no constraint = any platform
    const names = list.map(String);
    const positives = names.filter((n) => !n.startsWith('!'));
    const negatives = names.filter((n) => n.startsWith('!')).map((n) => n.slice(1));
    if (negatives.includes(value)) return false;
    return positives.length === 0 || positives.includes(value);
  };
  const want = new Map(); // REQUIRED: must be described
  const optional = []; // may legitimately be absent on this platform
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key || !key.startsWith('node_modules/')) continue; // the "" row is the root project
    if (!entry || entry.link || entry.dev) continue;
    const name = entry.name || key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const row = { name, version: entry.version };
    if (entry.optional) { optional.push([key, row, entry]); continue; }
    if (!applies(entry.os, currentOs) || !applies(entry.cpu, currentCpu)) { optional.push([key, row, entry]); continue; }
    want.set(key, row);
  }
  const have = new Map();
  for (const c of components) {
    const p = (c.properties || []).find((x) => x && x.name === 'path')?.value;
    if (p) have.set(p, { name: c.name, version: c.version });
  }
  const missing = [];
  const mismatched = [];
  for (const [p, w] of want) {
    const got = have.get(p);
    if (!got) missing.push(`${w.name}@${w.version} (${p})`);
    else if (got.version !== w.version) mismatched.push(`${p}: lock ${w.version} vs sbom ${got.version}`);
  }
  // an optional package that IS installed must still be described at the locked version
  let optPresent = 0;
  for (const [p, w] of optional) {
    const got = have.get(p);
    if (got) { optPresent++; if (got.version !== w.version) mismatched.push(`${p}: lock ${w.version} vs sbom ${got.version} (optional)`); }
  }
  if (missing.length || mismatched.length) {
    failed = true;
    console.error(`SBOM coverage FAILED: ${want.size} required locked packages expected, ${have.size} described`);
    for (const m of missing.slice(0, 20)) console.error('  missing: ' + m);
    if (missing.length > 20) console.error(`  … and ${missing.length - 20} more missing`);
    for (const m of mismatched.slice(0, 20)) console.error('  version drift: ' + m);
    process.exit(1);
  }
  console.log(`sbom coverage: ${want.size} required locked packages all described at their locked version/path ` +
    `(+ ${optPresent} of ${optional.length} platform-optional packages present on ${currentOs}/${currentCpu}, all at their locked version)`);
}
console.log(`sbom components: ${components.length} | pin assertion ok (${Object.entries(WANT).map(([n, w]) => `${n} ${w}`).join(' / ')})`);
