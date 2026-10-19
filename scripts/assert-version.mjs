// Version identity gate.
//
// v1.3.1 was released from a commit whose manifests still said 1.3.0: the tag was made
// first, the bump came later, and the artifacts were named with the version the code
// actually carried. The release had to be deleted and reissued. There is no reason to
// discover that from an asset filename again — every manifest that carries a version
// must agree, and package.json is the one that defines it.
//
// Run from the repo root (CI does): node scripts/assert-version.mjs
// An optional first argument overrides the root, so the gate itself can be tested
// against a deliberately inconsistent fixture tree instead of being taken on faith.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const pkg = JSON.parse(read('package.json'));
const want = pkg.version;
if (!want || typeof want !== 'string') {
  console.error('assert-version: package.json has no version');
  process.exit(1);
}

const failures = [];
const checkJson = (file, label) => {
  let doc;
  try { doc = JSON.parse(read(file)); } catch (e) {
    failures.push(`${file}: not valid JSON (${e.message})`);
    return;
  }
  const got = label ? doc[label]?.version : doc.version;
  if (got !== want) failures.push(`${file}: ${got ?? '(none)'} != ${want}`);
};
// anchored, not a bare "version" scan: package-lock.json also carries DEPENDENCY
// versions (a bare match once rewrote pvtsutils and produced invalid JSON).
// `\r?\n`: these files are checked out with CRLF on Windows and LF on CI.
const checkAnchored = (file, anchor) => {
  const s = read(file);
  const hit = s.match(anchor);
  const got = hit ? hit[1] : null;
  if (got !== want) failures.push(`${file}: ${got ?? '(none)'} != ${want}`);
};

checkJson('package.json');
checkJson('runtime-package.json');
checkJson('tauri/tauri.conf.json');
checkAnchored('package-lock.json', /"name":\s*"pi-workbench",\r?\n\s*"version":\s*"([^"]+)"/);
checkAnchored('runtime-package-lock.json', /"name":\s*"pi-workbench-runtime",\r?\n\s*"version":\s*"([^"]+)"/);
checkAnchored('tauri/Cargo.toml', /^version\s*=\s*"([^"]+)"/m);
checkAnchored('tauri/Cargo.lock', /name\s*=\s*"pi-workbench"\r?\nversion\s*=\s*"([^"]+)"/);

if (failures.length) {
  console.error(`assert-version: ${want} disagrees with:`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`assert-version: all manifests agree on ${want}`);
