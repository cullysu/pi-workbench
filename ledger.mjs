// ledger.mjs — 跨引擎统一用量账本：摄入 Codex / ZCode / Claude Code 本地会话记录
// 数据源字段均为源码级核实：codex TokenCountEvent / zcode model-io+sessions / claude transcripts
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { walkFiles, readJsonl } from './lib/io.mjs';

const DAY = 86400000;

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

// 用量按用户本地日历日分桶（与 /api/usage 同口径）；toISOString 会把本地早晨归到昨天
const localDay = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function scanCodex(days, home) {
  const root = path.join(home, '.codex', 'sessions');
  const since = Date.now() - days * DAY;
  const recs = [];
  for (const f of walkFiles(root)) {
    let st; try { st = fs.statSync(f); } catch { continue; } // file rotated away mid-walk
    if (st.mtimeMs < since) continue;
    const lines = readJsonl(f, { hot: 'token_usage' });
    if (!lines.length) continue;
    let meta = {cwd: null, ts: st.mtimeMs};
    let usage = null, model = null;
    for (const l of lines) {
      // session_meta carries type at the TOP level and cwd inside payload — reading
      // pay = l.payload first was why codex cwd was always null
      if (l.type === 'session_meta' || l.type === 'SessionMeta') {
        meta.cwd = l.payload?.cwd ?? null;
        meta.ts = l.payload?.timestamp ? Date.parse(l.payload.timestamp) : meta.ts;
      }
      const pay = l.payload ?? l;
      const u = deepFindUsage(pay?.info ?? pay);
      if (u && pay?.info?.total_token_usage) { usage = u; model = pay?.info?.model || model; }
      if (pay?.info?.model) model = pay.info.model;
    }
    if (usage) recs.push({engine: 'codex', file: path.basename(f), ts: meta.ts || st.mtimeMs, cwd: meta.cwd, model, usage});
  }
  return recs;
}

function scanZCode(days, home) {
  const since = Date.now() - days * DAY;
  const recs = [];
  // 1) model-io：逐次调用（每次一条记录）
  const roll = path.join(home, '.zcode', 'cli', 'rollout');
  for (const f of walkFiles(roll)) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < since) continue;
    for (const l of readJsonl(f)) {
      const ts = l.startedAt ? Date.parse(l.startedAt) : (l.completedAt ? Date.parse(l.completedAt) : st.mtimeMs);
      if (ts < since) continue;
      const u = deepFindUsage(l.response ?? l);
      if (u) recs.push({engine: 'zcode', file: path.basename(f), ts, cwd: null, model: l.model || null, usage: u});
    }
  }
  // 2) v2 会话文件是上述逐次调用的会话级聚合——只进 recent 列表，
  //    不进 byEngine/byDay/byModel，否则同一批 token 被算两遍
  const v2 = path.join(home, '.zcode', 'v2', 'sessions');
  for (const f of walkFiles(v2, {exts: ['.json']})) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < since) continue;
    let d = null;
    try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const u = deepFindUsage(d);
    if (u) recs.push({engine: 'zcode', file: path.basename(f), ts: st.mtimeMs, cwd: d.cwd ?? d.workspace ?? null, model: d.model ?? null, usage: u, aggregate: true});
  }
  return recs;
}

function scanClaude(days, home) {
  const root = path.join(home, '.claude', 'projects');
  const since = Date.now() - days * DAY;
  const recs = [];
  for (const f of walkFiles(root)) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < since) continue;
    for (const l of readJsonl(f, { hot: '"usage"' })) {
      const u = deepFindUsage(l.message ?? l);
      if (!u) continue;
      const ts = l.timestamp ? Date.parse(l.timestamp) : st.mtimeMs;
      if (ts < since) continue;
      recs.push({engine: 'claude', file: path.basename(f), ts, cwd: l.cwd ?? null, model: l.message?.model ?? null, usage: u});
    }
  }
  return recs;
}

export function ledger({days = 30, engines = ['codex', 'zcode', 'claude'], home = process.env.PIWB_LEDGER_HOME || os.homedir()} = {}) {
  let recs = [];
  if (engines.includes('codex')) recs = recs.concat(scanCodex(days, home));
  if (engines.includes('zcode')) recs = recs.concat(scanZCode(days, home));
  if (engines.includes('claude')) recs = recs.concat(scanClaude(days, home));
  const byEngine = {}, byDay = {}, byModel = {};
  for (const r of recs) {
    if (!r.aggregate) {
      const day = localDay(r.ts);
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
  }
  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return {
    days,
    sessions: recs.filter((r) => !r.aggregate).length,
    byEngine: sortObj(byEngine),
    byDay: sortObj(byDay),
    byModel: sortObj(byModel),
    recent: recs.sort((a, b) => b.ts - a.ts).slice(0, 20),
  };
}
