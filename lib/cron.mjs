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
  const live = new Map(); // job id → spawned cron child: shutdown reaping AND the in-process same-job dedup gate (F09)

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
      // guarded from double-running by lastRunDay. A daily DEFERRED by full slots
      // (all-running intervals) stays eligible for the rest of TODAY — the audit's
      // starvation case: sorting alone can't help a job whose window closed while
      // both slots were busy
      const dueMin = hh * 60 + mm;
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const eligible = (nowMin >= dueMin && nowMin - dueMin <= 2) || job.deferDay === todayStr(now);
      return eligible && job.lastRunDay !== todayStr(now);
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
    // the DEFAULT model's provider obeys the same rotation state: a job without an
    // explicit model used to bypass envOverrideFor entirely, and an all-cooled
    // provider used to launch unattended on the stale env anyway (v1.3.3 audit #15/#16)
    const effModel = job.model || (typeof ctx.defaultModel === 'function' ? ctx.defaultModel() : null);
    const prov = effModel ? String(effModel).split('/')[0] : null;
    if (prov && typeof ctx.providerCooledOut === 'function' && ctx.providerCooledOut(prov)) {
      // fail-closed on key availability — but do NOT consume the daily window. F12
      // (v1.3.5 audit): the comment below used to be a lie — jobDue's eligibility
      // is a 2-minute grace unless deferDay is set, so a key uncooling at +5min
      // still missed the day. Marking the daily deferred makes the promise real.
      job.lastStatus = 'keys cooled';
      job.lastOutput = `供应商 ${prov} 的可用密钥均已冷却——本次跳过，密钥恢复后自动重试`;
      if (job.kind === 'daily') job.deferDay = todayStr();
      return false;
    }
    // the kill switch is a unified execution gate: a disabled provider must not be
    // reachable from unattended runs either (audit #10)
    if (prov && typeof ctx.providerDisabled === 'function' && ctx.providerDisabled(prov)) {
      job.lastStatus = 'provider disabled';
      job.lastOutput = `供应商 ${prov} 已停用——本次跳过`;
      return false;
    }
    // F13 (v1.3.5 audit): the exact model's cooldown gate — an interactive 429 must
    // not keep getting re-hit by unattended runs. Transient → a daily keeps its
    // retry-until-day-end eligibility. (Automatic failover to the next chain model
    // is deliberately NOT done here: re-running a failed unattended prompt is the
    // same side-effect surface as the F22 resend — use 立即运行 to re-run by hand.)
    if (effModel && typeof ctx.modelCooled === 'function' && ctx.modelCooled(effModel)) {
      job.lastStatus = 'model cooled';
      job.lastOutput = `模型 ${effModel} 冷却中（限流/故障）——本次跳过`;
      if (job.kind === 'daily') job.deferDay = todayStr();
      return false;
    }
    // F09/F10 (v1.3.5 audit): one live execution per job id — in-process via the
    // live map, cross-process via an O_EXCL lock file in CRON_RUNS_DIR. The disk
    // `running` flag is advisory: a restore can overwrite it while the job runs,
    // so the lock (not the flag) is the duplicate-start guard. Stale locks (>30min,
    // past the killer window + margin) are taken over.
    try { fs.mkdirSync(CRON_RUNS_DIR, { recursive: true }); } catch { /* openSync below reports it */ }
    const lockPath = path.join(CRON_RUNS_DIR, job.id + '.lock');
    let lockFd;
    const writeLock = () => { try { fs.writeSync(lockFd, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch { /* lock content is advisory */ } };
    try {
      lockFd = fs.openSync(lockPath, 'wx', 0o600);
      writeLock();
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        let stale = false;
        try { stale = Date.now() - fs.statSync(lockPath).mtimeMs > 30 * 60000; } catch { stale = false; }
        if (stale) {
          try { fs.unlinkSync(lockPath); } catch { /* lost the race — refuse below */ }
          try { lockFd = fs.openSync(lockPath, 'wx', 0o600); writeLock(); } catch { lockFd = undefined; }
        }
      }
      if (lockFd === undefined) {
        job.lastStatus = 'already running';
        job.lastOutput = '该任务已在运行（本实例或另一实例持有运行锁）——跳过';
        return false;
      }
    }
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
    const logFd = fs.openSync(logFile, 'w', 0o600); // F05: run logs can carry secrets the agent printed — private-by-default
    // honor the interactive rotation state: a cooled-out key must not arm an
    // unattended run (envOverrideFor returns the working key's env when one exists)
    let ov = null;
    if (prov && ctx.envOverrideFor) ov = ctx.envOverrideFor(prov);
    // F14: `__keyIdx` is scheduler bookkeeping, not a credential — it must not leak
    // into the child env. The env NAME of the key that actually runs is recorded on
    // the job so post-mortems can attribute the run even after pool edits.
    const envOv = ov ? { ...ov } : null;
    if (envOv) delete envOv.__keyIdx;
    const keyIdx = ov ? ov.__keyIdx : null;
    const keyEnv = prov && typeof ctx.keyEnvAt === 'function' && Number.isInteger(keyIdx) ? ctx.keyEnvAt(prov, keyIdx) : null;
    const proc = spawn(process.execPath, [PI_CLI, ...args], {
      cwd,
      env: { ...process.env, ...SECRET_ENV, ...(envOv || {}) },
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
    // F16 (v1.3.5 audit): the killer terminates the tree, but the budget/fd release
    // depended on `close` actually arriving. If it never does (held pipe, taskkill
    // failure), this watchdog settles the run anyway — mirroring lib/io.mjs's
    // collectProc fallback.
    const settleWatch = setTimeout(() => {
      settle('timeout (no close)', '[timeout] 进程树已终止但 close 事件未到达——预算与运行锁已强制释放');
    }, CRON_KILLER_MS + 10000);
    settleWatch.unref();
    let finished = false;
    const settle = (status, detail) => {
      if (finished) return;
      finished = true; // spawn failure also emits close on some platforms — first settle wins
      runningCount--; // EVERY settle path releases the budget — the missing decrement
      live.delete(job.id); // and the lifecycle map — settled children must not accumulate
      // turned "max 2 concurrent" into "max 2 per service lifetime" (audit repro 1,2,2)
      clearTimeout(killer);
      clearTimeout(settleWatch);
      try { fs.unlinkSync(lockPath); } catch { /* another instance took it over */ }
      // v1.3.8 review P2-5: the lock HANDLE leaked on every run — unlinking the name does
      // not close the descriptor, so long-lived interval jobs accumulated one fd apiece
      try { if (lockFd !== undefined) fs.closeSync(lockFd); } catch { /* already closed */ }
      lockFd = undefined;
      try { if (logFd !== undefined) fs.closeSync(logFd); } catch { /* already closed */ }
      job.running = false;
      job.lastRun = new Date().toISOString();
      job.lastStatus = status;
      job.lastProvider = prov || null; // F14: actual run identity survives pool/default-model edits
      job.lastModel = effModel || null;
      job.lastKeyEnv = keyEnv || null;
      if (detail) {
        job.lastOutput = detail;
        try { fs.appendFileSync(logFile, '\n' + detail + '\n'); } catch { /* run log itself unwritable; nothing left to do */ }
      } else {
        try { job.lastOutput = fs.readFileSync(logFile, 'utf8').slice(-400); } catch { job.lastOutput = ''; }
      }
      try { broadcast({ type: 'cron-run', id: job.id, name: job.name, ok: status === 'ok' }); } catch { /* no live clients */ }
      try { saveJson(CRON_FILE, { jobs: (readJson(CRON_FILE) || { jobs: [] }).jobs.map((j) => (j.id === job.id ? { ...j, lastRun: job.lastRun, lastRunMs: job.lastRunMs, lastStatus: job.lastStatus, lastOutput: job.lastOutput, lastProvider: job.lastProvider, lastModel: job.lastModel, lastKeyEnv: job.lastKeyEnv, running: false } : j)) }); } catch { /* state refresh is best-effort; next run rewrites it */ }
    };
    proc.on('error', (e) => settle('spawn error', '[spawn error] ' + e.message));
    proc.on('close', (code) => settle(code === 0 ? 'ok' : 'exit ' + code));
    live.set(job.id, proc);
    // F11 (v1.3.5 audit): the daily window is consumed by an ACTUAL spawn — a throw
    // in mkdir/args/open above must not burn today's run (the old code consumed it
    // before the try block, contradicting its own comment)
    if (job.kind === 'daily') job.lastRunDay = todayStr();
    job.deferDay = null;
    job.lastStatus = 'running';
    return true; // actually spawned — run-now reports accepted vs budget-rejected
    } catch (e) {
      // spawn-prep failure: release the budget or "max 2 concurrent" becomes
      // "max 2 failures per lifetime" (two throws here used to stop cron forever)
      runningCount--;
      live.delete(job.id);
      try { fs.unlinkSync(lockPath); } catch { /* lock release best-effort */ }
      try { if (lockFd !== undefined) fs.closeSync(lockFd); } catch { /* already closed */ }
      lockFd = undefined;
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
    for (const p of live.values()) { try { killTree(p); } catch { /* gone */ } }
    live.clear();
  }
  // F15 (v1.3.5 audit): 停用/删除 must be able to stop the CURRENT run too — a job
  // that is misbehaving cannot otherwise be stopped before its 15-min killer window.
  // Returns true when a live run was found and killed (settle will fire via close).
  function cancelJob(jobId) {
    const p = live.get(jobId);
    if (!p) return false;
    try { killTree(p); } catch { /* gone; settle cleans up */ }
    return true;
  }
  function bootReset(d) {
    let changed = false;
    for (const j of d.jobs || []) {
      if (j.running) {
        j.running = false;
        j.lastStatus = 'interrupted (restart)'; // keep lastStatus from matching a future 'running' — otherwise the spawn tick sees "no change" and never persists running:true, and the next tick re-spawns the same job (audit #14)
        changed = true;
      }
    }
    // F10: locks orphaned by a previous process (crash/kill) past the stale window
    // are swept at boot; a FRESH lock belongs to another concurrently running
    // instance sharing this HOME — it is left alone.
    try {
      for (const f of fs.readdirSync(CRON_RUNS_DIR)) {
        if (!/^[A-Za-z0-9-]{1,64}\.lock$/.test(f)) continue;
        const full = path.join(CRON_RUNS_DIR, f);
        try { if (Date.now() - fs.statSync(full).mtimeMs > 30 * 60000) fs.unlinkSync(full); } catch { /* raced with its owner */ }
      }
    } catch { /* runs dir missing */ }
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
    let budgetFull = false;
    for (const job of due) {
      if (!budgetFull && runningCount >= CRON_MAX_CONCURRENT) budgetFull = true;
      if (budgetFull) {
        // EVERY daily squeezed out by already-RUNNING intervals is deferred — marking
        // only the first left the rest to miss today's window entirely (audit #15).
        // jobDue keeps deferred dailies eligible for the rest of today; interval jobs
        // past the budget simply re-fire on their next due tick
        if (job.kind === 'daily' && job.deferDay !== todayStr(now)) { job.deferDay = todayStr(now); dirty = true; }
        continue;
      }
      const st0 = job.lastStatus;
      const dd0 = job.deferDay;
      const spawned = runCronJob(job); // lastRunDay/lastRunMs are consumed inside, ONLY on an actual spawn — a refusal keeps the daily window and just flips the visible status
      // a spawn MUST reach disk even when lastStatus didn't visibly change (a job
      // interrupted by a restart boots as running:false/lastStatus:'running') — or the
      // next tick sees the stale disk row and spawns the SAME job a second time (audit #14).
      // A transient refusal ('keys cooled'/'model cooled') sets deferDay on a daily —
      // that must persist too, or the retry-until-day-end promise dies at the window edge
      if (spawned || job.lastStatus !== st0 || job.deferDay !== dd0) dirty = true;
    }
    if (dirty) saveJson(CRON_FILE, d);
  }

  return { tick, bootReset, runCronJob, cancelJob, shutdown };
}
