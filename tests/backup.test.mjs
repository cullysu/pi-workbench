// tests/backup.test.mjs — P3-23 (v1.3.9 review): the import rollback FAILURE path
// had no test. The success path was covered indirectly (a good import works); what
// nobody exercised is a write dying mid-loop and the rollback itself not being able
// to restore a target — the single worst state this module can reach, because the
// user's live config is then half-imported and the only record is a snapshot path
// buried in an error string.
//
// createBackupTerminal takes `fs` through ctx (dependency injection), so the test
// drives a fault-injecting fs double instead of fighting real file permissions —
// the branch under test is "the filesystem said no", and an injected syscall is a
// precise way to say exactly that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import realFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackupTerminal } from '../lib/backup-terminal.mjs';
import { createZip, readZip } from '../zip.mjs';

function tree() {
  const home = realFs.mkdtempSync(path.join(os.tmpdir(), 'piwb-bk-'));
  const cfgDir = path.join(home, '.pi-workbench');
  const piAgent = path.join(home, '.pi', 'agent');
  realFs.mkdirSync(cfgDir, { recursive: true });
  realFs.mkdirSync(piAgent, { recursive: true });
  const files = {
    CFG_FILE: path.join(cfgDir, 'config.json'),
    ROUTING_FILE: path.join(cfgDir, 'routing.json'),
    CRON_FILE: path.join(cfgDir, 'cron.json'),
    MODEL_META_FILE: path.join(cfgDir, 'model-meta.json'),
    PI_MODELS: path.join(piAgent, 'models.json'),
    PI_SETTINGS: path.join(piAgent, 'settings.json'),
  };
  realFs.writeFileSync(files.CFG_FILE, JSON.stringify({ projects: [{ path: home, name: 'live' }], lang: 'zh' }));
  realFs.writeFileSync(files.ROUTING_FILE, JSON.stringify({ chains: [] }));
  realFs.writeFileSync(files.PI_MODELS, JSON.stringify({ providers: {} }));
  return { home, cfgDir, files };
}

// A backup zip that restores config.json + routing.json (cron.json absent, so the
// target list is exactly two files and "after one write" is a reachable state).
function backupZip(t, label = 'incoming') {
  const entries = [
    { name: 'workbench/config.json', data: Buffer.from(JSON.stringify({ projects: [{ path: t.home, name: label }], lang: 'zh' })) },
    { name: 'workbench/routing.json', data: Buffer.from(JSON.stringify({ chains: [] })) },
  ];
  const zpath = path.join(t.home, 'backup.zip');
  realFs.writeFileSync(zpath, createZip(entries));
  return zpath;
}

function makeBT(t, fsish, extra = {}) {
  return createBackupTerminal({
    CFG_DIR: t.cfgDir, HOME: t.home, ...t.files,
    PI_SKILLS: path.join(t.home, '.pi', 'skills'),
    CODEX_SESSIONS: path.join(t.home, '.codex'), CLAUDE_PROJECTS: path.join(t.home, '.claude'),
    VERSION: '1.3.9', listSkills: () => ({ skills: [] }), createZip, readZip,
    spawn: () => { throw new Error('unused'); }, fs: fsish, path,
    ...extra,
  });
}

test('a write dying mid-import rolls the already-written target back', async () => {
  const t = tree();
  const zpath = backupZip(t);
  const before = realFs.readFileSync(t.files.CFG_FILE, 'utf8');
  let renameCount = 0;
  const faultFs = {
    ...realFs,
    renameSync: (from, to) => {
      renameCount++;
      // 1 = config.json (succeeds), 2 = routing.json → die here
      if (renameCount === 2) { const e = new Error('ENOSPC: no space left on device, rename'); e.code = 'ENOSPC'; throw e; }
      return realFs.renameSync(from, to);
    },
  };
  const bt = makeBT(t, faultFs);
  await assert.rejects(() => bt.importBackupZip(zpath), (e) => {
    assert.match(e.message, /导入写入失败/);
    assert.match(e.message, /已回滚到导入前状态/, 'the rollback must claim success only when it succeeded');
    return true;
  });
  // the live config must be byte-identical to before the import
  assert.equal(realFs.readFileSync(t.files.CFG_FILE, 'utf8'), before);
});

test('a rollback that cannot restore a target says so instead of claiming success', async () => {
  const t = tree();
  const zpath = backupZip(t);
  let renameCount = 0;
  const faultFs = {
    ...realFs,
    renameSync: (from, to) => {
      renameCount++;
      if (renameCount === 2) { const e = new Error('ENOSPC: no space left on device, rename'); e.code = 'ENOSPC'; throw e; }
      return realFs.renameSync(from, to);
    },
    // the rollback copies snapshots BACK over the live targets; refuse the first one
    copyFileSync: (from, to, mode) => {
      if (String(from).includes('pre-import-') && !String(to).includes('pre-import-')) {
        const e = new Error('EPERM: operation not permitted, copyfile'); e.code = 'EPERM'; throw e;
      }
      return realFs.copyFileSync(from, to, mode);
    },
  };
  const bt = makeBT(t, faultFs);
  let caught = null;
  try { await bt.importBackupZip(zpath); } catch (e) { caught = e; }
  assert.ok(caught, 'a failed rollback must still throw');
  // the wording must not say "已回滚" — that is the lie the audit item is about
  assert.match(caught.message, /部分回滚到导入前状态/);
  assert.match(caught.message, /回滚失败/);
  assert.match(caught.message, /快照保留在/); // and it must say where the manual restore lives
  assert.match(caught.message, /config\.json/, 'the failing file is named, not summarised as "some files"');
  // the snapshot really exists on disk, so the message is actionable
  const m = caught.message.match(/快照保留在 ([^，；]+)/);
  assert.ok(m, 'snapshot path present in the message');
  assert.ok(realFs.existsSync(m[1].trim()), 'the snapshot path in the message must exist');
});

test('a partial archive imports only the files it contains, and keeps a snapshot', async () => {
  const t = tree();
  const zpath = backupZip(t);
  const before = realFs.readFileSync(t.files.CFG_FILE, 'utf8');
  let writes = 0;
  const faultFs = {
    ...realFs,
    renameSync: (from, to) => { writes++; return realFs.renameSync(from, to); },
  };
  const bt = makeBT(t, faultFs);
  // model-meta.json with a bad shape is rejected during validation, before any write
  realFs.writeFileSync(zpath, createZip([
    { name: 'workbench/config.json', data: Buffer.from(JSON.stringify({ projects: [{ path: t.home, name: 'x' }] })) },
  ]));
  // config.json alone is legal — this should import, proving the gate is per file
  const out = await bt.importBackupZip(zpath);
  assert.deepEqual(out.restored, ['config.json']);
  assert.equal(writes, 1);
  assert.notEqual(realFs.readFileSync(t.files.CFG_FILE, 'utf8'), before);
  assert.ok(realFs.existsSync(out.backup), 'the pre-import snapshot directory is reported and kept');
});

test('an invalid archive aborts before touching anything', async () => {
  const t = tree();
  const before = realFs.readFileSync(t.files.CFG_FILE, 'utf8');
  const zpath = path.join(t.home, 'bad.zip');
  realFs.writeFileSync(zpath, createZip([
    { name: 'workbench/config.json', data: Buffer.from('{"projects":[null]}') }, // syntactically fine, semantically poison
  ]));
  const bt = makeBT(t, realFs);
  await assert.rejects(() => bt.importBackupZip(zpath), /内容结构与备份格式不符/);
  assert.equal(realFs.readFileSync(t.files.CFG_FILE, 'utf8'), before, 'no target touched on a rejected archive');
});

// v1.4.1 review #3: the ACL step was invisible. `icacls` reporting failure was swallowed and
// nothing anywhere said the credential-bearing export kept its inherited DACL, so the fix is
// not "call icacls harder" but "never let the result disappear" — asserted at the receipt.
test('a failed icacls reaches the backup receipt instead of vanishing (review #3)', async () => {
  const t = tree();
  const bt = makeBT(t, realFs, {
    acl: { platform: 'win32', env: { USERNAME: 'me' }, run: () => ({ status: 1, stderr: 'Access is denied.' }) },
  });
  const out = await bt.exportBackupZip(false);
  assert.ok(Array.isArray(out.aclWarnings) && out.aclWarnings.length >= 1, 'the receipt must carry the ACL failure');
  assert.match(out.aclWarnings[0], /icacls failed \(1\)/);
});

test('a clean ACL run adds nothing to the receipt (review #3)', async () => {
  const t = tree();
  const bt = makeBT(t, realFs, {
    acl: { platform: 'win32', env: { USERNAME: 'me' }, run: () => ({ status: 0, stdout: 'Successfully processed 1 files' }) },
  });
  const out = await bt.exportBackupZip(false);
  assert.equal(out.aclWarnings, undefined, 'no noise when nothing failed');
});
