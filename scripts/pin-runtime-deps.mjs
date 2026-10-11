// pin-runtime-deps.mjs — physically overwrite npm's transitive copies of
// audited-vulnerable packages inside the assembled runtime tree.
//
// Why this exists: both npm `overrides` AND direct lockfile edits are ignored by
// npm's installer on this tree — v1.2.4/v1.2.5 shipped undici 8.9.0 while the
// lockfile said 8.11.2. The published SBOM (which walks the physical tree) proved
// it. This step is the enforcement; the SBOM step asserts it stayed true.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const pkgBuild = path.resolve(process.argv[2] || 'pkg-build');
const PINS = [['undici', '8.11.2'], ['brace-expansion', '5.0.12']];
// integrity anchors come from the committed runtime lockfile — a version match alone
// would accept re-authored content; the tarball hash must equal the lock's integrity
const lock = JSON.parse(fs.readFileSync(path.resolve('runtime-package-lock.json'), 'utf8'));
const integrityFor = (name) => (lock.packages[`node_modules/@earendil-works/pi-coding-agent/node_modules/${name}`] || {}).integrity;
const piNm = path.join(pkgBuild, 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules');
if (!fs.existsSync(piNm)) {
  console.error(`pin-runtime-deps: ${piNm} does not exist — assemble the runtime tree first`);
  process.exit(1);
}
const tmp = fs.mkdtempSync(path.join(path.dirname(pkgBuild), 'pins-'));
try {
  execSync(`npm pack ${PINS.map(([n, v]) => `${n}@${v}`).join(' ')} --registry=https://registry.npmjs.org --silent`, { cwd: tmp, stdio: 'inherit' });
  for (const [name, ver] of PINS) {
    const tgz = path.join(tmp, `${name}-${ver}.tgz`);
    const want = integrityFor(name);
    if (!want) throw new Error(`pin-runtime-deps: no integrity recorded for ${name} — refresh the lockfile first`);
    const got = 'sha512-' + createHash('sha512').update(fs.readFileSync(tgz)).digest('base64');
    if (got !== want) throw new Error(`pin-runtime-deps: ${name} tarball integrity mismatch (${got} != ${want})`);
    console.log(`verified ${name}@${ver} integrity against the lockfile`);
    const dest = path.join(piNm, name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    execSync(`tar -xzf "${tgz}" -C "${dest}" --strip-components=1`, { stdio: 'inherit' });
    const gotVer = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')).version;
    if (gotVer !== ver) throw new Error(`pin failed: ${name} resolved to ${gotVer}, want ${ver}`);
    console.log(`pinned ${name}@${ver}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
