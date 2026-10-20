// tests/providers.test.mjs — lib/providers.mjs is the one place where a provider
// edit touches three files. Its contract is not "it writes" but "it writes all of
// them, or none of them, and if the disk refuses it says which state the disk is
// really in". None of that was tested; the route sweep only proved a good request
// returns 200.
//
// fs is NOT injected here (the module imports it directly), so the fault injection
// happens through `atomicWrite`, which IS injected — that is the single write
// primitive the module uses, so failing it is exactly "the disk said no".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProviders, ProviderError } from '../lib/providers.mjs';

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const isSafeKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= 200 && !UNSAFE.has(k);

function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-prov-'));
  return {
    dir,
    MODELS_FILE: path.join(dir, 'models.json'),
    ROUTING_FILE: path.join(dir, 'routing.json'),
    CFG_FILE: path.join(dir, 'config.json'),
  };
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// The real atomicWrite is tmp+rename; reproducing that here keeps the fixture
// honest about the failure mode (a half-written temp file must never appear).
function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function make(t, overrides = {}) {
  return createProviders({ ...t, readJson, atomicWrite, isSafeKey, ...overrides });
}

test('save writes only models.json when no routing or default is requested', () => {
  const t = tree();
  const p = make(t);
  const out = p.save({ name: 'alpha', provider: { baseUrl: 'https://a.example', models: [{ id: 'm1' }] } });
  assert.equal(out.routed, false);
  assert.equal(out.defaulted, false);
  assert.equal(readJson(t.MODELS_FILE).providers.alpha.models[0].id, 'm1');
  // the two files it did not need must stay absent, not be created empty
  assert.equal(fs.existsSync(t.ROUTING_FILE), false);
  assert.equal(fs.existsSync(t.CFG_FILE), false);
});

test('save commits models + routing + default model as one change', () => {
  const t = tree();
  const p = make(t);
  const out = p.save({
    name: 'beta',
    provider: { baseUrl: 'https://b.example', models: [{ id: 'b1' }] },
    testModel: 'b1',
    defaultModel: 'beta/b1',
  });
  assert.equal(out.routed, true);
  assert.equal(out.defaulted, true);
  assert.equal(readJson(t.ROUTING_FILE).providers.beta.testModel, 'b1');
  assert.equal(readJson(t.CFG_FILE).defaultModel, 'beta/b1');
});

test('an unsafe provider name is refused before any file is read or written', () => {
  const t = tree();
  const p = make(t);
  for (const bad of ['__proto__', 'constructor', '', 'x'.repeat(201)]) {
    assert.throws(() => p.save({ name: bad, provider: {} }), (e) => e instanceof ProviderError && e.status === 400);
  }
  assert.equal(fs.existsSync(t.MODELS_FILE), false, 'a rejected name must not create models.json');
});

test('a non-array models field is refused, and a missing one becomes []', () => {
  const t = tree();
  const p = make(t);
  assert.throws(() => p.save({ name: 'g', provider: { models: 'nope' } }), /models must be an array/);
  p.save({ name: 'g', provider: {} });
  assert.deepEqual(readJson(t.MODELS_FILE).providers.g.models, []);
});

test('a failed third write restores the first two files byte-for-byte', () => {
  const t = tree();
  fs.writeFileSync(t.MODELS_FILE, JSON.stringify({ providers: { old: { models: [] } } }, null, 2));
  fs.writeFileSync(t.CFG_FILE, JSON.stringify({ defaultModel: 'old/x' }, null, 2));
  const beforeModels = fs.readFileSync(t.MODELS_FILE, 'utf8');
  const beforeCfg = fs.readFileSync(t.CFG_FILE, 'utf8');

  let n = 0;
  const failingAtomic = (file, data) => {
    n++;
    if (n === 3) { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; }
    return atomicWrite(file, data);
  };
  const p = make(t, { atomicWrite: failingAtomic });

  let err = null;
  try { p.save({ name: 'gamma', provider: { models: [] }, testModel: 'g1', defaultModel: 'gamma/g1' }); } catch (e) { err = e; }
  assert.ok(err, 'the failing write must surface');
  assert.match(err.message, /写入失败/);
  assert.deepEqual(err.rollback, [], 'the rollback itself succeeded, so no residual failures');
  assert.match(err.detail, /已回滚到修改前的状态/);
  // the two files that WERE written must be back to their pre-image
  assert.equal(fs.readFileSync(t.MODELS_FILE, 'utf8'), beforeModels);
  assert.equal(fs.readFileSync(t.CFG_FILE, 'utf8'), beforeCfg);
  // and the file that had not been written yet must still not exist
  assert.equal(fs.existsSync(t.ROUTING_FILE), false);
});

test('a rollback that cannot write back reports the torn state instead of swallowing it', () => {
  const t = tree();
  fs.writeFileSync(t.MODELS_FILE, JSON.stringify({ providers: {} }, null, 2));
  const before = fs.readFileSync(t.MODELS_FILE, 'utf8');

  let n = 0;
  const halfDead = (file, data) => {
    n++;
    // write #1 = models (ok), #2 = routing (dies), then restore() writes models again (#3) — refuse that one
    if (n === 2 || n === 3) { const e = new Error(n === 2 ? 'ENOSPC on routing' : 'EPERM on models restore'); throw e; }
    return atomicWrite(file, data);
  };
  const p = make(t, { atomicWrite: halfDead });

  let err = null;
  try { p.save({ name: 'delta', provider: { models: [] }, testModel: 'd1' }); } catch (e) { err = e; }
  assert.ok(err);
  assert.equal(err.rollback.length, 1, 'exactly one file failed to roll back');
  assert.match(err.rollback[0], /models\.json/);
  assert.match(err.detail, /磁盘可能处于部分更新状态/, 'the honest wording, not "已回滚"');
  // and the message names the file, so the user knows what to look at
  assert.match(err.detail, /models\.json/);
  // the disk really is torn here: the module said so and did not pretend otherwise
  assert.notEqual(fs.readFileSync(t.MODELS_FILE, 'utf8'), before);
});

test('remove sweeps the dangling default model and the fallback chains', () => {
  const t = tree();
  fs.writeFileSync(t.MODELS_FILE, JSON.stringify({ providers: { gone: { models: [] }, kept: { models: [] } } }, null, 2));
  fs.writeFileSync(t.CFG_FILE, JSON.stringify({ defaultModel: 'gone/x', lang: 'zh' }, null, 2));
  fs.writeFileSync(t.ROUTING_FILE, JSON.stringify({ chains: [['gone/x', 'kept/y'], ['gone/z'], ['kept/y']] }, null, 2));

  const p = make(t);
  const out = p.remove('gone');
  assert.equal(out.existed, true);
  assert.deepEqual(out.swept.sort(), ['回退链', '默认模型']);
  assert.equal(readJson(t.MODELS_FILE).providers.gone, undefined);
  assert.equal(readJson(t.MODELS_FILE).providers.kept.models.length, 0);
  assert.equal(readJson(t.CFG_FILE).defaultModel, null);
  assert.equal(readJson(t.CFG_FILE).lang, 'zh', 'unrelated config keys survive');
  // the chain that lost every entry is dropped, not left as an empty array that
  // makes indexOf throw mid-fallback
  assert.deepEqual(readJson(t.ROUTING_FILE).chains, [['kept/y'], ['kept/y']]);
});

test('remove of an unknown provider still succeeds and leaves the rest alone', () => {
  const t = tree();
  fs.writeFileSync(t.MODELS_FILE, JSON.stringify({ providers: { kept: { models: [] } } }, null, 2));
  const p = make(t);
  const out = p.remove('never-there');
  assert.equal(out.existed, false);
  assert.deepEqual(out.swept, []);
  assert.equal(readJson(t.MODELS_FILE).providers.kept !== undefined, true);
});

test('a missing ctx key is a wiring error at construction, not a runtime surprise', () => {
  const t = tree();
  assert.throws(() => createProviders({ ...t, readJson, atomicWrite }), /createProviders: missing ctx\.isSafeKey/);
});
