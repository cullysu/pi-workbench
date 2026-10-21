// Locks for the v1.4.1 review fixes that live in Node code.
//
// Review #1 (predictable Tauri shell token) is locked in Rust, not here:
// `tauri/src/main.rs::tests::token_entropy_comes_from_the_os_rng` asserts the entropy comes
// from the OS RNG, because that code only builds on Windows.
//
// Everything below asserts BEHAVIOUR, not source text: the old code's failure mode was a
// call whose result was never inspected, and a source-level assertion would have passed both
// before and after the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildCmdLine, quoteCmdArg } from '../extensions/mcp-cmdline.js';
import { restrictWindowsAcl } from '../lib/win-acl.mjs';

// ---------------------------------------------------------------------------
// review #2 — cmd.exe argument construction
// ---------------------------------------------------------------------------

test('quoteCmdArg leaves a bare-safe token untouched', () => {
  for (const s of ['npx', '--yes', '@scope/pkg', './rel/path', 'C:\\tools\\x.cmd', 'a=b', 'plain']) {
    assert.equal(quoteCmdArg(s), s);
  }
});

test('quoteCmdArg quotes anything cmd would otherwise split', () => {
  assert.equal(quoteCmdArg('with space'), '"with space"');
  assert.equal(quoteCmdArg('a&b'), '"a&b"'); // unquoted, cmd ran `a` and then `b`
  assert.equal(quoteCmdArg('a|b'), '"a|b"');
  assert.equal(quoteCmdArg('a>b'), '"a>b"');
  assert.equal(quoteCmdArg('(paren)'), '"(paren)"');
  assert.equal(quoteCmdArg('x^y'), '"x^y"');
  assert.equal(quoteCmdArg('semi;colon'), '"semi;colon"');
  assert.equal(quoteCmdArg(''), '""');
});

test('quoteCmdArg refuses the characters cmd cannot escape', () => {
  // `%VAR%`/`!VAR!` expand inside quotes, a `"` ends the quoting, CR/LF ends the command:
  // half-escaping these would be a silent mangling, which is what this fix is about
  for (const bad of ['q"uote', 'pct%VAR%', 'bang!x', 'nl\nx', 'cr\rx']) {
    assert.throws(() => quoteCmdArg(bad), /cannot be passed through cmd\.exe safely/, bad);
  }
  assert.throws(() => quoteCmdArg(42), /must be a string/);
});

test('buildCmdLine produces one line with per-argument quoting', () => {
  assert.equal(
    buildCmdLine('npx', ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me\\My Docs']),
    'npx -y @modelcontextprotocol/server-filesystem "C:\\Users\\me\\My Docs"',
  );
  assert.equal(
    buildCmdLine('C:\\Program Files\\app\\run.cmd', ['a&b', 'plain']),
    '"C:\\Program Files\\app\\run.cmd" "a&b" plain',
  );
});

test('the built line round-trips through cmd.exe (review #2)', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-cmdline-'));
  const printer = path.join(dir, 'print-argv.js');
  fs.writeFileSync(printer, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  // a .cmd shim is the case that forces the bridge through cmd in the first place (npx/uvx)
  const shim = path.join(dir, 'shim.cmd');
  fs.writeFileSync(shim, '@echo off\r\nnode "%~dp0print-argv.js" %*\r\n');
  const cmd = process.env.ComSpec || 'cmd.exe';
  const cases = [['a&b'], ['with space'], ['x^y'], ['(paren)'], ['a|b'], [''], ['C:\\dir\\sub'], ['a', 'b c', 'd&e']];
  const run = (command, args) =>
    spawnSync(cmd, ['/d', '/s', '/c', `"${buildCmdLine(command, args)}"`], {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
    });
  try {
    for (const args of cases) {
      const viaExe = run(process.execPath, [printer, ...args]);
      assert.equal(viaExe.status, 0, `exe child failed for ${JSON.stringify(args)}: ${viaExe.stderr}`);
      assert.deepEqual(JSON.parse(viaExe.stdout.trim()), args, `argv mangled via exe for ${JSON.stringify(args)}`);

      const viaShim = run(shim, args);
      assert.equal(viaShim.status, 0, `shim child failed for ${JSON.stringify(args)}: ${viaShim.stderr}`);
      assert.deepEqual(JSON.parse(viaShim.stdout.trim()), args, `argv mangled via shim for ${JSON.stringify(args)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the pre-fix argv construction did not survive cmd.exe re-parsing', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-cmdold-'));
  const printer = path.join(dir, 'print-argv.js');
  fs.writeFileSync(printer, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const cmd = process.env.ComSpec || 'cmd.exe';
  try {
    // the old form: command and each arg as separate argv elements. Node quotes them for
    // CommandLineToArgvW, then cmd re-parses the joined line with its OWN rules — `a&b` has
    // no space, so it stayed unquoted and cmd ran two commands.
    const r = spawnSync(cmd, ['/d', '/s', '/c', process.execPath, printer, 'a&b'], { encoding: 'utf8' });
    let delivered = null;
    try { delivered = JSON.parse(r.stdout.trim()); } catch { /* cmd never handed the child a clean argv */ }
    assert.notDeepEqual(delivered, ['a&b'], 'the old construction must not deliver a metacharacter argument intact');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// review #3 — a failed icacls is reported, never swallowed
// ---------------------------------------------------------------------------

test('restrictWindowsAcl reports every outcome instead of swallowing failures', () => {
  const warns = [];
  const warn = (line) => warns.push(line);

  assert.deepEqual(
    restrictWindowsAcl('C:\\cfg\\token.json', { platform: 'linux', warn }),
    { status: 'skipped', reason: 'not-windows' },
  );
  assert.deepEqual(
    restrictWindowsAcl('f', { platform: 'win32', env: {}, warn }),
    { status: 'skipped', reason: 'no-username' },
  );

  // spawnSync does NOT throw on a non-zero exit — it reports `status`. The old try/catch
  // therefore never fired, which is exactly what this asserts is no longer true.
  const denied = restrictWindowsAcl('C:\\cfg\\token.json', {
    platform: 'win32',
    env: { USERNAME: 'me' },
    warn,
    run: () => ({ status: 1, stderr: 'Access is denied.\r\nsecond line' }),
  });
  assert.equal(denied.status, 'failed');
  assert.equal(denied.code, 1);
  assert.match(warns.at(-1), /icacls failed \(1\).*Access is denied/);
  assert.doesNotMatch(warns.at(-1), /second line/, 'one line is enough to be diagnosable');

  const missing = restrictWindowsAcl('f', {
    platform: 'win32',
    env: { USERNAME: 'me' },
    warn,
    run: () => ({ error: new Error('spawnSync icacls ENOENT') }),
  });
  assert.equal(missing.status, 'failed');
  assert.match(warns.at(-1), /could not run/);

  // success is quiet and passes icacls the arguments the fix promises
  const seen = [];
  const ok = restrictWindowsAcl('C:\\cfg\\routing.json', {
    platform: 'win32',
    env: { USERNAME: 'me' },
    warn,
    run: (cmd, argv) => { seen.push([cmd, argv]); return { status: 0, stdout: 'Successfully processed 1 files' }; },
  });
  assert.equal(ok.status, 'ok');
  assert.deepEqual(seen[0], ['icacls', ['C:\\cfg\\routing.json', '/inheritance:r', '/grant:r', 'me:F']]);
  assert.equal(warns.filter((w) => /icacls/.test(w)).length, 2, 'only the two failures warn');
});
