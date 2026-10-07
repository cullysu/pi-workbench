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
import { collectProc } from './lib/io.mjs';
import {createCron} from './lib/cron.mjs';
import {createFailover} from './lib/failover.mjs';
import {createSources} from './lib/sources.mjs';
import {createKbSkills} from './lib/kb-skills.mjs';
import {createBackupTerminal} from './lib/backup-terminal.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createZip, readZip } from './zip.mjs';

// soft node:sqlite import — Node < 22.13 has no such builtin and a static import
// would kill the whole boot; only the OpenCode importer degrades (sources guards null)
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {
  console.log(`[boot] node:sqlite unavailable on ${process.version} — OpenCode import disabled, everything else works`);
}

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
// HTTP token auth: any local process could hit the port — random per boot, embedded
// in the served HTML and required as x-api-token on /api/* routes
// Desktop shells bootstrap their own per-launch token via PIWB_TOKEN and inject it
// into the page out-of-band — the token never sits in the public HTML. Plain
// `node server.mjs` browser usage keeps the embedded mode via PIWB_EMBED_TOKEN=1
// (plus a 0600 token file for tooling). See the shell repos' main entry points.
const API_TOKEN = process.env.PIWB_TOKEN || crypto.randomBytes(24).toString('hex');
const TOKEN_EMBED = process.env.PIWB_EMBED_TOKEN === '1';
const TOKEN_FILE = path.join(CFG_DIR, 'token');
const HTML_NONCE = crypto.randomBytes(16).toString('base64'); // CSP script nonce for the injected token bootstrap
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
  } catch (e) {
    // a torn config must not vanish silently: preserve it for forensics, then fall back
    try {
      if (fs.existsSync(CFG_FILE) && fs.statSync(CFG_FILE).size > 0) {
        const keep = `${CFG_FILE}.corrupt-${Date.now()}`;
        fs.copyFileSync(CFG_FILE, keep);
        logErr(`config.json unreadable (${(e && e.message) || e}) — preserved as ${keep}`);
      }
    } catch { /* forensics are best-effort */ }
    return { projects: [], lang: 'zh', theme: 'dark' };
  }
}
function saveConfig(cfg) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  atomicWrite(CFG_FILE, JSON.stringify(cfg, null, 2));
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
const LOG_MAX_BYTES = 2 * 1024 * 1024;
let DEGRADED_AT = null; // set when an uncaughtException survives — /api/kernel surfaces it
// error messages can carry provider errors verbatim — never let a key fragment reach the disk
function redactSecrets(s) {
  return String(s)
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bp]-[A-Za-z0-9-]{10,}/g, '[redacted-token]')
    .replace(/Bearer [A-Za-z0-9._-]{8,}/g, 'Bearer ***');
}
function logErr(line) {
  try {
    fs.mkdirSync(CFG_DIR, { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch { /* rotation is best-effort */ }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${redactSecrets(line)}\n`);
  } catch { /* never let the error logger itself throw */ }
}
process.on('uncaughtException', (e) => { DEGRADED_AT = DEGRADED_AT || Date.now(); logErr('uncaughtException: ' + ((e && e.stack) || e)); });
process.on('unhandledRejection', (e) => logErr('unhandledRejection: ' + ((e && e.stack) || e)));

// DNS-rebinding armor: a browser-resolved evil.com -> 127.0.0.1 would arrive with a
// foreign Host header; the token already stops the API, this stops even the static page
const hostAllowed = (h) => h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}` || h === `[::1]:${PORT}`;

// ---------- helpers ----------
const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

// ---------- routing: fallback chains + per-key cooldowns/rotation ----------
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
  return r;
}
// atomic write: tmp+rename so a crash mid-write can never leave a torn config
// (Windows rename replaces existing files — no unlink dance needed)
const atomicWrite = (file, data) => {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch { /* best effort */ } } // workbench configs carry keys
};
const saveJson = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(obj, null, 2));
  return obj;
};
// ---------- cron: scheduled pi prompt runs (lib/cron.mjs) ----------
const CRON_FILE = path.join(CFG_DIR, 'cron.json');
const CRON_RUNS_DIR = path.join(CFG_DIR, 'cron-runs');
const cron = createCron({ CRON_FILE, CRON_RUNS_DIR, HOME, SECRET_ENV, PI_CLI, cronPiArgs, broadcast, readJson, saveJson, spawn });
function saveRouting(r) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  atomicWrite(ROUTING_FILE, JSON.stringify(r, null, 2));
  return r;
}
const failover = createFailover({ SECRET_ENV, readJson, loadRouting, saveRouting, PI_MODELS });
const { splitModel, keyEnvsFor, hasLiteralKey, coolModel, coolKey, clearCool, modelCooled, providerCooled, envOverrideFor, nextInChain } = failover;

// provider URLs are user-supplied: only http(s) may leave the box (no file:, ftp:, data:...)
// Local addresses stay allowed on purpose — ollama/LM Studio on 127.0.0.1 are first-class providers.
const assertHttpUrl = (raw) => {
  let parsed;
  try { parsed = new URL(String(raw || '')); } catch { return null; }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return null;
  return parsed;
};
// fetch + streaming size cap: a misbehaving endpoint must not balloon server memory
// (content-length alone is not enough — chunked responses omit it)
async function fetchJsonCapped(url, opts = {}, maxBytes = 2e6) {
  const r = await fetch(url, opts);
  let buf;
  if (r.body && typeof r.body.getReader === 'function') {
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { try { await reader.cancel(); } catch { /* already cancelled */ } throw new Error(`response too large (> ${maxBytes} bytes)`); }
      chunks.push(value);
    }
    buf = Buffer.concat(chunks);
  } else {
    buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`response too large (> ${maxBytes} bytes)`);
  }
  let j = {};
  try { j = JSON.parse(buf.toString('utf8')); } catch { j = {}; }
  return { r, j };
}

// per-protocol auth: anthropic wants x-api-key (+ version header), google wants
// x-goog-api-key, everything OpenAI-shaped speaks Bearer. api type comes from the
// provider config when known, otherwise it is sniffed from the hostname.
const isGoogleApi = (p, url) => p?.api === 'google-generative-ai' || /generativelanguage\.googleapis\.com/i.test(String(url || ''));
const isAnthropicApi = (p, url) => p?.api === 'anthropic-messages' || /api\.anthropic\.com/i.test(String(url || ''));
const authHeadersFor = (p, url, key, extra = {}) => {
  if (!key) return { ...extra };
  if (isGoogleApi(p, url)) return { ...extra, 'x-goog-api-key': key };
  if (isAnthropicApi(p, url)) return { ...extra, 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  return { ...extra, authorization: `Bearer ${key}` };
};
const modelsUrlFor = (p, url) => (isGoogleApi(p, url) ? String(url).replace(/\/$/, '') + '/v1beta/models' : String(url).replace(/\/$/, '') + '/models');

async function probeModel(modelId) {
  const [prov] = splitModel(modelId);
  const models = readJson(PI_MODELS) || { providers: {} };
  const p = models.providers?.[prov];
  if (!p?.baseUrl) return { ok: false, detail: 'provider has no baseUrl' };
  if (!assertHttpUrl(p.baseUrl)) return { ok: false, detail: 'provider baseUrl 必须是 http(s) 地址' };
  const ov = envOverrideFor(prov);
  let key = ov ? Object.values(ov).find((v) => typeof v === 'string') : null;
  if (!key && hasLiteralKey(prov)) key = p.apiKey;
  const t0 = Date.now();
  try {
    const { r, j } = await fetchJsonCapped(modelsUrlFor(p, p.baseUrl), {
      headers: authHeadersFor(p, p.baseUrl, key),
      signal: AbortSignal.timeout(8000),
    });
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, status: r.status, ms };
    const n = Array.isArray(j.data) ? j.data.length : Array.isArray(j.models) ? j.models.length : null;
    return { ok: true, ms, models: n };
  } catch (e) {
    return { ok: false, detail: String(e.message || e), ms: Date.now() - t0 };
  }
}
async function testModelReply(modelId) {
  const [prov, mid] = splitModel(modelId);
  const models = readJson(PI_MODELS) || { providers: {} };
  const p = models.providers?.[prov];
  if (!p?.baseUrl) return { ok: false, detail: 'provider has no baseUrl' };
  if (!assertHttpUrl(p.baseUrl)) return { ok: false, detail: 'provider baseUrl 必须是 http(s) 地址' };
  const ov = envOverrideFor(prov);
  let key = ov ? Object.values(ov).find((v) => typeof v === 'string') : null;
  if (!key && hasLiteralKey(prov)) key = p.apiKey;
  const base = p.baseUrl.replace(/\/$/, '');
  const t0 = Date.now();
  try {
    let r, j, txt = '';
    if (isGoogleApi(p, p.baseUrl)) {
      ({ r, j } = await fetchJsonCapped(`${base}/v1beta/models/${encodeURIComponent(mid)}:generateContent`, {
        method: 'POST', headers: { ...authHeadersFor(p, p.baseUrl, key), 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '只回复ok' }] }], generationConfig: { maxOutputTokens: 16 } }),
        signal: AbortSignal.timeout(30000),
      }));
      txt = (j.candidates?.[0]?.content?.parts || []).map((c) => c.text || '').join('');
    } else if (p.api === 'anthropic-messages') {
      ({ r, j } = await fetchJsonCapped(base + '/messages', {
        method: 'POST', headers: { ...authHeadersFor(p, p.baseUrl, key), 'content-type': 'application/json' },
        body: JSON.stringify({ model: mid, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(25000),
      }));
      txt = Array.isArray(j.content) ? j.content.map((c) => c.text || '').join('') : '';
    } else if (p.api === 'openai-responses') {
      ({ r, j } = await fetchJsonCapped(base + '/responses', {
        method: 'POST', headers: { ...authHeadersFor(p, p.baseUrl, key), 'content-type': 'application/json' },
        body: JSON.stringify({ model: mid, input: '只回复ok', max_output_tokens: 16 }),
        signal: AbortSignal.timeout(30000),
      }));
      txt = (j.output || []).filter((o) => o.type === 'message').flatMap((o) => (o.content || []).map((c) => c.text || '')).join('');
    } else { // openai-completions and anything else speaking the chat shape
      // no max_tokens: reasoning models spend it on thinking and some relays 400 on tiny budgets
      ({ r, j } = await fetchJsonCapped(base + '/chat/completions', {
        method: 'POST', headers: { ...authHeadersFor(p, p.baseUrl, key), 'content-type': 'application/json' },
        body: JSON.stringify({ model: mid, messages: [{ role: 'user', content: '只回复ok' }] }),
        signal: AbortSignal.timeout(30000),
      }));
      txt = j.choices?.[0]?.message?.content || '';
    }
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, status: r.status, detail: JSON.stringify(j).slice(0, 160), ms };
    return { ok: true, ms, reply: String(txt).slice(0, 60) };
  } catch (e) {
    return { ok: false, detail: String(e.message || e), ms: Date.now() - t0 };
  }
}

// ---------- pi process manager ----------
const MAX_TABS = 16; // each tab is a live pi child process — bound the resource fan-out
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
  proc.stdout.setEncoding('utf8'); // chunkwise toString would corrupt multibyte chars split across packets
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
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
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (c) => broadcast({ type: 'pi-stderr', tabId, data: String(c).slice(0, 2000) }));
  const isCurrent = () => { const cur = tabs.get(tabId); return cur && cur.proc === proc; };
  proc.on('error', () => { if (isCurrent()) { tabs.delete(tabId); broadcast({ type: 'pi-exit', tabId, code: -1 }); } });
  proc.on('exit', (code) => {
    if (!isCurrent()) return; // a newer spawn took over this tabId — its exit must not delete the fresh entry
    tabs.delete(tabId);
    broadcast({ type: 'pi-exit', tabId, code });
  });
}
function sendToPi(tabId, cmd) {
  const tab = tabs.get(tabId);
  if (!tab) return false;
  try { tab.proc.stdin.write(JSON.stringify(cmd) + '\n'); return true; } catch { return false; }
}

// ---------- ws ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 }); // oversized frames are torn down by ws itself
// A tab belongs to the connection that opened it: its pi-event/rpc/exit frames go
// only there. When the owner connection dies the tab keeps running and frames stop
// fanning out — a reopened window must explicitly {type:'adopt'} to reattach, so a
// foreign connection can never silently read or steer someone else's conversation.
const ownerLive = (tab) => tab && tab.owner && tab.owner.readyState === 1; // ws.OPEN
function broadcast(obj) {
  const tabId = obj && obj.tabId;
  const tab = tabId ? tabs.get(tabId) : null;
  const s = JSON.stringify(obj);
  if (tab) {
    if (ownerLive(tab)) { try { tab.owner.send(s); } catch { /* dead socket drops the frame */ } return; }
    for (const c of wss.clients) {
      if (!c.adopted || !c.adopted.has(tabId)) continue;
      try { c.send(s); } catch { /* dead socket drops the frame */ }
    }
    return; // nobody adopted: transient frames are dropped, the tab itself keeps running
  }
  for (const c of wss.clients) { try { c.send(s); } catch { /* dead or closing socket just drops this frame */ } }
}

wss.on('connection', (ws) => {
  if (wss.clients.size >= 32) { try { ws.close(1013, 'too many clients'); } catch { /* gone */ } return; }
  ws.clientId = crypto.randomBytes(8).toString('hex');
  ws.adopted = new Set();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  console.log(`[ws] client connected (${ws.clientId})`);
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    console.log('[ws] frame:', msg.type, msg.tabId || '');
    if (msg.type === 'adopt') {
      const tab = tabs.get(msg.tabId);
      if (tab && !ownerLive(tab)) {
        tab.owner = ws;
        tab.adoptedEver = true;
        tab.orphanSince = null;
        ws.adopted.add(msg.tabId);
        try { ws.send(JSON.stringify({ type: 'adopted', tabId: msg.tabId })); } catch { /* socket gone */ }
      }
      return;
    }
    if (msg.type === 'open') {
      const { tabId, cwd, sessionPath, model, thinking, name } = msg;
      // pi runs inside a registered project (or HOME) — same boundary as the file browser
      if (cwd && !knownProject(cwd) && path.resolve(cwd) !== path.resolve(HOME)) {
        ws.send(JSON.stringify({ type: 'open-denied', tabId }));
        return;
      }
      if (!tabs.has(tabId) && tabs.size >= MAX_TABS) {
        ws.send(JSON.stringify({ type: 'open-denied', tabId, reason: `too many live tabs (${MAX_TABS}) — close one first` }));
        return;
      }
      const existingTab = tabs.get(tabId);
      if (ownerLive(existingTab) && existingTab.owner !== ws) {
        ws.send(JSON.stringify({ type: 'open-denied', tabId, reason: 'tab is owned by another connection' }));
        return;
      }
      closeTab(tabId, true); // replacing a tab stays quiet — the new spawn owns the tabId now
      const prov = model ? splitModel(model)[0] : null;
      const ov = prov ? envOverrideFor(prov) : null;
      const { __keyIdx, ...envExtra } = ov || {};
      const proc = spawnPi({ cwd, sessionPath, model, thinking, name, envExtra });
      tabs.set(tabId, { proc, cwd, sessionPath: sessionPath || null, model: model || null, startedAt: Date.now(), routeProvider: prov, routeKeyIdx: ov ? __keyIdx : null, owner: ws, adoptedEver: true, orphanSince: null });
      ws.adopted.add(tabId);
      attachPiReader(tabId, proc);
      ws.send(JSON.stringify({ type: 'opened', tabId }));
    } else if (msg.type === 'rpc') {
      const tab = tabs.get(msg.tabId);
      const mine = ownerLive(tab) ? tab.owner === ws : !!(tab && ws.adopted.has(msg.tabId));
      if (!mine) { try { ws.send(JSON.stringify({ type: 'rpc-denied', tabId: msg.tabId })); } catch { /* socket gone */ } return; }
      sendToPi(msg.tabId, msg.data);
    } else if (msg.type === 'close') {
      const tab = tabs.get(msg.tabId);
      const mine = ownerLive(tab) ? tab.owner === ws : !!(tab && ws.adopted.has(msg.tabId));
      if (!mine) return; // only the owner (or an explicit adopter) may kill a tab
      closeTab(msg.tabId); // closeTab announces the exit itself — see the guard in closeTab
    }
  });
  ws.on('close', () => {
    for (const tab of tabs.values()) if (tab.owner === ws) tab.owner = null; // tab keeps running; frames wait for an adopt
  });
});
// zombie-connection sweep: browsers and the ws client answer protocol-level pings
// automatically — a client that misses two beats is dead and gets torn down
const WS_HEARTBEAT_MS = 30000;
const ORPHAN_TTL_MS = 30 * 60000; // an unadopted tab is a live pi child — it must not outlive its owner forever
setInterval(() => {
  for (const c of wss.clients) {
    if (c.isAlive === false) { c.terminate(); continue; }
    c.isAlive = false;
    c.ping();
  }
  const now = Date.now();
  for (const [tabId, tab] of tabs) {
    if (ownerLive(tab) || tab.adoptedEver) continue;
    if (!tab.orphanSince) { tab.orphanSince = now; continue; }
    if (now - tab.orphanSince > ORPHAN_TTL_MS) {
      logErr(`orphan tab ${tabId} reaped after ${Math.round((now - tab.orphanSince) / 60000)}m without an owner`);
      try { closeTab(tabId); } catch { /* already gone */ }
    }
  }
}, WS_HEARTBEAT_MS).unref();

function closeTab(tabId, silent = false) {
  const tab = tabs.get(tabId);
  if (tab) {
    try { tab.proc.stdin.write(JSON.stringify({ type: 'abort' }) + '\n'); } catch { /* child may already be gone */ }
    try { tab.proc.kill(); } catch { /* abort is best-effort */ }
    tabs.delete(tabId);
    // whoever sees the tab disappear first owns the announcement: closeTab here,
    // or the exit handler on a crash. Exactly one pi-exit broadcast, never two, never zero.
    if (!silent) broadcast({ type: 'pi-exit', tabId, code: 0 });
  }
}

// ---------- http ----------
// job ids are server-generated `job-<hex>`; anything else must never reach path.join
const isJobId = (s2) => typeof s2 === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(s2);
// path containment that sibling names can't fool: relative() is '' for the root itself
const contains = (root, target) => {
  const rel = path.relative(path.resolve(root), path.resolve(String(target || '')));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
// lexical contains() is escapable by a symlink/junction inside the project pointing
// outside; realpath both ends so the check sees what the OS will actually open.
// A not-yet-existing target is resolved through its nearest existing ancestor
// (macOS /var → /private/var would otherwise flip a legit delete into a 400).
const realContains = (root, target) => {
  let rpRoot;
  try { rpRoot = fs.realpathSync(root); } catch { rpRoot = path.resolve(root); }
  let t = path.resolve(String(target || ''));
  const tail = [];
  for (;;) {
    try { t = fs.realpathSync(t); break; } catch (e) {
      if (e && e.code === 'ENOENT') {
        tail.unshift(path.basename(t));
        const parent = path.dirname(t);
        if (parent === t) return false; // walked past the filesystem root
        t = parent;
      } else return false;
    }
  }
  return contains(rpRoot, tail.length ? path.join(t, ...tail) : t);
};
function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.setEncoding('utf8'); // chunkwise coercion would corrupt multibyte bodies split across packets
    req.on('data', (c) => { b += c; if (b.length > 5e6) { resolve({}); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
const runGit = (cwd, args, max = 200000) => new Promise((resolve) => {
  // 60s ceiling: a wedged repo (network mount, huge worktree) must not hang the panel forever
  const p = spawn('git', args, { cwd, windowsHide: true, timeout: 60000 });
  let out = '', err = '';
  p.stdout.setEncoding('utf8');
  p.stderr.setEncoding('utf8');
  p.stdout.on('data', (c) => { if (out.length < max) out += c; });
  p.stderr.on('data', (c) => { if (err.length < 2000) err += c; });
  p.on('error', (e) => resolve({ error: e.message }));
  p.on('close', (code) => resolve({ code, out: out.slice(0, max), err: err.slice(0, 2000) }));
});

const PI_SETTINGS = path.join(HOME, '.pi', 'agent', 'settings.json');
const MCP_FILE = path.join(HOME, '.pi', 'agent', 'mcp.json');
const MODEL_KB_FILE = path.join(__dirname, 'data', 'models-kb.json');
const MODEL_META_FILE = path.join(CFG_DIR, 'model-meta.json');
const MODEL_KB = readJson(MODEL_KB_FILE) || { models: {}, family: {} };
const OMP_SESSIONS = path.join(HOME, '.omp', 'agent', 'sessions');
const GROK_DIR = path.join(HOME, '.grok');
const PI_SKILLS = path.join(HOME, '.pi', 'agent', 'skills');
const AGENTS_SKILLS = path.join(HOME, '.agents', 'skills');
const kb = createKbSkills({ MODEL_KB, MODEL_META_FILE, CFG_DIR, PI_SKILLS, AGENTS_SKILLS, readJson, loadConfig, fs, path });
const { kbLookup, kbPrice, loadModelMeta, saveModelMeta, listSkills, skillArgsFor } = kb;
const sources = createSources({ PI_SESSIONS, CODEX_SESSIONS, CLAUDE_PROJECTS, OMP_SESSIONS, GROK_DIR, HOME, DatabaseSync, kbPrice, loadConfig });
const { IMPORT_SOURCES, usageSummary, sessionTree, piSessionInfo, listJsonFiles } = sources;
const bt = createBackupTerminal({ CFG_DIR, HOME, CFG_FILE, ROUTING_FILE, CRON_FILE, MODEL_META_FILE, PI_MODELS, PI_SETTINGS, PI_SKILLS, CODEX_SESSIONS, CLAUDE_PROJECTS, VERSION: readJson(path.join(__dirname, 'package.json'))?.version || '0.0.0', listSkills, createZip, readZip, spawn, fs, path });
const { exportBackupZip, importBackupZip, migrateScan, openExternalTerm, execInCwd } = bt;


// ---------- api route handlers ----------

async function hLedger(req, res, u) {
    const q = u.searchParams;
    const days = Math.min(365, Math.max(1, Number(q.get('days')) || 30));
    return json(res, 200, ledger({days}));
}

async function hConfig(req, res, u) {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const cfg = loadConfig();
      if ('projects' in body && !Array.isArray(body.projects)) return json(res, 400, { error: 'projects must be an array' });
      if ('disabledSkills' in body && !Array.isArray(body.disabledSkills)) return json(res, 400, { error: 'disabledSkills must be an array' });
      const next = { ...cfg };
      for (const k of ['lang', 'theme', 'themeAuto', 'defaultModel', 'goals', 'disabledSkills', 'projects', 'relaySecret']) if (k in body) next[k] = body[k]; // allowlist: a stray body key must not clobber config
      saveConfig(next);
      return json(res, 200, next);
    }
    return json(res, 200, loadConfig());
}

async function hProjectsAdd(req, res, u) {
    const { path: dir, name } = await readBody(req);
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return json(res, 400, { error: 'invalid dir' });
    const cfg = loadConfig();
    if (!cfg.projects.some((x) => projectKey(x.path) === projectKey(dir))) {
      cfg.projects.push({ path: path.resolve(dir), name: name || path.basename(dir) });
      saveConfig(cfg);
    }
    return json(res, 200, cfg);
}

async function hProjectsRemove(req, res, u) {
    const { path: dir } = await readBody(req);
    const cfg = loadConfig();
    cfg.projects = cfg.projects.filter((x) => path.resolve(x.path) !== path.resolve(dir));
    saveConfig(cfg);
    return json(res, 200, cfg);
}

async function hSessionsPi(req, res, u) {
    const cwdQ = u.searchParams.get('cwd');
    const files = listJsonFiles(PI_SESSIONS, 2);
    const items = files.map(piSessionInfo).filter((s) => !cwdQ || (s.cwd && path.resolve(s.cwd) === path.resolve(cwdQ)));
    items.sort((a, b) => b.mtime - a.mtime);
    return json(res, 200, { sessions: items.slice(0, 300) });
}

async function hSessionsDelete(req, res, u) {
    const { path: file } = await readBody(req);
    const root = path.resolve(PI_SESSIONS);
    const abs = path.resolve(String(file || ''));
    if (!realContains(root, abs) || !abs.toLowerCase().endsWith('.jsonl')) return json(res, 400, { error: 'bad path' });
    if (!fs.existsSync(abs)) return json(res, 404, { error: 'not found' });
    fs.rmSync(abs, { force: true });
    return json(res, 200, { ok: true, deleted: abs });
}

// API keys are write-only over the API: GET answers '***' for literal keys ($ENV refs
// are not secrets and stay readable — the UI shows the env name), and POST substitutes
// the stored key back when the sentinel round-trips. The UI never pre-fills key inputs.
const KEY_SENTINEL = '***';
const maskApiKeys = (doc) => {
  for (const p of Object.values(doc.providers || {})) {
    if (p && typeof p.apiKey === 'string' && p.apiKey && !p.apiKey.startsWith('$')) p.apiKey = KEY_SENTINEL;
  }
  return doc;
};

async function hModels(req, res, u) {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const { meta: _ignored, ...doc } = body; // meta lives in model-meta.json, never in models.json
      if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !doc.providers || typeof doc.providers !== 'object') {
        return json(res, 400, { error: 'body must be {providers:{...}} — refusing to overwrite models.json' });
      }
      const prev = readJson(PI_MODELS) || { providers: {} };
      for (const [name, p] of Object.entries(doc.providers)) {
        if (p && p.apiKey === KEY_SENTINEL) {
          const stored = prev.providers?.[name]?.apiKey;
          if (stored) p.apiKey = stored; // sentinel round-trip: keep the real key
          else delete p.apiKey;
        }
      }
      fs.mkdirSync(path.dirname(PI_MODELS), { recursive: true });
      atomicWrite(PI_MODELS, JSON.stringify(doc, null, 2));
    }
    return json(res, 200, { ...maskApiKeys(readJson(PI_MODELS) || { providers: {} }), meta: loadModelMeta() });
}

async function hModelsAvailable(req, res, u) {
    // short-lived rpc to enumerate models (uses pi's own catalog + models.json)
    const proc = spawn(process.execPath, [PI_CLI, '--mode', 'rpc', '--no-session'], { cwd: HOME, env: { ...process.env, ...SECRET_ENV }, windowsHide: true });
    const result = await new Promise((resolve) => {
      let buf = ''; const to = setTimeout(() => { try { proc.kill(); } catch { /* exited already */ } resolve({ models: [] }); }, 20000);
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'response' && ev.command === 'get_available_models') { clearTimeout(to); try { proc.kill(); } catch { /* exited already */ }; resolve(ev.data || { models: [] }); }
        }
      });
      proc.on('error', () => { clearTimeout(to); resolve({ models: [] }); });
      try { proc.stdin.write(JSON.stringify({ id: 'm1', type: 'get_available_models' }) + '\n'); } catch { /* died before accepting input — error/timeout handlers resolve */ }
    });
    return json(res, 200, result);
}

async function hProvidersDiscover(req, res, u) {
    const { provider, baseUrl, apiKey, api: apiType } = await readBody(req);
    let url = baseUrl;
    let key = apiKey && apiKey !== KEY_SENTINEL ? apiKey : null; // masked round-trip = "use the stored key"
    let pv = provider ? ((readJson(PI_MODELS) || { providers: {} }).providers?.[provider] || {}) : {};
    if (apiType) pv = { ...pv, api: apiType }; // an explicit UI selection beats stored config and hostname sniffing
    if ((!url || !key) && provider) {
      if (!url) url = pv.baseUrl;
      if (!key) {
        const ov = envOverrideFor(provider);
        key = ov ? Object.values(ov).find((v) => typeof v === 'string') : null;
        if (!key && hasLiteralKey(provider)) key = pv.apiKey;
      }
    }
    if (!url) return json(res, 200, { ok: false, detail: '请先填 API 地址' });
    if (!assertHttpUrl(url)) return json(res, 200, { ok: false, detail: 'API 地址必须是 http(s) URL' });
    try {
      const t0 = Date.now();
      const { r, j } = await fetchJsonCapped(modelsUrlFor(pv, url), {
        headers: authHeadersFor(pv, url, key),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return json(res, 200, { ok: false, status: r.status, ms: Date.now() - t0 });
      const ids = (j.data || j.models || []).map((m) => {
        const id = m.id || m.name || '';
        return id.startsWith('models/') ? id.slice('models/'.length) : id; // google lists "models/gemini-…"
      }).filter(Boolean);
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

async function hProvidersKbfill(req, res, u) {
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
    atomicWrite(PI_MODELS, JSON.stringify(doc, null, 2));
    const meta = loadModelMeta();
    for (const [id, price] of Object.entries(pricing)) meta[`${provider}|${id}`] = price;
    saveModelMeta(meta);
    return json(res, 200, { fills, pricing, priced: n });
}

async function hProvidersTest(req, res, u) {
    const { model } = await readBody(req);
    if (!model) return json(res, 400, { ok: false, detail: 'model required' });
    return json(res, 200, await testModelReply(model));
}

async function hRouting(req, res, u) {
    const routing = loadRouting();
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (Array.isArray(body.chains)) routing.chains = body.chains.filter((c) => Array.isArray(c) && c.every((x) => typeof x === 'string' && x.includes('/'))); // a malformed chain would only explode at failover time
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
      const envs = keyEnvsFor(name);
      return {
        name,
        enabled: rc.enabled !== false,
        priority: rc.priority || 1,
        testModel: rc.testModel || null,
        keyEnvs: envs,
        keyCount: envs.length || (hasLiteralKey(name) ? 1 : 0),
        cooldown: cd ? { until: cd.until, remainMs: Math.max(0, cd.until - Date.now()), error: cd.error || null } : null,
      };
    });
    return json(res, 200, { chains: routing.chains, providers });
}

async function hRoutingProbe(req, res, u) {
    const { model } = await readBody(req);
    if (!model) return json(res, 400, { ok: false, detail: 'model required' });
    return json(res, 200, await probeModel(model));
}

async function hRoutingFail(req, res, u) {
    const { model, error, tabId } = await readBody(req);
    const [prov] = splitModel(model);
    if (!prov) return json(res, 400, { error: 'bad model' });
    const tab = tabId ? tabs.get(tabId) : null;
    const msg = String(error || '');
    // auth-ish failures rotate the key; rate limits cool longer (the quota window is
    // usually minutes); everything else takes the standard omp-style chain step
    if (/401|403|unauthorized|invalid[ _-]*(api[ _-]*)?key|forbidden/i.test(msg)) {
      coolKey(prov, tab && tab.routeKeyIdx != null ? tab.routeKeyIdx : 0, msg, 300);
    } else if (/\b429\b|rate[ _-]?limit|too many requests|quota/i.test(msg)) {
      coolModel(model, msg, 300);
    } else {
      coolModel(model, msg, 120);
    }
    return json(res, 200, { next: nextInChain(model), cooldown: modelCooled(model) || providerCooled(prov) });
}

async function hRoutingOk(req, res, u) {
    const { model, tabId } = await readBody(req);
    const tab = tabId ? tabs.get(tabId) : null;
    if (model) clearCool(model, tab && tab.routeKeyIdx != null ? tab.routeKeyIdx : undefined);
    return json(res, 200, { ok: true });
}

async function hCron(req, res, u) {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const jobs = body.jobs;
      if (!Array.isArray(jobs)) return json(res, 400, { error: 'jobs array required' });
      for (const j of jobs) {
        if (!j.name || !j.prompt) return json(res, 400, { error: '每个任务需要 name 和 prompt' });
        if (j.id != null && j.id !== '' && !isJobId(j.id)) return json(res, 400, { error: '任务 ID 只能含字母/数字/连字符，最长 64 字符' });
        if (j.kind === 'daily' && !/^\d{2}:\d{2}$/.test(j.time || '')) return json(res, 400, { error: 'daily 任务需要 HH:MM 时间' });
        if (j.kind === 'interval' && (!(Number(j.everyMin) > 0))) return json(res, 400, { error: 'interval 任务需要正的 everyMin 分钟数' });
      }
      const prev = readJson(CRON_FILE) || { jobs: [] };
      for (const j of jobs) {
        const old = prev.jobs.find((x) => x.id === j.id);
        if (old) { j.lastRun = old.lastRun; j.lastStatus = old.lastStatus; j.lastOutput = old.lastOutput; j.lastRunMs = old.lastRunMs; j.lastRunDay = old.lastRunDay; } // keep the scheduler's own state too, or toggling a switch re-runs the job now
        if (!j.id) j.id = 'job-' + crypto.randomBytes(4).toString('hex');
        if (typeof j.enabled !== 'boolean') j.enabled = true;
      }
      saveJson(CRON_FILE, { jobs });
    }
    const d = readJson(CRON_FILE) || { jobs: [] };
    if (cron.bootReset(d)) saveJson(CRON_FILE, d);
    return json(res, 200, d);
}

async function hCronDelete(req, res, u) {
    const { id } = await readBody(req);
    if (!isJobId(id)) return json(res, 400, { error: 'bad job id' });
    const d = readJson(CRON_FILE) || { jobs: [] };
    d.jobs = d.jobs.filter((j) => j.id !== id);
    saveJson(CRON_FILE, d);
    return json(res, 200, d);
}

async function hUpdateCheck(req, res, u) {
    try {
      const r = await fetch('https://api.github.com/repos/cullysu/pi-workbench/releases/latest', { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'pi-workbench' } });
      const j = await r.json();
      return json(res, 200, { latest: j.tag_name || null, url: j.html_url || null });
    } catch (e) {
      return json(res, 200, { latest: null, error: String(e.message || e).slice(0, 100) });
    }
}

async function hCronLogs(req, res, u) {
    const { id } = await readBody(req);
    if (!isJobId(id)) return json(res, 400, { error: 'bad job id' });
    const dir = path.join(CRON_RUNS_DIR, id);
    let runs = [];
    try {
      runs = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort().reverse().map((f) => {
        const full = path.join(dir, f);
        return { file: f, size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs };
      });
    } catch { /* job has no runs yet */ }
    return json(res, 200, { runs });
}

async function hCronLastlog(req, res, u) {
    const { id } = await readBody(req);
    if (!isJobId(id)) return json(res, 400, { error: 'bad job id' });
    const dir = path.join(CRON_RUNS_DIR, id);
    let latest = null, mtime = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.log')) continue;
        const full = path.join(dir, f);
        const m = fs.statSync(full).mtimeMs;
        if (m > mtime) { mtime = m; latest = full; }
      }
    } catch { /* job never ran; latest stays null */ }
    if (!latest) return json(res, 200, { content: '(no runs yet)' });
    return json(res, 200, { content: fs.readFileSync(latest, 'utf8').slice(-4000), file: latest });
}

async function hSessionExport(req, res, u) {
    const root = path.resolve(PI_SESSIONS);
    const abs = path.resolve(u.searchParams.get('path') || '');
    if (!realContains(root, abs) || !abs.toLowerCase().endsWith('.jsonl')) { res.writeHead(400); return res.end('bad path'); }
    let st0; try { st0 = fs.statSync(abs); } catch { res.writeHead(404); return res.end('not found'); }
    if (st0.size > 100e6) { res.writeHead(413); return res.end('session too large to export (> 100MB)'); }
    // streamed line-by-line: a big session never sits whole in memory and the
    // event loop keeps serving while the file is walked
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    const NL = '\n';
    const write = (s2) => new Promise((r2) => { if (res.write(s2)) r2(); else res.once('drain', r2); });
    const rl = createInterface({ input: fs.createReadStream(abs, { encoding: 'utf8' }), crlfDelay: Infinity });
    res.on('error', () => rl.close()); // client vanished mid-export
    try {
      for await (const line of rl) {
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
        await write((m.role === 'user' ? '## User' + NL + NL : '## Assistant' + NL + NL) + text.trim() + NL + NL + '---' + NL);
      }
    } catch { /* read or client error: best-effort export */ }
    return res.end();
}

async function hCronRunNow(req, res, u) {
    const { id } = await readBody(req);
    if (!isJobId(id)) return json(res, 400, { error: 'bad job id' });
    const d = readJson(CRON_FILE) || { jobs: [] };
    const job = d.jobs.find((j) => j.id === id);
    if (!job) return json(res, 404, { error: 'job not found' });
    cron.runCronJob(job);
    saveJson(CRON_FILE, d);
    return json(res, 200, { ok: true, lastStatus: job.lastStatus });
}

async function hUsage(req, res, u) {
    return json(res, 200, usageSummary());
}

async function hSessionTree(req, res, u) {
    const f = u.searchParams.get('path');
    const tree = sessionTree(f);
    return tree ? json(res, 200, tree) : json(res, 400, { error: 'bad path or unreadable session' });
}

async function hFilesList(req, res, u) {
    const root = u.searchParams.get('root');
    const rel = u.searchParams.get('path') || '';
    const cfgc = loadConfig();
    const known = (cfgc.projects || []).some((pr) => path.resolve(pr.path) === path.resolve(root || ''));
    if (!root || !known) return json(res, 400, { error: 'unknown project root' });
    const base = path.resolve(root, rel);
    if (!realContains(root, base)) return json(res, 400, { error: 'bad path' });
    let entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { return json(res, 400, { error: e.message }); }
    const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__']);
    const items = entries.filter((e) => !skip.has(e.name)).map((e) => {
      let size = 0, mtime = 0;
      let isDir = e.isDirectory();
      try { const st = fs.statSync(path.join(base, e.name)); size = st.size; mtime = st.mtimeMs; } catch { /* file vanished mid-scan; serve the rest */ }
      return { name: e.name, dir: isDir, size, mtime };
    });
    items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    return json(res, 200, { cwd: base, items: items.slice(0, 500) });
}

async function hFilesRead(req, res, u) {
    const root = u.searchParams.get('root');
    const rel = u.searchParams.get('path') || '';
    const cfgc = loadConfig();
    const known = (cfgc.projects || []).some((pr) => path.resolve(pr.path) === path.resolve(root || ''));
    if (!root || !known) return json(res, 400, { error: 'unknown project root' });
    const base = path.resolve(root, rel);
    if (!realContains(root, base)) return json(res, 400, { error: 'bad path' });
    let st; try { st = fs.statSync(base); } catch { return json(res, 400, { error: 'not found' }); }
    if (st.isDirectory()) return json(res, 400, { error: 'is a directory' });
    if (st.size > 400000) return json(res, 200, { text: '', tooBig: true, size: st.size });
    try { return json(res, 200, { text: fs.readFileSync(base, 'utf8').slice(0, 200000) }); }
    catch { return json(res, 200, { text: '', tooBig: false, binary: true }); }
}

async function hKernel(req, res, u) {
    const piPkg = readJson(path.join(__dirname, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json')) || {};
    return json(res, 200, {
      node: process.version,
      platform: process.platform + ' ' + process.arch,
      execPath: process.execPath,
      uptimeSec: Math.round(process.uptime()),
      port: PORT,
      pi: piPkg.version || null,
      secrets: { relay: !!Object.keys(SECRET_ENV).length },
      sqlite: !!DatabaseSync,
      degradedSince: DEGRADED_AT, // non-null = an uncaughtException happened this boot — check server.log
      paths: {
        config: CFG_FILE,
        routing: ROUTING_FILE,
        models: PI_MODELS,
        sessions: PI_SESSIONS,
        server: path.join(__dirname, 'server.mjs'),
      },
    });
}

async function hEnv(req, res, u) {
    const g = await collectProc(spawn, 'git', ['--version'], { maxOut: 200 });
    const gitVer = g.error ? null : (g.out.trim() || null);
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

async function hImport(req, res, u, m) {
    const imp = IMPORT_SOURCES[m[1]];
    if (m[2]) {
      const f = u.searchParams.get('path');
      const roots = [imp.root, ...(imp.roots ? imp.roots() : [])].filter(Boolean);
      if (!f || (roots.length && !roots.some((r) => realContains(r, f)))) return json(res, 400, { error: 'bad path' });
      if (!roots.length && !(f || '').startsWith('opencode://')) return json(res, 400, { error: 'bad path' });
      return json(res, 200, { entries: imp.read(f) });
    }
    return json(res, 200, { sessions: await imp.list() });
}

async function hGitStatus(req, res, u) {
    const cwd = u.searchParams.get('cwd');
    if (!knownProject(cwd)) return json(res, 400, { error: 'unknown project root' });
    const r = await runGit(cwd, ['status', '--porcelain=v1', '-b'], 100000);
    return json(res, 200, r);
}

// git/terminal-adjacent routes only ever run inside a registered project — an
// arbitrary cwd would let any token holder diff their way through the whole disk
const knownProject = (cwd) => {
  const cfgc = loadConfig();
  return !!(cwd && (cfgc.projects || []).some((pr) => path.resolve(pr.path) === path.resolve(String(cwd))));
};

async function hGitDiff(req, res, u) {
    const cwd = u.searchParams.get('cwd');
    if (!knownProject(cwd)) return json(res, 400, { error: 'unknown project root' });
    const r = await runGit(cwd, ['diff', 'HEAD'], 300000);
    return json(res, 200, r);
}

async function hGitWorktrees(req, res, u) {
    const cwd = u.searchParams.get('cwd');
    if (!knownProject(cwd)) return json(res, 400, { error: 'unknown project root' });
    const r = await runGit(cwd, ['worktree', 'list', '--porcelain']);
    return json(res, 200, r);
}

async function hSkills(req, res, u) {
    const cwd = u.searchParams.get('cwd') || null;
    if (cwd && !knownProject(cwd)) return json(res, 400, { error: 'unknown project root' });
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

async function hTemplates(req, res, u) {
    const out = [];
    const q = u.searchParams.get('cwd') || '';
    if (q && !knownProject(q)) return json(res, 400, { error: 'unknown project root' });
    const dirs = [[path.join(HOME, '.pi', 'agent', 'prompts'), 'global']];
    if (q) dirs.push([path.join(q, '.pi', 'prompts'), 'project']);
    for (const [dir, source] of dirs) {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* dir absent: nothing discovered */ }
      for (const e of ents) {
        if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
        const full = path.join(dir, e.name);
        let raw = '';
        try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
        let desc = '';
        const di = raw.indexOf('description:');
        if (di >= 0) desc = raw.slice(di + 12, raw.indexOf('\n', di)).trim().slice(0, 120); // 12 = 'description:'.length
        if (!desc) desc = raw.replace(/^---/, '').trim().split('\n')[0].slice(0, 120);
        out.push({ name: e.name.replace(/.md$/i, ''), path: full, source, description: desc, body: raw.slice(0, 20000) });
      }
    }
    return json(res, 200, { templates: out });
}

async function hMcpConfig(req, res, u) {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const servers = body.mcpServers;
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return json(res, 400, { error: 'mcpServers object required' });
      for (const [name, s] of Object.entries(servers)) {
        if (!s || typeof s !== 'object' || !s.command) return json(res, 400, { error: `server "${name}" needs a command` });
      }
      const prev = readJson(MCP_FILE) || { mcpServers: {} };
      for (const s of Object.values(servers)) {
        if (!s || typeof s.env !== 'object' || s.env === null) continue;
        for (const k of Object.keys(s.env)) {
          if (s.env[k] === '***') {
            const stored = prev.mcpServers?.[Object.keys(servers).find((n2) => servers[n2] === s)]?.env?.[k];
            if (stored !== undefined) s.env[k] = stored; else delete s.env[k];
          }
        }
      }
      atomicWrite(MCP_FILE, JSON.stringify({ mcpServers: servers }, null, 2)); // MCP env carries secrets
    }
    const doc = readJson(MCP_FILE) || { mcpServers: {} };
    for (const srv of Object.values(doc.mcpServers || {})) {
      if (srv && typeof srv.env === 'object' && srv.env !== null) for (const k of Object.keys(srv.env)) srv.env[k] = '***'; // env values are secrets, like model keys
    }
    return json(res, 200, doc);
}

async function hMcpInstall(req, res, u) {
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

async function hBackupExport(req, res, u) {
    try { return json(res, 200, await exportBackupZip(u.searchParams.get('excludeKeys') === '1')); }
    catch (e) { return json(res, 500, { error: e.message }); }
}

async function hBackupImport(req, res, u) {
    const { path: zipPath } = await readBody(req);
    try { return json(res, 200, await importBackupZip(zipPath)); }
    catch (e) { return json(res, 400, { error: e.message }); }
}

async function hMigrateScan(req, res, u) {
    return json(res, 200, migrateScan());
}

async function hTermOpen(req, res, u) {
    const { cwd } = await readBody(req);
    if (cwd && !knownProject(cwd)) return json(res, 400, { error: 'unknown project root' });
    return json(res, 200, await openExternalTerm(cwd));
}

async function hTermExec(req, res, u) {
    const { cwd, cmd } = await readBody(req);
    if (!cmd || typeof cmd !== 'string' || cmd.length > 4000) return json(res, 400, { error: 'bad cmd' });
    if (cwd && !knownProject(cwd)) return json(res, 400, { error: 'unknown project root' }); // '' (=HOME) stays allowed
    return json(res, 200, await execInCwd(cwd, cmd));
}

function hStatic(req, res, u) {
  const p = u.pathname;
    let f = p === '/' ? '/index.html' : p;
    f = path.join(PUBLIC_DIR, path.normalize(f).replace(/^([.][.][/\\])+/, ''));
    if (!f.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    try {
      let data = fs.readFileSync(f);
      const ext = path.extname(f);
      if ((ext === '.html' || p === '/') && TOKEN_EMBED) {
        data = Buffer.from(data.toString('utf8').replace(
          '</head>',
          '<script nonce="' + HTML_NONCE + '">window.__API_TOKEN = ' + JSON.stringify(API_TOKEN) + '</scr' + 'ipt></head>'
        ));
      }
      const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }[ext] || 'application/octet-stream';
      // index.html embeds a per-boot token — a cached stale page would 403 itself dead
      const csp = "default-src 'self'; script-src 'self' 'nonce-" + HTML_NONCE + "'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
      res.writeHead(200, { 'content-type': mime, 'cache-control': (ext === '.html' || p === '/') ? 'no-store' : 'no-cache', 'content-security-policy': csp });
      return res.end(data);
    } catch { res.writeHead(404); return res.end('not found'); }
}

// api route table — [method ('*'=any, null=path is a regex), path, handler]
const routes = [
  ['*', '/api/ledger', hLedger],
  ['*', '/api/config', hConfig],
  ['POST', '/api/projects/add', hProjectsAdd],
  ['POST', '/api/projects/remove', hProjectsRemove],
  ['*', '/api/sessions/pi', hSessionsPi],
  ['POST', '/api/sessions/delete', hSessionsDelete],
  ['*', '/api/models', hModels],
  ['*', '/api/models/available', hModelsAvailable],
  ['POST', '/api/providers/discover', hProvidersDiscover],
  ['POST', '/api/providers/kbfill', hProvidersKbfill],
  ['POST', '/api/providers/test', hProvidersTest],
  ['*', '/api/routing', hRouting],
  ['POST', '/api/routing/probe', hRoutingProbe],
  ['POST', '/api/routing/fail', hRoutingFail],
  ['POST', '/api/routing/ok', hRoutingOk],
  ['*', '/api/cron', hCron],
  ['POST', '/api/cron/delete', hCronDelete],
  ['*', '/api/update/check', hUpdateCheck],
  ['POST', '/api/cron/logs', hCronLogs],
  ['POST', '/api/cron/lastlog', hCronLastlog],
  ['GET', '/api/session/export', hSessionExport],
  ['POST', '/api/cron/run-now', hCronRunNow],
  ['*', '/api/usage', hUsage],
  ['*', '/api/session/tree', hSessionTree],
  ['*', '/api/files/list', hFilesList],
  ['*', '/api/files/read', hFilesRead],
  ['*', '/api/kernel', hKernel],
  ['*', '/api/env', hEnv],
  [null, /^\/api\/import\/(codex|claude|zcode|opencode|omp|gemini|grok|aider)(\/read)?$/, hImport],
  ['*', '/api/git/status', hGitStatus],
  ['*', '/api/git/diff', hGitDiff],
  ['*', '/api/git/worktrees', hGitWorktrees],
  ['*', '/api/skills', hSkills],
  ['*', '/api/templates', hTemplates],
  ['*', '/api/mcp/config', hMcpConfig],
  ['POST', '/api/mcp/install', hMcpInstall],
  ['POST', '/api/backup/export', hBackupExport],
  ['POST', '/api/backup/import', hBackupImport],
  ['*', '/api/migrate/scan', hMigrateScan],
  ['POST', '/api/term/open', hTermOpen],
  ['POST', '/api/term/exec', hTermExec],
];

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (!hostAllowed(req.headers.host || '')) { res.writeHead(403); return res.end('forbidden host'); }
    if (u.pathname.startsWith('/api/')) {
      // browsers always attach Origin to cross-site fetches — a drive-by page probing
      // 127.0.0.1 must die here even before the token check; local processes can
      // spoof Origin but they can equally just read the token, so this is browser-only armor
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) { res.writeHead(403); return res.end('forbidden origin'); }
      if (req.headers['x-api-token'] !== API_TOKEN) { res.writeHead(403); return res.end('forbidden'); }
      for (const [method, path, handler] of routes) {
        if (method && method !== '*' && method !== req.method) continue; // null/regex rows match any method
        const m = typeof path === 'string' ? (u.pathname === path ? [path] : null) : path.exec(u.pathname);
        if (m) return handler(req, res, u, m);
      }
      return json(res, 404, { error: 'not found' });
    }
    return hStatic(req, res, u);
  } catch (e) {
    console.error(String(e.stack));
    try { json(res, 500, { error: e.message }); } catch { /* headers already sent */ }
  }
});


server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  // WS can't carry custom headers — token rides the ?t= query param instead;
  // browsers always send Origin on WS, so cross-site upgrade attempts die here
  const origin = req.headers.origin;
  const originOk = !origin || origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
  if (originOk && hostAllowed(req.headers.host || '') && pathname === '/ws' && searchParams.get('t') === API_TOKEN) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else socket.destroy();
});

resolveSecrets();

// cron scheduler heartbeat — without this tick is never called and daily/interval
// jobs only ever run via run-now
setInterval(() => { try { cron.tick(); } catch (e) { logErr('cron tick: ' + ((e && e.message) || e)); } }, 20000).unref();

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) server.listen(PORT, '127.0.0.1', () => {
  console.log(`pi-workbench listening on http://127.0.0.1:${PORT}`);
  // per-boot token file (0600 via atomicWrite on POSIX) for the desktop shells —
  // written only when the server owns the token generation
  if (!process.env.PIWB_TOKEN) {
    try { saveJson(TOKEN_FILE, { token: API_TOKEN, at: new Date().toISOString() }); } catch { /* shells fall back to embedded mode */ }
  }
  // warm the codex list cache in the background so the first UI click is instant
  setTimeout(() => {
    try {
      const r = IMPORT_SOURCES.codex.list();
      if (r && typeof r.catch === 'function') r.catch((e) => logErr('codex warmup: ' + (e && e.message || e)));
    } catch (e) { logErr('codex warmup: ' + (e && e.message || e)); }
  }, 3000);
});
