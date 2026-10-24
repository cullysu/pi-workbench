// _tmp.mjs — temp-dir registry for the test suite.
//
// v1.4.3 review #33: six test files created mkdtemp scratch dirs and never removed them,
// so a dev machine or reused runner accumulated a directory per invocation forever. Every
// test file that needs scratch space registers its dirs here instead of forgetting them;
// they are removed — best effort, force — when the test process exits. Files matching
// *.test.mjs are the discovery pattern, so this helper (underscore prefix) never runs as
// a test itself.
import fs from 'node:fs';

const dirs = new Set();

export function trackTemp(dir) {
  if (dir) dirs.add(dir);
  return dir;
}

function cleanup() {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked/never existed */ }
  }
  dirs.clear();
}

process.on('exit', cleanup);
// v1.4.4 review: these exited 0, turning an interrupted run into a green one. A signal is
// not a pass — clean up, then exit non-zero with the conventional 128+n.
const SIGNO = { SIGINT: 2, SIGTERM: 15, SIGQUIT: 3 };
for (const sig of Object.keys(SIGNO)) {
  try {
    process.on(sig, () => { cleanup(); process.exit(128 + SIGNO[sig]); });
  } catch { /* signal not supported on this platform */ }
}