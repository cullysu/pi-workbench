// Minimal CycloneDX 1.5 SBOM over a runtime root's dependency tree.
// Usage: node scripts/sbom.mjs <runtimeRoot> > sbom.cdx.json
// Walks <runtimeRoot>/node_modules (nested @scopes and nested node_modules included),
// reads each package's own package.json for name/version/license.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const comps = [];
const seen = new Set();
const posixRel = (from, to) => path.relative(from, to).split(path.sep).join('/');
const walk = (dir) => {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.name.startsWith('@')) { walk(p); continue; }
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')); } catch { pkg = null; }
    if (pkg && pkg.name) {
      // (v1.4.1 review #7) key components by PHYSICAL PATH, not name@version:
      // two physical copies of the same name+version (e.g. a nested node_modules
      // copy) used to collapse into one component and lose path provenance.
      const nmRel = posixRel(root, dir); // e.g. node_modules/x/node_modules
      const key = `${pkg.name}@${pkg.version || '0.0.0'}@${nmRel}/${e.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        comps.push({
          type: 'library',
          'bom-ref': key,
          name: pkg.name,
          version: pkg.version || '0.0.0',
          purl: `pkg:npm/${pkg.name}@${pkg.version || '0.0.0'}`,
          ...(pkg.license ? { licenses: [{ license: { name: String(pkg.license) } }] } : {}),
          properties: [{ name: 'path', value: `${nmRel}/${e.name}` }],
        });
      }
    }
    walk(path.join(p, 'node_modules'));
  }
};
walk(path.join(root, 'node_modules'));
// vendored frontend libraries are security-relevant deps npm audit cannot see —
// version them from the vendor README table so advisories can match
try {
  const readme = fs.readFileSync(path.join(root, 'public', 'vendor', 'README.md'), 'utf8');
  for (const m of readme.matchAll(/\| `([^`]+)`(?: \+ `[^`]+`)* \| ([^|]+) \| v?([0-9][0-9.]*) \|/g)) {
    // the optional (?: \+ `...`)* keeps multi-file rows parseable — uPlot ships js+css
    // in one cell and the old single-file regex silently dropped it from the SBOM
    const name = String(m[2]).trim().toLowerCase().replace(/[^a-z0-9.-]/g, '');
    if (!name || !m[3]) continue;
    comps.push({
      type: 'library', name, version: m[3],
      purl: `pkg:npm/${name}@${m[3]}`,
      properties: [{ name: 'scope', value: `vendored frontend asset (${m[1].trim()}) — NOT in node_modules; audit and SBOM gates must track it here` }],
    });
  }
} catch { /* vendor README missing — skip */ }
let appPkg = {};
try { appPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { /* dev tree without package.json */ }
console.log(JSON.stringify({
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: 'application', name: appPkg.name || 'pi-workbench', version: appPkg.version || '0.0.0' },
    properties: [{ name: 'scope', value: 'platform-independent JS runtime dependencies (the packaged node_modules tree) — all platform builds share this dependency set' }],
  },
  components: comps,
}, null, 2));
