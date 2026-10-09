// proctree.mjs — kill a spawned pi (and the MCP servers / shell tools it started),
// not just the direct child. A bare proc.kill() orphans the whole grandchild tree.
import { spawn } from 'node:child_process';

export function spawnTreeOpts() {
  // POSIX: detached gives pi its own process group so killTree can signal it all
  // at once. Windows: taskkill /T walks the tree by pid instead.
  return { detached: process.platform !== 'win32', windowsHide: true };
}

export function killTree(proc) {
  if (!proc) return;
  if (proc.exitCode !== null || proc.signalCode !== null) return; // already settled
  const pid = proc.pid;
  if (!pid) { try { proc.kill(); } catch { /* gone */ } return; }
  if (process.platform === 'win32') {
    // fire-and-forget: taskkill /T /F walks descendants; never block the event loop on it
    try {
      const t = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      t.on('error', () => { try { proc.kill(); } catch { /* gone */ } });
    } catch { try { proc.kill(); } catch { /* gone */ } }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { proc.kill(); } catch { /* gone */ } } // -pid = the process group
  }
}
