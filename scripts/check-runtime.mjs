// Runtime assembly self-check: walk pkg-build/server.mjs's relative import graph
// and fail if any imported file is missing from the assembled package. This is the
// guard for the class of bug where the assembly steps forget a file (lib/, data/,
// ledger.mjs were all missed at one point - the shipped installers crashed on boot).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'pkg-build');
const entry = path.join(root, 'server.mjs');
if (!fs.existsSync(entry)) {
  console.error('pkg-build/server.mjs missing - assemble the runtime first');
  process.exit(1);
}

const seen = new Set();
const queue = [entry];
const missing = [];
let count = 0;

while (queue.length) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  count++;
  const src = fs.readFileSync(file, 'utf8');
  const imports = [...src.matchAll(/(?:import|export)[^'"]*from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)];
  for (const m of imports) {
    const spec = m[1] || m[2];
    let resolved = path.resolve(path.dirname(file), spec);
    if (!path.resolve(resolved).startsWith(path.resolve(root))) continue; // outside the package (e.g. ../zip.mjs edge) - skip
    const candidates = [resolved, resolved + '.mjs', resolved + '.js', path.join(resolved, 'index.mjs')];
    const found = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!found) {
      missing.push(spec + ' (imported from ' + path.relative(root, file) + ')');
      continue;
    }
    if (found.endsWith('.mjs') || found.endsWith('.js')) queue.push(found);
  }
}

console.log(`runtime self-check: ${count} modules reachable, ${missing.length} missing`);
if (missing.length) {
  for (const m of missing) console.error('MISSING: ' + m);
  process.exit(1);
}
