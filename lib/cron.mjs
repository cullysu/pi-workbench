// cron.mjs — 内置定时任务引擎：到点无头运行 pi 提示词，逐次落日志，无外部调度器
import fs from 'node:fs';
import path from 'node:path';
import { killTree, spawnTreeOpts } from './proctree.mjs';

export function createCron(ctx) {
  const ctxKeys = ['CRON_FILE', 'CRON_RUNS_DIR', 'HOME', 'SECRET_ENV', 'PI_CLI', 'cronPiArgs', 'broadcast', 'readJson', 'saveJson', 'spawn'];
  for (const k of ctxKeys) {
    if (ctx[k] === undefined) throw new Error(`createCron: missing ctx.${k} — the wiring contract drifted; fix the createCron call site`);
  }
  const { CRON_FILE, CRON_RUNS_DIR, HOME, SECRET_ENV, PI_CLI, cronPiArgs, broadcast, readJson, saveJson, spawn } = ctx;
  const CRON_MAX_CONCURRENT = 2; // unattended fan-out budget across ALL jobs
  let runningCount = 0;
  const live = new Set(); // spawned cron children, for the server shutdown hook

  function todayStr(d = new Date()) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function jobDue(job, now = new Date()) {
    if (job.kind === 'daily') {
      // a malformed time (hostile import) must skip this job — an exception here
      // used to abort the whole tick and starve every other job too
      if (!/^\d{2}:\d{2}$/.test(String(job.time || ''))) return false;
      const hh = Number(String(job.time).slice(0, 2)), mm = Number(String(job.time).slice(3, 5));
      if (hh > 23 || mm > 59) return false;
      // 2-minute grace: a tick stalled across the target minute still catches up,
      // guarded from double-running by lastRunDay
      const dueMin = hh * 60 + mm;
      const nowMin = now.getHours() * 60 + now.getMinutes();
      return nowMin >= dueMin && nowMin - dueMin <= 2 && job.lastRunDay !== todayStr(now);
    }
    if (job.kind === 'interval') {
      return now.getTime() - (job.lastRunMs || 0) >= Number(job.everyMin) * 60000;
    }
    return false;
  }
  function runCronJob(job) {
    // defense in depth: the id reaches path.join below — even if a hostile id got
    // into cron.json through some other channel, it must never steer the filesystem
    if (!/^[A-Za-z0-9-]{1,64}$/.test(String(job.id || ''))) return false;
    if (job.running) return false;
    if (runningCount >= CRON_MAX_CONCURRENT) return false; // global budget: 8 due jobs must not stampede in one tick
    // fail-closed: a dead project must NOT silently degrade to HOME — an unattended
    // agent would keep "running" while reading and writing the wrong directory
    const kp = ctx.knownProject; // lazy: server defines it later in module init
    if (job.cwd && (!kp || !kp(job.cwd))) { job.lastStatus = 'project missing'; job.lastOutput = `项目已失效：${job.cwd}`; return false; }
    if (job.cwd && !fs.existsSync(job.cwd)) { job.lastStatus = 'project missing'; job.lastOutput = `项目目录不存在：${job.cwd}`; return false; }
    if (job.kind === 'daily') job.lastRunDay = todayStr(); // a manual run consumes today's window — tick must not double-fire
    runningCount++;
    job.running = true;
    job.lastRunMs = Date.now(); // set before spawn so the zombie timeout in tick() can see it
    const cwd = job.cwd || HOME;
    try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const runDir = path.join(CRON_RUNS_DIR, job.id);
    fs.mkdirSync(runDir, { recursive: true });
    const logFile = path.join(runDir, ts + '.log');
    const args = cronPiArgs(job);
    const logFd = fs.openSync(logFile, 'w');
    // honor the interactive rotation state: a cooled-out key must not arm an
    // unattended run (envOverrideFor returns the working key's env when one exists)
    const prov = job.model ? String(job.model).split('/')[0] : null;
    const ov = prov && ctx.envOverrideFor ? ctx.envOverrideFor(prov) : null;
    const proc = spawn(process.execPath, [PI_CLI, ...args], {
      cwd,
      env: { ...process.env, ...SECRET_ENV, ...(ov || {}) },
      ...spawnTreeOpts(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // capped log pump: a chatty job must not fill the disk inside its killer window
    let logBytes = 0;
    const LOG_CAP = 10 * 1024 * 1024;
    const pumpLog = (stream) => stream.on('data', (c) => {
      if (logBytes >= LOG_CAP) return;
      const room = LOG_CAP - logBytes;
      const slice = c.length > room ? c.subarray(0, room) : c;
      try { fs.writeSync(logFd, slice); logBytes += slice.length; } catch { /* log unwritable; drop */ }
      if (logBytes >= LOG_CAP) { try { fs.writeSync(logFd, '\n[log truncated at 10MB]\n'); } catch { /* same */ } }
    });
    pumpLog(proc.stdout); pumpLog(proc.stderr);
    // unref: a hung pi child must not keep the server process alive for the
    // full killer window once everything else has shut down
    const CRON_KILLER_MS = 15 * 60 * 1000;
    const killer = setTimeout(() => { killTree(proc); }, CRON_KILLER_MS);
    killer.unref();
    let finished = false;
    const settle = (status, detail) => {
      if (finished) return;
      finished = true; // spawn failure also emits close on some platforms — first settle wins
      runningCount--; // EVERY settle path releases the budget — the missing decrement
      live.delete(proc); // and the lifecycle set — settled children must not accumulate
      // turned "max 2 concurrent" into "max 2 per service lifetime" (audit repro 1,2,2)
      clearTimeout(killer);
      try { if (logFd !== undefined) fs.closeSync(logFd); } catch { /* already closed */ }
      job.running = false;
      job.lastRun = new Date().toISOString();
      job.lastStatus = status;
      if (detail) {
        job.lastOutput = detail;
        try { fs.appendFileSync(logFile, '\n' + detail + '\n'); } catch { /* run log itself unwritable; nothing left to do */ }
      } else {
        try { job.lastOutput = fs.readFileSync(logFile, 'utf8').slice(-400); } catch { job.lastOutput = ''; }
      }
      try { broadcast({ type: 'cron-run', id: job.id, name: job.name, ok: status === 'ok' }); } catch { /* no live clients */ }
      try { saveJson(CRON_FILE, { jobs: (readJson(CRON_FILE) || { jobs: [] }).jobs.map((j) => (j.id === job.id ? { ...j, lastRun: job.lastRun, lastRunMs: job.lastRunMs, lastStatus: job.lastStatus, lastOutput: job.lastOutput, running: false } : j)) }); } catch { /* state refresh is best-effort; next run rewrites it */ }
    };
    proc.on('error', (e) => settle('spawn error', '[spawn error] ' + e.message));
    proc.on('close', (code) => settle(code === 0 ? 'ok' : 'exit ' + code));
    live.add(proc);
    job.lastStatus = 'running';
    return true; // actually spawned — run-now reports accepted vs budget-rejected
    } catch (e) {
      // spawn-prep failure: release the budget or "max 2 concurrent" becomes
      // "max 2 failures per lifetime" (two throws here used to stop cron forever)
      runningCount--;
      job.running = false;
      job.lastStatus = 'spawn error';
      job.lastOutput = String(e.message || e).slice(0, 200);
      try { saveJson(CRON_FILE, { jobs: (readJson(CRON_FILE) || { jobs: [] }).jobs.map((j) => (j.id === job.id ? { ...j, lastStatus: job.lastStatus, running: false } : j)) }); } catch { /* best effort */ }
      return false;
    }
  }
  function shutdown() {
    // POSIX cron children live in their own process groups (spawnTreeOpts) — a dying
    // server's signal never reaches them, so the shutdown hook must reap explicitly
    for (const p of live) { try { killTree(p); } catch { /* gone */ } }
    live.clear();
  }
  function bootReset(d) {
    let changed = false;
    for (const j of d.jobs || []) { if (j.running) { j.running = false; changed = true; } }
    return changed;
  }
  function tick() {
    let d = readJson(CRON_FILE);
    if (!d || !Array.isArray(d.jobs) || !d.jobs.length) return;
    const now = new Date();
    let dirty = false;
    // bootReset deliberately does NOT run here: the server clears stale flags once at
    // boot, before the first tick — a second clear here would stomp a job the user
    // started manually in between (and let its interval re-spawn it)
    const due = [];
    for (const job of d.jobs) {
      if (job.enabled === false || job.running) {
        // 30-min zombie timeout: a running flag with no progress for 30 min is stale
        if (job.running && job.lastRunMs && Date.now() - job.lastRunMs > 30 * 60000) {
          job.running = false;
          job.lastStatus = 'stale-timeout';
          dirty = true;
        }
        continue;
      }
      if (!jobDue(job, now)) continue;
      due.push(job);
    }
    // daily jobs get scheduling priority: two hot interval jobs must not be able to
    // hold both concurrency slots forever and starve a daily out of its window
    due.sort((a, b) => (a.kind === 'daily' ? -1 : 0) - (b.kind === 'daily' ? -1 : 0));
    for (const job of due) {
      if (runningCount >= CRON_MAX_CONCURRENT) break;
      job.lastRunDay = todayStr(now);
      job.lastRunMs = Date.now();
      dirty = true;
      runCronJob(job);
    }
    if (dirty) saveJson(CRON_FILE, d);
  }

  return { tick, bootReset, runCronJob, shutdown };
}
