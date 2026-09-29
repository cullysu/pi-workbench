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
const listJsonFiles = (dir, depth = 2) => walkFiles(dir, { maxDepth: depth });
const firstLines = headLines;

// ---------- pi session listing ----------
function piSessionInfo(file) {
  const st = fs.statSync(file);
  const lines = firstLines(file);
  let cwd = null, id = null, name = null, preview = '', timestamp = null;
  for (const line of lines) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'session' || j.cwd || j.sessionId || j.id?.length > 8) {
      cwd = cwd || (typeof j.cwd === 'string' ? j.cwd : null);
      id = id || (typeof j.id === 'string' ? j.id : typeof j.sessionId === 'string' ? j.sessionId : null);
      name = name || (typeof j.name === 'string' ? j.name : null);
      timestamp = timestamp || j.timestamp || null;
    }
    if (!preview && j.type === 'message' && j.message?.role === 'user') {
      const c = j.message.content;
      preview = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join(' ') : '';
    }
    if (preview) break;
  }
  if (!preview) {
    // fallback: scan a few more lines for any user text
    for (const line of firstLines(file, 65536)) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      const role = j.message?.role || j.role;
      if (role === 'user') {
        const c = j.message?.content ?? j.content;
        preview = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join(' ') : '';
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
  const st = fs.statSync(file);
  const lines = firstLines(file, 65536); // session_meta is always the first line; 64KB also covers the first user turn
  let cwd = null, id = null, preview = '', ts = null;
  const userText = (p) => {
    if (p.type === 'user_message') return typeof p.message === 'string' ? p.message : '';
    if (p.type === 'message' && p.role === 'user') {
      const c = p.content;
      return Array.isArray(c) ? c.map((x) => x.text || x.input_text || '').join(' ') : typeof c === 'string' ? c : '';
    }
    return '';
  };
  for (const line of lines) {
    let j; try { j = JSON.parse(line); } catch { continue; }
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
  for (const j of readJsonl(file)) {
    const ts = j.timestamp || null;
    const p = j.payload || j;
    if (p.type === 'message') {
      const role = p.role === 'assistant' ? 'assistant' : p.role === 'user' ? 'user' : null;
      if (!role) continue; // developer/system/context frames are not conversation
      const texts = Array.isArray(p.content) ? p.content.map((c) => c.text || c.input_text || c.output_text || '').filter(Boolean) : [typeof p.content === 'string' ? p.content : ''];
      if (texts.join('').trim()) out.push({ kind: 'message', role, text: texts.join('\n'), ts });
    } else if (p.type === 'user_message' || p.type === 'agent_message') {
      out.push({ kind: 'message', role: p.type === 'user_message' ? 'user' : 'assistant', text: typeof p.message === 'string' ? p.message : JSON.stringify(p.message), ts });
    } else if (p.type === 'reasoning') {
      const sum = Array.isArray(p.summary) ? p.summary.map((s) => s.text || '').join('\n') : '';
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
  const st = fs.statSync(file);
  const lines = firstLines(file, 32768);
  let cwd = null, id = null, preview = '';
  for (const line of lines) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    cwd = cwd || (typeof j.cwd === 'string' ? j.cwd : null);
    id = id || (typeof j.sessionId === 'string' ? j.sessionId : null);
    if (!preview && (j.type === 'user' || j.message?.role === 'user') && !j.isMeta) {
      const c = j.message?.content;
      preview = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').filter(Boolean).join(' ') : '';
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
    const ts = j.timestamp || null;
    const m = j.message;
    if (!m || (j.type !== 'user' && j.type !== 'assistant')) continue;
    const c = m.content;
    if (typeof c === 'string') { if (c.trim()) out.push({ kind: 'message', role: m.role, text: c, ts }); continue; }
    if (!Array.isArray(c)) continue;
    for (const block of c) {
      if (block.type === 'text' && block.text?.trim()) out.push({ kind: 'message', role: m.role, text: block.text, ts });
      else if (block.type === 'thinking' && block.thinking?.trim()) out.push({ kind: 'thinking', text: block.thinking, ts });
      else if (block.type === 'tool_use') out.push({ kind: 'toolcall', id: block.id, name: block.name, args: JSON.stringify(block.input || {}), ts });
      else if (block.type === 'tool_result') {
        const txt = Array.isArray(block.content) ? block.content.map((x) => x.text || '').join('\n') : typeof block.content === 'string' ? block.content : '';
        out.push({ kind: 'toolresult', id: block.tool_use_id, output: txt, ts });
      }
    }
  }
  return out;
}

// ---------- usage aggregation (design borrowed from oh-my-pi omp-stats) ----------
const usageCache = new Map(); // file -> {mtime, size, agg}
function usageFromFile(f) {
  let st; try { st = fs.statSync(f); } catch { return null; }
  const cached = usageCache.get(f);
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.agg;
  const agg = { ok: 0, err: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costEst: 0, models: {}, providers: {}, days: {} };
  const lines = readJsonl(f);
  let curProv = null;
  const bump = (store, u, mk) => {
    const t = store[mk] = store[mk] || { ok: 0, input: 0, output: 0, cacheRead: 0, cost: 0, costEst: 0 };
    t.ok++; t.input += u.input || 0; t.output += u.output || 0; t.cacheRead += u.cacheRead || 0; t.cost += u.cost?.total || 0;
    // models that don't report cost: estimate from the built-in knowledge base (input+output, usd, first tier)
    if (!u.cost?.total) {
      const price = kbPrice(mk);
      if (price) t.costEst += ((u.input || 0) * price.in + (u.output || 0) * price.out) / 1e6;
    }
  };
  for (const j of lines) {
    if (j.type === 'model_change') { curProv = j.provider || curProv; continue; }
    if (j.type !== 'message' || j.message?.role !== 'assistant') continue;
    if (j.message.stopReason === 'error') { agg.err++; continue; }
    const u = j.message.usage;
    if (!u || (!u.input && !u.output)) continue;
    agg.ok++; agg.input += u.input || 0; agg.output += u.output || 0;
    agg.cacheRead += u.cacheRead || 0; agg.cacheWrite += u.cacheWrite || 0;
    agg.cost += u.cost?.total || 0;
    bump(agg.models, u, j.message.model || 'unknown');
    bump(agg.providers, u, curProv || 'unknown');
    const d = j.timestamp ? new Date(j.timestamp) : null;
    const day = d && !isNaN(d) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;
    if (day) {
      const dd = agg.days[day] = agg.days[day] || { ok: 0, input: 0, output: 0, cacheRead: 0, cost: 0, providers: {} };
      dd.ok++; dd.input += u.input || 0; dd.output += u.output || 0; dd.cacheRead += u.cacheRead || 0; dd.cost += u.cost?.total || 0;
      bump(dd.providers, u, curProv || 'unknown');
    }
  }
  usageCache.set(f, { mtime: st.mtimeMs, size: st.size, agg });
  return agg;
}
function usageSummary() {
  const files = listJsonFiles(PI_SESSIONS, 2);
  const items = files.map((f) => { try { return { f, mt: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.mt - a.mt).slice(0, 300);
  const total = { sessions: items.length, ok: 0, err: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costEst: 0, models: {}, providers: {}, days: {} };
  for (const { f } of items) {
    const a = usageFromFile(f);
    if (!a) continue;
    total.ok += a.ok; total.err += a.err; total.input += a.input; total.output += a.output;
    total.cacheRead += a.cacheRead; total.cacheWrite += a.cacheWrite; total.cost += a.cost; total.costEst += a.costEst || 0;
    for (const [mk, m] of Object.entries(a.models)) {
      const t = total.models[mk] = total.models[mk] || { ok: 0, input: 0, output: 0, cacheRead: 0, cost: 0, costEst: 0 };
      t.ok += m.ok; t.input += m.input; t.output += m.output; t.cacheRead += m.cacheRead; t.cost += m.cost; t.costEst += m.costEst || 0;
    }
    for (const [pk, m] of Object.entries(a.providers || {})) {
      const t = total.providers[pk] = total.providers[pk] || { ok: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
      t.ok += m.ok; t.input += m.input; t.output += m.output; t.cacheRead += m.cacheRead; t.cost += m.cost;
    }
    for (const [d, v] of Object.entries(a.days)) {
      const t = total.days[d] = total.days[d] || { ok: 0, input: 0, output: 0, cacheRead: 0, cost: 0, providers: {} };
      t.ok += v.ok; t.input += v.input; t.output += v.output; t.cacheRead += v.cacheRead || 0; t.cost += v.cost;
      for (const [pk, m] of Object.entries(v.providers || {})) {
        const tp = t.providers[pk] = t.providers[pk] || { ok: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
        tp.ok += m.ok; tp.input += m.input; tp.output += m.output; tp.cacheRead += m.cacheRead; tp.cost += m.cost;
      }
    }
  }
  total.cacheHit = total.input + total.cacheRead > 0 ? total.cacheRead / (total.input + total.cacheRead) : 0;
  total.cost = +total.cost.toFixed(4);
  total.costEstimated = +total.costEst.toFixed(4);
  return total;
}

// ---------- session tree (design borrowed from oh-my-pi /tree) ----------
function sessionTree(file) {
  const rootAbs = path.resolve(PI_SESSIONS);
  if (!file || !path.resolve(file).startsWith(rootAbs + path.sep)) return null;
  const nodes = []; const byId = new Map();
  for (const j of readJsonl(file)) {
    if (!j.id) continue;
    const n = { id: j.id, parentId: j.parentId || null, type: j.type, ts: j.timestamp || null };
    if (j.type === 'message') {
      const m = j.message || {};
      n.role = m.role;
      const txt = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((c) => c.text || '').join(' ') : '';
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
  for (let n = last; n; n = n.parentId ? byId.get(n.parentId) : null) activePath.add(n.id);
  return {
    count: nodes.length,
    branches: [...kids.values()].filter((v) => v.length > 1).length,
    activePath: [...activePath],
    nodes: nodes.slice(-4000),
  };
}


// ---------- OpenCode (SQLite via node:sqlite, read-only) ----------
function opencodeDb() {
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
  try {
    const out = [];
    const msgs = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created').all(id);
    for (const m of msgs) {
      const md = JSON.parse(m.data || '{}');
      const role = md.role === 'user' ? 'user' : md.role === 'assistant' ? 'assistant' : null;
      const ts = m.time_created ? new Date(m.time_created).toISOString() : null;
      const parts = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created').all(m.id);
      for (const pt of parts) {
        let pd; try { pd = JSON.parse(pt.data || '{}'); } catch { continue; }
        if (pd.type === 'text' && pd.text) { if (role) out.push({ kind: 'message', role, text: pd.text, ts }); }
        else if (pd.type === 'reasoning' && pd.text) out.push({ kind: 'thinking', text: pd.text, ts });
        else if (pd.type === 'tool') out.push({ kind: 'toolcall', id: pd.id || pt.id, name: pd.tool || pd.state?.tool || 'tool', args: JSON.stringify(pd.state?.input || pd.input || {}), ts });
      }
    }
    return out;
  } catch { return []; }
  finally { try { db.close(); } catch { /* connection may already be closed */ } }
}

// ---------- Gemini CLI (~/.gemini/tmp/<hash>/chats/session-*.json) ----------
const GEMINI_DIR = path.join(HOME, '.gemini');
function geminiList() {
  const root = path.join(GEMINI_DIR, 'tmp');
  const out = walkFiles(root, { maxDepth: 4, match: (n) => n.startsWith('session-') && n.endsWith('.json') });
  return out.map((f) => {
    let st; try { st = fs.statSync(f); } catch { return null; }
    let preview = '', hash = path.basename(path.dirname(path.dirname(f)));
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const msgs = j.messages || j.history || [];
      const firstUser = msgs.find((m) => m.type === 'user');
      preview = (typeof firstUser?.text === 'string' ? firstUser.text : '') || j.title || '';
    } catch { /* unreadable session: keep it with an empty preview */ }
    return { file: f, id: path.basename(f, '.json'), cwd: '~/.gemini/tmp/' + hash, mtime: st.mtimeMs, size: st.size, preview: preview.replace(/\s+/g, ' ').slice(0, 120) };
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 400);
}
function geminiRead(file) {
  const out = [];
  let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return out; }
  for (const m of j.messages || j.history || []) {
    if (m.type === 'user' && m.text) out.push({ kind: 'message', role: 'user', text: m.text, ts: null });
    else if ((m.type === 'gemini' || m.type === 'model') && m.text) out.push({ kind: 'message', role: 'assistant', text: m.text, ts: null });
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
  let input = 0, output = 0, cacheRead = 0, duration = 0, model = '';
  for (const j of parsed) {
    const u = j.response?.usage || {};
    input += u.inputTokens || 0; output += u.outputTokens || 0; cacheRead += u.cacheReadTokens || 0;
    duration += j.durationMs || 0;
    model = j.model?.modelId || model;
  }
  return { calls, input, output, cacheRead, duration, model };
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
  ].filter(Boolean).join('\n');
  return [{ kind: 'message', role: 'assistant', text }];
}
function fmtK(n) { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }

// ---------- OMP / pi-fork sessions (same JSONL format as pi, ~/.omp/agent/sessions) ----------
// pi-fork session file → entries (works for any pi-format JSONL without a live process)
function piFileRead(file) {
  const out = [];
  for (const j of readJsonl(file)) {
    if (j.type !== 'message') continue;
    const m = j.message || {};
    const ts = j.timestamp ? Date.parse(j.timestamp) : null;
    if (m.role === 'user') {
      const txt = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((x) => x.type !== 'image').map((x) => x.text || '').join(' ') : '';
      if (txt.trim()) out.push({ kind: 'message', role: 'user', text: txt, ts });
    } else if (m.role === 'assistant') {
      for (const b of m.content || []) {
        if (b.type === 'text' && b.text) out.push({ kind: 'message', role: 'assistant', text: b.text, ts });
        else if (b.type === 'thinking' && b.thinking) out.push({ kind: 'thinking', text: b.thinking, ts });
        else if (b.type === 'toolCall') out.push({ kind: 'toolcall', id: b.id, name: b.name, args: JSON.stringify(b.arguments || {}), ts });
      }
    } else if (m.role === 'toolResult') {
      const txt = (m.content || []).map((x) => x.text || '').join('');
      out.push({ kind: 'toolresult', id: m.toolCallId, output: txt, ts });
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
      const role = j.role || j.message?.role;
      const content = j.content ?? j.message?.content;
      if ((role === 'user' || role === 'human') && content) {
        preview = typeof content === 'string' ? content : Array.isArray(content) ? content.map((x) => x.text || '').join(' ') : '';
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
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((x) => x.text || '').join(' ') : '';
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
    items.push(codexSessionInfo(f));
    if (++n % 40 === 0) await new Promise((r) => setImmediate(r)); // keep the event loop responsive
  }
  return items;
}
const IMPORT_SOURCES = {
  codex: { list: () => cachedList('codex', codexList), read: codexSessionRead, root: CODEX_SESSIONS },
  claude: { list: () => cachedList('claude', () => listJsonFiles(CLAUDE_PROJECTS, 2)
    .map((f) => { try { return { f, mt: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.mt - a.mt).slice(0, 400).map((x) => claudeSessionInfo(x.f))), read: claudeSessionRead, root: CLAUDE_PROJECTS },
  zcode: { list: () => cachedList('zcode', zcodeList), read: zcodeRead, root: ZCODE_ROLLOUT },
  opencode: { list: () => cachedList('opencode', opencodeList), read: opencodeRead },
  omp: { list: () => cachedList('omp', () => listJsonFiles(OMP_SESSIONS, 2).map(piSessionInfo).sort((a, b) => b.mtime - a.mtime).slice(0, 400)), read: piFileRead, root: OMP_SESSIONS },
  gemini: { list: () => cachedList('gemini', geminiList), read: geminiRead, root: GEMINI_DIR },
  grok: { list: () => cachedList('grok', grokList), read: grokRead, root: GROK_DIR },
  // aider histories live in HOME and in every registered project dir — both are legal read roots
  aider: { list: () => cachedList('aider', aiderList), read: aiderRead, root: HOME, roots: () => (loadConfig().projects || []).map((p) => p.path) },
};


  return { IMPORT_SOURCES, usageSummary, sessionTree, piSessionInfo, codexSessionInfo, claudeSessionInfo, claudeSessionRead, listJsonFiles, firstLines };
}
