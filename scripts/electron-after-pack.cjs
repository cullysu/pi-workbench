// electron-builder afterPack hook: write shell-manifest.json (sha256 per shell
// file) so the packaged app can fail closed if its own JavaScript fails
// verification — parity with the runtime manifest the boot check verifies.
// electron-builder hooks are CommonJS; the repo's eslint config is module-scoped
/* eslint-disable no-undef */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

exports.default = async function afterPack(context) {
  // win/linux: <out>/resources/app — mac: <out>/<Product>.app/Contents/Resources/app
  const candidates = [
    path.join(context.appOutDir, 'resources', 'app'),
    path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app'),
  ];
  let appDir = null;
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'electron-main.cjs'))) { appDir = c; break; }
  }
  if (!appDir) return; // no unpacked app dir — nothing to cover
  const files = ['electron-main.cjs', 'electron-preload.cjs', 'package.json'];
  const manifest = { generatedAt: new Date().toISOString(), files: {} };
  for (const f of files) {
    const p = path.join(appDir, f);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    manifest.files[f] = { size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  }
  fs.writeFileSync(path.join(appDir, 'shell-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('[after-pack] shell-manifest.json written:', Object.keys(manifest.files).join(', '));
};
