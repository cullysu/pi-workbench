// prepare-runtime.mjs — assemble pkg-build/ for a clean checkout, from the same
// committed runtime lockfile CI installs. The working dev path:
//   npm install && npm run prepare-runtime && npm run electron
// Packaging a distributable additionally needs the bundled node — see
// scripts/make-runtime.mjs + the CI workflow (the single source of assembly truth).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgBuild = path.join(root, 'pkg-build');
for (const f of ['runtime-package.json', 'runtime-package-lock.json']) {
  if (!fs.existsSync(path.join(root, f))) {
    console.error(`${f} missing at the repo root — it anchors the exact runtime dependency set`);
    process.exit(1);
  }
}

// stage in a neutral dir: npm hoists nested installs into an ancestor node_modules,
// which would wipe the root install (the same trap the CI workflow routes around)
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-runtime-'));
try {
  fs.copyFileSync(path.join(root, 'runtime-package.json'), path.join(stage, 'package.json'));
  fs.copyFileSync(path.join(root, 'runtime-package-lock.json'), path.join(stage, 'package-lock.json'));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log('installing the pinned runtime set…');
  execFileSync(npm, ['ci', '--omit=dev', '--no-fund', '--no-audit'], { cwd: stage, stdio: 'inherit', shell: process.platform === 'win32' });

  fs.mkdirSync(pkgBuild, { recursive: true });
  fs.copyFileSync(path.join(stage, 'package.json'), path.join(pkgBuild, 'package.json'));
  fs.rmSync(path.join(pkgBuild, 'node_modules'), { recursive: true, force: true });
  fs.cpSync(path.join(stage, 'node_modules'), path.join(pkgBuild, 'node_modules'), { recursive: true });

  // the app code itself (dev mode runs the server straight from pkg-build/)
  for (const top of ['server.mjs', 'zip.mjs', 'ledger.mjs', 'lib', 'public', 'extensions']) {
    const src = path.join(root, top);
    const dest = path.join(pkgBuild, top);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
  }
  console.log(`pkg-build/ ready (${pkgBuild})`);
  console.log('dev run:  npm run electron');
  console.log('package:  node scripts/make-runtime.mjs  (needs a bundled node — see the CI workflow)');
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
