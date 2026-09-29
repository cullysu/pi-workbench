// backupTerminal.mjs — 备份恢复/迁移扫描/外部终端/命令执行（从 server.mjs 抽出，工厂注入依赖）

export function createBackupTerminal(ctx) {
  const { CFG_DIR, HOME, PI_SESSIONS, IMPORT_SOURCES, CFG_FILE, ROUTING_FILE, CRON_FILE, MODEL_META_FILE, PI_MODELS, PI_SETTINGS, PI_SKILLS, CODEX_SESSIONS, CLAUDE_PROJECTS, listSkills, copyIfExists, createZip, readZip, logErr, spawn, SECRET_ENV, fs, path } = ctx;
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
}async function importBackupZip(zipPath) {
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
}function countFiles(root, ext, max = 400) {
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
}function migrateScan() {
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
}function openExternalTerm(cwd) {
  const dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
  spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', 'cmd.exe', '/K', `cd /d "${dir}"`], { windowsHide: true, cwd: dir });
  return { ok: true, cwd: dir };
}function execInCwd(cwd, cmd) {
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
  return { exportBackupZip, importBackupZip, countFiles, migrateScan, openExternalTerm, execInCwd };
}
