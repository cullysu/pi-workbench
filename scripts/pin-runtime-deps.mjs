// pin-runtime-deps.mjs — physically overwrite npm's transitive copies of
// audited-vulnerable packages inside the assembled runtime tree.
//
// Why this exists: both npm `overrides` AND direct lockfile edits are ignored by
// npm's installer on this tree — v1.2.4/v1.2.5 shipped undici 8.9.0 while the
// lockfile said 8.11.2. The published SBOM (which walks the physical tree) proved
// it. This step is the enforcement; the SBOM step asserts it stayed true.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const pkgBuild = path.resolve(process.argv[2] || 'pkg-build');
const PINS = [['undici', '8.11.2'], ['brace-expansion', '5.0.12']];
const piNm = path.join(pkgBuild, 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules');
if (!fs.existsSync(piNm)) {
  console.error(`pin-runtime-deps: ${piNm} does not exist — assemble the runtime tree first`);
  process.exit(1);
}
const tmp = fs.mkdtempSync(path.join(path.dirname(pkgBuild), 'pins-'));
try {
  execSync(`npm pack ${PINS.map(([n, v]) => `${n}@${v}`).join(' ')} --registry=https://registry.npmjs.org --silent`, { cwd: tmp, stdio: 'inherit' });
  for (const [name, ver] of PINS) {
    const dest = path.join(piNm, name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    execSync(`tar -xzf "${path.join(tmp, `${name}-${ver}.tgz`)}" -C "${dest}" --strip-components=1`, { stdio: 'inherit' });
    const got = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')).version;
    if (got !== ver) throw new Error(`pin failed: ${name} resolved to ${got}, want ${ver}`);
    console.log(`pinned ${name}@${ver}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
