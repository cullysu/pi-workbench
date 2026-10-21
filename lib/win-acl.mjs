/**
 * Windows ACL application with a visible failure path (pi-workbench v1.4.1 review, finding #3).
 *
 * F08 (v1.3.5 audit) added `icacls /inheritance:r /grant:r <user>:F` to every file that carries
 * credentials, because Windows ignores the POSIX modes the writer sets. The call was wrapped in
 * a try/catch whose catch block could never fire: spawnSync does NOT throw on a non-zero exit,
 * it reports it through `status`. So every real failure — icacls missing from PATH, a denied
 * parent directory, a name icacls cannot parse — was swallowed, and the file silently kept the
 * inherited (often broad) profile DACL with nothing anywhere to say so.
 *
 * This module returns the outcome instead of swallowing it and reports a failure through an
 * injected sink, so a caller can put it in the server log, a backup receipt, or a test.
 * `platform`, `run` and `env` are injectable precisely so the failure branch is reachable from a
 * test on every OS — a Windows-only branch that only ever ran on Windows was how this hid.
 */
import { spawnSync } from "node:child_process";

const DEFAULT_WARN = (line) => console.warn(line);

/**
 * Remove inheritance and grant one user full control on a single file.
 * @param {string} file
 * @param {{warn?: (line: string) => void, run?: typeof spawnSync, platform?: string, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{status: 'ok'|'failed'|'skipped', reason?: string, code?: number}}
 */
export function restrictWindowsAcl(file, opts = {}) {
  const warn = typeof opts.warn === "function" ? opts.warn : DEFAULT_WARN;
  const run = opts.run || spawnSync;
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  if (platform !== "win32") return { status: "skipped", reason: "not-windows" };
  const user = env.USERNAME;
  if (!user) {
    warn(`[pi-workbench] USERNAME is unset — left the inherited ACL on ${file}`);
    return { status: "skipped", reason: "no-username" };
  }
  const res = run("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], {
    windowsHide: true,
    encoding: "utf8",
  });
  if (res && res.error) {
    warn(`[pi-workbench] icacls could not run for ${file}: ${res.error.message}`);
    return { status: "failed", reason: res.error.message };
  }
  if (!res || res.status !== 0) {
    const first = String((res && (res.stderr || res.stdout)) || "")
      .trim()
      .split(/\r?\n/)[0]
      .slice(0, 200);
    warn(`[pi-workbench] icacls failed (${res && res.status}) for ${file}: ${first || "no output"}`);
    return { status: "failed", reason: first, code: res ? res.status : undefined };
  }
  return { status: "ok" };
}
