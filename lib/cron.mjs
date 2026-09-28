// cron.mjs — 内置定时任务引擎（从 server.mjs 抽出，工厂注入依赖）
import fs from 'node:fs';
import path from 'node:path';

export function createCron(ctx) {
  const { CRON_FILE, CRON_RUNS_DIR, HOME, SECRET_ENV, PI_CLI, cronPiArgs, broadcast, readJson, saveJson, spawn } = ctx;
// ---------- cron: scheduled pi prompt runs (built-in, no external scheduler) ----------
function todayStr(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function jobDue(job, now = new Date()) {
  if (job.kind === 'daily') {
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    return hhmm === job.time && job.lastRunDay !== todayStr(now);
  }
  if (job.kind === 'interval') {
    const last = job.lastRunMs || 0;
    return Date.now() - last >= Number(job.everyMin) * 60000;
  }
  return false;
}
function runCronJob(job, _reason = 'schedule') {
  if (job.running) return;
  job.running = true;
  const cwd = job.cwd && fs.existsSync(job.cwd) ? job.cwd : HOME;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(CRON_RUNS_DIR, job.id);
  fs.mkdirSync(runDir, { recursive: true });
  const logFile = path.join(runDir, ts + '.log');
  const args = cronPiArgs(job);
  const logFd = fs.openSync(logFile, 'w');
  const proc = spawn(process.execPath, [PI_CLI, ...args], {
    cwd,
    env: { ...process.env, ...SECRET_ENV },
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  const killer = setTimeout(() => { try { proc.kill(); } catch {} }, 15 * 60000);
  proc.on('error', (e) => {
    clearTimeout(killer);
    job.running = false;
    job.lastStatus = 'spawn error';
    job.lastOutput = '[spawn error] ' + e.message;
    try { fs.appendFileSync(logFile, '\n' + '[spawn error] ' + e.message + '\n'); } catch {}
  });
  let finished = false;
  proc.on('close', (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(killer);
    job.running = false;
    job.lastRun = new Date().toISOString();
    job.lastRunMs = Date.now();
    job.lastStatus = code === 0 ? 'ok' : 'exit ' + code;
    try { job.lastOutput = fs.readFileSync(logFile, 'utf8').slice(-400); } catch { job.lastOutput = ''; }
    try { broadcast({ type: 'cron-run', id: job.id, name: job.name, ok: code === 0 }); } catch {}
    try { saveJson(CRON_FILE, { jobs: (readJson(CRON_FILE) || { jobs: [] }).jobs.map((j) => (j.id === job.id ? { ...j, lastRun: job.lastRun, lastRunMs: job.lastRunMs, lastStatus: job.lastStatus, lastOutput: job.lastOutput, running: false } : j)) }); } catch {}
  });
  job.lastStatus = 'running';
}
let cronBootResetDone = false;
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
  if (!cronBootResetDone) {
    // a server restart orphans running flags — clear them once at startup
    cronBootResetDone = true;
    if (bootReset(d)) dirty = true;
  }
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
    if (jobDue(job, now)) {
      job.lastRunDay = todayStr(now);
      job.lastRunMs = Date.now();
      dirty = true;
      runCronJob(job, 'schedule');
    }
  }
  if (dirty) saveJson(CRON_FILE, d);
}

  return { tick, bootReset, runCronJob };
}
