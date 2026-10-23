// run-tests.mjs — run every tests/*.test.mjs, discovered from disk.
//
// v1.4.3 review #30: `npm test` listed eight filenames explicitly, so a NEW test file was
// silently not run — CI stayed green while the new coverage never executed, and
// CONTRIBUTING.md told contributors to run `node --test tests/`, which on current Node
// resolves the directory as a module and fails. Discovery is the only rule that cannot
// drift: anything matching tests/*.test.mjs runs, and the count is printed so a shrinking
// suite is visible in the log.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'tests');
const files = fs.readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.test.mjs'))
  .map((e) => path.join('tests', e.name))
  .sort();
if (!files.length) {
  console.error('run-tests: no tests/*.test.mjs found — refusing to report a green run over an empty suite');
  process.exit(1);
}
console.log(`run-tests: ${files.length} files — ${files.map((f) => path.basename(f, '.test.mjs')).join(', ')}`);
const args = ['--test', ...process.argv.slice(2), ...files];
const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
