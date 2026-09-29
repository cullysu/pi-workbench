#!/usr/bin/env node
// pi-workbench server — local workbench shell around the pi coding agent.
// Spawns `pi --mode rpc` (JSONL over stdio, per pi docs), never reimplements the agent.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {ledger} from './ledger.mjs';
import {pathToFileURL} from 'node:url';
import {cronPiArgs} from './lib/cron-args.mjs';
import {createCron} from './lib/cron.mjs';
import {createFailover} from './lib/failover.mjs';
import {createSources} from './lib/sources.mjs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createZip, readZip } from './zip.mjs';

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
const saveJson = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return obj;
};
// ---------- cron: scheduled pi prompt runs (lib/cron.mjs) ----------
const CRON_FILE = path.join(CFG_DIR, 'cron.json');
const CRON_RUNS_DIR = path.join(CFG_DIR, 'cron-runs');
const cron = createCron({ CRON_FILE, CRON_RUNS_DIR, HOME, SECRET_ENV, PI_CLI, cronPiArgs, broadcast, readJson, saveJson, spawn });
function saveRouting(r) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(ROUTING_FILE, JSON.stringify(r, null, 2));
  return r;
}
const failover = createFailover({ SECRET_ENV, readJson, saveJson, logErr, loadRouting, saveRouting });
const { splitModel, keyEnvsFor, hasLiteralKey, keyValue, providerHasKey, pickKey, coolModel, coolKey, clearCool, modelCooled, providerCooled, envOverrideFor, nextInChain } = failover;

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

const OMP_SESSIONS = path.join(HOME, '.omp', 'agent', 'sessions');
const GROK_DIR = path.join(HOME, '.grok');
const sources = createSources({ PI_SESSIONS, CODEX_SESSIONS, CLAUDE_PROJECTS, OMP_SESSIONS, GROK_DIR, HOME, readJson, logErr, DatabaseSync, kbPrice, loadConfig });
const { IMPORT_SOURCES, usageSummary, sessionTree, piSessionInfo, codexSessionInfo, claudeSessionInfo, claudeSessionRead, listJsonFiles, firstLines } = sources;
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
const MODEL_KB_FILE = path.join(__dirname, 'data', 'models-kb.json');
const MODEL_META_FILE = path.join(CFG_DIR, 'model-meta.json');
const MODEL_KB = readJson(MODEL_KB_FILE) || { models: {}, family: {} };

// Look up a model id in the knowledge base. Exact id first (with common suffixes
// stripped), then longest family-prefix match. Family matches carry structure
// (context window / max output) but never invented pricing.
function kbLookup(modelId) {
  let id = String(modelId || '').toLowerCase();
  if (id.includes('/')) id = id.slice(id.lastIndexOf('/') + 1);
  id = id.replace(/:latest$/, '').replace(/:free$/, '').replace(/:beta$/, '');
  const exact = MODEL_KB.models[id];
  if (exact) return { ...exact, source: 'exact' };
  const dated = id.replace(/-\d{8}$/, '');
  if (dated !== id && MODEL_KB.models[dated]) return { ...MODEL_KB.models[dated], source: 'exact' };
  let best = null;
  for (const [prefix, meta] of Object.entries(MODEL_KB.family || {})) {
    if (id.startsWith(prefix) && (!best || prefix.length > best._len)) best = { ...meta, _len: prefix.length };
  }
  if (best) return { ctx: best.ctx, max: best.max, price: best.price, source: 'family' };
  return null;
}
function kbPrice(modelId) {
  const hit = kbLookup(modelId);
  if (hit && hit.price && hit.price.cur === 'usd') return hit.price;
  return null;
}
function loadModelMeta() {
  return readJson(MODEL_META_FILE) || {};
}
function saveModelMeta(meta) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(MODEL_META_FILE, JSON.stringify(meta, null, 2));
}
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
async function exportBackupZip() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const destDir = path.join(CFG_DIR, 'exports');
  fs.mkdirSync(destDir, { recursive: true });
  const zipPath = path.join(destDir, `pi-workbench-backup-${stamp}.zip`);
  const entries = [];
  const add = (name, src) => {
    try {
      if (fs.existsSync(src)) entries.push({ name, data: fs.readFileSync(src) });
    } catch {}
  };
  add('workbench/config.json', CFG_FILE);
  add('workbench/routing.json', ROUTING_FILE);
  add('pi-agent/models.json', PI_MODELS);
  add('workbench/cron.json', CRON_FILE);
  add('workbench/model-meta.json', MODEL_META_FILE);
  add('pi-agent/settings.json', PI_SETTINGS);
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify({
    app: 'pi-workbench', version: '0.3.0', at: new Date().toISOString(), packed: entries.map((e) => e.name),
    skills: listSkills(null).skills.map((s) => s.name),
  }, null, 2)) });
  const zip = createZip(entries);
  fs.writeFileSync(zipPath, zip);
  return { path: zipPath, packed: entries.map((e) => e.name), size: zip.length };
}
async function importBackupZip(zipPath) {
  if (!zipPath || !fs.existsSync(zipPath) || !zipPath.toLowerCase().endsWith('.zip')) throw new Error('需要本地 .zip 路径');
  const pre = path.join(CFG_DIR, 'backups', 'pre-import-' + Date.now());
  fs.mkdirSync(pre, { recursive: true });
  copyIfExists(CFG_FILE, path.join(pre, 'config.json'));
  copyIfExists(ROUTING_FILE, path.join(pre, 'routing.json'));
  copyIfExists(PI_MODELS, path.join(pre, 'models.json'));
  copyIfExists(PI_SETTINGS, path.join(pre, 'settings.json'));
  const entries = readZip(fs.readFileSync(zipPath));
  const byName = new Map(entries.map((e) => [e.name.split('\\').join('/'), e.data]));
  const targets = [
    ['workbench/config.json', CFG_FILE, 'config.json'],
    ['workbench/routing.json', ROUTING_FILE, 'routing.json'],
    ['workbench/cron.json', CRON_FILE, 'cron.json'],
    ['workbench/model-meta.json', MODEL_META_FILE, 'model-meta.json'],
    ['pi-agent/models.json', PI_MODELS, 'models.json'],
    ['pi-agent/settings.json', PI_SETTINGS, 'settings.json'],
  ];
  const restored = [];
  for (const [name, dest, label] of targets) {
    if (byName.has(name)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, byName.get(name));
      restored.push(label);
    }
  }
  if (!restored.length) throw new Error('压缩包里没有可识别的备份文件');
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
  const isWin = process.platform === 'win32';
  const exe = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  const args = isWin ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
  return new Promise((resolve) => {
    const p = spawn(exe, args, { cwd: dir, windowsHide: true });
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
    if (p.startsWith('/api/') && p !== '/api/token') {
      const token = req.headers['x-api-token'];
      if (token !== API_TOKEN) { res.writeHead(403); return res.end('forbidden'); }
    }
    if (p === '/api/ledger') {
      const q = new URL(req.url, 'http://x').searchParams;
      const days = Math.min(365, Math.max(1, Number(q.get('days') || 30)));
      return json(res, 200, ledger({days}));
    }
    if (p === '/api/engines' && req.method === 'GET') {
      const {execSync} = await import('node:child_process');
      const engines = {};
      for (const e of ['codex', 'zcode', 'claude']) {
        try { engines[e] = {ok: true, ver: execSync(`${e} --version 2>nul`, {encoding: 'utf8', timeout: 8000}).trim().slice(0, 60)}; }
        catch { engines[e] = {ok: false}; }
      }
      return json(res, 200, engines);
    }
    function resolveEngineCmd(name) {
      // 解析 npm 全局 .cmd shim 指向的真实 JS 入口：node 直启 + 参数数组，无 cmd.exe 注入面
      try {
        const {execSync} = require('node:child_process');
        const nl = String.fromCharCode(13, 10);
        const where = execSync(`where ${name}`, {encoding: 'utf8', timeout: 5000}).split(nl).find((l) => l.trim().toLowerCase().endsWith('.cmd'));
        if (!where) return null;
        const cmdBody = fs.readFileSync(where.trim(), 'utf8');
        const m = cmdBody.match(/"%~dp0(\\[^"]*\.js)"\s*%\*/);
        if (!m) return null;
        return path.join(path.dirname(where.trim()), m[1]);
      } catch { return null; }
    }
    if (p === '/api/engines/run' && req.method === 'POST') {
      const {engine, prompt, cwd} = await readBody(req);
      if (!['codex', 'zcode', 'claude'].includes(engine) || !prompt || typeof prompt !== 'string' || prompt.length > 8000) return json(res, 400, {error: 'bad engine/prompt'});
      const jsPath = resolveEngineCmd(engine);
      if (!jsPath) return json(res, 503, {error: engine + ' CLI not installed'});
      const args = engine === 'codex' ? ['exec', prompt, '--json', '--skip-git-repo-check', '-C', cwd || '.']
                 : engine === 'zcode' ? ['-p', prompt, '--output-format', 'json']
                 : ['-p', prompt, '--output-format', 'json'];
      const {spawn} = await import('node:child_process');
      // node.exe + 参数数组 + shell:false = CreateProcess 直启，无命令注入面
      const child = spawn(process.execPath, [jsPath, ...args], {cwd: cwd || '.', shell: false, windowsHide: true});
      let out = '', err = '';
      const kill = setTimeout(() => { try { child.kill(); } catch {} }, 600000);
      child.stdout.on('data', (c) => { out += c; if (out.length > 2e6) out = out.slice(-1e6); });
      child.stderr.on('data', (c) => { err += c; if (err.length > 2e5) err = err.slice(-1e5); });
      child.on('error', (e) => { clearTimeout(kill); return json(res, 500, {error: String(e)}); });
      child.on('close', (code) => {
        clearTimeout(kill);
        if (res.headersSent) return;
        let usage = null, last = '';
        for (const line of out.split('\n')) {
          let j = null; try { j = JSON.parse(line); } catch { continue; }
          const u = j.usage ?? j.info?.total_token_usage ?? null;
          if (u) usage = u;
          if (j.type === 'item.completed' && j.item?.text) last = j.item.text;
          if (j.result) last = typeof j.result === 'string' ? j.result : last;
          if (j.is_error) err = String(j.result ?? err);
        }
        return json(res, 200, {code, usage, last: last.slice(0, 4000), err: err.slice(-800)});
      });
      return;
    }
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
        const { meta: _ignored, ...doc } = body; // meta lives in model-meta.json, never in models.json
        fs.mkdirSync(path.dirname(PI_MODELS), { recursive: true });
        fs.writeFileSync(PI_MODELS, JSON.stringify(doc, null, 2));
      }
      return json(res, 200, { ...(readJson(PI_MODELS) || { providers: {} }), meta: loadModelMeta() });
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
        const kb = {};
        for (const id of ids) {
          const hit = kbLookup(id);
          if (hit) kb[id] = hit;
        }
        return json(res, 200, { ok: true, ms: Date.now() - t0, models: ids, kb });
      } catch (e) {
        return json(res, 200, { ok: false, detail: String(e.message || e) });
      }
    }
    if (p === '/api/providers/kbfill' && req.method === 'POST') {
      const { provider } = await readBody(req);
      const doc = readJson(PI_MODELS) || { providers: {} };
      const pv = doc.providers?.[provider];
      if (!pv || !Array.isArray(pv.models)) return json(res, 400, { error: 'unknown provider or empty model list' });
      const fills = {};
      const pricing = {};
      let n = 0;
      for (const m of pv.models) {
        const hit = kbLookup(m.id);
        if (!hit) continue;
        if ((!m.contextWindow || m.contextWindow === 128000) && hit.ctx) {
          m.contextWindow = hit.ctx;
          (fills[m.id] = fills[m.id] || {}).contextWindow = hit.ctx;
        }
        if ((!m.maxTokens || m.maxTokens === 4096) && hit.max) {
          m.maxTokens = hit.max;
          (fills[m.id] = fills[m.id] || {}).maxTokens = hit.max;
        }
        if (hit.price) {
          pricing[m.id] = hit.price;
          n++;
        }
      }
      fs.mkdirSync(path.dirname(PI_MODELS), { recursive: true });
      fs.writeFileSync(PI_MODELS, JSON.stringify(doc, null, 2));
      const meta = loadModelMeta();
      for (const [id, price] of Object.entries(pricing)) meta[`${provider}|${id}`] = price;
      saveModelMeta(meta);
      return json(res, 200, { fills, pricing, priced: n });
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
    if (p === '/api/cron') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const jobs = body.jobs;
        if (!Array.isArray(jobs)) return json(res, 400, { error: 'jobs array required' });
        for (const j of jobs) {
          if (!j.name || !j.prompt) return json(res, 400, { error: '每个任务需要 name 和 prompt' });
          if (j.kind === 'daily' && !/^\d{2}:\d{2}$/.test(j.time || '')) return json(res, 400, { error: 'daily 任务需要 HH:MM 时间' });
          if (j.kind === 'interval' && (!(Number(j.everyMin) > 0))) return json(res, 400, { error: 'interval 任务需要正的 everyMin 分钟数' });
        }
        const prev = readJson(CRON_FILE) || { jobs: [] };
        for (const j of jobs) {
          const old = prev.jobs.find((x) => x.id === j.id);
          if (old) { j.lastRun = old.lastRun; j.lastStatus = old.lastStatus; j.lastOutput = old.lastOutput; }
          if (!j.id) j.id = 'job-' + crypto.randomBytes(4).toString('hex');
          if (typeof j.enabled !== 'boolean') j.enabled = true;
        }
        saveJson(CRON_FILE, { jobs });
      }
      const d = readJson(CRON_FILE) || { jobs: [] };
      if (cron.bootReset(d)) saveJson(CRON_FILE, d);
      return json(res, 200, d);
    }
    if (p === '/api/cron/delete' && req.method === 'POST') {
      const { id } = await readBody(req);
      const d = readJson(CRON_FILE) || { jobs: [] };
      d.jobs = d.jobs.filter((j) => j.id !== id);
      saveJson(CRON_FILE, d);
      return json(res, 200, d);
    }
    if (p === '/api/update/check') {
      try {
        const r = await fetch('https://api.github.com/repos/cullysu/pi-workbench/releases/latest', { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'pi-workbench' } });
        const j = await r.json();
        return json(res, 200, { latest: j.tag_name || null, url: j.html_url || null });
      } catch (e) {
        return json(res, 200, { latest: null, error: String(e.message || e).slice(0, 100) });
      }
    }
    if (p === '/api/cron/logs' && req.method === 'POST') {
      const { id } = await readBody(req);
      const dir = path.join(CRON_RUNS_DIR, id);
      let runs = [];
      try {
        runs = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort().reverse().map((f) => {
          const full = path.join(dir, f);
          return { file: f, size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs };
        });
      } catch {}
      return json(res, 200, { runs });
    }
    if (p === '/api/cron/lastlog' && req.method === 'POST') {
      const { id } = await readBody(req);
      const dir = path.join(CRON_RUNS_DIR, id);
      let latest = null, mtime = 0;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.log')) continue;
          const full = path.join(dir, f);
          const m = fs.statSync(full).mtimeMs;
          if (m > mtime) { mtime = m; latest = full; }
        }
      } catch {}
      if (!latest) return json(res, 200, { content: '(no runs yet)' });
      return json(res, 200, { content: fs.readFileSync(latest, 'utf8').slice(-4000), file: latest });
    }
    if (p === '/api/session/export' && req.method === 'GET') {
      const root = path.resolve(PI_SESSIONS);
      const abs = path.resolve(u.searchParams.get('path') || '');
      if (!abs.startsWith(root + path.sep) || !abs.toLowerCase().endsWith('.jsonl')) { res.writeHead(400); return res.end('bad path'); }
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      const NL = '\n';  // 之前那行是字面反斜杠+n：按它切会把每行 JSON 从转义处切碎，导出恒为空
      for (const line of fs.readFileSync(abs, 'utf8').split(NL)) {
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.type !== 'message' || !j.message) continue;
        const m = j.message;
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const c = m.content;
        let text = '';
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c)) text = c.map((b) => {
          if (b.type === 'text') return b.text;
          if (b.type === 'toolCall') return '[' + (b.name || 'tool') + ']';
          if (b.type === 'thinking') return '[thinking]';
          return '';
        }).filter(Boolean).join(NL);
        if (!text.trim()) continue;
        res.write((m.role === 'user' ? '## User' + NL + NL : '## Assistant' + NL + NL) + text.trim() + NL + NL + '---' + NL);
      }
      return res.end();
    }
    if (p === '/api/cron/run-now' && req.method === 'POST') {
      const { id } = await readBody(req);
      const d = readJson(CRON_FILE) || { jobs: [] };
      const job = d.jobs.find((j) => j.id === id);
      if (!job) return json(res, 404, { error: 'job not found' });
      cron.runCronJob(job);
      saveJson(CRON_FILE, d);
      return json(res, 200, { ok: true, lastStatus: job.lastStatus });
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
    if (p === '/api/templates') {
      const out = [];
      const q = u.searchParams.get('cwd') || '';
      const dirs = [[path.join(HOME, '.pi', 'agent', 'prompts'), 'global']];
      if (q) dirs.push([path.join(q, '.pi', 'prompts'), 'project']);
      for (const [dir, source] of dirs) {
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
        for (const e of ents) {
          if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
          const full = path.join(dir, e.name);
          let raw = '';
          try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
          let desc = '';
          const di = raw.indexOf('description:');
          if (di >= 0) desc = raw.slice(di + 12, raw.indexOf(String.fromCharCode(10), di)).trim().slice(0, 120);
          if (!desc) desc = raw.replace(/^---/, '').trim().split(String.fromCharCode(10))[0].slice(0, 120);
          out.push({ name: e.name.replace(/.md$/i, ''), path: full, source, description: desc, body: raw.slice(0, 20000) });
        }
      }
      return json(res, 200, { templates: out });
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
        // npm install in background — the API returns immediately
        execInCwd(destDir, 'npm install --omit=dev --no-fund --no-audit');
      }
      return json(res, 200, { ok: true, dest: destDir, note: hasDep ? 'already installed' : 'npm install running in background' });
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
        let data = fs.readFileSync(f);
        const ext = path.extname(f);
        if (ext === '.html' || p === '/') {
          data = Buffer.from(data.toString('utf8').replace(
            '</head>',
            '<script>window.__API_TOKEN = ' + JSON.stringify(API_TOKEN) + '</scr' + 'ipt></head>'
          ));
        }
        const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }[ext] || 'application/octet-stream';
        // index.html embeds a per-boot token — a cached stale page would 403 itself dead
        const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
        res.writeHead(200, { 'content-type': mime, 'cache-control': (ext === '.html' || p === '/') ? 'no-store' : 'no-cache', 'content-security-policy': csp });
        return res.end(data);
      } catch { res.writeHead(404); return res.end('not found'); }
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(String(e.stack)); json(res, 500, { error: e.message });
  }
});

server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  // WS can't carry custom headers — token rides the ?t= query param instead
  if (pathname === '/ws' && searchParams.get('t') === API_TOKEN) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else socket.destroy();
});

resolveSecrets();

// HTTP token auth: any local process can hit 32123 without this — generate random
// token per startup, embed in HTML, require in X-Api-Token header for /api/* routes
const API_TOKEN = crypto.randomBytes(24).toString('hex');
globalThis.API_TOKEN = API_TOKEN;

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
console.error('[boot-debug] isMain=' + isMain, 'argv1=' + process.argv[1], 'meta=' + import.meta.url);
if (isMain) server.listen(PORT, '127.0.0.1', () => {
  console.log(`pi-workbench listening on http://127.0.0.1:${PORT}`);
  // warm the codex list cache in the background so the first UI click is instant
  setTimeout(() => {
    try {
      const r = IMPORT_SOURCES.codex.list();
      if (r && typeof r.catch === 'function') r.catch((e) => logErr('codex warmup: ' + (e && e.message || e)));
    } catch (e) { logErr('codex warmup: ' + (e && e.message || e)); }
  }, 3000);
});
