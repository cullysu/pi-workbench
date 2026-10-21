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
console.log(`sbom components: ${components.length} | pin assertion ok (${Object.entries(WANT).map(([n, w]) => `${n} ${w}`).join(' / ')})`);
