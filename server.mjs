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
import {createProviders, ProviderError} from './lib/providers.mjs';
import {createSources} from './lib/sources.mjs';
import { killTree, spawnTreeOpts } from './lib/proctree.mjs';
import {createKbSkills} from './lib/kb-skills.mjs';
import {createBackupTerminal} from './lib/backup-terminal.mjs';
import { restrictWindowsAcl } from './lib/win-acl.mjs';
import * as outboundFetch from './lib/outbound-fetch.mjs';
import {
  isSafeKey as isSafeKeyFn,
  providerRowProblem,
  routingMetaProblem,
  normalizeRoutingDoc,
} from './lib/schema.mjs';
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
// v1.4.3 review #10: PIWB_PI_CLI lets a test (and a user with pi installed elsewhere)
// point at a different entry. The probe's stdin-EPIPE crash path is only reachable with a
// child that dies before reading stdin, and a hard-coded path made that path untestable.
const PI_CLI = process.env.PIWB_PI_CLI || path.join(__dirname, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
const PORT = Number(process.env.PIWB_PORT || 32123);
// HTTP token auth: any local process could hit the port — random per boot, embedded
// in the served HTML and required as x-api-token on /api/* routes
// Desktop shells bootstrap their own per-launch token via PIWB_TOKEN and inject it
// into the page out-of-band — the token never sits in the public HTML. Plain
// `node server.mjs` browser usage keeps the embedded mode via PIWB_EMBED_TOKEN=1
// (plus a 0600 token file for tooling). See the shell repos' main entry points.
const API_TOKEN = process.env.PIWB_TOKEN || crypto.randomBytes(24).toString('hex');
const TOKEN_FROM_ENV = !!process.env.PIWB_TOKEN; // the shell owns this token; we only hand it back
// P2-6 (v1.3.9 review): `npm start` used to be unusable — no token variable meant the page
// got no credentials at all, so the documented browser workflow 403'd itself dead. The
// v1.3.9 fix made "embed the token in the served HTML" the DEFAULT whenever no desktop shell
// supplied one. The v1.4.2 review (H2) is right that this default contradicts the comment
// above: any local process — any other user account on a shared machine included — can GET "/"
// and read the admin token out of the HTML, then call /api/term/exec.
// The default is now OFF: `npm start` prints exactly what to set, and the page teaches the
// same thing. Embedding is an explicit opt-in (PIWB_EMBED_TOKEN=1) for the single-user case,
// or you keep using the desktop shells, which hand the token over out-of-band.
const TOKEN_EMBED = process.env.PIWB_EMBED_TOKEN === '1'
  ? true
  : (process.env.PIWB_EMBED_TOKEN === '0' || TOKEN_FROM_ENV
      ? false
      : (() => { console.log('[boot] no PIWB_TOKEN and no PIWB_EMBED_TOKEN — the page will 403 until you either\n' +
          '         set PIWB_EMBED_TOKEN=1 (single-user machine, token ships in the HTML) or\n' +
          '         PIWB_EMBED_TOKEN=0 + the 0600 token file (headless/tooling).'); return false; })());
// v1.3.8 review P1-2: CAPTURE, THEN SCRUB. Every child we start (pi, MCP servers, tool
// shells, cron runs, git, the file browser) inherits process.env, and pi can run arbitrary
// commands — so keeping PIWB_TOKEN in the environment handed the GUI's admin credential to
// every process the agent could start. Only THIS process authenticates the GUI; nothing
// downstream needs it, so it leaves the environment before any spawn happens.
delete process.env.PIWB_TOKEN;
delete process.env.PIWB_EMBED_TOKEN;
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
const projectKey = (p) => {
  const r = (() => { try { return path.resolve(String(p)); } catch { return String(p); } })();
  // fold only where the default filesystem folds (Windows NTFS, macOS APFS default) —
  // Linux keeps distinct Foo/ and foo/
  return (process.platform === 'win32' || process.platform === 'darwin') ? r.toLowerCase() : r;
};
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
    // a torn config must not vanish silently: preserve it for forensics, then fall back.
    // F38 (v1.3.5 audit): copies go to a dedicated dir, are private (0600 where the OS
    // honors it) and are capped at the 3 most recent — repeated reads of a corrupt
    // file used to grow unbounded .corrupt-* siblings next to the live config.
    try {
      if (fs.existsSync(CFG_FILE) && fs.statSync(CFG_FILE).size > 0) {
        const keepDir = path.join(CFG_DIR, 'corrupt-backups');
        fs.mkdirSync(keepDir, { recursive: true });
        const keep = path.join(keepDir, `config.corrupt-${Date.now()}.json`);
        fs.copyFileSync(CFG_FILE, keep);
        try { fs.chmodSync(keep, 0o600); } catch { /* Windows keeps inherited ACL */ }
        try {
          const olds = fs.readdirSync(keepDir).filter((f) => f.startsWith('config.corrupt-')).sort();
          for (const o of olds.slice(0, Math.max(0, olds.length - 3))) {
            try { fs.unlinkSync(path.join(keepDir, o)); } catch { /* best-effort cap */ }
          }
        } catch { /* best-effort cap */ }
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
process.on('uncaughtException', (e) => {
  DEGRADED_AT = DEGRADED_AT || Date.now();
  logErr('uncaughtException: ' + redactSecrets((e && e.stack) || e));
  // an uncaught exception leaves unknown state — continuing as a healthy service would
  // trade a diagnosable crash for silent corruption. reap children and exit; the desktop
  // shells restart the server automatically. PIWB_NO_EXIT_ON_UNCAUGHT=1 is the test hatch.
  if (process.env.PIWB_NO_EXIT_ON_UNCAUGHT === '1') return;
  setTimeout(() => {
    try { for (const t of tabs.values()) { try { killTree(t.proc); } catch { /* gone */ } } } catch { /* best effort */ }
    try { cron.shutdown(); } catch { /* best effort */ }
    process.exit(1);
  }, 1500); // let the error log flush first
});
process.on('unhandledRejection', (e) => logErr('unhandledRejection: ' + ((e && e.stack) || e)));

// DNS-rebinding armor: a browser-resolved evil.com -> 127.0.0.1 would arrive with a
// foreign Host header; the token already stops the API, this stops even the static page
const hostAllowed = (h) => h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}` || h === `[::1]:${PORT}`;

// ---------- helpers ----------
const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};
// v1.3.8 review P2-8: object keys taken from requests/disk must never be able to traverse
// the prototype chain. `providers['__proto__']` reads Object.prototype (truthy), so a plain
// `x = x || {}` would then write onto the global prototype.
// v1.4.3 review #25: the predicate and the deep validators now live in lib/schema.mjs so
// the HTTP door, the restore door and the on-disk loader cannot drift apart again.
const isSafeKey = isSafeKeyFn;

// ---------- routing: fallback chains + per-key cooldowns/rotation ----------
const ROUTING_FILE = path.join(CFG_DIR, 'routing.json');
function loadRouting() {
  // v1.4.3 review #4: this used to be an ad-hoc sanitiser that only checked CONTAINERS —
  // providers is an object, chains is an array, state is an object. A restored or
  // hand-edited `{"providers":{"p":{"keyEnvs":1}}}` passed all three and then threw in
  // failover's `for (const e of routing.providers[p].keyEnvs)` — which runs on every
  // failure decision, so one bad field took the routing page, the cron provider gate and
  // the failover chain down together. The deep rules now live in lib/schema.mjs, the same
  // module the HTTP write and the backup restore validate against.
  return normalizeRoutingDoc(readJson(ROUTING_FILE));
}
// F08 (v1.3.5 audit): Windows ignores POSIX modes, so the 0600 above is a no-op there
// and every credential-bearing file kept the inherited (often broad) profile ACL — the
// token file was the ONLY one explicitly restricted. Same DACL for every file that
// actually carries secrets, applied to the final name after the rename.
const ACL_FILE_RE = /^(token|routing\.json|cron\.json|config\.json|models\.json|mcp\.json|settings\.json|model-meta\.json)$/i;
function restrictAcl(file) {
  if (!ACL_FILE_RE.test(path.basename(file))) return;
  // v1.4.1 review #3: spawnSync reports a non-zero exit through `status`, it does not throw —
  // so the old try/catch swallowed EVERY failure and a credential file silently kept its
  // inherited ACL (Windows ignores the 0600 above). The outcome now goes to the server log.
  restrictWindowsAcl(file, { warn: (line) => logErr(line) });
}
// atomic write: tmp+rename so a crash mid-write can never leave a torn config
// (Windows rename replaces existing files — no unlink dance needed)
let atomicSeq = 0;
const atomicWrite = (file, data) => {
  const tmp = `${file}.tmp-${process.pid}-${++atomicSeq}`; // concurrent writes must not share one tmp path
  fs.writeFileSync(tmp, data, { mode: 0o600 }); // restrictive at CREATION — chmod-after-write left a 0644 window on the tmp file itself (audit #05)
  if (process.platform !== 'win32') { try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ } }
  fs.renameSync(tmp, file);
  restrictAcl(file);
};
const saveJson = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(obj, null, 2));
  return obj;
};
// A provider spans models.json + routing.json + config.json. The client used to write
// those one at a time and reconcile afterwards; lib/providers.mjs commits them together
// and restores the pre-images if any single write fails.
const providers = createProviders({
  MODELS_FILE: PI_MODELS,
  ROUTING_FILE,
  CFG_FILE,
  readJson,
  atomicWrite,
  isSafeKey,
});
// ---------- cron: scheduled pi prompt runs (lib/cron.mjs) ----------
const CRON_FILE = path.join(CFG_DIR, 'cron.json');
const CRON_RUNS_DIR = path.join(CFG_DIR, 'cron-runs');
// v1.4.0 review #2: cron.json is hand-editable and restorable from a backup, so a
// non-object row is a real state. Every read path below used to index it directly —
// `d.jobs.filter((j) => j.id !== id)` and `d.jobs.find((j) => j.id === id)` both threw on
// `null`, answering 500 from the endpoints that are the ONLY way to clean such a file.
// One accessor, used by every reader, so the rule can't drift apart again.
const cronRows = (d) => (d && Array.isArray(d.jobs) ? d.jobs.filter((j) => j && typeof j === 'object' && !Array.isArray(j)) : []);
const cron = createCron({
  CRON_FILE, CRON_RUNS_DIR, HOME, SECRET_ENV, PI_CLI, broadcast, readJson, saveJson, spawn,
  get knownProject() { return knownProject; },
  get envOverrideFor() { return envOverrideFor; },
  get defaultModel() { return () => (loadConfig() || {}).defaultModel || null; }, // lazy: jobs WITHOUT an explicit model run the default — its provider needs the same rotation wiring
  get providerCooledOut() { return providerCooledOut; },
  get providerDisabled() { return (prov) => !!(loadRouting().providers?.[prov]?.enabled === false); },
  // F13 (v1.3.5 audit): the exact MODEL's cooldown gates unattended runs too — an
  // interactive 429 must not keep getting re-hit by cron
  get modelCooled() { return modelCooled; },
  // F14: the env NAME of the key that actually ran is recorded on the job for attribution
  get keyEnvAt() { return keyEnvAt; },
  // unattended jobs run with the panel's skills switches (per cwd) and default model —
  // the arrow body defers skillArgsFor/loadConfig past their definition points
  get cronPiArgs() {
    return (job) => {
      const args = [...cronPiArgs(job)];
      if (!job.model) { const dm = (loadConfig() || {}).defaultModel; if (dm) args.push('--model', dm); }
      return [...args, ...skillArgsFor(job.cwd || HOME)];
    };
  },
});
function saveRouting(r) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  atomicWrite(ROUTING_FILE, JSON.stringify(r, null, 2));
  return r;
}
const failover = createFailover({ SECRET_ENV, readJson, loadRouting, saveRouting, PI_MODELS });
const { splitModel, keyEnvsFor, keyEnvAt, hasLiteralKey, coolModel, coolKey, clearCool, modelCooled, providerCooled, envOverrideFor, nextInChain, sameModelNewKey, providerCooledOut } = failover;

// provider URLs are user-supplied: only http(s) may leave the box (no file:, ftp:, data:...)
// Local addresses stay allowed BY DEFAULT — ollama/LM Studio on 127.0.0.1 are first-class
// providers, and this is a single-user local tool whose server already requires the admin
// token for every config change. That is a POLICY, stated here rather than implied
// (v1.4.2 review M7): a multi-user host can forbid loopback/link-local targets entirely by
// starting the server with PIWB_DISALLOW_LOCAL_URLS=1 — the UI's own probe then reports the
// refusal in its status line instead of silently reaching an internal service.
// v1.4.3 review #1/#11/#25: the URL policy, the redirect hop budget and the credential
// allow-list now live in lib/outbound-fetch.mjs — one implementation, unit-testable, used by
// every caller. The header rule is an ALLOW-list, not a list of known credential names: a
// provider's `headers` map is arbitrary user JSON, so an open set can only be closed by
// enumerating what SURVIVES (content negotiation) rather than what is dropped.
const { assertHttpUrl, fetchJsonCapped } = outboundFetch;

// per-protocol auth: anthropic wants x-api-key (+ version header), google wants
// x-goog-api-key, everything OpenAI-shaped speaks Bearer. api type comes from the
// provider config when known, otherwise it is sniffed from the hostname.
const isGoogleApi = (p, url) => p?.api === 'google-generative-ai' || /generativelanguage\.googleapis\.com/i.test(String(url || ''));
const isAnthropicApi = (p, url) => p?.api === 'anthropic-messages' || /api\.anthropic\.com/i.test(String(url || ''));
const authHeadersFor = (p, url, key, extra = {}) => {
  const out = { ...extra };
  // stored provider headers describe the STORED endpoint — attach them only when the
  // request actually targets it (probe/test against p.baseUrl), never a moved URL
  if (p && typeof p.headers === 'object' && p.baseUrl && url === p.baseUrl) {
    for (const [k, v] of Object.entries(p.headers)) { if (typeof v === 'string' && v && out[k] === undefined) out[k] = v; }
  }
  if (!key) return out;
  if (isGoogleApi(p, url)) return { ...out, 'x-goog-api-key': key };
  if (isAnthropicApi(p, url)) return { ...out, 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  return { ...out, authorization: `Bearer ${key}` };
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
      // cap the test spend: 512 keeps reasoning-model thinking in budget without
      // the 400s a 16-token cap drew from some relays; a relay that rejects the cap
      // itself gets ONE uncapped retry — with the parameter actually removed, not
      // the identical body resent (the old "retry" changed nothing but the latency)
      ({ r, j } = await fetchJsonCapped(base + '/chat/completions', {
        method: 'POST', headers: { ...authHeadersFor(p, p.baseUrl, key), 'content-type': 'application/json' },
        body: JSON.stringify({ model: mid, max_tokens: 512, messages: [{ role: 'user', content: '只回复ok' }] }),
        signal: AbortSignal.timeout(30000),
      }));
      if (!r.ok && (r.status === 400 || r.status === 422)) {
        ({ r, j } = await fetchJsonCapped(base + '/chat/completions', {
          method: 'POST', headers: { ...authHeadersFor(p, p.baseUrl, key), 'content-type': 'application/json' },
          body: JSON.stringify({ model: mid, messages: [{ role: 'user', content: '只回复ok' }] }), // no max_tokens — the point of this retry
          signal: AbortSignal.timeout(30000),
        }));
      }
      txt = j.choices?.[0]?.message?.content || '';
    }
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, status: r.status, detail: JSON.stringify(j).slice(0, 160), ms };
    if (r.ok && !String(txt || '').trim()) return { ok: false, detail: 'HTTP 成功但模型没有返回内容（中继可能忽略参数或配额异常）', ms };
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
    ...spawnTreeOpts(),
  });
  proc.stdin.setEncoding('utf8');
  proc.stdin.on('error', () => {}); // an async EPIPE (prompt sent while the child dies) must not become an uncaughtException — the sync try/catch around write() cannot see stream-level errors
  return proc;
}
function attachPiReader(tabId, proc) {
  const tab = tabs.get(tabId);
  let buffer = '';
  proc.stdout.setEncoding('utf8'); // chunkwise toString would corrupt multibyte chars split across packets
  const isLive = () => { const cur = tabs.get(tabId); return !!cur && cur.proc === proc; }; // identity, not just tabId — a replaced spawn's late stdout must not reach the new owner
  proc.stdout.on('data', (chunk) => {
    if (!isLive()) return;
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'response' && ev.command === 'set_model' && ev.success) {
        // pi 0.85 answers set_model with the Model OBJECT ({provider, id, ...}) — the
        // v1.3.3 handler read data.model/modelId strings that never exist, so the
        // rebind never fired and a later 401 cooled the wrong provider/key slot
        const m = ev.data && typeof ev.data === 'object' ? ev.data : null;
        const prov2 = m && m.provider ? String(m.provider)
          : (typeof ev.data === 'string' && ev.data.includes('/') ? ev.data.split('/')[0] : '');
        const mid2 = m && m.id ? String(m.id)
          : (typeof ev.data === 'string' && ev.data.includes('/') ? ev.data.split('/')[1] : '');
        if (prov2 && mid2) {
          const newModel = `${prov2}/${mid2}`;
          // key identity survives a SAME-provider model switch: the process still runs
          // on the key it started with — nulling routeKeyIdx made a later failure cool
          // key0 while key1 was the one actually serving (audit #11)
          const switchedProvider = tab.routeProvider !== prov2;
          if (switchedProvider) tab.routeKeyIdx = null;
          tab.routeProvider = prov2;
          tab.model = newModel;
          // F21 (v1.3.5 audit): a CROSS-provider switch cannot be served by the old
          // process — its env still carries the previous provider's key. Restart the
          // tab's pi child on the same session with the new model and the new
          // provider's rotation env; the session file keeps the history.
          if (switchedProvider) restartPiForTab(tabId, newModel);
        }
      }
      if (ev.type === 'response' && ev.success && ev.data?.sessionFile && ev.data.sessionFile !== tab.sessionFile) {
        tab.sessionFile = ev.data.sessionFile;
        // v1.4.3 review #6: keep BOTH fields in step. Everything that relaunches or
        // re-attaches this tab reads `sessionPath`; leaving it null after pi reported a
        // real file meant the conversation was on disk but unreachable.
        if (!tab.sessionPath) tab.sessionPath = tab.sessionFile;
        broadcast({ type: 'pi-session-file', tabId, sessionFile: tab.sessionFile });
      }
      broadcast({ type: 'pi-event', tabId, data: ev });
    }
    // a corrupt/flooded child emitting without any newline degrades to a tail
    // instead of OOMing the single-threaded server
    if (buffer.length > 16 * 1024 * 1024) buffer = buffer.slice(-65536);
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (c) => { if (!isLive()) return; broadcast({ type: 'pi-stderr', tabId, data: String(c).slice(0, 2000) }); });
  const isCurrent = () => { const cur = tabs.get(tabId); return cur && cur.proc === proc; };
  proc.on('error', () => { if (isCurrent()) { const owner = tabs.get(tabId)?.owner ?? null; tabs.delete(tabId); sendTabGone(tabId, -1, owner); } });
  proc.on('exit', (code) => {
    if (!isCurrent()) return; // a newer spawn took over this tabId — its exit must not delete the fresh entry
    const owner = tabs.get(tabId)?.owner ?? null;
    tabs.delete(tabId);
    sendTabGone(tabId, code, owner);
  });
}
function sendToPi(tabId, cmd) {
  const tab = tabs.get(tabId);
  if (!tab) return false;
  try { tab.proc.stdin.write(JSON.stringify(cmd) + '\n'); return true; } catch { return false; }
}
// F21: replace a tab's pi child after a cross-provider model switch — same session
// path and project, new model + new provider's key env. Silent close (the switch is
// not an error) and the SAME owner keeps the tab; the reader reattaches to the new
// child. Anything that fails here leaves the tab gone via the normal exit path.
function restartPiForTab(tabId, model) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const owner = tab.owner ?? null;
  const cwd = tab.cwd;
  // v1.4.3 review #6: a tab is opened with sessionPath = null (a brand-new conversation);
  // pi later reports the file it created via `sessionFile`. The restart carried only
  // sessionPath, so a cross-provider switch — the ONE path that must preserve history —
  // relaunched without `--session` and silently started a fresh context. Prefer the file
  // pi actually wrote, and carry both fields onto the replacement tab.
  const sessionPath = tab.sessionFile || tab.sessionPath || null;
  const thinking = tab.thinking;
  const name = tab.name;
  closeTab(tabId, true);
  const prov = splitModel(model)[0] || null;
  if (prov && loadRouting().providers?.[prov]?.enabled === false) {
    if (owner && owner.readyState === 1) { try { owner.send(JSON.stringify({ type: 'open-denied', tabId, reason: `供应商 ${prov} 已停用` })); } catch { /* gone */ } }
    return;
  }
  const ov = prov ? envOverrideFor(prov) : null;
  const { __keyIdx, ...envExtra } = ov || {};
  const proc = spawnPi({ cwd, sessionPath, model, thinking, name, envExtra });
  // sessionFile starts as the path we passed in: if pi echoes the same file back, the
  // reader's `sessionFile !== tab.sessionFile` guard would not fire and the UI would keep
  // showing "no session yet" for a conversation that is already on disk.
  tabs.set(tabId, { proc, cwd, sessionPath, sessionFile: tab.sessionFile || null, model, thinking: thinking || null, name: name || null, startedAt: Date.now(), routeProvider: prov, routeKeyIdx: ov ? __keyIdx : null, routeKeyEnv: ov ? keyEnvAt(prov, __keyIdx) : null, owner, orphanSince: null });
  if (owner) { try { owner.adopted.add(tabId); } catch { /* socket gone */ } }
  attachPiReader(tabId, proc);
  if (owner && owner.readyState === 1) { try { owner.send(JSON.stringify({ type: 'pi-restarted', tabId, model })); } catch { /* gone */ } }
}

// ---------- ws ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 }); // oversized frames are torn down by ws itself
// A tab belongs to the connection that opened it: its pi-event/rpc/exit frames go
// only there. When the owner connection dies the tab keeps running and frames stop
// fanning out — a reopened window must explicitly {type:'adopt'} to reattach, so a
// foreign connection can never silently read or steer someone else's conversation.
const ownerLive = (tab) => tab && tab.owner && tab.owner.readyState === 1; // ws.OPEN
// pi-exit for a tab that is ALREADY deleted from the Map: the generic broadcast would
// find no owner and fall through to EVERY client. Resolve recipients before the delete
// and address them directly (audit #09 — exit frames leaked tab ids to all connections)
function sendTabGone(tabId, code, formerOwner) {
  const s = JSON.stringify({ type: 'pi-exit', tabId, code });
  if (formerOwner && formerOwner.readyState === 1) { try { formerOwner.send(s); } catch { /* gone */ } }
  for (const c of wss.clients) {
    if (c === formerOwner || !c.adopted || !c.adopted.has(tabId)) continue;
    try { c.send(s); } catch { /* gone */ }
  }
}
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
    if (!msg || typeof msg !== 'object') return; // a literal `null` frame is valid JSON — it must not reach property access
    // light schema gate before any lookup: a type-confused tabId/cwd must never
    // reach path.resolve or the tabs Map as an object
    const strField = (v) => v === undefined || v === null || typeof v === 'string';
    if (typeof msg.type !== 'string' || !strField(msg.tabId) || !strField(msg.cwd) || !strField(msg.model) || !strField(msg.thinking) || !strField(msg.name)) return;
    // a tab-scoped frame with an empty/absent tabId would fall through broadcast's
    // owner lookup into an ALL-CLIENT send — same-token connections stay isolated
    if (['open', 'rpc', 'close', 'detach', 'adopt'].includes(msg.type) && (typeof msg.tabId !== 'string' || !msg.tabId)) return;
    console.log('[ws] frame:', msg.type, msg.tabId || '');
    if (msg.type === 'adopt') {
      const tab = tabs.get(msg.tabId);
      if (tab && !ownerLive(tab)) {
        tab.owner = ws;
        tab.orphanSince = null;
        ws.adopted.add(msg.tabId);
        try { ws.send(JSON.stringify({ type: 'adopted', tabId: msg.tabId })); } catch { /* socket gone */ }
      }
      return;
    }
    if (msg.type === 'open') {
      const { tabId, cwd, model, thinking, name } = msg;
      let sessionPath = msg.sessionPath; // let-bound: the TOCTOU fix below replaces a symlink path with its verified realpath
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
      if (sessionPath) {
        // pi --session takes a filesystem path — hold it to the same boundary as
        // every other session endpoint, or a crafted frame reads/writes outside
        const rootReal = (() => { try { return fs.realpathSync(PI_SESSIONS); } catch { return PI_SESSIONS; } })();
        let real;
        try { real = fs.realpathSync(path.resolve(String(sessionPath))); } catch {
          ws.send(JSON.stringify({ type: 'open-denied', tabId, reason: 'sessionPath not found' }));
          return;
        }
        if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
          ws.send(JSON.stringify({ type: 'open-denied', tabId, reason: 'sessionPath outside sessions dir' }));
          return;
        }
        // v1.4.2 review M8 (TOCTOU): the realpath check verified `real`, but the RAW string
        // went to the child — a symlink swapped between this check and the spawn would make
        // pi follow it outside the sessions root. The verified path IS what we hand over.
        sessionPath = real;
      }
      // F20 (v1.3.5 audit): an open WITHOUT an explicit model used to bypass every
      // default-provider gate entirely (prov stayed null → no disabled check, no key
      // env) and let pi self-select. The configured default model — when one exists —
      // is now the effective open model, so the same gates and key identity apply.
      // No default configured → the ambient/keyless spawn is left as-is on purpose.
      const effOpenModel = model || (loadConfig() || {}).defaultModel || null;
      const prov = effOpenModel ? splitModel(effOpenModel)[0] : null;
      // enabled=false is a global kill switch, not just a fallback-chain filter — an
      // explicit open on a disabled provider must be denied BEFORE the replaced tab is
      // torn down, or a denied open still kills the running session (audit #10)
      if (prov && loadRouting().providers?.[prov]?.enabled === false) {
        ws.send(JSON.stringify({ type: 'open-denied', tabId, reason: `供应商 ${prov} 已停用——在路由页重新启用后再启动` }));
        return;
      }
      closeTab(tabId, true); // replacing a tab stays quiet — the new spawn owns the tabId now
      const ov = prov ? envOverrideFor(prov) : null;
      const { __keyIdx, ...envExtra } = ov || {};
      const proc = spawnPi({ cwd, sessionPath, model: effOpenModel, thinking, name, envExtra });
      tabs.set(tabId, { proc, cwd, sessionPath: sessionPath || null, model: effOpenModel || null, thinking: thinking || null, name: name || null, startedAt: Date.now(), routeProvider: prov, routeKeyIdx: ov ? __keyIdx : null, routeKeyEnv: ov ? keyEnvAt(prov, __keyIdx) : null, owner: ws, orphanSince: null });
      ws.adopted.add(tabId);
      attachPiReader(tabId, proc);
      ws.send(JSON.stringify({ type: 'opened', tabId }));
    } else if (msg.type === 'rpc') {
      const tab = tabs.get(msg.tabId);
      const mine = ownerLive(tab) ? tab.owner === ws : !!(tab && ws.adopted.has(msg.tabId));
      if (!mine) { try { ws.send(JSON.stringify({ type: 'rpc-denied', tabId: msg.tabId })); } catch { /* socket gone */ } return; }
      // set_model is an execution entry too — a disabled provider must not be
      // reachable by steering an existing tab's model (audit #10)
      if (msg.data && typeof msg.data === 'object' && msg.data.type === 'set_model' && msg.data.provider
        && loadRouting().providers?.[String(msg.data.provider)]?.enabled === false) {
        try { ws.send(JSON.stringify({ type: 'rpc-denied', tabId: msg.tabId, reason: `供应商 ${msg.data.provider} 已停用` })); } catch { /* socket gone */ }
        return;
      }
      sendToPi(msg.tabId, msg.data);
    } else if (msg.type === 'close') {
      const tab = tabs.get(msg.tabId);
      const mine = ownerLive(tab) ? tab.owner === ws : !!(tab && ws.adopted.has(msg.tabId));
      if (!mine) return; // only the owner (or an explicit adopter) may kill a tab
      closeTab(msg.tabId); // closeTab announces the exit itself — see the guard in closeTab
    } else if (msg.type === 'detach') {
      // the UI "switched project away from a running session": the tab keeps running
      // but the connection no longer manages it — the orphan TTL (30 min) bounds its
      // lifetime, and `adopt` reclaims it (v1.3.3 audit #10: forgetting the tabId used
      // to leave an unmanaged, un-reapable child)
      const tab = tabs.get(msg.tabId);
      const mine = ownerLive(tab) ? tab.owner === ws : !!(tab && ws.adopted.has(msg.tabId));
      if (!mine || !tab) return;
      tab.owner = null;
      tab.orphanSince = Date.now();
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
    if (ownerLive(tab)) continue; // only a live owner protects a tab from the TTL — nothing else
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
    killTree(tab.proc); // a bare kill() orphans the grandchildren (MCP servers, shell tools)
    const owner = tab.owner ?? null; // capture BEFORE the delete — see sendTabGone
    tabs.delete(tabId);
    // whoever sees the tab disappear first owns the announcement: closeTab here,
    // or the exit handler on a crash. Exactly one pi-exit broadcast, never two, never zero.
    if (!silent) sendTabGone(tabId, 0, owner);
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
// v1.3.8 review P3-12: realContains() proved the TARGET was inside the root, but the
// caller then opened the ORIGINAL (still symlink-bearing) path — a same-user process
// could swap the link in between. resolveInside() returns the already-resolved real
// path so the check and the syscall name the same file. A path whose last components
// do not exist yet still resolves through its nearest existing ancestor (so "not
// found" keeps reporting 404, not 400). Residual: a directory component of the
// resolved path can still be swapped (Windows has no O_NOFOLLOW) — closing that needs
// openat-style handling the platform does not offer here.
const resolveInside = (root, target) => {
  const abs = path.resolve(String(target || ''));
  const real = (() => {
    try { return fs.realpathSync(abs); } catch (e) {
      if (!e || e.code !== 'ENOENT') return null;
      let t = abs; const tail = [];
      for (;;) {
        try { return path.join(fs.realpathSync(t), ...tail); } catch (e2) {
          if (!e2 || e2.code !== 'ENOENT') return null;
          tail.unshift(path.basename(t));
          const up = path.dirname(t);
          if (up === t) return null;
          t = up;
        }
      }
    }
  })();
  return real && realContains(root, real) ? real : null;
};
function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.setEncoding('utf8'); // chunkwise coercion would corrupt multibyte bodies split across packets
    req.on('data', (c) => { b += c; if (b.length > 5e6) { resolve({}); req.destroy(); } });
    req.on('end', () => {
      try {
        const j = JSON.parse(b || '{}');
        resolve(j && typeof j === 'object' ? j : {}); // 'null'/scalars must not explode handler destructuring
      } catch { resolve({}); }
    });
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
const { IMPORT_SOURCES, usageSummary, sessionTree, piSessionInfo, listJsonFilesBounded } = sources;
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
    // v1.4.3 review #15: bounded walk — the old one stat'ed the whole history to keep 300
    const { files, capped } = listJsonFilesBounded(PI_SESSIONS, 2);
    // v1.4.0 review #3: piSessionInfo answers null for a file that vanished between the
    // listing and its stat (rotation, an agent cleaning up, the user deleting it). The
    // filter below only guarded the cwd comparison — with no `cwd` param the `||`
    // short-circuited and the null reached sort()'s `b.mtime` and threw, so ONE dropped
    // file 500'd the whole list on the commonest request the panel makes. Drop the row
    // where it is produced; lib/sources.mjs already does this for its own omp listing.
    const items = files.map(piSessionInfo).filter((s) => s && (!cwdQ || (s.cwd && path.resolve(s.cwd) === path.resolve(cwdQ))));
    items.sort((a, b) => b.mtime - a.mtime);
    // `capped`/`truncated` let the panel say the list is partial instead of posing as all
    return json(res, 200, { sessions: items.slice(0, 300), truncated: capped || items.length > 300 });
}

async function hSessionsDelete(req, res, u) {
    const { path: file } = await readBody(req);
    const root = path.resolve(PI_SESSIONS);
    const abs0 = path.resolve(String(file || ''));
    // P3-12: the check and the unlink must name the same file — resolve once
    const abs = resolveInside(root, abs0);
    if (!abs || !abs.toLowerCase().endsWith('.jsonl')) return json(res, 400, { error: 'bad path' });
    if (!fs.existsSync(abs)) return json(res, 404, { error: 'not found' });
    fs.rmSync(abs, { force: true });
    return json(res, 200, { ok: true, deleted: abs });
}

// API keys are write-only over the API: GET answers '***' for literal keys ($ENV refs
// are not secrets and stay readable — the UI shows the env name), and POST substitutes
// the stored key back when the sentinel round-trips. The UI never pre-fills key inputs.
const KEY_SENTINEL = '***';
// credential-ish header names — deliberately broad: masking too much is round-trip
// safe (POST restores the stored value), missing one leaks it into GET responses and
// "no-keys" backups. Cookie / Ocp-Apim-Subscription-Key / X-Auth-Secret all live here
const CRED_HEADER_RE = /auth|cookie|token|key|secret|credential|session|subscription/i;
// F04 (v1.3.5 audit): a URL can carry secrets OUTSIDE the key field — userinfo
// (https://user:pass@host) and credential-looking query values (?key=sk-...). GET
// responses must not render those either; masking is round-trip safe (POST restores
// via the same-endpoint sentinel logic — and a masked URL no longer matches the old
// endpoint, which fail-closes the key restore: the safe direction).
const scrubUrlCreds = (raw) => {
  if (typeof raw !== 'string' || !raw) return raw;
  let s2 = raw;
  try {
    const u = new URL(s2);
    if (u.username || u.password) { u.username = ''; u.password = ''; s2 = u.toString(); }
    for (const [k, v] of u.searchParams) {
      if (v && CRED_HEADER_RE.test(k)) u.searchParams.set(k, '***');
    }
    s2 = u.toString();
  } catch { /* not a parseable URL — leave as-is */ }
  return s2;
};
// v1.4.3 review #2: the argv scrubber lives in lib/mcp-scrub.mjs (array-shaped: the flag
// consumes its successor, and --flag=value / -H / --auth-token are covered) so the GET
// endpoint and the unit test share one implementation instead of drifting apart.
import { scrubArgSecrets } from './lib/mcp-scrub.mjs';
const maskApiKeys = (doc) => {
  for (const p of Object.values(doc.providers || {})) {
    if (p && typeof p.apiKey === 'string' && p.apiKey && !p.apiKey.startsWith('$')) p.apiKey = KEY_SENTINEL;
    if (p && typeof p.baseUrl === 'string') p.baseUrl = scrubUrlCreds(p.baseUrl);
    const h = p && p.headers;
    if (h && typeof h === 'object') for (const k of Object.keys(h)) {
      if (CRED_HEADER_RE.test(k) && h[k]) h[k] = '***'; // credential headers are secrets too
    }
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
        // v1.3.8 review P2-7/P2-8: a null provider row or a `__proto__` key used to survive
        // the write and then TypeError every reader (`kbfill` walks m.id). Validate the
        // SHAPE here, where a 400 costs nothing, instead of trusting the doc.
        // v1.4.3 review #25: the rules now come from lib/schema.mjs — the same module the
        // backup restore and loadRouting() validate against, so the doors cannot disagree.
        const why = providerRowProblem(name, p);
        if (why) return json(res, 400, { error: why });
        if (p.models == null) p.models = [];
        // credential ownership follows the ENDPOINT — and an old provider with a key
        // but NO baseUrl is an UNKNOWN trust domain, not the same one (audit #02).
        // F04: GET answers with a scrubbed URL, so a plain UI save round-trips the
        // scrubbed form — recognize it and put the stored raw URL back (sentinel
        // style); anything else is a genuinely NEW endpoint and fails the restore closed.
        const prevP = prev.providers?.[name] || {};
        const prevScrub = typeof prevP.baseUrl === 'string' ? scrubUrlCreds(prevP.baseUrl) : prevP.baseUrl;
        const sameKnownEndpoint = !!prevP.baseUrl && p && typeof p.baseUrl === 'string' && (p.baseUrl === prevP.baseUrl || p.baseUrl === prevScrub);
        if (p && typeof p.baseUrl === 'string' && p.baseUrl === prevScrub && prevScrub !== prevP.baseUrl) p.baseUrl = prevP.baseUrl;
        if (p && typeof p.baseUrl === 'string' && !sameKnownEndpoint) {
          if (!p.apiKey || p.apiKey === KEY_SENTINEL) delete p.apiKey;
          if (p.headers && typeof p.headers === 'object') for (const k of Object.keys(p.headers)) {
            if (CRED_HEADER_RE.test(k) && (!p.headers[k] || p.headers[k] === KEY_SENTINEL)) delete p.headers[k];
          }
        }
        if (p && p.apiKey === KEY_SENTINEL) {
          const stored = prevP.apiKey;
          if (stored && sameKnownEndpoint) p.apiKey = stored; // sentinel round-trip: keep the real key
          else delete p.apiKey;
        }
        // credential HEADERS round-trip too: the GET masked them to '***' — a plain
        // save must restore the stored value or it silently destroys the header (audit #03)
        if (p && p.headers && typeof p.headers === 'object') {
          const storedH = prevP.headers && typeof prevP.headers === 'object' ? prevP.headers : {};
          for (const k of Object.keys(p.headers)) {
            if (p.headers[k] === KEY_SENTINEL) {
              if (sameKnownEndpoint && storedH[k]) p.headers[k] = storedH[k];
              else delete p.headers[k];
            }
          }
        }
      }
      fs.mkdirSync(path.dirname(PI_MODELS), { recursive: true });
      atomicWrite(PI_MODELS, JSON.stringify(doc, null, 2));
    }
    return json(res, 200, { ...maskApiKeys(readJson(PI_MODELS) || { providers: {} }), meta: loadModelMeta() });
}

// One provider change = one transaction. The UI used to POST /api/models, then
// /api/routing, then /api/config, and could only reload to reconcile when the second or
// third leg failed (review wave 28, shortcoming 1). These handlers do the whole change
// in lib/providers.mjs: pre-images are restored if any write fails, and a rollback that
// itself fails is reported rather than swallowed.
function providerError(res, e) {
  if (e instanceof ProviderError) return json(res, e.status, { error: e.message, detail: e.detail || null, rollback: e.rollback || [] });
  logErr('provider transaction: ' + redactSecrets((e && e.stack) || String(e)));
  return json(res, 500, { error: (e && e.message) || 'provider transaction failed' });
}
async function hProviderSave(req, res, u) {
    const body = await readBody(req);
    const { name, provider, testModel = null, defaultModel = null } = body || {};
    const prev = readJson(PI_MODELS) || { providers: {} };
    const prevP = (prev.providers || {})[name] || {};
    const clean = provider && typeof provider === 'object' && !Array.isArray(provider) ? { ...provider } : provider;
    // the same credential-ownership rules the bulk /api/models save applies: a '***'
    // sentinel (or a cleared key) must round-trip against the endpoint it came from,
    // and a NEW endpoint must never inherit the old key or credential headers.
    if (clean && typeof clean === 'object') {
      const prevScrub = typeof prevP.baseUrl === 'string' ? scrubUrlCreds(prevP.baseUrl) : prevP.baseUrl;
      const sameKnownEndpoint = !!prevP.baseUrl && typeof clean.baseUrl === 'string' && (clean.baseUrl === prevP.baseUrl || clean.baseUrl === prevScrub);
      if (typeof clean.baseUrl === 'string' && clean.baseUrl === prevScrub && prevScrub !== prevP.baseUrl) clean.baseUrl = prevP.baseUrl;
      if (typeof clean.baseUrl === 'string' && !sameKnownEndpoint) {
        if (!clean.apiKey || clean.apiKey === KEY_SENTINEL) delete clean.apiKey;
        if (clean.headers && typeof clean.headers === 'object') for (const k of Object.keys(clean.headers)) {
          if (CRED_HEADER_RE.test(k) && (!clean.headers[k] || clean.headers[k] === KEY_SENTINEL)) delete clean.headers[k];
        }
      }
      if (clean.apiKey === KEY_SENTINEL) {
        if (prevP.apiKey && sameKnownEndpoint) clean.apiKey = prevP.apiKey;
        else delete clean.apiKey;
      }
      if (clean.headers && typeof clean.headers === 'object') {
        const storedH = prevP.headers && typeof prevP.headers === 'object' ? prevP.headers : {};
        for (const k of Object.keys(clean.headers)) {
          if (clean.headers[k] === KEY_SENTINEL) {
            if (sameKnownEndpoint && storedH[k]) clean.headers[k] = storedH[k];
            else delete clean.headers[k];
          }
        }
      }
    }
    try {
      const out = providers.save({ name, provider: clean, testModel, defaultModel });
      return json(res, 200, {
        ok: true,
        modelsDoc: { ...maskApiKeys(out.models), meta: loadModelMeta() },
        routing: out.routing,
        config: out.config,
        routed: out.routed,
        defaulted: out.defaulted,
      });
    } catch (e) { return providerError(res, e); }
}
async function hProviderDelete(req, res, u) {
    const body = await readBody(req);
    const { name } = body || {};
    try {
      // remove() takes the NAME, not the request body — passing the object stringified
      // to "[object Object]" and every deletion failed with "provider name not allowed"
      const out = providers.remove(name);
      return json(res, 200, {
        ok: true,
        existed: out.existed,
        swept: out.swept,
        modelsDoc: { ...maskApiKeys(out.models), meta: loadModelMeta() },
        routing: out.routing,
        config: out.config,
      });
    } catch (e) { return providerError(res, e); }
}

// v1.4.0 review #5: this probe starts a whole pi process, and three things about it were
// unbounded. (1) stderr had NO reader, so a child that wrote 64KB to stderr blocked on a
// full pipe and the probe simply waited out its 20-second timeout; (2) stdout accumulated
// with no ceiling — one line without a newline grew the string for the entire window;
// (3) every concurrent panel request spawned its own pi, each loading the full agent
// bundle. Single-flight collapses concurrent callers onto one probe, which bounds (3)
// outright; the caps bound (1) and (2).
const MODELS_PROBE_MAX_STDOUT = 1 << 20; // a reply that never terminates within 1MiB is not the rpc protocol
let modelsProbe = null;
function probeModels() {
  if (modelsProbe) return modelsProbe;
  const p = new Promise((resolve) => {
    let buf = '';
    let settled = false;
    let to = null;
    const proc = spawn(process.execPath, [PI_CLI, '--mode', 'rpc', '--no-session'], { cwd: HOME, env: { ...process.env, ...SECRET_ENV }, windowsHide: true });
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      try { killTree(proc); } catch { /* exited already */ }
      resolve(v);
    };
    to = setTimeout(() => done({ models: [] }), 20000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'response' && ev.command === 'get_available_models') return done(ev.data || { models: [] });
      }
      if (buf.length > MODELS_PROBE_MAX_STDOUT) done({ models: [] });
    });
    // draining stderr is the point, not the text: an unread pipe blocks the child, and
    // the child is the thing we are waiting on
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', () => { /* discarded — draining keeps the pipe from filling */ });
    proc.on('error', () => done({ models: [] }));
    // v1.4.3 review #10: the ordinary tab spawn has listened for a stream-level EPIPE
    // since the 1.3.x audit ("an async EPIPE must not become an uncaughtException — the
    // sync try/catch around write() cannot see stream-level errors"); this probe never
    // did. pi dying before it reads stdin turns the write below into an async 'error'
    // event on proc.stdin, which reaches the global uncaughtException handler and that
    // handler exits the whole service. Same guard, same shape.
    proc.stdin.on('error', () => done({ models: [] }));
    try {
      proc.stdin.write(JSON.stringify({ id: 'm1', type: 'get_available_models' }) + '\n');
      proc.stdin.end();
    } catch { /* died before accepting input — error/timeout handlers resolve */ }
  });
  modelsProbe = p;
  // clear the slot from every path (the promise never rejects, but a throw in the
  // executor would otherwise pin a permanently-settled probe against all later callers)
  p.then(() => { modelsProbe = null; }, () => { modelsProbe = null; });
  return p;
}

async function hModelsAvailable(req, res, u) {
    // short-lived rpc to enumerate models (uses pi's own catalog + models.json)
    const result = await probeModels();
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
        // credential ownership follows the endpoint: a URL the user just typed that
        // differs from the stored one must not inherit the stored key — the discover
        // request would otherwise send the old credential to the new address (v1.3.3 audit #01)
        const urlUnchanged = !baseUrl || url === pv.baseUrl;
        if (urlUnchanged) {
          const ov = envOverrideFor(provider);
          key = ov ? Object.values(ov).find((v) => typeof v === 'string') : null;
          if (!key && hasLiteralKey(provider)) key = pv.apiKey;
        }
      }
    }
    if (!url) return json(res, 200, { ok: false, detail: '请先填 API 地址' });
    if (!key && baseUrl && pv.baseUrl && baseUrl !== pv.baseUrl) {
      // we suppressed a stored credential above — say so instead of letting the
      // request 401 opaquely against the new endpoint
      return json(res, 200, { ok: false, detail: '地址已变更：请输入新端点的密钥后再获取模型列表' });
    }
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
      // v1.3.8 review P2-7: models.json can arrive from a restore or the advanced editor —
      // a null row used to throw on m.id and 500 the fill.
      if (!m || typeof m !== 'object' || typeof m.id !== 'string') continue;
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
    // v1.4.3 review #13: two files carry this answer — models.json (contextWindow /
    // maxTokens) and model-meta.json (prices). They were written one after the other, so a
    // failure on the second left the model parameters committed with no prices attached
    // while the endpoint answered 500 — a half-applied fill that no retry could reconcile.
    // Same shape as the provider transaction: snapshot both, write both, restore both.
    fs.mkdirSync(path.dirname(PI_MODELS), { recursive: true });
    const metaPrev = loadModelMeta();
    const meta = { ...metaPrev };
    for (const [id, price] of Object.entries(pricing)) meta[`${provider}|${id}`] = price;
    let modelsPrev = null;
    try { modelsPrev = fs.readFileSync(PI_MODELS, 'utf8'); } catch { modelsPrev = null; }
    try {
      atomicWrite(PI_MODELS, JSON.stringify(doc, null, 2));
      saveModelMeta(meta);
    } catch (e) {
      const rollback = [];
      try { if (modelsPrev === null) fs.rmSync(PI_MODELS, { force: true }); else atomicWrite(PI_MODELS, modelsPrev); }
      catch (re) { rollback.push(`models.json: ${(re && re.message) || re}`); }
      try { saveModelMeta(metaPrev); } catch (re) { rollback.push(`model-meta.json: ${(re && re.message) || re}`); }
      return json(res, 500, {
        error: `知识库填充写入失败：${(e && e.message) || e}`,
        ...(rollback.length ? { rollbackFailed: rollback, detail: '两个文件未能同时回滚，磁盘可能处于部分更新状态' } : { detail: '已回滚到填充前的状态' }),
      });
    }
    return json(res, 200, { fills, pricing, priced: n });
}

async function hProvidersTest(req, res, u) {
    const { model } = await readBody(req);
    if (!model) return json(res, 400, { ok: false, detail: 'model required' });
    return json(res, 200, await testModelReply(model));
}

async function hRouting(req, res, u) {
    // v1.4.2 review M13: `loadRouting()` used to run BEFORE the body arrived, so two
    // concurrent saves both based their edits on the same on-disk snapshot and the slower
    // response silently overwrote the faster one's chains / provider flags / cooldowns.
    // Every other config handler reads after `await readBody`; this one now does too.
    if (req.method === 'POST') {
      const body = await readBody(req);
      const routing = loadRouting();
      if (Array.isArray(body.chains)) routing.chains = body.chains.filter((c) => Array.isArray(c) && c.every((x) => typeof x === 'string' && x.includes('/'))); // a malformed chain would only explode at failover time
      if (body.providers && typeof body.providers === 'object') {
        for (const [name, meta] of Object.entries(body.providers)) {
          // v1.3.8 review P2-7: `{"providers":{"x":null}}` used to throw at meta.enabled and
          // surface as a 500 on an endpoint that only ever receives hand-edited JSON.
          // v1.4.3 review #4: object-ness was all this checked, so `{"keyEnvs":1}` was
          // written and then threw in failover's `for...of` on every failure decision. The
          // deep rules now come from lib/schema.mjs — same module as the restore and loader.
          // (it also carries the P2-8 rule: a provider named `__proto__` read
          // Object.prototype back, truthy, and the assignments below then wrote
          // enabled/priority onto EVERY object in the process.)
          const why = routingMetaProblem(name, meta);
          if (why) return json(res, 400, { error: why });
          if (!Object.hasOwn(routing.providers, name)) routing.providers[name] = {};
          const cur = routing.providers[name];
          if (typeof meta.enabled === 'boolean') cur.enabled = meta.enabled;
          if (Number.isFinite(meta.priority)) cur.priority = meta.priority;
          if (Array.isArray(meta.keyEnvs)) cur.keyEnvs = meta.keyEnvs.map(String);
          if (typeof meta.testModel === 'string') cur.testModel = meta.testModel;
        }
      }
      saveRouting(routing);
    }
    // the GET response reads the file fresh: after a POST it sees the state that was just
    // saved (and any concurrent change), never a stale pre-body snapshot (review M13)
    const routing = loadRouting();
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
      // F19 (v1.3.5 audit): prefer the env NAME captured at spawn — an index into a
      // pool reordered since the tab started would cool a different credential
      const keyId = tab && tab.routeKeyEnv ? tab.routeKeyEnv : (tab && tab.routeKeyIdx != null ? tab.routeKeyIdx : 0);
      coolKey(prov, keyId, msg, 300);
    } else if (/\b429\b|rate[ _-]?limit|too many requests|quota/i.test(msg)) {
      coolModel(model, msg, 300);
    } else {
      coolModel(model, msg, 120);
    }
    return json(res, 200, {
      next: nextInChain(model),
      sameModelKey: sameModelNewKey(model), // the same model still has a usable key — the resend re-opens THIS model, not the next provider
      cooldown: modelCooled(model) || providerCooled(prov),
    });
}

async function hRoutingOk(req, res, u) {
    const { model, tabId } = await readBody(req);
    const tab = tabId ? tabs.get(tabId) : null;
    if (model) clearCool(model, tab ? (tab.routeKeyEnv ?? (tab.routeKeyIdx != null ? tab.routeKeyIdx : undefined)) : undefined);
    return json(res, 200, { ok: true });
}

async function hCron(req, res, u) {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const jobs = body.jobs;
      if (!Array.isArray(jobs)) return json(res, 400, { error: 'jobs array required' });
      if (jobs.length > 100) return json(res, 400, { error: '定时任务最多 100 个' });
      const seenIds = new Set();
      for (const j of jobs) {
        // v1.3.8 review P2-7: `{"jobs":[null]}` used to throw on `j.name` and answer 500
        // from an endpoint whose whole job is validating hand-edited input.
        if (!j || typeof j !== 'object' || Array.isArray(j)) return json(res, 400, { error: '每个任务必须是对象' });
        if (typeof j.name !== 'string' || !j.name || typeof j.prompt !== 'string' || !j.prompt) return json(res, 400, { error: '每个任务需要字符串类型的 name 和 prompt' });
        if (j.id != null && j.id !== '' && !isJobId(j.id)) return json(res, 400, { error: '任务 ID 只能含字母/数字/连字符，最长 64 字符' });
        if (j.id && seenIds.has(j.id)) return json(res, 400, { error: '任务 ID 重复：' + j.id });
        if (j.id) seenIds.add(j.id);
        const tm = j.kind === 'daily' ? /^(\d{2}):(\d{2})$/.exec(j.time || '') : null;
        if (j.kind === 'daily' && (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59)) return json(res, 400, { error: 'daily 任务需要合法的 HH:MM 时间（00:00–23:59）' });
        if (j.kind === 'interval') {
          const m = Number(j.everyMin);
          if (!(m >= 0.5) || !Number.isFinite(m)) return json(res, 400, { error: 'interval 任务需要 ≥0.5 的有限 everyMin 分钟数' });
        }
        if (j.cwd != null && j.cwd !== '') {
          if (typeof j.cwd !== 'string' || !knownProject(j.cwd)) return json(res, 400, { error: 'cwd 必须是已注册的项目目录' });
        }
      }
      const prevRaw = readJson(CRON_FILE) || { jobs: [] };
      // the file on disk is hand-editable/restorable too — `jobs: null` or a null element
      // must not break a legitimate save with a TypeError
      const prev = { jobs: Array.isArray(prevRaw.jobs) ? prevRaw.jobs.filter((x) => x && typeof x === 'object') : [] };
      for (const j of jobs) {
        const old = prev.jobs.find((x) => x.id === j.id);
        if (old) {
          j.lastRun = old.lastRun; j.lastStatus = old.lastStatus; j.lastOutput = old.lastOutput;
          j.lastRunMs = old.lastRunMs; j.lastRunDay = old.lastRunDay;
          // a live run must survive a settings save — but a flag stale past the zombie
          // timeout is a dead marker (settle's save is best-effort) and must not resurrect
          const stale = old.running && old.lastRunMs && (Date.now() - old.lastRunMs > 30 * 60000);
          if (old.running && !stale) j.running = true;
        }
        if (!j.id) j.id = 'job-' + crypto.randomBytes(4).toString('hex');
        if (typeof j.enabled !== 'boolean') j.enabled = true;
      }
      saveJson(CRON_FILE, { jobs });
      // F15 (v1.3.5 audit): a job the user just DISABLED must stop NOW — its live run
      // is killed (settle records the outcome); nothing to do for jobs not running.
      for (const j of jobs) {
        if (j.enabled === false && cron.cancelJob(j.id)) logErr(`cron job ${j.id} cancelled: disabled while running`);
      }
    }
    // bootReset deliberately does NOT run here: it clears running flags, and a
    // panel refresh during a live run would clear the lock and double-spawn the job
    const d = readJson(CRON_FILE) || { jobs: [] };
    // the panel must never receive a row it can only crash on — same accessor as every
    // other reader, so the list endpoint cannot disagree with the scheduler about shape
    d.jobs = cronRows(d);
    return json(res, 200, d);
}

async function hCronDelete(req, res, u) {
    const { id } = await readBody(req);
    if (!isJobId(id)) return json(res, 400, { error: 'bad job id' });
    // F15: deleting a job also stops its current run — a deleted job must not keep
    // executing for up to 15 more minutes
    if (cron.cancelJob(id)) logErr(`cron job ${id} cancelled: deleted while running`);
    const d = readJson(CRON_FILE) || { jobs: [] };
    // delete is also the repair path for a corrupt file: normalising here means one
    // delete cleans out every bad row, not just the one the user aimed at
    d.jobs = cronRows(d).filter((j) => j.id !== id);
    saveJson(CRON_FILE, d);
    return json(res, 200, d);
}

const semverGt = (a, b) => {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
  return false;
};

async function hUpdateCheck(req, res, u) {
    // `current` comes from the LOCAL package.json — it is knowable with no network, and the UI
    // prints it when `updateAvailable` is false. Read it before the fetch so an unreachable or
    // slow GitHub still answers with it (found during the v1.4.1 gate run: with no route to
    // github the field was missing and `npm test` failed on a purely environmental condition).
    const cur = readJson(path.join(__dirname, 'package.json'))?.version || null;
    try {
      const r = await fetch('https://api.github.com/repos/cullysu/pi-workbench/releases/latest', { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'pi-workbench' } });
      const j = await r.json();
      const latest = String(j.tag_name || '').replace(/^v/, '');
      return json(res, 200, { latest: j.tag_name || null, url: j.html_url || null, current: cur, updateAvailable: !!(cur && latest && semverGt(latest, cur)) });
    } catch (e) {
      // no `updateAvailable` here on purpose: offline means UNKNOWN, and the UI claims "already
      // up to date" only on an explicit false.
      return json(res, 200, { latest: null, current: cur, error: String(e.message || e).slice(0, 100) });
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
    const allBranches = u.searchParams.get('all') === '1';
    // P3-12: stat/read the RESOLVED path so a link swap cannot redirect the export
    const abs = resolveInside(root, u.searchParams.get('path') || '');
    if (!abs || !abs.toLowerCase().endsWith('.jsonl')) { res.writeHead(400); return res.end('bad path'); }
    let st0; try { st0 = fs.statSync(abs); } catch { res.writeHead(404); return res.end('not found'); }
    if (st0.size > 100e6) { res.writeHead(413); return res.end('session too large to export (> 100MB)'); }
    const onGone = () => {}; res.on('error', onGone); // client vanished mid-export
    // F28 (v1.3.5 audit): the default export now follows the session's ACTIVE branch
    // only — regenerating a reply used to weave abandoned branches into the exported
    // transcript and present them as the conversation. ?all=1 keeps the whole file,
    // labelled. Parent-walk failures degrade to whole-file (never a broken export).
    let activeIds = null; let otherBranch = 0;
    if (!allBranches) {
      try {
        const parent = new Map(); const ids = new Set(); let last = null;
        let sawParent = false; let idless = false;
        const rl1 = createInterface({ input: fs.createReadStream(abs, { encoding: 'utf8' }), crlfDelay: Infinity });
        for await (const line of rl1) {
          if (!line) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (!j || j.type !== 'message' || !j.message) continue;
          const m = j.message;
          if (m.role !== 'user' && m.role !== 'assistant') continue;
          // F28b (api.test.mjs:306 caught this): a session row with NO id carries no branch
          // information at all. The first version then produced activeIds = EMPTY SET, which
          // is truthy, so the pruner at the write loop dropped EVERY message and the export
          // came out header-only. Without provable branch structure we must export the whole
          // file — pruning is only allowed when we can actually name the branch.
          if (!j.id) { idless = true; continue; }
          if (j.parentId) sawParent = true;
          if (!ids.has(j.id)) { ids.add(j.id); if (j.parentId) parent.set(j.id, j.parentId); last = j.id; }
        }
        rl1.close();
        if (idless || !sawParent || !last) {
          activeIds = null; otherBranch = 0; // degrade to whole-file (never a broken export)
        } else {
          const chain = new Set(); const guard = new Set();
          let cur = last;
          while (cur && !guard.has(cur)) { guard.add(cur); chain.add(cur); cur = parent.get(cur) || null; }
          activeIds = chain; otherBranch = Math.max(0, ids.size - chain.size);
        }
      } catch { activeIds = null; otherBranch = 0; }
    }
    // streamed line-by-line: a big session never sits whole in memory and the
    // event loop keeps serving while the file is walked
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    const NL = '\n';
    const write = (s2) => new Promise((r2) => { if (res.write(s2)) r2(); else res.once('drain', r2); });
    const rl = createInterface({ input: fs.createReadStream(abs, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      await write('# pi-workbench 会话导出' + NL + NL + (allBranches
        ? '> 范围：全部分支（含被放弃的重新生成）' + NL + NL
        : otherBranch > 0
          ? `> 范围：当前对话分支（另有 ${otherBranch} 条其他分支消息未包含；导出全部请加 ?all=1）` + NL + NL
          : '> 范围：当前对话分支' + NL + NL));
      for await (const line of rl) {
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (!j || j.type !== 'message' || !j.message) continue; // F24: bare `null` lines must not throw
        if (activeIds && !(j.id && activeIds.has(j.id))) continue;
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
    } catch (e) {
      // F25 (v1.3.5 audit): a 200 is already on the wire — a mid-stream failure must
      // leave a VISIBLE marker instead of silently truncating the transcript
      try { await write(NL + '> [导出中断：' + String((e && e.message) || e).slice(0, 200) + ']' + NL); } catch { /* client gone */ }
    }
    return res.end();
}

async function hCronRunNow(req, res, u) {
    const { id } = await readBody(req);
    if (!isJobId(id)) return json(res, 400, { error: 'bad job id' });
    const d = readJson(CRON_FILE) || { jobs: [] };
    const job = cronRows(d).find((j) => j.id === id);
    if (!job) return json(res, 404, { error: 'job not found' });
    const started = cron.runCronJob(job);
    saveJson(CRON_FILE, d);
    // a budget-rejected run-now must not report ok — callers treat this as "it ran"
    return json(res, started ? 200 : 503, { ok: started, accepted: started, lastStatus: job.lastStatus });
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
    const known = (cfgc.projects || []).some((pr) => projectKey(pr.path) === projectKey(root || '')); // same identity as registration — case folds only where the filesystem does
    if (!root || !known) return json(res, 400, { error: 'unknown project root' });
    // P3-12: list the resolved directory — a symlinked subdir must not expose names
    // from outside the project
    const base = resolveInside(root, path.resolve(root, rel));
    if (!base) return json(res, 400, { error: 'bad path' });
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
    const known = (cfgc.projects || []).some((pr) => projectKey(pr.path) === projectKey(root || '')); // same identity as registration — case folds only where the filesystem does
    if (!root || !known) return json(res, 400, { error: 'unknown project root' });
    // P3-12: read the resolved path, not the one the client named
    const base = resolveInside(root, path.resolve(root, rel));
    if (!base) return json(res, 400, { error: 'bad path' });
    let st; try { st = fs.statSync(base); } catch { return json(res, 400, { error: 'not found' }); }
    if (st.isDirectory()) return json(res, 400, { error: 'is a directory' });
    // FIFOs (and other non-regular files) pass a !isDirectory check with size 0 —
    // a plain "is it a regular file" gate keeps a writer-less pipe from blocking the
    // single-threaded event loop inside readFileSync (audit #18)
    if (!st.isFile()) return json(res, 400, { error: 'not a regular file' });
    if (st.size > 400000) return json(res, 200, { text: '', tooBig: true, size: st.size });
    const text = fs.readFileSync(base, 'utf8');
    if (text.length > 200000) return json(res, 200, { text: text.slice(0, 200000), truncated: true, size: st.size }); // a silent tail-drop hides the half of the log that matters (audit #23)
    return json(res, 200, { text });
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

// v1.3.8 review P2-6: importers hand the WHOLE file to readFileSync (Claude/Gemini/Aider
// readers) — a restored or hand-placed 2 GB session file would pin the single-threaded
// event loop and blow out memory, while the neighbouring export path has had a cap all
// along. Refuse before reading, and cap the returned entry count so even a file under the
// byte limit cannot produce an unbounded reply.
// v1.4.2 review M12: 100 MB of JSON in memory is a 200-400 MB heap spike on a request that
// also stalls HTTP and the WS stream; and the entry cap truncates anything past 20k rows
// anyway, so a file that big was never usable in the panel. 25 MB keeps every real session
// and bounds the worst-case read.
const MAX_IMPORT_BYTES = 25 * 1000 * 1000;
const MAX_IMPORT_ENTRIES = 20000;
async function hImport(req, res, u, m) {
    const imp = IMPORT_SOURCES[m[1]];
    if (m[2]) {
      const f0 = u.searchParams.get('path');
      const roots = [imp.root, ...(imp.roots ? imp.roots() : [])].filter(Boolean);
      if (!f0 || (roots.length && !roots.some((r) => realContains(r, f0)))) return json(res, 400, { error: 'bad path' });
      if (!roots.length && !(f0 || '').startsWith('opencode://')) return json(res, 400, { error: 'bad path' });
      // v1.4.2 review M12: "root = HOME" made every file under the user's home readable
      // through the aider importer, while its list() only ever returns the two aider history
      // files per directory. Hold the aider importer to the exact file names its own list
      // produces — the import surface is the two histories, not the home directory. The gate
      // keys on the importer NAME, not on how many roots happen to be registered: with one
      // registered project the roots array grew and the old condition silently disabled the
      // check (caught by this wave's own lock run in the full suite).
      if (m[1] === 'aider') {
        const base = path.basename(path.resolve(String(f0)));
        if (!['.aider.chat.history.md', '.aider.history.md'].includes(base)) return json(res, 400, { error: 'aider 导入只接受 .aider.chat.history.md / .aider.history.md' });
      }
      // P3-12: read the RESOLVED target (a swapped link cannot redirect the import)
      const f = String(f0).startsWith('opencode://') ? f0 : (roots.map((r) => resolveInside(r, f0)).find(Boolean) || f0);
      if (!String(f).startsWith('opencode://')) {
        let st = null;
        try { st = fs.statSync(f); } catch { return json(res, 400, { error: '会话文件不存在或不可读' }); }
        if (!st.isFile()) return json(res, 400, { error: 'not a regular file' });
        if (st.size > MAX_IMPORT_BYTES) {
          return json(res, 413, { error: `会话文件过大（${(st.size / 1048576).toFixed(1)} MB），超过 ${MAX_IMPORT_BYTES / 1048576} MB 导入上限`, size: st.size });
        }
      }
      const all = imp.read(f);
      const entries = Array.isArray(all) ? all : [];
      const truncated = entries.length > MAX_IMPORT_ENTRIES;
      // keep the TAIL — an agent session's most recent turns are the ones worth re-reading
      return json(res, 200, { entries: truncated ? entries.slice(-MAX_IMPORT_ENTRIES) : entries, truncated, total: entries.length });
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
  // case-folded compare via projectKey — on Windows a differently-cased path must still resolve to the registered project
  return !!(cwd && (cfgc.projects || []).some((pr) => projectKey(pr.path) === projectKey(String(cwd))));
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
        // P2-7 (v1.3.9 review): `!s.command` accepted ANY truthy value, so `command: {}`
        // or `command: 42` was persisted and then handed to spawn() — which on Windows
        // goes through cmd.exe /c (extensions/mcp-bridge.js), i.e. an object coerced into
        // a command line. A command must be a plain non-empty program token.
        if (!s || typeof s !== 'object') return json(res, 400, { error: `server "${name}" must be an object` });
        if (typeof s.command !== 'string' || !s.command.trim()) {
          return json(res, 400, { error: `server "${name}" needs a command (non-empty string)` });
        }
        if (/[\r\n\0]/.test(s.command)) return json(res, 400, { error: `server "${name}" command must be a single line` });
        if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a) => typeof a !== 'string'))) {
          return json(res, 400, { error: `server "${name}" args must be an array of strings` });
        }
        // v1.4.0 review #6: a count/length budget on args. spawn() hands these to the OS
        // verbatim; past the platform's argument ceiling the child dies with E2BIG/ENAMETOOLONG
        // at connect time, far from the config screen that accepted them.
        if (Array.isArray(s.args)) {
          if (s.args.length > 64) return json(res, 400, { error: `server "${name}" has too many args (max 64)` });
          const total = s.args.reduce((n, a) => n + a.length, 0);
          if (total > 8192) return json(res, 400, { error: `server "${name}" args are too long in total (max 8192 chars)` });
        }
        if (s.env !== undefined && (!s.env || typeof s.env !== 'object' || Array.isArray(s.env))) {
          return json(res, 400, { error: `server "${name}" env must be an object` });
        }
        // v1.4.0 review #6: env VALUES were unchecked, so `{"env":{"K":{}}}` persisted and
        // reached spawn() as an object — coerced to "[object Object]" or rejected by Node,
        // depending on version. Values must be strings; keys must not contain '=' or NUL.
        if (s.env) {
          for (const [k, v] of Object.entries(s.env)) {
            if (typeof v !== 'string') return json(res, 400, { error: `server "${name}" env.${k} must be a string` });
            if (!k || /[=\0]/.test(k)) return json(res, 400, { error: `server "${name}" env name "${k}" is not a valid variable name` });
          }
        }
        if (String(s.command).length > 500) return json(res, 400, { error: `server "${name}" command is too long` });
      }
      const prev = readJson(MCP_FILE) || { mcpServers: {} };
      const prevByName = prev.mcpServers && typeof prev.mcpServers === 'object' ? prev.mcpServers : {};
      for (const [name, s] of Object.entries(servers)) {
        if (!s || typeof s !== 'object') continue;
        const prevS = prevByName[name];
        // F04: GET masks credential-ish args, so a plain save round-trips the masked
        // form — put the stored raw args back when nothing else changed, BEFORE the
        // identity check below (masked args would otherwise read as a changed command)
        if (prevS && typeof prevS === 'object' && Array.isArray(s.args) && Array.isArray(prevS.args)
          && JSON.stringify(s.args) === JSON.stringify(scrubArgSecrets(prevS.args))) s.args = prevS.args;
        // F03 (v1.3.5 audit): the sentinel may only be resolved against the stored
        // server with the SAME identity (command+args). A renamed/re-pointed server
        // must NOT inherit the previous program's secrets — that used to leak one
        // server's env into a completely different command.
        const sameIdentity = !!prevS && typeof prevS === 'object'
          && prevS.command === s.command
          && JSON.stringify(Array.isArray(prevS.args) ? prevS.args : []) === JSON.stringify(Array.isArray(s.args) ? s.args : []);
        if (typeof s.env !== 'object' || s.env === null) continue;
        for (const k of Object.keys(s.env)) {
          if (s.env[k] === '***') {
            const stored = sameIdentity ? prevS.env?.[k] : undefined;
            if (stored !== undefined) s.env[k] = stored; else delete s.env[k];
          }
        }
      }
      fs.mkdirSync(path.dirname(MCP_FILE), { recursive: true }); // F37: config save must not depend on install having run first
      atomicWrite(MCP_FILE, JSON.stringify({ mcpServers: servers }, null, 2)); // MCP env carries secrets
    }
    const doc = readJson(MCP_FILE) || { mcpServers: {} };
    for (const srv of Object.values(doc.mcpServers || {})) {
      if (!srv || typeof srv !== 'object') continue; // F24: a bare `null` row must not throw
      if (typeof srv.env === 'object' && srv.env !== null) for (const k of Object.keys(srv.env)) srv.env[k] = '***'; // env values are secrets, like model keys
      // F04: args can inline credentials (`--token xxx`) — mask just the value
      if (Array.isArray(srv.args)) srv.args = scrubArgSecrets(srv.args);
    }
    return json(res, 200, doc);
}

async function hMcpInstall(req, res, u) {
    const srcDir = path.join(__dirname, 'extensions');
    const bridge = path.join(srcDir, 'mcp-bridge.js');
    if (!fs.existsSync(bridge)) return json(res, 404, { error: 'bridge file missing' });
    const destDir = path.join(HOME, '.pi', 'agent', 'extensions', 'mcp-bridge');
    const parent = path.dirname(destDir);
    // v1.4.2 review M10: the install used to overwrite the LIVE extension in place — entry,
    // package.json, then deps — so a copy/npm failure mid-way left a previously-working
    // extension half-installed. It is now a directory-level transaction: everything is built
    // in a sibling staging dir and swapped in with renames, the same shape the cron lock and
    // the Tauri runtime swap use. A symlink/junction at the destination is refused outright —
    // the swap would otherwise write through it to wherever it points.
    try {
      const destStat = fs.lstatSync(destDir);
      if (destStat.isSymbolicLink()) return json(res, 400, { error: `安装目标 ${destDir} 是符号链接/junction，拒绝写入（先手动移除它）` });
    } catch { /* does not exist yet — the normal clean-machine path */ }
    fs.mkdirSync(parent, { recursive: true });
    const stage = path.join(parent, `.mcp-bridge-stage-${process.pid}-${Date.now()}`);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    // pi discovers a subdirectory extension only via its index entry (dist/core/extensions/loader.js
    // resolveExtensionEntries: index.ts | index.js) — installing it under any other name returns
    // ok:true while the engine finds nothing
    fs.copyFileSync(bridge, path.join(stage, 'index.js'));
    fs.copyFileSync(path.join(srcDir, 'package.json'), path.join(stage, 'package.json'));
    // v1.4.1 review #2 follow-up: the bridge imports a sibling module (the cmd quoting helper).
    // An extension is loaded from ITS OWN directory, so copying only the entry left
    // `import './mcp-cmdline.js'` unresolvable — pi's loader then threw ERR_MODULE_NOT_FOUND
    // and the extension silently stopped working while this endpoint still answered ok:true.
    // Copy every relative import of the entry beside it, and fail closed if the source is gone
    // (an install that reports success but produces an unloadable extension is the bug being
    // fixed here, not an acceptable degraded mode).
    const entrySrc = fs.readFileSync(bridge, 'utf8');
    const relDeps = [...entrySrc.matchAll(/(?:import|export)[^'"`]*?from\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
    for (const dep of relDeps) {
      const from = path.join(srcDir, dep);
      if (!fs.existsSync(from)) {
        fs.rmSync(stage, { recursive: true, force: true });
        return json(res, 500, { ok: false, error: `bridge dependency missing: ${dep}` });
      }
      const to = path.join(stage, dep);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    // typebox is resolved from the extension's own node_modules (pi documents this flow).
    // The packaged runtime bundles it — copy across and skip npm entirely on clean machines.
    const bundledTypebox = path.join(__dirname, 'node_modules', 'typebox');
    if (fs.existsSync(bundledTypebox)) {
      fs.cpSync(bundledTypebox, path.join(stage, 'node_modules', 'typebox'), { recursive: true });
    }
    // v1.4.3 review #5: the dependency install used to run on the LIVE directory, AFTER the
    // old tree had already been renamed to a grave and DELETED. `npm ci` failing there (no
    // network, a registry hiccup, a lock mismatch) returned 500 while the previously-working
    // extension was already gone — the endpoint reported an error and destroyed a working
    // install in the same breath. Everything now happens in the staging dir; the swap is the
    // last step and only runs once the tree is complete and loadable.
    const hasDepInStage = () => fs.existsSync(path.join(stage, 'node_modules', 'typebox'));
    if (!hasDepInStage()) {
      // the committed lock pins typebox by integrity hash; npm ci enforces it.
      // lifecycle scripts are a supply-chain door; typebox needs none.
      const lockSrc = path.join(srcDir, 'package-lock.json');
      if (fs.existsSync(lockSrc)) fs.copyFileSync(lockSrc, path.join(stage, 'package-lock.json'));
      const cmd = fs.existsSync(path.join(stage, 'package-lock.json'))
        ? 'npm ci --omit=dev --no-fund --no-audit --ignore-scripts'
        : 'npm install --omit=dev --no-fund --no-audit --ignore-scripts';
      const r = await execInCwd(stage, cmd, { timeoutMs: 120000 });
      if (r.code !== 0) {
        fs.rmSync(stage, { recursive: true, force: true });
        return json(res, 500, { ok: false, dest: destDir, error: ('typebox 安装失败: ' + (r.err || r.out || ('exit ' + r.code))).slice(0, 400), note: '原有扩展保持不变' });
      }
    }
    // last gate before the swap: the entry must actually load from the staged tree. A tree
    // that installs but cannot resolve its imports is the exact failure the 1.4.1 review
    // found (a missing sibling module answered ok:true), so assert the resolution now —
    // while the old extension is still untouched.
    if (!fs.existsSync(path.join(stage, 'index.js'))) {
      fs.rmSync(stage, { recursive: true, force: true });
      return json(res, 500, { ok: false, dest: destDir, error: 'staged extension has no index.js', note: '原有扩展保持不变' });
    }
    try {
      await import(pathToFileURL(path.join(stage, 'index.js')).href);
    } catch (e) {
      fs.rmSync(stage, { recursive: true, force: true });
      return json(res, 500, { ok: false, dest: destDir, error: ('staged extension does not load: ' + ((e && e.message) || e)).slice(0, 400), note: '原有扩展保持不变' });
    }
    // swap: old → grave, staging → live. A rename failure restores the old tree, so a
    // previously-working extension is never left half-installed (M10).
    const grave = path.join(parent, `.mcp-bridge-old-${process.pid}-${Date.now()}`);
    let hadOld = false;
    try {
      if (fs.existsSync(destDir)) { fs.renameSync(destDir, grave); hadOld = true; }
      fs.renameSync(stage, destDir);
      fs.rmSync(grave, { recursive: true, force: true });
    } catch (e) {
      fs.rmSync(stage, { recursive: true, force: true });
      if (hadOld) { try { fs.renameSync(grave, destDir); } catch { /* the grave stays for manual recovery */ } }
      return json(res, 500, { ok: false, dest: destDir, error: `安装交换失败（${(e && e.message) || e}）${hadOld ? '，原扩展已恢复' : ''}` });
    }
    return json(res, 200, { ok: true, dest: destDir, note: hasDepInStage ? 'typebox installed in staging' : 'typebox was bundled' });
}

async function hBackupExport(req, res, u) {
    // default to scrubbed: only an explicit excludeKeys=0 (the UI's "含密钥" button) carries keys
    try { return json(res, 200, await exportBackupZip(u.searchParams.get('excludeKeys') !== '0')); }
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
  // atomic provider transactions (review wave 28, shortcoming 1)
  ['POST', '/api/provider/save', hProviderSave],
  ['POST', '/api/provider/delete', hProviderDelete],
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
  let u;
  try {
    u = new URL(req.url, 'http://x');
  } catch {
    try { res.writeHead(400); res.end('bad request'); } catch { /* socket gone */ }
    return;
  }
  try {
    if (!hostAllowed(req.headers.host || '')) { res.writeHead(403); return res.end('forbidden host'); }
    if (u.pathname.startsWith('/api/')) {
      // browsers always attach Origin to cross-site fetches — a drive-by page probing
      // 127.0.0.1 must die here even before the token check; local processes can
      // spoof Origin but they can equally just read the token, so this is browser-only armor
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) { res.writeHead(403); return res.end('forbidden origin'); }
      // F01 (v1.3.5 audit): identity challenge for the desktop shells. A port
      // pre-occupier used to pass the shells' `HTTP/1. + 200` probe AND receive the
      // raw API token. Now the shells send a fresh random nonce and NO token; only a
      // genuine server can answer HMAC-SHA256(token, nonce). The endpoint is an HMAC
      // oracle for chosen nonces only — useless without the token, and the shells
      // never send theirs before the proof verifies.
      if (u.pathname === '/api/identify') {
        const nonce = String(u.searchParams.get('n') || '');
        if (!/^[0-9a-f]{16,64}$/.test(nonce)) { res.writeHead(400); return res.end('bad nonce'); }
        const proof = crypto.createHmac('sha256', API_TOKEN).update(nonce).digest('hex');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-piwb-proof': proof, 'cache-control': 'no-store' });
        return res.end('pi-workbench');
      }
      if (req.headers['x-api-token'] !== API_TOKEN) { res.writeHead(403); return res.end('forbidden'); }
      for (const [method, path, handler] of routes) {
        if (method && method !== '*' && method !== req.method) continue; // null/regex rows match any method
        const m = typeof path === 'string' ? (u.pathname === path ? [path] : null) : path.exec(u.pathname);
        if (m) return await handler(req, res, u, m); // await: rejections must hit the catch below, not hang the request
      }
      return json(res, 404, { error: 'not found' });
    }
    return hStatic(req, res, u);
  } catch (e) {
    console.error(redactSecrets(String(e.stack)));
    try { json(res, 500, { error: e.message }); } catch { /* headers already sent */ }
  }
});


server.on('upgrade', (req, socket, head) => {
  // `//[` as the upgrade target makes new URL() throw — an unguarded throw here hit
  // the global uncaughtException handler, which reaps every tab and cron child and
  // EXITS the service. One malformed request must never be that switch (audit #01)
  try {
    const { pathname, searchParams } = new URL(req.url, 'http://x');
    // WS can't carry custom headers — token rides the ?t= query param instead;
    // browsers always send Origin on WS, so cross-site upgrade attempts die here
    const origin = req.headers.origin;
    const originOk = !origin || origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
    if (originOk && hostAllowed(req.headers.host || '') && pathname === '/ws' && searchParams.get('t') === API_TOKEN) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    else socket.destroy();
  } catch {
    try { socket.destroy(); } catch { /* already gone */ }
  }
});

// the shell's tree-kill is Windows-only; on POSIX a dying server must reap its own
// pi process groups (each tab is detached — SIGTERM to the server never reaches them)
for (const sig of ['SIGTERM', 'SIGINT']) {
  try {
    process.on(sig, () => {
      for (const t of tabs.values()) { try { killTree(t.proc); } catch { /* gone */ } }
      process.exit(0);
    });
  } catch { /* handler already installed */ }
}
process.on('exit', () => {
  for (const t of tabs.values()) { try { killTree(t.proc); } catch { /* gone */ } }
  try { cron.shutdown(); } catch { /* best effort */ } // cron children are detached process groups too
});

resolveSecrets();
// cron: clear stale running flags exactly once per process lifetime (never per request)
try {
  const d = readJson(CRON_FILE) || { jobs: [] };
  if (cron.bootReset(d)) saveJson(CRON_FILE, d);
} catch { /* cron state is best-effort at boot */ }

// cron scheduler heartbeat — without this tick is never called and daily/interval
// jobs only ever run via run-now
setInterval(() => { try { cron.tick(); } catch (e) { logErr('cron tick: ' + ((e && e.message) || e)); } }, 20000).unref();

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) server.listen(PORT, '127.0.0.1', () => {
  console.log(`pi-workbench listening on http://127.0.0.1:${PORT}`);
  // Say which credential mode is live. Before v1.3.9 the answer was "none" for a plain
  // `node server.mjs`, and the only symptom was a UI that silently 403'd every request.
  if (!TOKEN_FROM_ENV) {
    console.log(TOKEN_EMBED
      ? 'auth: token embedded in the served page (browser mode). PIWB_EMBED_TOKEN=0 keeps it in the token file only.'
      : `auth: token file only — open http://127.0.0.1:${PORT} from a shell that reads ${TOKEN_FILE}`);
  }
  // per-boot token file (0600 via atomicWrite on POSIX) for the desktop shells —
  // written only when the server owns the token generation
  if (!TOKEN_FROM_ENV) {
    // restrictAcl inside atomicWrite already tightens this file's DACL on Windows (F08)
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
