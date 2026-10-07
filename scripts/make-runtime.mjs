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
      // preserve the POSIX mode (the bundled node must stay executable through the zip round-trip)
      const st = fs.statSync(process.platform === 'win32' ? '\\\\?\\' + full : full);
      const mode = process.platform === 'win32' ? undefined : (st.mode & 0o7777);
      entries.push({ name: rel, data, mode });
    }
  }
};
walk(root);
entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // stable order for reproducible archives

// SOURCE_DATE_EPOCH (unix seconds) pins the archive timestamps for byte-reproducible builds
const epoch = Number(process.env.SOURCE_DATE_EPOCH);
const zip = createZip(entries, epoch ? { mtime: new Date(epoch * 1000) } : {});
fs.writeFileSync(outPath, zip);
console.log(`pkg-runtime.zip written: ${zip.length} bytes, ${entries.length} entries`);
