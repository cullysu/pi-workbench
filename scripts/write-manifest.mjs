// Runtime manifest generator — run with cwd = the assembled pkg-build directory.
// Emits manifest.json ({files: {relpath: {size, sha256}}}) over every runtime JS/JSON
// file the server imports (plus public/ assets). electron-main verifies it after
// extracting runtime.zip and refuses to spawn on drift — a v1.1.2-class assembly
// omission becomes a loud pre-spawn failure instead of ERR_MODULE_NOT_FOUND.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    // NOTE: the old `e.name === 'node_modules'` guard here skipped EVERY nested
    // dependency tree (including the pinned undici/brace-expansion) — the manifest
    // and the shipped zip must describe the same world, so nothing is name-skipped
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.bin') continue; // npm symlinks — make-runtime does not ship them, so the manifest must not describe them
      walk(p);
    } else files.push(path.relative(root, p).split(path.sep).join('/'));
  }
};
for (const top of ['server.mjs', 'zip.mjs', 'ledger.mjs', 'node', 'node.exe', 'lib', 'public', 'data', 'extensions', 'node_modules', 'package.json']) {
  const p = path.join(root, top);
  if (!fs.existsSync(p)) continue;
  if (fs.statSync(p).isDirectory()) walk(p);
  else files.push(top);
}
files.sort();
// the previous run's manifest inside pkg-build must not describe itself
const manifestOnly = files.filter((f) => f !== 'manifest.json');
files.length = 0;
files.push(...manifestOnly);
if (!files.length) throw new Error('manifest would cover zero files — the runtime tree is wrong');
const manifest = { generatedAt: new Date().toISOString(), files: {} };
for (const rel of files) {
  const buf = fs.readFileSync(path.join(root, rel));
  manifest.files[rel] = { size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`manifest written: ${files.length} entries, ${Object.keys(manifest.files).length} hashed`);
