#!/usr/bin/env node
// pi-workbench server — local workbench shell around the pi coding agent.
// Spawns `pi --mode rpc` (JSONL over stdio, per pi docs), never reimplements the agent.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOME = os.homedir();
const CFG_DIR = path.join(HOME, '.pi-workbench');
const CFG_FILE = path.join(CFG_DIR, 'config.json');
const PI_SESSIONS = path.join(HOME, '.pi', 'agent', 'sessions');
const PI_MODELS = path.join(HOME, '.pi', 'agent', 'models.json');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const PI_CLI = path.join(__dirname, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
const PORT = Number(process.env.PIWB_PORT || 32123);
// Electron mode: self-terminate when the desktop app dies, so the port never leaks
if (process.env.PIWB_PARENT_PID) {
  const parent = Number(process.env.PIWB_PARENT_PID);
  const watchdog = setInterval(() => {
    try { process.kill(parent, 0); } catch { process.exit(0); }
  }, 3000);
  watchdog.unref();
}

// ---------- config ----------
// path key: resolve + lowercase so Windows case variants don't create duplicate projects
const projectKey = (p) => { try { return path.resolve(String(p)).toLowerCase(); } catch { return String(p).toLowerCase(); } };
function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    if (Array.isArray(cfg.projects)) {
      const seen = new Set();
      cfg.projects = cfg.projects.filter((p) => {
        if (!p || typeof p.path !== 'string' || !p.path) return false;
        const k = projectKey(p.path);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    return cfg;
  } catch {
    return { projects: [], lang: 'zh', theme: 'dark' };
  }
}
function saveConfig(cfg) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

// ---------- secrets (in-memory only, never persisted) ----------
// Opt-in relay secret: all fields come from ~/.pi-workbench/config.json "relaySecret",
// e.g. { settingsPath, relayId, relayName, tokenField, envName, fingerprint }.
// Nothing about any particular provider is hardcoded here.
const SECRET_ENV = {};
function resolveSecrets() {
  try {
    const cfg = loadConfig();
    const src = cfg.relaySecret;
    if (!src || !src.settingsPath) return;
    const settingsPath = String(src.settingsPath).replace(/%APPDATA%/gi, process.env.APPDATA || '');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const relay = (settings.relayProfiles || []).find((r) =>
      (src.relayId && r.id === src.relayId) || (src.relayName && r.name === src.relayName));
    let token = relay?.[src.tokenField || 'experimental_bearer_token'] || null;
    if (!token && typeof relay?.configContents === 'string' && src.tokenField) {
      // plain indexOf slicing — no regex escaping to get wrong
      const cc = relay.configContents;
      const i = cc.indexOf(src.tokenField);
      if (i !== -1) {
        const eq = cc.indexOf('=', i);
        const v1 = cc.indexOf('"', eq);
        const v2 = v1 === -1 ? -1 : cc.indexOf('"', v1 + 1);
        if (v1 !== -1 && v2 > v1) token = cc.slice(v1 + 1, v2);
      }
    }
    const envName = src.envName || 'RELAY_API_KEY';
    if (token) {
      if (src.fingerprint) {
        const fp = crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
        if (fp !== src.fingerprint) {
          console.log(`[secrets] relay token fingerprint mismatch (${fp} != ${src.fingerprint}), not used`);
          return;
        }
      }
      SECRET_ENV[envName] = token;
      console.log(`[secrets] ${envName} loaded (memory only)`);
    }
  } catch (e) {
    console.log('[secrets] relaySecret source unavailable:', e.message);
  }
}

// ---------- crash resilience: a local workbench should not die on a stray rejection ----------
const LOG_FILE = path.join(CFG_DIR, 'server.log');
function logErr(line) {
  try {
    fs.mkdirSync(CFG_DIR, { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 2e6) fs.writeFileSync(LOG_FILE, ''); } catch {}
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}
process.on('uncaughtException', (e) => logErr('uncaughtException: ' + ((e && e.stack) || e)));
process.on('unhandledRejection', (e) => logErr('unhandledRejection: ' + ((e && e.stack) || e)));

// ---------- helpers ----------
const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

// ---------- routing v2 (design borrowed from oh-my-pi: fallback chains + per-key rotation) ----------
const ROUTING_FILE = path.join(CFG_DIR, 'routing.json');
function loadRouting() {
  const d = readJson(ROUTING_FILE);
  const r = d && typeof d === 'object' ? d : {};
  // migrate legacy PySide-era schema: routes{name:{enabled,priority,...}} -> providers
  if ((!r.providers || !Object.keys(r.providers).length) && r.routes && typeof r.routes === 'object') {
    r.providers = {};
    for (const [name, meta] of Object.entries(r.routes)) {
      r.providers[name] = { enabled: meta.enabled !== false, priority: meta.priority || 1, keyEnvs: [] };
    }
    delete r.routes;
  }
  r.providers = r.providers || {};
  r.chains = Array.isArray(r.chains) ? r.chains : [];
  r.state = r.state || {}; r.state.cooldowns = r.state.cooldowns || {};
  if (!r.chains.length) r.chains = [];
  return r;
}
function saveRouting(r) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(ROUTING_FILE, JSON.stringify(r, null, 2));
  return r;
}
const splitModel = (m) => { const i = (m || '').indexOf('/'); return i === -1 ? [null, m] : [m.slice(0, i), m.slice(i + 1)]; };
function keyEnvsFor(provider) {
  const models = readJson(PI_MODELS) || { providers: {} };
  const routing = loadRouting();
  const envs = new Set();
  const ak = models.providers?.[provider]?.apiKey;
  if (typeof ak === 'string' && ak.startsWith('$')) envs.add(ak.slice(1));
  for (const e of routing.providers?.[provider]?.keyEnvs || []) envs.add(String(e).startsWith('$') ? e.slice(1) : String(e));
  return [...envs];
}
function hasLiteralKey(provider) {
  const models = readJson(PI_MODELS) || { providers: {} };
  const ak = models.providers?.[provider]?.apiKey;
  return typeof ak === 'string' && ak.length > 0 && !ak.startsWith('$');
}
function keyValue(env) {
  return SECRET_ENV[env] || process.env[env] || null;
}
function providerHasKey(provider) {
  // pickKey respects per-key cooldowns — a cooled key set means "no usable key"
  return pickKey(provider) !== null || hasLiteralKey(provider);
}
function pickKey(provider) {
  const cds = loadRouting().state.cooldowns;
  const envs = keyEnvsFor(provider);
  for (let i = 0; i < envs.length; i++) {
    const cd = cds[`${provider}#key${i}`];
    if (cd && cd.until > Date.now()) continue;
    if (!keyValue(envs[i])) continue;
    return { idx: i, env: envs[i], value: keyValue(envs[i]) };
  }
  return null;
}
function coolModel(modelId, err, seconds) {
  const routing = loadRouting();
  routing.state.cooldowns[`model:${modelId}`] = { until: Date.now() + seconds * 1000, error: String(err || '').slice(0, 200) };
  saveRouting(routing);
}
function coolKey(provider, idx, err, seconds) {
  if (idx === null || idx === undefined) return;
  const routing = loadRouting();
  routing.state.cooldowns[`${provider}#key${idx}`] = { until: Date.now() + seconds * 1000, error: String(err || '').slice(0, 200) };
  saveRouting(routing);
}
function clearCool(modelId) {
  const [prov] = splitModel(modelId);
  const routing = loadRouting();
  const cds = routing.state.cooldowns;
  let changed = false;
  for (const k of Object.keys(cds)) {
    if (k === `model:${modelId}` || k === prov || k.startsWith(prov + '#key')) { delete cds[k]; changed = true; }
  }
  if (changed) saveRouting(routing);
}
function modelCooled(modelId) {
  const cd = loadRouting().state.cooldowns[`model:${modelId}`];
  return cd && cd.until > Date.now() ? cd : null;
}
function providerCooled(provider) {
  const models = readJson(PI_MODELS) || { providers: {} };
  const list = (models.providers?.[provider]?.models || []).map((m) => `${provider}/${m.id}`);
  if (!list.length) return null;
  const cds = loadRouting().state.cooldowns;
  const cooled = list.map((m) => cds[`model:${m}`]).filter((c) => c && c.until > Date.now());
  return cooled.length === list.length ? cooled.reduce((a, b) => (a.until > b.until ? a : b)) : null;
}
function envOverrideFor(provider) {
  const pk = pickKey(provider);
  if (!pk) return null;
  const models = readJson(PI_MODELS) || { providers: {} };
  const ak = models.providers?.[provider]?.apiKey;
  if (typeof ak !== 'string' || !ak.startsWith('$')) return null;
  return { __keyIdx: pk.idx, [ak.slice(1)]: pk.value };
}
function nextInChain(modelId) {
  const routing = loadRouting();
  for (const chain of routing.chains || []) {
    const i = chain.indexOf(modelId);
    if (i === -1) continue;
    for (let j = i + 1; j < chain.length; j++) {
      const cand = chain[j];
      const [prov] = splitModel(cand);
      if (routing.providers?.[prov]?.enabled === false) continue;
      if (modelCooled(cand)) continue;
      if (providerCooled(prov)) continue;
      if (!providerHasKey(prov)) continue;
      return cand;
    }
  }
  return null;
}
async function probeModel(modelId) {
  const [prov] = splitModel(modelId);
  const models = readJson(PI_MODELS) || { providers: {} };
  const p = models.providers?.[prov];
  if (!p?.baseUrl) return { ok: false, detail: 'provider has no baseUrl' };
  const ov = envOverrideFor(prov);
  let key = ov ? Object.values(ov).find((v) => typeof v === 'string') : null;
  if (!key && hasLiteralKey(prov)) key = p.apiKey;
  const t0 = Date.now();
  try {
    const r = await fetch(p.baseUrl.replace(/\/$/, '') + '/models', {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, status: r.status, ms };
    const j = await r.json().catch(() => ({}));
    return { ok: true, ms, models: Array.isArray(j.data) ? j.data.length : null };
  } catch (e) {
    return { ok: false, detail: String(e.message || e), ms: Date.now() - t0 };
  }
}
const listJsonFiles = (dir, depth = 2) => {
  const out = [];
  const walk = (d, lvl) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (lvl < depth) walk(p, lvl + 1); }
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
};
const firstLines = (p, bytes = 16384) => {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n).split('\n').filter(Boolean);
  } catch { return []; }
  finally { try { fd && fs.closeSync(fd); } catch {} }
};

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
  const raw = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of raw) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
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
  const agg = { ok: 0, err: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: {}, providers: {}, days: {} };
  let buf; try { buf = fs.readFileSync(f, 'utf8'); } catch { usageCache.set(f, { mtime: st.mtimeMs, size: st.size, agg }); return agg; }
  let curProv = null;
  const bump = (store, u, mk) => {
    const t = store[mk] = store[mk] || { ok: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
    t.ok++; t.input += u.input || 0; t.output += u.output || 0; t.cacheRead += u.cacheRead || 0; t.cost += u.cost?.total || 0;
  };
  for (const line of buf.split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
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
  const total = { sessions: items.length, ok: 0, err: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: {}, providers: {}, days: {} };
  for (const { f } of items) {
    const a = usageFromFile(f);
    if (!a) continue;
    total.ok += a.ok; total.err += a.err; total.input += a.input; total.output += a.output;
    total.cacheRead += a.cacheRead; total.cacheWrite += a.cacheWrite; total.cost += a.cost;
    for (const [mk, m] of Object.entries(a.models)) {
      const t = total.models[mk] = total.models[mk] || { ok: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
      t.ok += m.ok; t.input += m.input; t.output += m.output; t.cacheRead += m.cacheRead; t.cost += m.cost;
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
  return total;
}

// ---------- session tree (design borrowed from oh-my-pi /tree) ----------
function sessionTree(file) {
  if (!file || !path.resolve(file).startsWith(path.resolve(PI_SESSIONS))) return null;
  let buf; try { buf = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const nodes = []; const byId = new Map();
  for (const line of buf.split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
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

async function testModelReply(modelId) {
  const [prov, mid] = splitModel(modelId);
  const models = readJson(PI_MODELS) || { providers: {} };
  const p = models.providers?.[prov];
  if (!p?.baseUrl) return { ok: false, detail: 'provider has no baseUrl' };
  const ov = envOverrideFor(prov);
  let key = ov ? Object.values(ov).find((v) => typeof v === 'string') : null;
  if (!key && hasLiteralKey(prov)) key = p.apiKey;
  const auth = key ? { authorization: `Bearer ${key}` } : {};
  const base = p.baseUrl.replace(/\/$/, '');
  const t0 = Date.now();
  try {
    let r, j, txt = '';
    if (p.api === 'anthropic-messages') {
      r = await fetch(base + '/messages', {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: mid, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(25000),
      });
      j = await r.json().catch(() => ({}));
      txt = Array.isArray(j.content) ? j.content.map((c) => c.text || '').join('') : '';
    } else if (p.api === 'openai-responses') {
      r = await fetch(base + '/responses', {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ model: mid, input: '只回复ok', max_output_tokens: 16 }),
        signal: AbortSignal.timeout(30000),
      });
      j = await r.json().catch(() => ({}));
      txt = (j.output || []).filter((o) => o.type === 'message').flatMap((o) => (o.content || []).map((c) => c.text || '')).join('');
    } else { // openai-completions and anything else speaking the chat shape
      // no max_tokens: reasoning models spend it on thinking and some relays 400 on tiny budgets
      r = await fetch(base + '/chat/completions', {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ model: mid, messages: [{ role: 'user', content: '只回复ok' }] }),
        signal: AbortSignal.timeout(30000),
      });
      j = await r.json().catch(() => ({}));
      txt = j.choices?.[0]?.message?.content || '';
    }
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, status: r.status, detail: JSON.stringify(j).slice(0, 160), ms };
    return { ok: true, ms, reply: String(txt).slice(0, 60) };
  } catch (e) {
    return { ok: false, detail: String(e.message || e), ms: Date.now() - t0 };
  }
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
  finally { try { db.close(); } catch {} }
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
  finally { try { db.close(); } catch {} }
}

// ---------- Gemini CLI (~/.gemini/tmp/<hash>/chats/session-*.json) ----------
const GEMINI_DIR = path.join(HOME, '.gemini');
function geminiList() {
  const root = path.join(GEMINI_DIR, 'tmp');
  const out = [];
  const walk = (d, lvl) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && lvl < 4) walk(p, lvl + 1);
      else if (e.isFile() && e.name.startsWith('session-') && e.name.endsWith('.json')) out.push(p);
    }
  };
  walk(root, 0);
  return out.map((f) => {
    const st = fs.statSync(f);
    let preview = '', hash = path.basename(path.dirname(path.dirname(f)));
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const msgs = j.messages || j.history || [];
      const firstUser = msgs.find((m) => m.type === 'user');
      preview = (typeof firstUser?.text === 'string' ? firstUser.text : '') || j.title || '';
    } catch {}
    return { file: f, id: path.basename(f, '.json'), cwd: '~/.gemini/tmp/' + hash, mtime: st.mtimeMs, size: st.size, preview: preview.replace(/\s+/g, ' ').slice(0, 120) };
  }).sort((a, b) => b.mtime - a.mtime).slice(0, 400);
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
  const parsed = firstLines(f, 2 * 1024 * 1024)
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
const OMP_SESSIONS = path.join(HOME, '.omp', 'agent', 'sessions');
// pi-fork session file → entries (works for any pi-format JSONL without a live process)
function piFileRead(file) {
  const out = [];
  let buf; try { buf = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of buf.split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
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
const GROK_DIR = path.join(HOME, '.grok');
function grokList() {
  if (!fs.existsSync(GROK_DIR)) return [];
  const files = [];
  (function walk(d, lvl) {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && lvl < 3) walk(p, lvl + 1);
      else if (e.isFile() && (e.name.endsWith('.jsonl') || e.name.endsWith('.json'))) files.push(p);
    }
  })(GROK_DIR, 0);
  return files.map((f) => {
    const st = fs.statSync(f);
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
  }).sort((a, b) => b.mtime - a.mtime).slice(0, 400);
}
function grokRead(file) {
  const out = [];
  let buf; try { buf = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of buf.split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
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
    try { entry.items = await fn(); entry.at = Date.now(); } catch {}
    finally { entry.refreshing = null; }
  })();
  importListCache.set(src, entry);
  if (Date.now() - entry.at < 250) await entry.refreshing.catch(() => {}); // first populate awaits; later refreshes serve stale
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
  claude: { list: () => cachedList('claude', () => listJsonFiles(CLAUDE_PROJECTS, 2).map(claudeSessionInfo).sort((a, b) => b.mtime - a.mtime).slice(0, 400)), read: claudeSessionRead, root: CLAUDE_PROJECTS },
  zcode: { list: () => cachedList('zcode', zcodeList), read: zcodeRead, root: ZCODE_ROLLOUT },
  opencode: { list: () => cachedList('opencode', opencodeList), read: opencodeRead },
  omp: { list: () => cachedList('omp', () => listJsonFiles(OMP_SESSIONS, 2).map(piSessionInfo).sort((a, b) => b.mtime - a.mtime).slice(0, 400)), read: piFileRead, root: OMP_SESSIONS },
  gemini: { list: () => cachedList('gemini', geminiList), read: geminiRead, root: GEMINI_DIR },
  grok: { list: () => cachedList('grok', grokList), read: grokRead, root: GROK_DIR },
  aider: { list: () => cachedList('aider', aiderList), read: aiderRead },
};

// ---------- pi process manager ----------
const tabs = new Map(); // tabId -> {proc, cwd, sessionPath, sessionFile, model, startedAt, buffer}
function spawnPi({ cwd, sessionPath, model, thinking, name, envExtra }) {
  const args = ['--mode', 'rpc', ...skillArgsFor(cwd)];
  if (sessionPath) args.push('--session', sessionPath);
  if (model) args.push('--model', model);
  if (thinking) args.push('--thinking', thinking);
  if (name) args.push('--name', name);
  const proc = spawn(process.execPath, [PI_CLI, ...args], {
    cwd: cwd || HOME,
    env: { ...process.env, ...SECRET_ENV, ...(envExtra || {}) },
    windowsHide: true,
  });
  proc.stdin.setEncoding('utf8');
  return proc;
}
function attachPiReader(tabId, proc) {
  const tab = tabs.get(tabId);
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'response' && ev.success && ev.data?.sessionFile && ev.data.sessionFile !== tab.sessionFile) {
        tab.sessionFile = ev.data.sessionFile;
        broadcast({ type: 'pi-session-file', tabId, sessionFile: tab.sessionFile });
      }
      broadcast({ type: 'pi-event', tabId, data: ev });
    }
  });
  proc.stderr.on('data', (c) => broadcast({ type: 'pi-stderr', tabId, data: c.toString('utf8').slice(0, 2000) }));
  proc.on('exit', (code) => { broadcast({ type: 'pi-exit', tabId, code }); tabs.delete(tabId); });
}
function sendToPi(tabId, cmd) {
  const tab = tabs.get(tabId);
  if (!tab) return false;
  try { tab.proc.stdin.write(JSON.stringify(cmd) + '\n'); return true; } catch { return false; }
}

// ---------- ws ----------
const wss = new WebSocketServer({ noServer: true });
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of wss.clients) { try { c.send(s); } catch {} }
}

wss.on('connection', (ws) => {
  console.log('[ws] client connected');
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    console.log('[ws] frame:', msg.type, msg.tabId || '');
    if (msg.type === 'open') {
      const { tabId, cwd, sessionPath, model, thinking, name } = msg;
      closeTab(tabId);
      const prov = model ? splitModel(model)[0] : null;
      const ov = prov ? envOverrideFor(prov) : null;
      const { __keyIdx, ...envExtra } = ov || {};
      const proc = spawnPi({ cwd, sessionPath, model, thinking, name, envExtra });
      tabs.set(tabId, { proc, cwd, sessionPath: sessionPath || null, model: model || null, startedAt: Date.now(), buffer: '', routeProvider: prov, routeKeyIdx: ov ? __keyIdx : null });
      attachPiReader(tabId, proc);
      ws.send(JSON.stringify({ type: 'opened', tabId }));
    } else if (msg.type === 'rpc') {
      sendToPi(msg.tabId, msg.data);
    } else if (msg.type === 'close') {
      closeTab(msg.tabId);
      broadcast({ type: 'pi-exit', tabId: msg.tabId, code: 0 });
    }
  });
});
function closeTab(tabId) {
  const tab = tabs.get(tabId);
  if (tab) {
    try { tab.proc.stdin.write(JSON.stringify({ type: 'abort' }) + '\n'); } catch {}
    try { tab.proc.kill(); } catch {}
    tabs.delete(tabId);
  }
}

// ---------- http ----------
function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
const runGit = (cwd, args, max = 200000) => new Promise((resolve) => {
  const p = spawn('git', args, { cwd, windowsHide: true });
  let out = '', err = '';
  p.stdout.on('data', (c) => { if (out.length < max) out += c; });
  p.stderr.on('data', (c) => { err += c; });
  p.on('error', (e) => resolve({ error: e.message }));
  p.on('close', (code) => resolve({ code, out: out.slice(0, max), err: err.slice(0, 2000) }));
});

const PI_SETTINGS = path.join(HOME, '.pi', 'agent', 'settings.json');
const MCP_FILE = path.join(HOME, '.pi', 'agent', 'mcp.json');
const PI_SKILLS = path.join(HOME, '.pi', 'agent', 'skills');
const AGENTS_SKILLS = path.join(HOME, '.agents', 'skills');

function parseFrontmatter(md) {
  const text = String(md || '').replace(/^\uFEFF/, '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fm = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 1) continue;
      fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return { fm, body: m ? text.slice(m[0].length) : text };
}
function loadSkillFile(file, source, fallbackName) {
  let md = '';
  try { md = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const { fm, body } = parseFrontmatter(md);
  const name = String(fm.name || fallbackName || path.basename(path.dirname(file))).trim();
  const description = String(fm.description || '').trim();
  if (!description && !fm.name) return null;
  return {
    name,
    description,
    path: file,
    dir: path.dirname(file),
    source,
    license: fm.license || '',
    compatibility: fm.compatibility || '',
    body,
  };
}
function walkSkillDir(root, source, out, depth = 0) {
  if (depth > 5 || !root) return;
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  const isPiRoot = source === 'pi' || source === 'project-pi';
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      const skillMd = path.join(full, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        const s = loadSkillFile(skillMd, source, e.name);
        if (s) out.push(s);
      } else walkSkillDir(full, source, out, depth + 1);
    } else if (isPiRoot && depth === 0 && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'skill.md') {
      const s = loadSkillFile(full, source, e.name.replace(/\.md$/i, ''));
      if (s) out.push(s);
    }
  }
}
function listSkills(cwd) {
  const out = [];
  walkSkillDir(PI_SKILLS, 'pi', out);
  walkSkillDir(AGENTS_SKILLS, 'agents', out);
  if (cwd) {
    walkSkillDir(path.join(cwd, '.pi', 'skills'), 'project-pi', out);
    walkSkillDir(path.join(cwd, '.agents', 'skills'), 'project-agents', out);
  }
  const disabled = new Set(loadConfig().disabledSkills || []);
  const seen = new Set();
  const skills = [];
  for (const s of out) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    skills.push({ ...s, enabled: !disabled.has(s.name) });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, disabled: [...disabled] };
}
function skillArgsFor(cwd) {
  const { skills, disabled } = listSkills(cwd);
  if (!disabled.length) return [];
  const args = ['--no-skills'];
  for (const s of skills) {
    if (s.enabled && s.path) args.push('--skill', s.path);
  }
  return args;
}
function copyIfExists(src, dest) {
  try {
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
  } catch { return false; }
}
function runPs(command) {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', (e) => resolve({ code: -1, out: '', err: e.message }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}
async function exportBackupZip() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-bak-'));
  const destDir = path.join(CFG_DIR, 'exports');
  fs.mkdirSync(destDir, { recursive: true });
  const zipPath = path.join(destDir, `pi-workbench-backup-${stamp}.zip`);
  const packed = [];
  if (copyIfExists(CFG_FILE, path.join(tmp, 'workbench', 'config.json'))) packed.push('workbench/config.json');
  if (copyIfExists(ROUTING_FILE, path.join(tmp, 'workbench', 'routing.json'))) packed.push('workbench/routing.json');
  if (copyIfExists(PI_MODELS, path.join(tmp, 'pi-agent', 'models.json'))) packed.push('pi-agent/models.json');
  if (copyIfExists(PI_SETTINGS, path.join(tmp, 'pi-agent', 'settings.json'))) packed.push('pi-agent/settings.json');
  const { skills } = listSkills(null);
  fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({
    app: 'pi-workbench', version: '0.2.0', at: new Date().toISOString(), packed, skills: skills.map((s) => s.name),
  }, null, 2));
  packed.push('manifest.json');
  const r = await runPs(`Compress-Archive -Path ${psQuote(path.join(tmp, '*'))} -DestinationPath ${psQuote(zipPath)} -Force`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  if (r.code !== 0 || !fs.existsSync(zipPath)) throw new Error(r.err || r.out || 'zip failed');
  return { path: zipPath, packed, size: fs.statSync(zipPath).size };
}
async function importBackupZip(zipPath) {
  if (!zipPath || !fs.existsSync(zipPath) || !zipPath.toLowerCase().endsWith('.zip')) throw new Error('需要本地 .zip 路径');
  const pre = path.join(CFG_DIR, 'backups', 'pre-import-' + Date.now());
  fs.mkdirSync(pre, { recursive: true });
  copyIfExists(CFG_FILE, path.join(pre, 'config.json'));
  copyIfExists(ROUTING_FILE, path.join(pre, 'routing.json'));
  copyIfExists(PI_MODELS, path.join(pre, 'models.json'));
  copyIfExists(PI_SETTINGS, path.join(pre, 'settings.json'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-imp-'));
  const r = await runPs(`Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(tmp)} -Force`);
  if (r.code !== 0) throw new Error(r.err || r.out || 'unzip failed');
  const restored = [];
  if (copyIfExists(path.join(tmp, 'workbench', 'config.json'), CFG_FILE)) restored.push('config.json');
  if (copyIfExists(path.join(tmp, 'workbench', 'routing.json'), ROUTING_FILE)) restored.push('routing.json');
  if (copyIfExists(path.join(tmp, 'pi-agent', 'models.json'), PI_MODELS)) restored.push('models.json');
  if (copyIfExists(path.join(tmp, 'pi-agent', 'settings.json'), PI_SETTINGS)) restored.push('settings.json');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  return { restored, backup: pre };
}
function countFiles(root, ext, max = 400) {
  let n = 0;
  const walk = (d, depth) => {
    if (n >= max || depth > 4) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (n >= max) return;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (!ext || e.name.toLowerCase().endsWith(ext)) n++;
    }
  };
  walk(root, 0);
  return n;
}
function migrateScan() {
  const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
  const sources = [
    { id: 'models', name: '模型与密钥', path: PI_MODELS, found: exists(PI_MODELS), detail: exists(PI_MODELS) ? '已有 models.json' : '还没有 models.json' },
    { id: 'routing', name: '回退路由', path: ROUTING_FILE, found: exists(ROUTING_FILE), detail: exists(ROUTING_FILE) ? '已有 routing.json' : '还没有 routing.json' },
    { id: 'skills', name: '技能', path: PI_SKILLS, found: listSkills(null).skills.length > 0, detail: `${listSkills(null).skills.length} 个已发现` },
    { id: 'codex', name: 'Codex 会话', path: CODEX_SESSIONS, found: exists(CODEX_SESSIONS), detail: exists(CODEX_SESSIONS) ? `${countFiles(CODEX_SESSIONS, '.jsonl')} 个 jsonl` : '未安装' },
    { id: 'claude', name: 'Claude 会话', path: CLAUDE_PROJECTS, found: exists(CLAUDE_PROJECTS), detail: exists(CLAUDE_PROJECTS) ? `${countFiles(CLAUDE_PROJECTS, '.jsonl')} 个 jsonl` : '未安装' },
    { id: 'zcode', name: 'ZCode 会话', path: path.join(HOME, '.zcode'), found: exists(path.join(HOME, '.zcode')), detail: exists(path.join(HOME, '.zcode')) ? '本机有 .zcode 目录' : '未安装' },
  ];
  return { sources };
}
function openExternalTerm(cwd) {
  const dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
  spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', 'cmd.exe', '/K', `cd /d "${dir}"`], { windowsHide: true, cwd: dir });
  return { ok: true, cwd: dir };
}
function execInCwd(cwd, cmd) {
  const dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
  return new Promise((resolve) => {
    const p = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd], { cwd: dir, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (c) => { if (out.length < 200000) out += c; });
    p.stderr.on('data', (c) => { if (err.length < 40000) err += c; });
    p.on('error', (e) => resolve({ code: -1, out: '', err: e.message, cwd: dir }));
    p.on('close', (code) => resolve({ code, out, err, cwd: dir }));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p === '/api/config') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const cfg = loadConfig();
        const next = { ...cfg, ...body };
        saveConfig(next);
        return json(res, 200, next);
      }
      return json(res, 200, loadConfig());
    }
    if (p === '/api/projects/add' && req.method === 'POST') {
      const { path: dir, name } = await readBody(req);
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return json(res, 400, { error: 'invalid dir' });
      const cfg = loadConfig();
      if (!cfg.projects.some((x) => projectKey(x.path) === projectKey(dir))) {
        cfg.projects.push({ path: path.resolve(dir), name: name || path.basename(dir) });
        saveConfig(cfg);
      }
      return json(res, 200, cfg);
    }
    if (p === '/api/projects/remove' && req.method === 'POST') {
      const { path: dir } = await readBody(req);
      const cfg = loadConfig();
      cfg.projects = cfg.projects.filter((x) => path.resolve(x.path) !== path.resolve(dir));
      saveConfig(cfg);
      return json(res, 200, cfg);
    }
    if (p === '/api/sessions/pi') {
      const cwdQ = u.searchParams.get('cwd');
      const files = listJsonFiles(PI_SESSIONS, 2);
      const items = files.map(piSessionInfo).filter((s) => !cwdQ || (s.cwd && path.resolve(s.cwd) === path.resolve(cwdQ)));
      items.sort((a, b) => b.mtime - a.mtime);
      return json(res, 200, { sessions: items.slice(0, 300) });
    }
    if (p === '/api/sessions/delete' && req.method === 'POST') {
      const { path: file } = await readBody(req);
      const root = path.resolve(PI_SESSIONS);
      const abs = path.resolve(String(file || ''));
      if (!abs.startsWith(root + path.sep) || !abs.toLowerCase().endsWith('.jsonl')) return json(res, 400, { error: 'bad path' });
      if (!fs.existsSync(abs)) return json(res, 404, { error: 'not found' });
      fs.rmSync(abs, { force: true });
      return json(res, 200, { ok: true, deleted: abs });
    }
    if (p === '/api/models') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        fs.mkdirSync(path.dirname(PI_MODELS), { recursive: true });
        fs.writeFileSync(PI_MODELS, JSON.stringify(body, null, 2));
      }
      return json(res, 200, readJson(PI_MODELS) || { providers: {} });
    }
    if (p === '/api/models/available') {
      // short-lived rpc to enumerate models (uses pi's own catalog + models.json)
      const proc = spawn(process.execPath, [PI_CLI, '--mode', 'rpc', '--no-session'], { cwd: HOME, env: { ...process.env, ...SECRET_ENV }, windowsHide: true });
      const result = await new Promise((resolve) => {
        let buf = ''; const to = setTimeout(() => { try { proc.kill(); } catch {} resolve({ models: [] }); }, 20000);
        proc.stdout.on('data', (c) => {
          buf += c.toString('utf8');
          let i;
          while ((i = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
            let ev; try { ev = JSON.parse(line); } catch { continue; }
            if (ev.type === 'response' && ev.command === 'get_available_models') { clearTimeout(to); try { proc.kill(); } catch {}; resolve(ev.data || { models: [] }); }
          }
        });
        proc.on('error', () => { clearTimeout(to); resolve({ models: [] }); });
        proc.stdin.write(JSON.stringify({ id: 'm1', type: 'get_available_models' }) + '\n');
      });
      return json(res, 200, result);
    }
    if (p === '/api/providers/discover' && req.method === 'POST') {
      const { provider, baseUrl, apiKey } = await readBody(req);
      let url = baseUrl;
      let key = apiKey || null;
      if ((!url || !key) && provider) {
        const models = readJson(PI_MODELS) || { providers: {} };
        const pv = models.providers?.[provider] || {};
        if (!url) url = pv.baseUrl;
        if (!key) {
          const ov = envOverrideFor(provider);
          key = ov ? Object.values(ov).find((v) => typeof v === 'string') : null;
          if (!key && hasLiteralKey(provider)) key = pv.apiKey;
        }
      }
      if (!url) return json(res, 200, { ok: false, detail: '请先填 API 地址' });
      try {
        const t0 = Date.now();
        const r = await fetch(url.replace(/\/$/, '') + '/models', {
          headers: key ? { authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return json(res, 200, { ok: false, status: r.status, ms: Date.now() - t0 });
        const j = await r.json().catch(() => ({}));
        const ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
        return json(res, 200, { ok: true, ms: Date.now() - t0, models: ids });
      } catch (e) {
        return json(res, 200, { ok: false, detail: String(e.message || e) });
      }
    }
    if (p === '/api/providers/test' && req.method === 'POST') {
      const { model } = await readBody(req);
      if (!model) return json(res, 200, { ok: false, detail: 'model required' });
      return json(res, 200, await testModelReply(model));
    }
    if (p === '/api/routing') {
      const routing = loadRouting();
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (Array.isArray(body.chains)) routing.chains = body.chains;
        if (body.providers && typeof body.providers === 'object') {
          for (const [name, meta] of Object.entries(body.providers)) {
            const cur = routing.providers[name] = routing.providers[name] || {};
            if (typeof meta.enabled === 'boolean') cur.enabled = meta.enabled;
            if (Number.isFinite(meta.priority)) cur.priority = meta.priority;
            if (Array.isArray(meta.keyEnvs)) cur.keyEnvs = meta.keyEnvs.map(String);
            if (typeof meta.testModel === 'string') cur.testModel = meta.testModel;
          }
        }
        saveRouting(routing);
      }
      const models = readJson(PI_MODELS) || { providers: {} };
      const names = [...new Set([...Object.keys(models.providers || {}), ...Object.keys(routing.providers)])];
      const providers = names.map((name) => {
        const rc = routing.providers[name] || {};
        const cd = providerCooled(name);
        return {
          name,
          enabled: rc.enabled !== false,
          priority: rc.priority || 1,
          testModel: rc.testModel || null,
          keyEnvs: keyEnvsFor(name),
          keyCount: keyEnvsFor(name).length || (hasLiteralKey(name) ? 1 : 0),
          cooldown: cd ? { until: cd.until, remainMs: Math.max(0, cd.until - Date.now()), error: cd.error || null } : null,
        };
      });
      return json(res, 200, { chains: routing.chains, providers });
    }
    if (p === '/api/routing/probe' && req.method === 'POST') {
      const { model } = await readBody(req);
      if (!model) return json(res, 400, { ok: false, detail: 'model required' });
      return json(res, 200, await probeModel(model));
    }
    if (p === '/api/routing/fail' && req.method === 'POST') {
      const { model, error, tabId } = await readBody(req);
      const [prov] = splitModel(model);
      if (!prov) return json(res, 400, { error: 'bad model' });
      const tab = tabId ? tabs.get(tabId) : null;
      const msg = String(error || '');
      // auth-ish failures rotate the key; other failures cool the model (omp-style chain step)
      if (/401|403|unauthorized|invalid[ _-]*(api[ _-]*)?key|forbidden/i.test(msg)) {
        coolKey(prov, tab && tab.routeKeyIdx != null ? tab.routeKeyIdx : 0, msg, 300);
      } else {
        coolModel(model, msg, 120);
      }
      return json(res, 200, { next: nextInChain(model), cooldown: modelCooled(model) || providerCooled(prov) });
    }
    if (p === '/api/routing/ok' && req.method === 'POST') {
      const { model } = await readBody(req);
      if (model) clearCool(model);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/usage') {
      return json(res, 200, usageSummary());
    }
    if (p === '/api/session/tree') {
      const f = u.searchParams.get('path');
      const tree = sessionTree(f);
      return tree ? json(res, 200, tree) : json(res, 400, { error: 'bad path or unreadable session' });
    }
    if (p === '/api/files/list') {
      const root = u.searchParams.get('root');
      const rel = u.searchParams.get('path') || '';
      const cfgc = loadConfig();
      const known = (cfgc.projects || []).some((pr) => path.resolve(pr.path) === path.resolve(root || ''));
      if (!root || !known) return json(res, 400, { error: 'unknown project root' });
      const base = path.resolve(root, rel);
      if (!base.startsWith(path.resolve(root))) return json(res, 400, { error: 'bad path' });
      let entries;
      try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { return json(res, 400, { error: e.message }); }
      const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__']);
      const items = entries.filter((e) => !skip.has(e.name)).map((e) => {
        let size = 0, mtime = 0;
        let isDir = e.isDirectory();
        try { const st = fs.statSync(path.join(base, e.name)); size = st.size; mtime = st.mtimeMs; } catch {}
        return { name: e.name, dir: isDir, size, mtime };
      });
      items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
      return json(res, 200, { cwd: base, items: items.slice(0, 500) });
    }
    if (p === '/api/files/read') {
      const root = u.searchParams.get('root');
      const rel = u.searchParams.get('path') || '';
      const cfgc = loadConfig();
      const known = (cfgc.projects || []).some((pr) => path.resolve(pr.path) === path.resolve(root || ''));
      if (!root || !known) return json(res, 400, { error: 'unknown project root' });
      const base = path.resolve(root, rel);
      if (!base.startsWith(path.resolve(root))) return json(res, 400, { error: 'bad path' });
      let st; try { st = fs.statSync(base); } catch { return json(res, 400, { error: 'not found' }); }
      if (st.isDirectory()) return json(res, 400, { error: 'is a directory' });
      if (st.size > 400000) return json(res, 200, { text: '', tooBig: true, size: st.size });
      try { return json(res, 200, { text: fs.readFileSync(base, 'utf8').slice(0, 200000) }); }
      catch { return json(res, 200, { text: '', tooBig: false, binary: true }); }
    }
    if (p === '/api/kernel') {
      const piPkg = readJson(path.join(__dirname, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json')) || {};
      return json(res, 200, {
        node: process.version,
        platform: process.platform + ' ' + process.arch,
        execPath: process.execPath,
        uptimeSec: Math.round(process.uptime()),
        port: PORT,
        pi: piPkg.version || null,
        secrets: { relay: !!Object.keys(SECRET_ENV).length },
        paths: {
          config: CFG_FILE,
          routing: ROUTING_FILE,
          models: PI_MODELS,
          sessions: PI_SESSIONS,
          server: path.join(__dirname, 'server.mjs'),
        },
      });
    }
    if (p === '/api/env') {
      const gitVer = await new Promise((resolve) => {
        const g = spawn('git', ['--version'], { windowsHide: true });
        let o = '';
        g.stdout.on('data', (c) => { o += c; });
        g.on('error', () => resolve(null));
        g.on('close', () => resolve(o.trim() || null));
      });
      const providers = Object.keys((readJson(PI_MODELS) || { providers: {} }).providers || {});
      return json(res, 200, {
        platform: process.platform + ' ' + process.arch,
        node: process.version,
        git: gitVer,
        providers,
        secrets: { relay: !!Object.keys(SECRET_ENV).length },
        uptimeSec: Math.round(process.uptime()),
      });
    }
    const mImport = p.match(/^\/api\/import\/(codex|claude|zcode|opencode|omp|gemini|grok|aider)(\/read)?$/);
    if (mImport) {
      const imp = IMPORT_SOURCES[mImport[1]];
      if (mImport[2]) {
        const f = u.searchParams.get('path');
        if (!f || (imp.root && !path.resolve(f).startsWith(path.resolve(imp.root)))) return json(res, 400, { error: 'bad path' });
        if (!imp.root && !(f || '').startsWith('opencode://')) return json(res, 400, { error: 'bad path' });
        return json(res, 200, { entries: imp.read(f) });
      }
      return json(res, 200, { sessions: await imp.list() });
    }
    if (p === '/api/git/status') {
      const cwd = u.searchParams.get('cwd');
      const r = await runGit(cwd, ['status', '--porcelain=v1', '-b'], 100000);
      return json(res, 200, r);
    }
    if (p === '/api/git/diff') {
      const cwd = u.searchParams.get('cwd');
      const r = await runGit(cwd, ['diff', 'HEAD'], 300000);
      return json(res, 200, r);
    }
    if (p === '/api/git/worktrees') {
      const cwd = u.searchParams.get('cwd');
      const r = await runGit(cwd, ['worktree', 'list', '--porcelain']);
      return json(res, 200, r);
    }
    if (p === '/api/skills') {
      const cwd = u.searchParams.get('cwd') || null;
      if (req.method === 'POST') {
        const body = await readBody(req);
        const cfg = loadConfig();
        const disabled = new Set(cfg.disabledSkills || []);
        if (body.name) {
          if (body.enabled === false) disabled.add(body.name);
          else disabled.delete(body.name);
        }
        cfg.disabledSkills = [...disabled];
        saveConfig(cfg);
      }
      return json(res, 200, listSkills(cwd));
    }
    if (p === '/api/mcp/config') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const servers = body.mcpServers;
        if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return json(res, 400, { error: 'mcpServers object required' });
        for (const [name, s] of Object.entries(servers)) {
          if (!s || typeof s !== 'object' || !s.command) return json(res, 400, { error: `server "${name}" needs a command` });
        }
        fs.mkdirSync(path.dirname(MCP_FILE), { recursive: true });
        fs.writeFileSync(MCP_FILE, JSON.stringify({ mcpServers: servers }, null, 2));
      }
      return json(res, 200, readJson(MCP_FILE) || { mcpServers: {} });
    }
    if (p === '/api/mcp/install' && req.method === 'POST') {
      const srcDir = path.join(__dirname, 'extensions');
      const bridge = path.join(srcDir, 'mcp-bridge.js');
      if (!fs.existsSync(bridge)) return json(res, 404, { error: 'bridge file missing' });
      const destDir = path.join(HOME, '.pi', 'agent', 'extensions', 'mcp-bridge');
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(bridge, path.join(destDir, 'mcp-bridge.js'));
      fs.copyFileSync(path.join(srcDir, 'package.json'), path.join(destDir, 'package.json'));
      // typebox is resolved from the extension's own node_modules (pi documents this flow)
      const hasDep = fs.existsSync(path.join(destDir, 'node_modules', 'typebox'));
      if (!hasDep) {
        const r = await execInCwd(destDir, 'npm install --omit=dev --no-fund --no-audit');
        if (r.code !== 0 || !fs.existsSync(path.join(destDir, 'node_modules', 'typebox'))) {
          return json(res, 500, { error: 'npm install typebox failed', detail: (r.err || r.out || '').slice(-800) });
        }
      }
      return json(res, 200, { ok: true, dest: destDir });
    }
    if (p === '/api/backup/export' && req.method === 'POST') {
      try { return json(res, 200, await exportBackupZip()); }
      catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/backup/import' && req.method === 'POST') {
      const { path: zipPath } = await readBody(req);
      try { return json(res, 200, await importBackupZip(zipPath)); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/migrate/scan') {
      return json(res, 200, migrateScan());
    }
    if (p === '/api/term/open' && req.method === 'POST') {
      const { cwd } = await readBody(req);
      return json(res, 200, openExternalTerm(cwd));
    }
    if (p === '/api/term/exec' && req.method === 'POST') {
      const { cwd, cmd } = await readBody(req);
      if (!cmd || typeof cmd !== 'string' || cmd.length > 4000) return json(res, 400, { error: 'bad cmd' });
      return json(res, 200, await execInCwd(cwd, cmd));
    }
    if (p.startsWith('/vendor/') || p === '/' || p.endsWith('.html') || p.endsWith('.css') || p.endsWith('.js') || p.endsWith('.svg') || p.endsWith('.png')) {
      let f = p === '/' ? '/index.html' : p;
      f = path.join(PUBLIC_DIR, path.normalize(f).replace(/^([.][.][/\\])+/, ''));
      if (!f.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
      try {
        const data = fs.readFileSync(f);
        const ext = path.extname(f);
        const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'content-type': mime });
        return res.end(data);
      } catch { res.writeHead(404); return res.end('not found'); }
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else socket.destroy();
});

resolveSecrets();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`pi-workbench listening on http://127.0.0.1:${PORT}`);
  // warm the codex list cache in the background so the first UI click is instant
  setTimeout(() => {
    try {
      const r = IMPORT_SOURCES.codex.list();
      if (r && typeof r.catch === 'function') r.catch((e) => logErr('codex warmup: ' + (e && e.message || e)));
    } catch (e) { logErr('codex warmup: ' + (e && e.message || e)); }
  }, 3000);
});
