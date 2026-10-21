// Runtime assembly self-check: walk pkg-build/server.mjs's module graph and fail if any
// imported file is missing from the assembled package. This is the guard for the class of
// bug where the assembly steps forget a file (lib/, data/, ledger.mjs were all missed at
// one point - the shipped installers crashed on boot).
//
// P3-23 (v1.3.9 review): the original check only understood ESM `import ... from './x'`,
// `export ... from './x'` and literal `import('./x')`. It could not see:
//   - require('./x') — extensions/mcp-bridge.js is CJS and runs as a real child process
//   - bare specifiers — `ws`, `typebox` and friends must exist under pkg-build/node_modules;
//     a missing dependency is exactly as fatal as a missing lib/ file
//   - non-JS runtime artifacts read by path (public/, data/) — the crash class this script
//     was written for in the first place
// All of that is covered now. It still cannot see a path assembled at runtime from user
// input (e.g. path.join(root, userSupplied)) — stated here rather than implied.
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
const missingDeps = [];
const missingArtifacts = [];
let count = 0;

// non-JS files the server opens by path at boot; a runtime zip without these ships broken
const ARTIFACTS = [
  'package.json',
  'public/index.html',
  'public/app.js',
  'public/style.css',
  'data/models-kb.json',
  // the MCP bridge is loaded by pi, not by server.mjs, so the import walk below can never
  // reach it — name it and its helper explicitly or a zip missing them passes this check
  'extensions/mcp-bridge.js',
  'extensions/mcp-cmdline.js',
];

const RESOLVE_EXT = ['.mjs', '.js', '.cjs', '.json'];

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, ...RESOLVE_EXT.map((e) => base + e), ...RESOLVE_EXT.map((e) => path.join(base, 'index' + e))];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) || null;
}

function resolveBare(spec) {
  // subpath: '@scope/pkg/x' -> '@scope/pkg'; 'ws/x' -> 'ws'
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return fs.existsSync(path.join(root, 'node_modules', name));
}

while (queue.length) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  count++;
  const src = fs.readFileSync(file, 'utf8');
  // ESM static + dynamic, and CJS require with a literal argument
  const specs = [
    ...[...src.matchAll(/(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ...[...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ...[...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ];
  for (const spec of specs) {
    if (spec.startsWith('node:') || spec.startsWith('data:')) continue;
    if (spec.startsWith('.')) {
      const found = resolveRelative(file, spec);
      if (!found) {
        missing.push(spec + ' (imported from ' + path.relative(root, file) + ')');
        continue;
      }
      if (!path.resolve(found).startsWith(path.resolve(root))) continue; // outside the package (e.g. ../zip.mjs edge)
      if (/\.(mjs|js|cjs)$/.test(found)) queue.push(found);
      continue;
    }
    if (!resolveBare(spec)) missingDeps.push(spec + ' (imported from ' + path.relative(root, file) + ')');
  }
}

for (const rel of ARTIFACTS) {
  if (!fs.existsSync(path.join(root, rel))) missingArtifacts.push(rel);
}

console.log(
  `runtime self-check: ${count} modules reachable, ${missing.length} missing, ` +
  `${missingDeps.length} unresolved deps, ${missingArtifacts.length} missing artifacts`
);
let bad = false;
for (const m of missing) { console.error('MISSING: ' + m); bad = true; }
for (const m of missingDeps) { console.error('MISSING DEP: ' + m); bad = true; }
for (const m of missingArtifacts) { console.error('MISSING ARTIFACT: ' + m); bad = true; }
if (bad) process.exit(1);
