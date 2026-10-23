// sources.mjs — 会话导入源（8 引擎适配器）+ pi 会话用量聚合 + 会话树
import fs from 'node:fs';
import path from 'node:path';
import { walkFiles, headLines, readJsonl } from './io.mjs';
export function createSources(ctx) {
  const ctxKeys = ['PI_SESSIONS', 'CODEX_SESSIONS', 'CLAUDE_PROJECTS', 'OMP_SESSIONS', 'GROK_DIR', 'HOME', 'DatabaseSync', 'kbPrice', 'loadConfig'];
  for (const k of ctxKeys) {
    if (ctx[k] === undefined) throw new Error(`createSources: missing ctx.${k} — the wiring contract drifted; fix the createSources call site`);
  }
  const { PI_SESSIONS, CODEX_SESSIONS, CLAUDE_PROJECTS, OMP_SESSIONS, GROK_DIR, HOME, DatabaseSync, kbPrice, loadConfig } = ctx;
// v1.4.3 review #14: `{"content": [null]}` is a real shape in a truncated or
// half-written session file — `.map((x) => x.text)` threw on the null element, and because
// every one of these readers sits behind a whole-DIRECTORY list handler, ONE bad file
// answered 500 for the entire panel (pi list, Codex import, Claude import, Gemini import,
// transcript read). A broken conversation must cost that conversation only.
const partText = (x, keys = ['text']) => {
  if (!x || typeof x !== 'object') return typeof x === 'string' ? x : '';
  for (const k of keys) if (typeof x[k] === 'string' && x[k]) return x[k];
  return '';
};
const contentText = (c, keys = ['text'], sep = ' ') => (
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => partText(x, keys)).filter(Boolean).join(sep) : ''
);
// v1.4.3 review #15: `walkFiles` defaults to maxFiles=Infinity, so "list the 400 newest
// sessions" walked and stat'ed EVERY session a user had ever produced, then threw all but
// 400 away — on the single-threaded HTTP thread, on every panel paint. The cap now happens
// in the walk, and `capped` travels to the UI so a truncated list is never presented as a
// total (the ledger path already does this; these listers did not).
const LIST_MAX_FILES = 4000;
const listJsonFilesBounded = (dir, depth = 2) => {
  const files = walkFiles(dir, { maxDepth: depth, maxFiles: LIST_MAX_FILES + 1 });
  const capped = files.length > LIST_MAX_FILES;
  return { files: capped ? files.slice(0, LIST_MAX_FILES) : files, capped };
};
const listJsonFiles = (dir, depth = 2) => listJsonFilesBounded(dir, depth).files;
const firstLines = headLines;

// ---------- pi session listing ----------
function piSessionInfo(file) {
  // P3-19 (v1.3.9 review): this statSync was unguarded while every sibling lister wraps its
  // own — so one session file deleted between listJsonFiles() and this stat (rotation, an
  // agent cleaning up, a user in Finder) threw out of the whole .map() and the entire session
  // list answered 500. Returns null; callers filter.
  let st; try { st = fs.statSync(file); } catch { return null; }
  const lines = firstLines(file);
  let cwd = null, id = null, name = null, preview = '', timestamp = null;
  for (const line of lines) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== 'object') continue; // F24: a bare `null` line must not throw
    if (j.type === 'session' || j.cwd || j.sessionId || j.id?.length > 8) {
      cwd = cwd || (typeof j.cwd === 'string' ? j.cwd : null);
      id = id || (typeof j.id === 'string' ? j.id : typeof j.sessionId === 'string' ? j.sessionId : null);
      name = name || (typeof j.name === 'string' ? j.name : null);
      timestamp = timestamp || j.timestamp || null;
    }
    if (!preview && j.type === 'message' && j.message?.role === 'user') {
      const c = j.message.content;
      preview = contentText(c);
    }
    if (preview) break;
  }
  if (!preview) {
    // fallback: scan a few more lines for any user text
    for (const line of firstLines(file, 65536)) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (!j || typeof j !== 'object') continue; // F24
      const role = j.message?.role || j.role;
      if (role === 'user') {
        const c = j.message?.content ?? j.content;
        preview = contentText(c);
        if (preview) break;
      }
    }
  }
  return {
    file, id: id || path.basename(file, '.jsonl'), name, cwd,
    mtime: st.mtimeMs, size: st.size,
    preview: preview.replace(/\s+/g, ' ').slice(0, 120),
  };
}

// ---------- Codex / Claude / OpenCode / Gemini / Aider importers (read-only) ----------
function codexSessionInfo(file) {
  let st; try { st = fs.statSync(file); } catch { return null; } // P3-19: same race as piSessionInfo
  const lines = firstLines(file, 65536); // session_meta is always the first line; 64KB also covers the first user turn
  let cwd = null, id = null, preview = '', ts = null;
  const userText = (p) => {
    if (p.type === 'user_message') return typeof p.message === 'string' ? p.message : '';
    if (p.type === 'message' && p.role === 'user') {
      const c = p.content;
      return contentText(c, ['text', 'input_text']);
    }
    return '';
  };
  for (const line of lines) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== 'object') continue; // F24
    const p = j.payload || {};
    if (j.type === 'session_meta') { cwd = p.cwd || cwd; id = p.id || p.session_id || id; ts = ts || j.timestamp; }
    if (!preview) preview = userText(p);
    if (id && preview) break;
  }
  if (!preview) {
    // deeper bounded scan: first user turn may sit behind large injected context
    for (const line of firstLines(file, 524288)) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      preview = userText(j.payload || {});
      if (preview) break;
    }
  }
  return { file, id: id || path.basename(file, '.jsonl').replace(/^rollout-/, ''), cwd, mtime: st.mtimeMs, size: st.size, preview: preview.replace(/\s+/g, ' ').slice(0, 120), ts };
}
function codexSessionRead(file) {
  const out = [];
  // F23 (v1.3.5 audit): files can carry the same turn twice — the response_item
  // `message` AND its event_msg echo (`user_message`/`agent_message`). When response
  // items exist they are the authoritative representation, so echoes are skipped
  // wholesale. The old full-text dedupe is GONE: it merged legitimate repeated
  // turns ("run the tests again") into one. Older files with ONLY echoes keep them
  // all — one event per turn, no cross-merging.
  const all = readJsonl(file);
  const hasResponseItems = all.some((j) => (j?.payload || j)?.type === 'message');
  const pushMsg = (role, text, ts) => out.push({ kind: 'message', role, text, ts });
  for (const j of all) {
    if (!j || typeof j !== 'object') continue; // F24
    const ts = j.timestamp || null;
    const p = j.payload || j;
    if (p.type === 'message') {
      const role = p.role === 'assistant' ? 'assistant' : p.role === 'user' ? 'user' : null;
      if (!role) continue; // developer/system/context frames are not conversation
      const texts = Array.isArray(p.content) ? p.content.map((c) => partText(c, ['text', 'input_text', 'output_text'])).filter(Boolean) : [typeof p.content === 'string' ? p.content : ''];
      if (texts.join('').trim()) pushMsg(role, texts.join('\n'), ts);
    } else if (!hasResponseItems && (p.type === 'user_message' || p.type === 'agent_message')) {
      pushMsg(p.type === 'user_message' ? 'user' : 'assistant', typeof p.message === 'string' ? p.message : JSON.stringify(p.message), ts);
    } else if (p.type === 'reasoning') {
      const sum = Array.isArray(p.summary) ? p.summary.map((s) => partText(s)).filter(Boolean).join('\n') : '';
      if (sum.trim()) out.push({ kind: 'thinking', text: sum, ts });
    } else if (p.type === 'function_call') {
      out.push({ kind: 'toolcall', id: p.call_id || p.id, name: p.name, args: p.arguments, ts });
    } else if (p.type === 'function_call_output') {
      out.push({ kind: 'toolresult', id: p.call_id, output: typeof p.output === 'string' ? p.output : JSON.stringify(p.output), ts });
    }
  }
  return out;
}
function claudeSessionInfo(file) {
  let st; try { st = fs.statSync(file); } catch { return null; } // P3-19: same race as piSessionInfo
  const lines = firstLines(file, 32768);
  let cwd = null, id = null, preview = '';
  for (const line of lines) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== 'object') continue; // F24
    cwd = cwd || (typeof j.cwd === 'string' ? j.cwd : null);
    id = id || (typeof j.sessionId === 'string' ? j.sessionId : null);
    if (!preview && (j.type === 'user' || j.message?.role === 'user') && !j.isMeta) {
      const c = j.message?.content;
      preview = contentText(c);
      if (preview) break;
    }
  }
  return { file, id: id || path.basename(file, '.jsonl'), cwd, mtime: st.mtimeMs, size: st.size, preview: preview.replace(/\s+/g, ' ').slice(0, 120) };
}
function claudeSessionRead(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== 'object') continue; // F24
    const ts = j.timestamp || null;
    const m = j.message;
    if (!m || (j.type !== 'user' && j.type !== 'assistant')) continue;
    const c = m.content;
    if (typeof c === 'string') { if (c.trim()) out.push({ kind: 'message', role: m.role, text: c, ts }); continue; }
    if (!Array.isArray(c)) continue;
    for (const block of c) {
      if (!block || typeof block !== 'object') continue; // F24: null block rows
      if (block.type === 'text' && block.text?.trim()) out.push({ kind: 'message', role: m.role, text: block.text, ts });
      else if (block.type === 'thinking' && block.thinking?.trim()) out.push({ kind: 'thinking', text: block.thinking, ts });
      else if (block.type === 'tool_use') out.push({ kind: 'toolcall', id: block.id, name: block.name, args: JSON.stringify(block.input || {}), ts });
      else if (block.type === 'tool_result') {
        const txt = contentText(block.content, ['text'], '\n');
        // F30: a failed tool result is DATA, not silence — carry it through
        out.push({ kind: 'toolresult', id: block.tool_use_id, output: txt, ts, isError: block.is_error === true });
      }
    }
  }
  return out;
}

// ---------- usage aggregation (design borrowed from oh-my-pi omp-stats) ----------
const usageCache = new Map(); // file -> {mtime, size, agg}
// v1.4.3 review #9: every aggregation below used a model/provider/session string as a
// plain object key. `store[mk] = store[mk] || {...}` on the key `__proto__` reads
// Object.prototype (truthy!), skips the initialiser, and then `t.ok++` / `t.input += …`
// writes those fields onto the GLOBAL prototype — a session file with
// {"model":"__proto__"} polluted the whole process, not just its own totals. A Map (or a
// null-prototype object) plus a charset/length bound on the key closes it at the source.
const UNSAFE_STAT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SAFE_STAT_KEY = /^[\w.:@/+-]{1,200}$/;
const statKey = (raw) => {
  const s = String(raw ?? '');
  // a real model id never looks like a prototype key; anything that fails the charset,
  // the length bound or the prototype names collapses into one labelled bucket
  if (!SAFE_STAT_KEY.test(s) || UNSAFE_STAT_KEYS.has(s)) return s ? `unsafe:${s.slice(0, 40).replace(/[^\w.:@/-]/g, '_')}` : 'unknown';
  return s;
};
// null-prototype buckets: even a key that slips past statKey() cannot reach a prototype
const statBucket = () => Object.create(null);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
function usageFromFile(f) {
  let st; try { st = fs.statSync(f); } catch { return null; }
  const cached = usageCache.get(f);
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.agg;
  const agg = { ok: 0, err: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costEst: 0, models: statBucket(), providers: statBucket(), days: statBucket() };
  const { items: lines, truncated: capHit } = readJsonl(f, { wantMeta: true });
  if (capHit) agg.lineCapHit = true; // F31: the 200k-line cap hit this file — surfaced through usageSummary
  let curProv = null;
  const bump = (store, u, mk, estimate = false) => {
    const k = statKey(mk);
    const t = store[k] = store[k] || { ok: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costEst: 0 };
    t.ok++; t.input += finite(u.input); t.output += finite(u.output); t.cacheRead += finite(u.cacheRead); t.cacheWrite += finite(u.cacheWrite); t.cost += finite(u.cost?.total);
    // models that don't report cost: estimate from the built-in knowledge base (input+output, usd, first tier)
    if (estimate && !u.cost?.total) {
      const price = kbPrice(k);
      if (price) t.costEst += ((finite(u.input)) * price.in + (finite(u.output)) * price.out) / 1e6;
    }
  };
  for (const j of lines) {
    if (!j || typeof j !== 'object') continue; // v1.4.3 review #14: a `null` JSONL row
    if (j.type === 'model_change') { curProv = j.provider || curProv; continue; }
    if (j.type !== 'message' || j.message?.role !== 'assistant') continue;
    if (j.message.stopReason === 'error') { agg.err++; continue; }
    const u = j.message.usage;
    if (!u || (!u.input && !u.output)) continue;
    agg.ok++; agg.input += finite(u.input); agg.output += finite(u.output);
    agg.cacheRead += finite(u.cacheRead); agg.cacheWrite += finite(u.cacheWrite);
    agg.cost += finite(u.cost?.total);
    bump(agg.models, u, j.message.model || 'unknown', true);
    bump(agg.providers, u, curProv || 'unknown', false); // provider rows stay factual — kbPrice keys on MODEL names
    const d = j.timestamp ? new Date(j.timestamp) : null;
    const day = d && !isNaN(d) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;
    if (day) {
      const dd = agg.days[day] = agg.days[day] || { ok: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costEst: 0, providers: statBucket() };
      dd.ok++; dd.input += finite(u.input); dd.output += finite(u.output); dd.cacheRead += finite(u.cacheRead); dd.cacheWrite += finite(u.cacheWrite); dd.cost += finite(u.cost?.total);
      if (!u.cost?.total) {
        const price = kbPrice(statKey(j.message.model || 'unknown'));
        if (price) dd.costEst += ((finite(u.input)) * price.in + (finite(u.output)) * price.out) / 1e6;
      }
      bump(dd.providers, u, curProv || 'unknown', false);
    }
  }
  usageCache.set(f, { mtime: st.mtimeMs, size: st.size, agg });
  return agg;
}
function usageSummary() {
  // v1.4.3 review #15: `capped` means the WALK hit its budget, so even "diskSessions" is
  // a floor, not a count. Surfaced instead of silently posing as the whole tree.
  const { files, capped: walkCapped } = listJsonFilesBounded(PI_SESSIONS, 2);
  const sorted = files.map((f) => { try { return { f, mt: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.mt - a.mt);
  const truncated = sorted.length > 300; // only the 300 newest sessions are scanned — surface that instead of posing as full history
  const items = sorted.slice(0, 300);
  // review wave 28, shortcoming 3: the cache is keyed by file and had no eviction, so a
  // long-lived server accumulated an aggregate for every file it had EVER scanned —
  // including ones that fell out of the 300-newest window long ago and can never be read
  // again from here. Bound it to the set this scan actually uses; an entry that leaves
  // the window is simply recomputed on the day it comes back.
  const scanned = new Set(items.map((i) => i.f));
  for (const key of [...usageCache.keys()]) if (!scanned.has(key)) usageCache.delete(key);
  const total = { sessions: items.length, diskSessions: sorted.length, truncated, walkCapped, cappedFiles: 0, ok: 0, err: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costEst: 0, models: statBucket(), providers: statBucket(), days: statBucket() };
  for (const { f } of items) {
    const a = usageFromFile(f);
    if (!a) continue;
    if (a.lineCapHit) total.cappedFiles++; // F31: per-file read cap — the UI labels the totals as partial
    // fold per-model costEst up WITHOUT writing into `a` — usageCache hands back the
    // same object every read, and mutating it compounded the estimate (0.0015 → 0.003)
    let fileEst = 0;
    for (const m of Object.values(a.models || {})) fileEst += m.costEst || 0;
    total.ok += a.ok; total.err += a.err; total.input += a.input; total.output += a.output;
    total.cacheRead += a.cacheRead; total.cacheWrite += a.cacheWrite; total.cost += a.cost; total.costEst += fileEst;
    for (const [mk, m] of Object.entries(a.models)) {
      const t = total.models[mk] = total.models[mk] || { ok: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costEst: 0 };
      t.ok += m.ok; t.input += m.input; t.output += m.output; t.cacheRead += m.cacheRead; t.cacheWrite += m.cacheWrite || 0; t.cost += m.cost; t.costEst += m.costEst || 0;
    }
    for (const [pk, m] of Object.entries(a.providers || {})) {
      const t = total.providers[pk] = total.providers[pk] || { ok: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      t.ok += m.ok; t.input += m.input; t.output += m.output; t.cacheRead += m.cacheRead; t.cacheWrite += m.cacheWrite || 0; t.cost += m.cost;
    }
    for (const [d, v] of Object.entries(a.days)) {
      const t = total.days[d] = total.days[d] || { ok: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costEst: 0, providers: statBucket() };
      t.ok += v.ok; t.input += v.input; t.output += v.output; t.cacheRead += v.cacheRead || 0; t.cacheWrite += v.cacheWrite || 0; t.cost += v.cost; t.costEst += v.costEst || 0;
      for (const [pk, m] of Object.entries(v.providers || {})) {
        const tp = t.providers[pk] = t.providers[pk] || { ok: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        tp.ok += m.ok; tp.input += m.input; tp.output += m.output; tp.cacheRead += m.cacheRead; tp.cacheWrite += m.cacheWrite || 0; tp.cost += m.cost;
      }
    }
  }
  total.cacheHit = total.input + total.cacheRead > 0 ? total.cacheRead / (total.input + total.cacheRead) : 0;
  total.cachedFiles = usageCache.size; // bounded by the scan window above — surfaced so the bound is visible
  total.cost = +total.cost.toFixed(4);
  total.costEstimated = +total.costEst.toFixed(4);
  return total;
}

// ---------- session tree (design borrowed from oh-my-pi /tree) ----------
function sessionTree(file) {
  const rootAbs = path.resolve(PI_SESSIONS);
  // realpath both ends: a symlink inside sessions must not point the read outside
  let real;
  try { real = fs.realpathSync(path.resolve(String(file || ''))); } catch { return null; }
  let rootReal;
  try { rootReal = fs.realpathSync(rootAbs); } catch { return null; }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
  const nodes = []; const byId = new Map();
  // v1.4.2 review M8 (TOCTOU): the boundary was checked on `real` but the read used the RAW
  // path — a link swapped between the two steps read from wherever the link now points.
  // Read the verified path.
  for (const j of readJsonl(real)) {
    if (!j.id) continue;
    const n = { id: j.id, parentId: j.parentId || null, type: j.type, ts: j.timestamp || null };
    if (j.type === 'message') {
      const m = j.message || {};
      n.role = m.role;
      const txt = contentText(m.content);
      n.preview = txt.replace(/\s+/g, ' ').slice(0, 90);
      n.stop = m.stopReason || null;
      n.model = m.model || null;
    } else if (j.type === 'model_change') n.preview = `${j.provider}/${j.modelId}`;
    else if (j.type === 'thinking_level_change') n.preview = String(j.thinkingLevel);
    nodes.push(n); byId.set(n.id, n);
  }
  const kids = new Map();
  for (const n of nodes) if (n.parentId) kids.set(n.parentId, (kids.get(n.parentId) || []).concat(n.id));
  const last = nodes[nodes.length - 1];
  const activePath = new Set();
  // a corrupted/hand-edited session can point two nodes at each other as parents —
  // the v1.3.3 "cycle guard" was announced but the walk here stayed unguarded and
  // hung the whole single-threaded service on a legal /tree request (audit #18)
  const seenWalk = new Set();
  for (let n = last; n && !seenWalk.has(n.id); n = n.parentId ? byId.get(n.parentId) : null) { seenWalk.add(n.id); activePath.add(n.id); }
  const keptNodes = nodes.slice(-4000);
  const keptIds = new Set(keptNodes.map((n) => n.id)); // activePath must only reference nodes the client actually receives
  return {
    count: nodes.length,
    branches: [...kids.values()].filter((v) => v.length > 1).length,
    activePath: [...activePath].filter((id) => keptIds.has(id)),
    nodes: keptNodes,
    truncated: nodes.length >= 200000, // readJsonl's cap hit — "last" is the cap's tail, not the file's; the UI must say so (audit #19)
    // F27 (v1.3.5 audit): the 4000-node window is a SECOND, silent truncation —
    // the UI could not tell a 3999-node session from a 40000-node one
    windowed: nodes.length > 4000,
  };
}


// ---------- OpenCode (SQLite via node:sqlite, read-only) ----------
function opencodeDb() {
  if (!DatabaseSync) return null; // Node < 22.13: OpenCode import degrades, the rest of the app is unaffected
  const f = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');
  if (!fs.existsSync(f)) return null;
  try { return new DatabaseSync(f, { readOnly: true }); } catch { return null; }
}
function opencodeList() {
  const db = opencodeDb();
  if (!db) return [];
  try {
    return db.prepare('SELECT id, title, directory, time_updated, tokens_input, tokens_output, cost FROM session ORDER BY time_updated DESC LIMIT 400').all()
      .map((r) => ({ file: 'opencode://' + r.id, id: r.id, cwd: r.directory, mtime: r.time_updated, size: ((r.tokens_input || 0) + (r.tokens_output || 0)), preview: r.title || '' }));
  } catch { return []; }
  finally { try { db.close(); } catch { /* connection may already be closed */ } }
}
function opencodeRead(file) {
  const id = String(file).replace(/^opencode:\/\//, '');
  const db = opencodeDb();
  if (!db || !id) return [];
  // v1.4.3 review #16: this used to SELECT every message, then run one part query PER
  // message, accumulating the whole conversation in memory — and the `opencode://` URI
  // skips the file-size check at the server door, so the only cap was the generic entry
  // budget applied AFTER the full read. A long OpenCode session meant tens of thousands
  // of synchronous SQLite round trips on the single HTTP thread. The budget now lives in
  // the query, and the part fetch stops as soon as it is reached.
  const ENTRY_BUDGET = 20000;
  try {
    const out = [];
    const msgs = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created LIMIT 4000').all(id);
    for (const m of msgs) {
      if (out.length >= ENTRY_BUDGET) break;
      let md; try { md = JSON.parse(m.data || '{}'); } catch { md = {}; }
      const role = md.role === 'user' ? 'user' : md.role === 'assistant' ? 'assistant' : null;
      const ts = m.time_created ? new Date(m.time_created).toISOString() : null;
      const parts = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created').all(m.id);
      for (const pt of parts) {
        if (out.length >= ENTRY_BUDGET) break;
        let pd; try { pd = JSON.parse(pt.data || '{}'); } catch { continue; }
        if (pd.type === 'text' && pd.text) { if (role) out.push({ kind: 'message', role, text: pd.text, ts }); }
        else if (pd.type === 'reasoning' && pd.text) out.push({ kind: 'thinking', text: pd.text, ts });
        else if (pd.type === 'tool') out.push({ kind: 'toolcall', id: pd.id || pt.id, name: pd.tool || pd.state?.tool || 'tool', args: JSON.stringify(pd.state?.input || pd.input || {}), ts });
      }
    }
    if (out.length >= ENTRY_BUDGET) out.truncated = true; // the caller labels the tail instead of posing as the whole session
    return out;
  } catch { return []; }
  finally { try { db.close(); } catch { /* connection may already be closed */ } }
}

// ---------- Gemini CLI (~/.gemini/tmp/<hash>/chats/session-*.json) ----------
const GEMINI_DIR = path.join(HOME, '.gemini');
function geminiList() {
  const root = path.join(GEMINI_DIR, 'tmp');
  // v1.4.3 review #15: this read EVERY session JSON whole (readFileSync, no size cap) just
  // to fill a 120-char preview — the most expensive lister in the module for the least
  // output. Bounded walk + head-only parse, same as every sibling lister.
  const walked = walkFiles(root, { maxDepth: 4, maxFiles: LIST_MAX_FILES + 1, match: (n) => n.startsWith('session-') && n.endsWith('.json') });
  const capped = walked.length > LIST_MAX_FILES;
  const out = walked.slice(0, LIST_MAX_FILES);
  const items = out.map((f) => {
    let st; try { st = fs.statSync(f); } catch { return null; }
    let preview = '', hash = path.basename(path.dirname(path.dirname(f)));
    try {
      // the preview only needs the head: a 200MB session file must not be parsed for it
      const head = fs.readFileSync(f, { encoding: 'utf8', flag: 'r' }).slice(0, 262144);
      const j = JSON.parse(head.endsWith('}') ? head : head + '}');
      const msgs = Array.isArray(j.messages) ? j.messages : Array.isArray(j.history) ? j.history : [];
      const firstUser = msgs.find((m) => m && m.type === 'user');
      preview = (typeof firstUser?.text === 'string' ? firstUser.text : '') || (typeof j.title === 'string' ? j.title : '');
    } catch { /* unreadable/oversized session: keep it with an empty preview */ }
    return { file: f, id: path.basename(f, '.json'), cwd: '~/.gemini/tmp/' + hash, mtime: st.mtimeMs, size: st.size, preview: preview.replace(/\s+/g, ' ').slice(0, 120) };
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 400);
  if (capped) items.capped = true;
  return items;
}
function geminiRead(file) {
  const out = [];
  let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return out; }
  for (const m of j.messages || j.history || []) {
    // Gemini content arrives as .text, a PartListUnion .parts array, OR a .content
    // wrapper (string | {parts} | array) — all three shapes are real in the wild (audit #21)
    const c = m.content;
    const ctext = typeof c === 'string' ? c
      : Array.isArray(c) ? c.map((p) => p?.text || '').filter(Boolean).join('')
      : (c && Array.isArray(c.parts)) ? c.parts.map((p) => p?.text || '').filter(Boolean).join('')
      : '';
    const gtext = m.text || ctext || (Array.isArray(m.parts) ? m.parts.map((p) => p?.text || '').filter(Boolean).join('') : '');
    if (m.type === 'user' && gtext) out.push({ kind: 'message', role: 'user', text: gtext, ts: null });
    else if ((m.type === 'gemini' || m.type === 'model') && gtext) out.push({ kind: 'message', role: 'assistant', text: gtext, ts: null });
  }
  return out;
}

// ---------- Aider (.aider.chat.history.md per project) ----------
function aiderList() {
  const dirs = [HOME, ...(loadConfig().projects || []).map((p) => p.path)];
  const out = [];
  for (const dir of dirs) {
    for (const name of ['.aider.chat.history.md', '.aider.history.md']) {
      const f = path.join(dir, name);
      let st; try { st = fs.statSync(f); } catch { continue; }
      out.push({ file: f, id: name + ' · ' + path.basename(dir), cwd: dir, mtime: st.mtimeMs, size: st.size, preview: '' });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 200);
}
function aiderRead(file) {
  const out = [];
  let cur = null;
  let buf; try { buf = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of buf.split('\n')) {
    if (line.startsWith('#### ')) {
      if (cur && cur.text.trim()) out.push(cur);
      cur = { kind: 'message', role: line.slice(5).trim().toLowerCase() === 'user' ? 'user' : 'assistant', text: '' };
    } else if (line.startsWith('> ')) {
      if (cur && cur.text.trim()) out.push(cur);
      cur = { kind: 'message', role: 'user', text: line.slice(2) };
    } else if (cur) {
      cur.text += line + '\n';
    }
  }
  if (cur && cur.text.trim()) out.push(cur);
  return out;
}

// ---------- ZCode (~/.zcode/cli/rollout/model-io-sess_*.jsonl) ----------
// NOTE: ZCode redacts request bodies in these logs (messages are empty) — only
// per-call usage/duration is recoverable, so the import shows a usage summary.
const ZCODE_ROLLOUT = path.join(HOME, '.zcode', 'cli', 'rollout');
function zcodeScan(f) {
  const parsed = firstLines(f, 256 * 1024)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const calls = parsed.length;
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, duration = 0, model = '';
  for (const j of parsed) {
    const u = j.response?.usage || {};
    input += u.inputTokens || 0; output += u.outputTokens || 0; cacheRead += u.cacheReadTokens || 0; cacheWrite += u.cacheWriteTokens || 0;
    duration += j.durationMs || 0;
    model = (typeof j.model === 'string' ? j.model : j.model?.modelId || j.model?.id || '') || model;
  }
  let truncated = false; // only the first 256 KB is parsed — a tail beyond that is silently missing from the totals unless flagged
  try { truncated = fs.statSync(f).size > 256 * 1024; } catch { /* file gone mid-scan */ }
  return { calls, input, output, cacheRead, cacheWrite, duration, model, truncated };
}
function zcodeList() {
  if (!fs.existsSync(ZCODE_ROLLOUT)) return [];
  const out = [];
  for (const f of fs.readdirSync(ZCODE_ROLLOUT)) {
    if (!f.startsWith('model-io-sess_') || !f.endsWith('.jsonl')) continue;
    const p = path.join(ZCODE_ROLLOUT, f);
    let st; try { st = fs.statSync(p); } catch { continue; }
    const scan = zcodeScan(p);
    out.push({
      file: p,
      id: f.replace(/^model-io-/, '').replace(/\.jsonl$/, ''),
      cwd: '~/.zcode', mtime: st.mtimeMs, size: st.size,
      preview: `${scan.calls} 次调用 · ${scan.model || '未知模型'} · 输入 ${fmtK(scan.input)} / 输出 ${fmtK(scan.output)} / 缓存读 ${fmtK(scan.cacheRead)}`,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 200);
}
function zcodeRead(file) {
  const scan = zcodeScan(file);
  const hit = scan.cacheRead + scan.input > 0 ? Math.round((scan.cacheRead / (scan.cacheRead + scan.input)) * 100) : null;
  const text = [
    'ZCode 模型调用日志（对话正文由 ZCode 脱敏不落盘，仅记录用量）',
    `调用次数：${scan.calls}`,
    `输入 tokens：${(scan.input || 0).toLocaleString()}`,
    `输出 tokens：${(scan.output || 0).toLocaleString()}`,
    `缓存读取：${(scan.cacheRead || 0).toLocaleString()}`,
    `缓存率：${hit === null ? '—' : hit + '%'}`,
    `累计耗时：${(scan.duration / 1000).toFixed(1)}s`,
    scan.model ? `模型：${scan.model}` : '',
    scan.truncated ? `⚠ 该日志超过 256KB，仅统计了前 256KB（数据不完整）` : '',
  ].filter(Boolean).join('\n');
  return [{ kind: 'message', role: 'assistant', text }];
}
function fmtK(n) { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }

// ---------- OMP / pi-fork sessions (same JSONL format as pi, ~/.omp/agent/sessions) ----------
// pi-fork session file → entries (works for any pi-format JSONL without a live process)
function piFileRead(file) {
  const out = [];
  for (const j of readJsonl(file)) {
    if (!j || typeof j !== 'object') continue; // F24
    if (j.type !== 'message') continue;
    const m = j.message || {};
    // F29 (v1.3.5 audit): keep the ORIGINAL string timestamp — the UI runs Date.parse
    // on it, and a pre-parsed epoch NUMBER fed to Date.parse() comes out Invalid Date
    const ts = j.timestamp || null;
    if (m.role === 'user') {
      const txt = contentText(Array.isArray(m.content) ? m.content.filter((x) => x && x.type !== 'image') : m.content);
      if (txt.trim()) out.push({ kind: 'message', role: 'user', text: txt, ts });
    } else if (m.role === 'assistant') {
      for (const b of m.content || []) {
        if (b.type === 'text' && b.text) out.push({ kind: 'message', role: 'assistant', text: b.text, ts });
        else if (b.type === 'thinking' && b.thinking) out.push({ kind: 'thinking', text: b.thinking, ts });
        else if (b.type === 'toolCall') out.push({ kind: 'toolcall', id: b.id, name: b.name, args: JSON.stringify(b.arguments || {}), ts });
      }
    } else if (m.role === 'toolResult') {
      const txt = contentText(m.content, ['text'], '');
      // F30: pi marks failed tool results — carry the flag through
      out.push({ kind: 'toolresult', id: m.toolCallId, output: txt, ts, isError: m.isError === true || m.stopReason === 'error' });
    }
  }
  return out;
}

// ---------- Grok CLI (~/.grok, generic best-effort jsonl extraction) ----------
function grokList() {
  if (!fs.existsSync(GROK_DIR)) return [];
  const files = walkFiles(GROK_DIR, { exts: ['.jsonl', '.json'], maxDepth: 3 });
  return files.map((f) => {
    let st; try { st = fs.statSync(f); } catch { return null; }
    let preview = '';
    for (const line of firstLines(f, 32768)) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (!j || typeof j !== 'object') continue; // F24
      const role = j.role || j.message?.role;
      const content = j.content ?? j.message?.content;
      if ((role === 'user' || role === 'human') && content) {
        preview = contentText(content);
        break;
      }
    }
    return { file: f, id: path.basename(f), cwd: '~/.grok', mtime: st.mtimeMs, size: st.size, preview: preview.replace(/\s+/g, ' ').slice(0, 120) };
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 400);
}
function grokRead(file) {
  const out = [];
  for (const j of readJsonl(file)) {
    const role = j.role || j.message?.role;
    const content = j.content ?? j.message?.content;
    if (!role || (role !== 'user' && role !== 'assistant' && role !== 'model')) continue;
    const text = contentText(content);
    if (text.trim()) out.push({ kind: 'message', role: role === 'model' ? 'assistant' : role, text, ts: j.timestamp || null });
  }
  return out;
}

// ---------- import source registry ----------
const importListCache = new Map(); // src -> {at, items, refreshing}
const LIST_TTL = 30000;
async function cachedList(src, fn) {
  const hit = importListCache.get(src);
  if (hit && Date.now() - hit.at < LIST_TTL && !hit.refreshing) return hit.items;
  if (hit && hit.refreshing) return hit.items; // serve stale while a refresh is in flight
  const entry = hit || { items: [], at: 0 };
  entry.at = Date.now();
  entry.refreshing = (async () => {
    try { entry.items = await fn(); entry.at = Date.now(); } catch { /* keep serving the stale list; next call retries */ }
    finally { entry.refreshing = null; }
  })();
  importListCache.set(src, entry);
  const wasPopulated = Array.isArray(entry.items) && entry.items.length > 0;
  if (!wasPopulated) await entry.refreshing.catch(() => {}); // first populate awaits; populated lists refresh in the background
  return entry.items;
}
async function codexList() {
  const files = listJsonFiles(CODEX_SESSIONS, 4)
    .map((f) => { try { return { f, mt: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.mt - a.mt).slice(0, 400).map((x) => x.f);
  const items = [];
  let n = 0;
  for (const f of files) {
    const info = codexSessionInfo(f);
    if (info) items.push(info); // P3-19: a file that vanished mid-list is skipped, not fatal
    if (++n % 40 === 0) await new Promise((r) => setImmediate(r)); // keep the event loop responsive
  }
  return items;
}
const notNull = (x) => x !== null;
const IMPORT_SOURCES = {
  codex: { list: () => cachedList('codex', codexList), read: codexSessionRead, root: CODEX_SESSIONS },
  claude: { list: () => cachedList('claude', () => listJsonFiles(CLAUDE_PROJECTS, 2)
    .map((f) => { try { return { f, mt: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.mt - a.mt).slice(0, 400).map((x) => claudeSessionInfo(x.f)).filter(notNull)), read: claudeSessionRead, root: CLAUDE_PROJECTS },
  zcode: { list: () => cachedList('zcode', zcodeList), read: zcodeRead, root: ZCODE_ROLLOUT },
  opencode: { list: () => cachedList('opencode', opencodeList), read: opencodeRead },
  omp: { list: () => cachedList('omp', () => listJsonFiles(OMP_SESSIONS, 2).map(piSessionInfo).filter(notNull).sort((a, b) => b.mtime - a.mtime).slice(0, 400)), read: piFileRead, root: OMP_SESSIONS },
  gemini: { list: () => cachedList('gemini', geminiList), read: geminiRead, root: GEMINI_DIR },
  grok: { list: () => cachedList('grok', grokList), read: grokRead, root: GROK_DIR },
  // aider histories live in HOME and in every registered project dir — both are legal read roots
  aider: { list: () => cachedList('aider', aiderList), read: aiderRead, root: HOME, roots: () => (loadConfig().projects || []).map((p) => p.path) },
};


  return { IMPORT_SOURCES, usageSummary, sessionTree, piSessionInfo, codexSessionInfo, claudeSessionInfo, claudeSessionRead, listJsonFiles, listJsonFilesBounded, firstLines };
}
