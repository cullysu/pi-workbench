// backup-terminal.mjs — 配置备份 zip（导出/导入+回滚快照）、迁移扫描、外部终端、受控命令执行
import { walkFiles, collectProc } from './io.mjs';

export function createBackupTerminal(ctx) {
  const ctxKeys = ['CFG_DIR', 'HOME', 'CFG_FILE', 'ROUTING_FILE', 'CRON_FILE', 'MODEL_META_FILE', 'PI_MODELS', 'PI_SETTINGS', 'PI_SKILLS', 'CODEX_SESSIONS', 'CLAUDE_PROJECTS', 'VERSION', 'listSkills', 'createZip', 'readZip', 'spawn', 'fs', 'path'];
  for (const k of ctxKeys) {
    if (ctx[k] === undefined) throw new Error(`createBackupTerminal: missing ctx.${k} — the wiring contract drifted; fix the createBackupTerminal call site`);
  }
  const { CFG_DIR, HOME, CFG_FILE, ROUTING_FILE, CRON_FILE, MODEL_META_FILE, PI_MODELS, PI_SETTINGS, PI_SKILLS, CODEX_SESSIONS, CLAUDE_PROJECTS, VERSION, listSkills, createZip, readZip, spawn, fs, path } = ctx;

  async function exportBackupZip(excludeKeys = false) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const destDir = path.join(CFG_DIR, 'exports');
    fs.mkdirSync(destDir, { recursive: true });
    const zipPath = path.join(destDir, `pi-workbench-backup-${stamp}.zip`);
    const entries = [];
    const add = (name, src) => {
      try {
        if (fs.existsSync(src)) entries.push({ name, data: fs.readFileSync(src) });
      } catch { /* unreadable file: omit it rather than failing the whole backup */ }
    };
    add('workbench/config.json', CFG_FILE);
    add('workbench/routing.json', ROUTING_FILE);
    if (!excludeKeys) add('pi-agent/models.json', PI_MODELS); // keys are the only secret in the set — excludable on demand
    add('workbench/cron.json', CRON_FILE);
    add('workbench/model-meta.json', MODEL_META_FILE);
    add('pi-agent/settings.json', PI_SETTINGS);
    entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify({
      app: 'pi-workbench', version: VERSION, at: new Date().toISOString(), packed: entries.map((e) => e.name),
      skills: listSkills(null).skills.map((s) => s.name),
    }, null, 2)) });
    const zip = createZip(entries);
    fs.writeFileSync(zipPath, zip);
    if (process.platform !== 'win32') { try { fs.chmodSync(zipPath, 0o600); } catch { /* best effort */ } } // the backup may carry plaintext keys
    return { path: zipPath, packed: entries.map((e) => e.name), size: zip.length };
  }
  async function importBackupZip(zipPath) {
    if (!zipPath || !fs.existsSync(zipPath) || !zipPath.toLowerCase().endsWith('.zip')) throw new Error('需要本地 .zip 路径');
    const pre = path.join(CFG_DIR, 'backups', 'pre-import-' + Date.now());
    fs.mkdirSync(pre, { recursive: true });
    // snapshot everything the import may overwrite, so any bad import is rollbackable
    // strict snapshot: a copy failure must abort the import BEFORE any target is
    // touched — a silent snapshot gap would make the rollback below destructive
    for (const [src, name] of [
      [CFG_FILE, 'config.json'], [ROUTING_FILE, 'routing.json'], [CRON_FILE, 'cron.json'],
      [MODEL_META_FILE, 'model-meta.json'], [PI_MODELS, 'models.json'], [PI_SETTINGS, 'settings.json'],
    ]) {
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(pre, name));
    }
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
    // validate everything first — a corrupt entry aborts the whole import before
    // a single target file is touched (the pre-import snapshot above stays for manual rollback)
    const pending = [];
    for (const [name, dest, label] of targets) {
      if (!byName.has(name)) continue;
      if (name.endsWith('.json')) {
        try { JSON.parse(byName.get(name).toString('utf8')); } catch (e) {
          throw new Error(`${label} 不是有效的 JSON（${(e && e.message) || e}），导入已中止，未写入任何文件`);
        }
      }
      pending.push([dest, byName.get(name), label]);
    }
    if (!pending.length) throw new Error('压缩包里没有可识别的备份文件');
    const restored = [];
    try {
      for (const [dest, data, label] of pending) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const tmp = `${dest}.imp-${process.pid}`;
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, dest); // per-file atomic: no torn single file even on a crash
        if (process.platform !== 'win32') { try { fs.chmodSync(dest, 0o600); } catch { /* best effort */ } }
        restored.push(label);
      }
    } catch (e) {
      // write died mid-loop (disk full, permissions, kill): roll every already-written
      // target back from the pre-import snapshot, so a half-imported state never survives
      for (const [dest, , label] of pending.slice(0, restored.length)) {
        const snap = path.join(pre, label);
        try {
          if (fs.existsSync(snap)) fs.copyFileSync(snap, dest);
          else fs.rmSync(dest, { force: true });
        } catch { /* best-effort rollback */ }
      }
      throw new Error(`导入写入失败（${(e && e.message) || e}），已回滚到导入前状态；快照保留在 ${pre}`);
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
    const dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
    if (process.platform === 'win32') {
      spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', 'cmd.exe', '/K', `cd /d "${dir}"`], { windowsHide: true, cwd: dir });
      return { ok: true, cwd: dir };
    }
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', dir], { cwd: dir });
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
  function execInCwd(cwd, cmd) {
    const dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
    const isWin = process.platform === 'win32';
    const exe = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const args = isWin ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
    // 10-min ceiling: a misfired server command must not hang the panel request forever
    return collectProc(spawn, exe, args, { cwd: dir, maxErr: 40000, timeoutMs: 10 * 60000, timeoutTag: '\n[timeout after 10 min]' })
      .then((r) => r.error !== undefined ? { code: -1, out: '', err: r.error, cwd: dir } : { ...r, cwd: dir });
  }
  return { exportBackupZip, importBackupZip, countFiles, migrateScan, openExternalTerm, execInCwd };
}
