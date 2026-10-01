// Minimal CycloneDX 1.5 SBOM over a runtime root's dependency tree.
// Usage: node scripts/sbom.mjs <runtimeRoot> > sbom.cdx.json
// Walks <runtimeRoot>/node_modules (nested @scopes and nested node_modules included),
// reads each package's own package.json for name/version/license.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const comps = [];
const seen = new Set();
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
      const key = `${pkg.name}@${pkg.version || '0.0.0'}`;
      if (!seen.has(key)) {
        seen.add(key);
        comps.push({
          type: 'library',
          'bom-ref': key,
          name: pkg.name,
          version: pkg.version || '0.0.0',
          purl: `pkg:npm/${pkg.name}@${pkg.version || '0.0.0'}`,
          ...(pkg.license ? { licenses: [{ license: { name: String(pkg.license) } }] } : {}),
        });
      }
    }
    walk(path.join(p, 'node_modules'));
  }
};
walk(path.join(root, 'node_modules'));
let appPkg = {};
try { appPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { /* dev tree without package.json */ }
console.log(JSON.stringify({
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: 'application', name: appPkg.name || 'pi-workbench', version: appPkg.version || '0.0.0' },
  },
  components: comps,
}, null, 2));
