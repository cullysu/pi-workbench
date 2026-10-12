// backup-terminal.mjs — 配置备份 zip（导出/导入+回滚快照）、迁移扫描、外部终端、受控命令执行
import { walkFiles, collectProc } from './io.mjs';

export function createBackupTerminal(ctx) {
  const ctxKeys = ['CFG_DIR', 'HOME', 'CFG_FILE', 'ROUTING_FILE', 'CRON_FILE', 'MODEL_META_FILE', 'PI_MODELS', 'PI_SETTINGS', 'PI_SKILLS', 'CODEX_SESSIONS', 'CLAUDE_PROJECTS', 'VERSION', 'listSkills', 'createZip', 'readZip', 'spawn', 'fs', 'path'];
  for (const k of ctxKeys) {
    if (ctx[k] === undefined) throw new Error(`createBackupTerminal: missing ctx.${k} — the wiring contract drifted; fix the createBackupTerminal call site`);
  }
  const { CFG_DIR, HOME, CFG_FILE, ROUTING_FILE, CRON_FILE, MODEL_META_FILE, PI_MODELS, PI_SETTINGS, PI_SKILLS, CODEX_SESSIONS, CLAUDE_PROJECTS, VERSION, listSkills, createZip, readZip, spawn, fs, path } = ctx;

  // credential-ish header names — deliberately broad, same rule as the server's mask:
  // missing a credential class (Cookie / Ocp-Apim-Subscription-Key / …) in a "no-keys"
  // backup is worse than masking a functional header the restore keeps anyway
  const CRED_HEADER_RE = /auth|cookie|token|key|secret|credential|session|subscription/i;

  async function exportBackupZip(excludeKeys = false) {
    // second-precision stamps collide: export "without keys" then "with keys" inside
    // the same second and the FIRST path silently points at a keys-bearing zip (audit #06)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + Math.random().toString(36).slice(2, 6);
    const destDir = path.join(CFG_DIR, 'exports');
    fs.mkdirSync(destDir, { recursive: true });
    const zipPath = path.join(destDir, `pi-workbench-backup-${stamp}.zip`);
    const entries = [];
    const add = (name, src) => {
      try {
        if (fs.existsSync(src)) entries.push({ name, data: fs.readFileSync(src) });
      } catch { /* unreadable file: omit it rather than failing the whole backup */ }
    };
    const writePrivate = (file, data) => {
      fs.writeFileSync(file, data, { mode: 0o600 }); // restrictive at CREATION, not after (audit #05)
      if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch { /* best effort */ } }
    };
    add('workbench/config.json', CFG_FILE);
    if (excludeKeys) {
      // routing.json's cooldown entries keep the first 200 chars of provider errors —
      // upstream errors can embed the key/token that triggered them, so a "no keys"
      // backup must not carry them verbatim (audit #04). The rest of routing state
      // (chains, enabled flags, keyEnv NAMES) is not secret and survives.
      try {
        const raw = JSON.parse(fs.readFileSync(ROUTING_FILE, 'utf8'));
        const cds = raw && raw.state && raw.state.cooldowns;
        if (cds && typeof cds === 'object') {
          for (const c of Object.values(cds)) {
            if (c && typeof c === 'object' && typeof c.error === 'string') c.error = '[redacted]';
          }
        }
        const redactedR = path.join(CFG_DIR, 'backups', 'routing.redacted.json');
        fs.mkdirSync(path.dirname(redactedR), { recursive: true });
        writePrivate(redactedR, JSON.stringify(raw, null, 2));
        add('workbench/routing.json', redactedR);
      } catch { /* unreadable routing.json — the backup simply carries no routing config */ }
      // cron run outputs are the same class: the last 400 chars of a run log can echo
      // upstream error text — strip them from a keys-free backup. Redaction failure
      // must fail CLOSED: falling back to the raw file would export the very secrets
      // the user asked to exclude (audit #04)
      try {
        const rawC = JSON.parse(fs.readFileSync(CRON_FILE, 'utf8'));
        if (rawC && Array.isArray(rawC.jobs)) {
          for (const j of rawC.jobs) { if (j && typeof j === 'object' && typeof j.lastOutput === 'string' && j.lastOutput) j.lastOutput = '[redacted]'; }
        }
        const redactedC = path.join(CFG_DIR, 'backups', 'cron.redacted.json');
        fs.mkdirSync(path.dirname(redactedC), { recursive: true });
        writePrivate(redactedC, JSON.stringify(rawC, null, 2));
        add('workbench/cron.json', redactedC);
      } catch { /* omit cron.json from a keys-free backup rather than pack it raw */ }
    } else add('workbench/routing.json', ROUTING_FILE);
    if (excludeKeys) {
      // keep the provider/model TOPOLOGY with the secrets stripped — dropping the
      // whole file used to erase every baseUrl and model list from a "safe" backup
      try {
        const raw = JSON.parse(fs.readFileSync(PI_MODELS, 'utf8'));
        if (raw && typeof raw.providers === 'object') {
          for (const p of Object.values(raw.providers)) {
            if (!p || typeof p !== 'object') continue;
            if (typeof p.apiKey === 'string') delete p.apiKey;
            const h = p.headers;
            if (h && typeof h === 'object') for (const k of Object.keys(h)) {
              if (CRED_HEADER_RE.test(k) && h[k]) delete h[k];
            }
          }
          const redacted = path.join(CFG_DIR, 'backups', 'models.redacted.json');
          fs.mkdirSync(path.dirname(redacted), { recursive: true });
          writePrivate(redacted, JSON.stringify(raw, null, 2));
          add('pi-agent/models.json', redacted);
        }
      } catch { /* unreadable models.json — the backup simply carries no model config */ }
    } else add('pi-agent/models.json', PI_MODELS);
    if (!excludeKeys) add('workbench/cron.json', CRON_FILE); // excludeKeys branch above already added the redacted copy
    add('workbench/model-meta.json', MODEL_META_FILE);
    add('pi-agent/settings.json', PI_SETTINGS);
    entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify({
      app: 'pi-workbench', version: VERSION, at: new Date().toISOString(), packed: entries.map((e) => e.name),
      keysIncluded: !excludeKeys, // downstream tooling can detect scrubbed vs credential-bearing backups without unzipping
      skills: listSkills(null).skills.map((s) => s.name),
    }, null, 2)) });
    const zip = createZip(entries);
    fs.writeFileSync(zipPath, zip, { mode: 0o600 }); // the backup may carry plaintext keys
    if (process.platform !== 'win32') { try { fs.chmodSync(zipPath, 0o600); } catch { /* best effort */ } }
    return { path: zipPath, packed: entries.map((e) => e.name), size: zip.length };
  }
  let importInFlight = false;
  async function importBackupZip(zipPath) {
    if (importInFlight) throw new Error('另一个导入正在进行中，请稍后再试');
    importInFlight = true;
    try {
      return await importBackupZipInner(zipPath);
    } finally {
      importInFlight = false;
    }
  }
  async function importBackupZipInner(zipPath) {
    if (!zipPath || !fs.existsSync(zipPath) || !zipPath.toLowerCase().endsWith('.zip')) throw new Error('需要本地 .zip 路径');
    const pre = path.join(CFG_DIR, 'backups', 'pre-import-' + Date.now());
    fs.mkdirSync(pre, { recursive: true, mode: 0o700 }); // snapshots carry keys — the dir itself must be private
    // snapshot everything the import may overwrite, so any bad import is rollbackable
    // strict snapshot: a copy failure must abort the import BEFORE any target is
    // touched — a silent snapshot gap would make the rollback below destructive
    for (const [src, name] of [
      [CFG_FILE, 'config.json'], [ROUTING_FILE, 'routing.json'], [CRON_FILE, 'cron.json'],
      [MODEL_META_FILE, 'model-meta.json'], [PI_MODELS, 'models.json'], [PI_SETTINGS, 'settings.json'],
    ]) {
      if (!fs.existsSync(src)) continue;
      const snap = path.join(pre, name);
      fs.copyFileSync(src, snap);
      if (process.platform !== 'win32') { try { fs.chmodSync(snap, 0o600); } catch { /* best effort */ } } // snapshots carry the same keys as the originals
    }
    // a config backup never approaches 64 MB total — the tighter budget bounds a hostile archive's inflate work
    if (fs.statSync(zipPath).size > 128 * 1024 * 1024) throw new Error('备份文件超过 128MB 压缩输入上限'); // the inflate budget bounds output — this bounds the input itself
    const entries = readZip(fs.readFileSync(zipPath), { maxTotal: 64 * 1024 * 1024 });
    const byName = new Map(entries.map((e) => [e.name.split('\\').join('/'), e.data]));
    const targets = [
      ['workbench/config.json', CFG_FILE, 'config.json'],
      ['workbench/routing.json', ROUTING_FILE, 'routing.json'],
      ['workbench/cron.json', CRON_FILE, 'cron.json'],
      ['workbench/model-meta.json', MODEL_META_FILE, 'model-meta.json'],
      ['pi-agent/models.json', PI_MODELS, 'models.json'],
      ['pi-agent/settings.json', PI_SETTINGS, 'settings.json'],
    ];
    // validate everything first — a corrupt entry aborts the whole import before
    // a single target file is touched (the pre-import snapshot above stays for manual rollback)
    const pending = [];
    for (const [name, dest, label] of targets) {
      if (!byName.has(name)) continue;
      if (name.endsWith('.json')) {
        let doc;
        try { doc = JSON.parse(byName.get(name).toString('utf8')); } catch (e) {
          throw new Error(`${label} 不是有效的 JSON（${(e && e.message) || e}），导入已中止，未写入任何文件`);
        }
        // syntax-valid garbage must not overwrite live config either — per-file field gates
        // ({} used to pass and destroy the projects list)
        const shaped = doc && typeof doc === 'object' && !Array.isArray(doc) && (() => {
          if (name === 'workbench/config.json') return Array.isArray(doc.projects) && doc.projects.every((x) => x && typeof x === 'object' && typeof x.path === 'string'); // [null] used to pass
          if (name === 'workbench/cron.json') return Array.isArray(doc.jobs) && doc.jobs.every((x) => x && typeof x === 'object'
            && (x.kind !== 'daily' || /^\d{2}:\d{2}$/.test(String(x.time || '')))
            && (x.kind !== 'interval' || Number(x.everyMin) > 0)); // a time-less daily used to crash the whole tick
          if (name === 'workbench/routing.json') {
            // `{"state":1}` / `{"chains":[null]}` are valid JSON but poison every
            // consumer — the scalar survives `||` and assigning .cooldowns on a
            // primitive throws; a null chain breaks indexOf mid-fallback (audit #07)
            if (doc.chains !== undefined && (!Array.isArray(doc.chains) || !doc.chains.every((c) => Array.isArray(c) && c.every((x) => typeof x === 'string' && x)))) return false;
            if (doc.state !== undefined && (!doc.state || typeof doc.state !== 'object' || Array.isArray(doc.state))) return false;
            if (doc.state && doc.state.cooldowns !== undefined && (!doc.state.cooldowns || typeof doc.state.cooldowns !== 'object' || Array.isArray(doc.state.cooldowns))) return false;
            return true;
          }
          if (name === 'pi-agent/models.json') return doc.providers === undefined || (!!doc.providers && typeof doc.providers === 'object' && !Array.isArray(doc.providers));
          return true; // model-meta / settings: object-ness is the contract today
        })();
        if (!shaped) throw new Error(`${label} 的内容结构与备份格式不符（缺少必需字段），导入已中止，未写入任何文件`);
      }
      pending.push([dest, byName.get(name), label]);
    }
    if (!pending.length) throw new Error('压缩包里没有可识别的备份文件');
    const restored = [];
    try {
      for (const [dest, rawData, label] of pending) {
        let data = rawData; // the models.json merge may replace the payload
        // a redacted restore must not delete the live machine's credentials: merge the
        // incoming providers over the current ones, keeping existing apiKey/headers
        if (label === 'models.json') {
          try {
            const incoming = JSON.parse(data.toString('utf8'));
            const current = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, 'utf8')) : null;
            if (incoming && current && incoming.providers && current.providers) {
              for (const [pk, pv] of Object.entries(incoming.providers)) {
                const cur = current.providers?.[pk];
                if (pv && typeof pv === 'object') {
                  // credential ownership follows the ENDPOINT, not the provider name:
                  // both sides must name the SAME baseUrl — a missing URL is an unknown
                  // trust domain, not a match (audit #02)
                  const sameEndpoint = !!pv.baseUrl && !!cur?.baseUrl && pv.baseUrl === cur.baseUrl;
                  if (sameEndpoint) {
                    if (!pv.apiKey && cur?.apiKey) pv.apiKey = cur.apiKey;
                    if (cur?.headers) pv.headers = { ...cur.headers, ...(pv.headers || {}) };
                  }
                }
              }
              data = Buffer.from(JSON.stringify(incoming, null, 2));
            }
          } catch { /* unparseable current state — import as-is */ }
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const tmp = `${dest}.imp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; // unique: two concurrent imports must not share a temp file
        fs.writeFileSync(tmp, data, { mode: 0o600 }); // restrictive at CREATION — no 0644 window before the rename (audit #05)
        if (process.platform !== 'win32') { try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ } }
        fs.renameSync(tmp, dest); // per-file atomic: no torn single file even on a crash
        restored.push(label);
      }
    } catch (e) {
      // write died mid-loop (disk full, permissions, kill): roll every already-written
      // target back from the pre-import snapshot, so a half-imported state never survives
      const rollFailed = [];
      for (const [dest, , label] of pending.slice(0, restored.length)) {
        const snap = path.join(pre, label);
        try {
          if (fs.existsSync(snap)) fs.copyFileSync(snap, dest);
          else fs.rmSync(dest, { force: true });
        } catch (re) { rollFailed.push(`${label}: ${re.message}`); }
      }
      const rollNote = rollFailed.length ? `；警告：${rollFailed.length} 个文件回滚失败（${rollFailed.join('；')}），快照保留在 ${pre}，请手动恢复` : `；快照保留在 ${pre}`;
      throw new Error(`导入写入失败（${(e && e.message) || e}），${rollFailed.length ? '部分' : '已'}回滚到导入前状态${rollNote}`);
    }
    return { restored, backup: pre };
  }
  function countFiles(root, ext, max = 400) {
    return walkFiles(root, { exts: [ext.toLowerCase()], maxDepth: 4, maxFiles: max }).length;
  }
  function migrateScan() {
    const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
    const skillCount = listSkills(null).skills.length;
    const fileCount = (dir) => {
      const n = countFiles(dir, '.jsonl');
      return n >= 400 ? '400+ 个 jsonl' : `${n} 个 jsonl`; // countFiles caps at 400 — never show a cap as a total
    };
    const sources = [
      { id: 'models', name: '模型与密钥', path: PI_MODELS, found: exists(PI_MODELS), detail: exists(PI_MODELS) ? '已有 models.json' : '还没有 models.json' },
      { id: 'routing', name: '回退路由', path: ROUTING_FILE, found: exists(ROUTING_FILE), detail: exists(ROUTING_FILE) ? '已有 routing.json' : '还没有 routing.json' },
      { id: 'skills', name: '技能', path: PI_SKILLS, found: skillCount > 0, detail: `${skillCount} 个已发现` },
      { id: 'codex', name: 'Codex 会话', path: CODEX_SESSIONS, found: exists(CODEX_SESSIONS), detail: exists(CODEX_SESSIONS) ? fileCount(CODEX_SESSIONS) : '未安装' },
      { id: 'claude', name: 'Claude 会话', path: CLAUDE_PROJECTS, found: exists(CLAUDE_PROJECTS), detail: exists(CLAUDE_PROJECTS) ? fileCount(CLAUDE_PROJECTS) : '未安装' },
      { id: 'zcode', name: 'ZCode 会话', path: path.join(HOME, '.zcode'), found: exists(path.join(HOME, '.zcode')), detail: exists(path.join(HOME, '.zcode')) ? '本机有 .zcode 目录' : '未安装' },
    ];
    return { sources };
  }
  async function openExternalTerm(cwd) {
    // an explicit but dead cwd must ERROR, not silently reopen on HOME — the user
    // would type commands believing they target the project (audit #16)
    if (cwd && !fs.existsSync(cwd)) return { ok: false, cwd, error: `目录不存在：${cwd}` };
    const dir = cwd || HOME;
    if (process.platform === 'win32') {
      // an async spawn failure (ENOENT/race) must not become an uncaughtException —
      // the response is already gone, but the service must survive (audit #17)
      spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', 'cmd.exe', '/K', `cd /d "${dir}"`], { windowsHide: true, cwd: dir }).on('error', () => {});
      return { ok: true, cwd: dir };
    }
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', dir], { cwd: dir }).on('error', () => {});
      return { ok: true, cwd: dir };
    }
    // linux: no assumption about the desktop environment — walk the common terminal
    // emulators, the first one whose spawn survives its error tick wins; when none
    // exists the panel gets a real error instead of a silent no-op
    const candidates = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'alacritty', 'kitty', 'terminator', 'tilix', 'xterm'];
    for (const term of candidates) {
      const launched = await new Promise((resolve) => {
        let settled = false;
        try {
          const p = spawn(term, [], { cwd: dir, windowsHide: true, stdio: 'ignore', detached: true });
          p.on('error', () => { if (!settled) { settled = true; resolve(false); } });
          setTimeout(() => { if (!settled) { settled = true; try { p.unref(); } catch { /* already gone */ } resolve(true); } }, 400);
        } catch { resolve(false); }
      });
      if (launched) return { ok: true, cwd: dir, term };
    }
    return { ok: false, cwd: dir, error: `未找到可用的终端模拟器（尝试过: ${candidates.join(', ')}）` };
  }
  function execInCwd(cwd, cmd, opts = {}) {
    // same rule as the terminal opener: a registered-but-missing directory errors
    // instead of silently executing against HOME (audit #16)
    if (cwd && !fs.existsSync(cwd)) return Promise.resolve({ code: -1, out: '', err: `目录不存在：${cwd}`, cwd });
    const dir = cwd || HOME;
    const isWin = process.platform === 'win32';
    const exe = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const args = isWin ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
    // 10-min ceiling: a misfired server command must not hang the panel request forever
    return collectProc(spawn, exe, args, { cwd: dir, maxErr: 40000, timeoutMs: opts.timeoutMs || 10 * 60000, timeoutTag: '\n[timeout after 10 min]' })
      .then((r) => r.error !== undefined ? { code: -1, out: '', err: r.error, cwd: dir } : { ...r, cwd: dir });
  }
  return { exportBackupZip, importBackupZip, countFiles, migrateScan, openExternalTerm, execInCwd };
}
