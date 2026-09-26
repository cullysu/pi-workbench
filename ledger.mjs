// ledger.mjs — 跨引擎统一用量账本：摄入 Codex / ZCode / Claude Code 本地会话记录
// 数据源字段均为源码级核实：codex TokenCountEvent / zcode model-io+sessions / claude transcripts
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DAY = 86400000;

function* walkFiles(dir, ext, depth = 0, maxDepth = 6) {
  if (depth > maxDepth) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p, ext, depth + 1, maxDepth);
    else if (e.name.endsWith(ext)) yield p;
  }
}

function readLines(file, hotSubstr) {
  // 行式读取；hotSubstr 命中才 parse，控制大文件开销
  const out = [];
  let buf = '';
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return out; }
  const chunk = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      buf += chunk.toString('utf8', 0, n);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        if (hotSubstr && !line.includes(hotSubstr)) continue;
        try { out.push(JSON.parse(line)); } catch {}
        if (out.length > 200000) return out;
      }
    }
    if (buf.trim()) { try { out.push(JSON.parse(buf)); } catch {} }
  } finally { fs.closeSync(fd); }
  return out;
}

const deepFindUsage = (o) => {
  // 在任意嵌套结构里找带 input_tokens+output_tokens 的对象
  if (!o || typeof o !== 'object') return null;
  if (typeof o.input_tokens === 'number' && typeof o.output_tokens === 'number') {
    return {
      input: o.input_tokens || 0,
      cached: o.cache_read_input_tokens ?? o.cached_input_tokens ?? 0,
      cacheWrite: o.cache_creation_input_tokens ?? o.cache_write_input_tokens ?? 0,
      output: o.output_tokens || 0,
      reasoning: o.reasoning_output_tokens ?? 0,
    };
  }
  for (const k of Object.keys(o)) {
    const r = deepFindUsage(o[k]);
    if (r) return r;
  }
  return null;
};

function scanCodex(days) {
  const H = process.env.PIWB_LEDGER_HOME || os.homedir();
  const root = path.join(H, '.codex', 'sessions');
  const since = Date.now() - days * DAY;
  const recs = [];
  for (const f of walkFiles(root, '.jsonl')) {
    const st = fs.statSync(f);
    if (st.mtimeMs < since) continue;
    const lines = readLines(f, 'token_usage');
    if (!lines.length) continue;
    let meta = {cwd: null, ts: st.mtimeMs};
    let usage = null, model = null;
    for (const l of lines) {
      const pay = l.payload ?? l;
      if (pay.type === 'session_meta' || pay.type === 'SessionMeta') {
        meta.cwd = pay.payload?.cwd ?? null;
        meta.ts = pay.payload?.timestamp ? Date.parse(pay.payload.timestamp) : meta.ts;
      }
      const u = deepFindUsage(pay?.info ?? pay);
      if (u && pay?.info?.total_token_usage) { usage = u; model = pay?.info?.model || model; }
      if (pay?.info?.model) model = pay.info.model;
    }
    if (usage) recs.push({engine: 'codex', file: path.basename(f), ts: meta.ts || st.mtimeMs, cwd: meta.cwd, model, usage});
  }
  return recs;
}

function scanZCode(days) {
  const home = process.env.PIWB_LEDGER_HOME || os.homedir();
  const since = Date.now() - days * DAY;
  const recs = [];
  // 1) model-io：逐次调用（每次一条记录）
  const roll = path.join(home, '.zcode', 'cli', 'rollout');
  for (const f of walkFiles(roll, '.jsonl')) {
    const st = fs.statSync(f);
    if (st.mtimeMs < since) continue;
    for (const l of readLines(f)) {
      const ts = l.startedAt ? Date.parse(l.startedAt) : (l.completedAt ? Date.parse(l.completedAt) : st.mtimeMs);
      if (ts < since) continue;
      const u = deepFindUsage(l.response ?? l);
      if (u) recs.push({engine: 'zcode', file: path.basename(f), ts, cwd: null, model: l.model || null, usage: u});
    }
  }
  // 2) v2 会话文件（每会话聚合，取 usage 字段若存在）
  const v2 = path.join(home, '.zcode', 'v2', 'sessions');
  for (const f of walkFiles(v2, '.json')) {
    const st = fs.statSync(f);
    if (st.mtimeMs < since) continue;
    let d = null;
    try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const u = deepFindUsage(d);
    if (u) recs.push({engine: 'zcode', file: path.basename(f), ts: st.mtimeMs, cwd: d.cwd ?? d.workspace ?? null, model: d.model ?? null, usage: u, aggregate: true});
  }
  return recs;
}

function scanClaude(days) {
  const root = path.join(process.env.PIWB_LEDGER_HOME || os.homedir(), '.claude', 'projects');
  const since = Date.now() - days * DAY;
  const recs = [];
  for (const f of walkFiles(root, '.jsonl')) {
    const st = fs.statSync(f);
    if (st.mtimeMs < since) continue;
    for (const l of readLines(f, '"usage"')) {
      const u = deepFindUsage(l.message ?? l);
      if (!u) continue;
      const ts = l.timestamp ? Date.parse(l.timestamp) : st.mtimeMs;
      if (ts < since) continue;
      recs.push({engine: 'claude', file: path.basename(f), ts, cwd: l.cwd ?? null, model: l.message?.model ?? null, usage: u});
    }
  }
  return recs;
}

export function ledger({days = 30, engines = ['codex', 'zcode', 'claude']} = {}) {
  let recs = [];
  if (engines.includes('codex')) recs = recs.concat(scanCodex(days));
  if (engines.includes('zcode')) recs = recs.concat(scanZCode(days));
  if (engines.includes('claude')) recs = recs.concat(scanClaude(days));
  const byEngine = {}, byDay = {}, byModel = {};
  for (const r of recs) {
    const day = new Date(r.ts).toISOString().slice(0, 10);
    const bump = (o, k) => {
      o[k] ??= {calls: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0};
      const t = o[k]; t.calls++;
      t.input += r.usage.input; t.cached += r.usage.cached;
      t.cacheWrite += r.usage.cacheWrite; t.output += r.usage.output;
      t.reasoning += r.usage.reasoning || 0;
    };
    bump(byEngine, r.engine);
    bump(byDay, day);
    if (r.model) bump(byModel, `${r.engine}/${r.model}`);
  }
  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return {
    days,
    sessions: recs.length,
    byEngine: sortObj(byEngine),
    byDay: sortObj(byDay),
    byModel: sortObj(byModel),
    recent: recs.sort((a, b) => b.ts - a.ts).slice(0, 20),
  };
}
