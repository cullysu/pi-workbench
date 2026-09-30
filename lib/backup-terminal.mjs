// backup-terminal.mjs — 配置备份 zip（导出/导入+回滚快照）、迁移扫描、外部终端、受控命令执行
import { walkFiles, collectProc } from './io.mjs';

export function createBackupTerminal(ctx) {
  const ctxKeys = ['CFG_DIR', 'HOME', 'CFG_FILE', 'ROUTING_FILE', 'CRON_FILE', 'MODEL_META_FILE', 'PI_MODELS', 'PI_SETTINGS', 'PI_SKILLS', 'CODEX_SESSIONS', 'CLAUDE_PROJECTS', 'VERSION', 'listSkills', 'copyIfExists', 'createZip', 'readZip', 'spawn', 'fs', 'path'];
  for (const k of ctxKeys) {
    if (ctx[k] === undefined) throw new Error(`createBackupTerminal: missing ctx.${k} — the wiring contract drifted; fix the createBackupTerminal call site`);
  }
  const { CFG_DIR, HOME, CFG_FILE, ROUTING_FILE, CRON_FILE, MODEL_META_FILE, PI_MODELS, PI_SETTINGS, PI_SKILLS, CODEX_SESSIONS, CLAUDE_PROJECTS, VERSION, listSkills, copyIfExists, createZip, readZip, spawn, fs, path } = ctx;

  async function exportBackupZip() {
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
    add('pi-agent/models.json', PI_MODELS);
    add('workbench/cron.json', CRON_FILE);
    add('workbench/model-meta.json', MODEL_META_FILE);
    add('pi-agent/settings.json', PI_SETTINGS);
    entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify({
      app: 'pi-workbench', version: VERSION, at: new Date().toISOString(), packed: entries.map((e) => e.name),
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
    // snapshot everything the import may overwrite, so any bad import is rollbackable
    for (const [src, name] of [
      [CFG_FILE, 'config.json'], [ROUTING_FILE, 'routing.json'], [CRON_FILE, 'cron.json'],
      [MODEL_META_FILE, 'model-meta.json'], [PI_MODELS, 'models.json'], [PI_SETTINGS, 'settings.json'],
    ]) copyIfExists(src, path.join(pre, name));
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
  function openExternalTerm(cwd) {
    const dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
    if (process.platform === 'win32') {
      spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', 'cmd.exe', '/K', `cd /d "${dir}"`], { windowsHide: true, cwd: dir });
    } else if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', dir], { cwd: dir });
    } else {
      const term = process.env.COLORTERM || process.env.TERM || 'x-terminal-emulator';
      spawn(term, [], { cwd: dir });
    }
    return { ok: true, cwd: dir };
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
