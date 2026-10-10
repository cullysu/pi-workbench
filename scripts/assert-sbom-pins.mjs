// assert-sbom-pins.mjs — the shipped-runtime SBOM must carry the pinned fixed
// versions. This is the physical-tree gate: npm audit reads the lockfile's logical
// tree and went green while v1.2.4/5 physically shipped undici 8.9.0 — the SBOM
// reads what is actually in the box, so the assertion lives here.
import fs from 'node:fs';

const file = process.argv[2] || 'sbom-pi-workbench.cdx.json';
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const v = Object.fromEntries((d.components || []).map((c) => [c.name, c.version]));
const WANT = { undici: '8.11.2', 'brace-expansion': '5.0.12' };
for (const [name, want] of Object.entries(WANT)) {
  if (v[name] !== want) {
    console.error(`SBOM pin assertion FAILED: ${name} is ${v[name]}, want ${want}`);
    process.exit(1);
  }
}
console.log(`sbom components: ${(d.components || []).length} | pin assertion ok (${Object.entries(WANT).map(([n, w]) => `${n} ${w}`).join(' / ')})`);
