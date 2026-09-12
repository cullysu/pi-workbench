// Assemble pkg-runtime.zip from pkg-build/. Cross-platform; long-path safe on
// Windows via \\?\ prefixes. Same zip writer the app uses for backups.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from '../zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'pkg-build');
const outPath = path.resolve(root, '..', 'pkg-runtime.zip');
if (!fs.existsSync(root)) {
  console.error('pkg-build/ missing — assemble it first (npm install pi + copy server/public/extensions)');
  process.exit(1);
}

const entries = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (e.name === '.bin') continue;
      walk(full);
    } else {
      if (rel.endsWith('.zip')) continue;
      let data;
      try {
        data = fs.readFileSync(process.platform === 'win32' ? '\\\\?\\' + full : full);
      } catch (err) {
        console.warn('skip unreadable', rel, err.message);
        continue;
      }
      entries.push({ name: rel, data });
    }
  }
};
walk(root);

const zip = createZip(entries);
fs.writeFileSync(outPath, zip);
console.log(`pkg-runtime.zip written: ${zip.length} bytes, ${entries.length} entries`);
