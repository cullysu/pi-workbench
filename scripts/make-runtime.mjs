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
// (v1.4.1 review #8) fail closed: an unreadable file used to be warned about and
// skipped, so an incomplete pkg-runtime.zip was still written and the damage only
// surfaced at pack time / at user launch. Collect every failure, report the full
// list, and ship nothing. PIWB_RUNTIME_ALLOW_MISSING is the explicit escape hatch
// (comma-separated POSIX rel paths, `*`/`?` globs allowed) for knowingly-missing files.
const allowSpecs = String(process.env.PIWB_RUNTIME_ALLOW_MISSING || '')
  .split(',')
  .map((s) => s.trim().replace(/\\/g, '/'))
  .filter(Boolean)
  .map((g) => {
    const re = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${re}$`);
  });
const isAllowedMissing = (rel) => allowSpecs.some((re) => re.test(rel));
const longPath = (p) => (process.platform === 'win32' ? '\\\\?\\' + p : p);
const unreadable = [];
const allowedMissing = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (e.name === '.bin') continue;
      try { fs.readdirSync(full); } catch (err) {
        if (isAllowedMissing(rel)) { allowedMissing.push(`${rel}: ${err.message}`); continue; }
        unreadable.push(`${rel}: ${err.message}`); // unreadable subtree — cannot enumerate it
        continue;
      }
      walk(full);
    } else {
      if (rel.endsWith('.zip')) continue;
      let data;
      try {
        data = fs.readFileSync(longPath(full));
      } catch (err) {
        if (isAllowedMissing(rel)) { allowedMissing.push(`${rel}: ${err.message}`); continue; }
        unreadable.push(`${rel}: ${err.message}`);
        continue;
      }
      // preserve the POSIX mode (the bundled node must stay executable through the zip round-trip)
      let st;
      try {
        st = fs.statSync(longPath(full));
      } catch (err) {
        if (isAllowedMissing(rel)) { allowedMissing.push(`${rel}: ${err.message}`); continue; }
        unreadable.push(`${rel}: ${err.message}`);
        continue;
      }
      const mode = process.platform === 'win32' ? undefined : (st.mode & 0o7777);
      entries.push({ name: rel, data, mode });
    }
  }
};
walk(root);
if (unreadable.length) {
  console.error(`pkg-runtime.zip NOT written: ${unreadable.length} unreadable file(s) under pkg-build/:`);
  for (const u of unreadable) console.error(`  - ${u}`);
  console.error('fix the tree, or list knowingly-missing paths in PIWB_RUNTIME_ALLOW_MISSING (comma-separated, `*` allowed).');
  process.exit(1);
}
for (const m of allowedMissing) console.warn('allow-missing (PIWB_RUNTIME_ALLOW_MISSING):', m);
entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // stable order for reproducible archives

// SOURCE_DATE_EPOCH (unix seconds) pins the archive timestamps for byte-reproducible builds
const epoch = Number(process.env.SOURCE_DATE_EPOCH);
const zip = createZip(entries, epoch ? { mtime: new Date(epoch * 1000) } : {});
fs.writeFileSync(outPath, zip);
console.log(`pkg-runtime.zip written: ${zip.length} bytes, ${entries.length} entries`);
