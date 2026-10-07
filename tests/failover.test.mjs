// Unit tests for lib/failover.mjs — cooldown expiry, per-key rotation, chain walking.
// The factory takes explicit ctx, so these run against a scratch dir with no server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFailover } from '../lib/failover.mjs';

function makeCtx({ models = { providers: {} }, routing = {}, secretEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-failover-'));
  const PI_MODELS = path.join(dir, 'models.json');
  const ROUTING = path.join(dir, 'routing.json');
  fs.writeFileSync(PI_MODELS, JSON.stringify(models));
  fs.writeFileSync(ROUTING, JSON.stringify(routing));
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const normalize = (d) => {
    const r = d && typeof d === 'object' ? d : {};
    r.providers = r.providers || {};
    r.chains = Array.isArray(r.chains) ? r.chains : [];
    r.state = r.state || {};
    r.state.cooldowns = r.state.cooldowns || {};
    return r;
  };
  const loadRouting = () => normalize(readJson(ROUTING));
  const saveRouting = (r) => { fs.writeFileSync(ROUTING, JSON.stringify(r, null, 2)); return r; };
  const ctx = { SECRET_ENV: secretEnv, readJson, loadRouting, saveRouting, PI_MODELS };
  return { failover: createFailover(ctx), dir, ROUTING, PI_MODELS };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROVIDERS = {
  a: { apiKey: '$KEY_A', models: [{ id: 'm1' }] },
  b: { apiKey: '$KEY_B', models: [{ id: 'm1' }] },
  c: { apiKey: '$KEY_C', models: [{ id: 'm1' }] },
  lit: { apiKey: 'sk-literal', models: [{ id: 'm1' }] },
  multi: { apiKey: '$KEY_A', models: [{ id: 'm1' }, { id: 'm2' }] },
};

test('failover ctx contract: missing dependency throws at creation, not at 9am', () => {
  assert.throws(() => createFailover({ SECRET_ENV: {} }), /missing ctx\.(readJson|loadRouting|saveRouting|PI_MODELS)/);
});

test('splitModel: provider/model split, bare id has null provider', () => {
  const { failover } = makeCtx();
  assert.deepEqual(failover.splitModel('prov/model-x'), ['prov', 'model-x']);
  assert.deepEqual(failover.splitModel('justamodel'), [null, 'justamodel']);
  assert.deepEqual(failover.splitModel(''), [null, '']);
});

test('keyEnvsFor unions $ENV apiKey with routing keyEnvs', () => {
  const { failover } = makeCtx({
    models: { providers: { a: { apiKey: '$ENV_A' } } },
    routing: { providers: { a: { keyEnvs: ['$ENV_B', 'ENV_C'] } } },
  });
  assert.deepEqual(failover.keyEnvsFor('a'), ['ENV_A', 'ENV_B', 'ENV_C']);
});

test('hasLiteralKey: literal true, $ENV ref false, missing false', () => {
  const { failover } = makeCtx({ models: { providers: { lit: { apiKey: 'sk-x' }, e: { apiKey: '$E' } } } });
  assert.equal(failover.hasLiteralKey('lit'), true);
  assert.equal(failover.hasLiteralKey('e'), false);
  assert.equal(failover.hasLiteralKey('nope'), false);
});

test('coolModel expires: cooled immediately, null after the window', async () => {
  const { failover } = makeCtx();
  failover.coolModel('a/m1', '500 boom', 1);
  assert.ok(failover.modelCooled('a/m1'), 'cooled right after');
  assert.equal(failover.modelCooled('a/m1').error.includes('500'), true);
  await sleep(1100);
  assert.equal(failover.modelCooled('a/m1'), null, 'expired after the window');
});

test('per-key rotation: cooled keys are skipped, exhausted pool means no key', () => {
  const { failover } = makeCtx({
    models: { providers: { a: { apiKey: '$KEY_A', models: [{ id: 'm1' }] } } },
    routing: { providers: { a: { keyEnvs: ['KEY_A', 'KEY_B'] } } },
    secretEnv: { KEY_A: 'v1', KEY_B: 'v2' },
  });
  assert.deepEqual(failover.pickKey('a'), { idx: 0, env: 'KEY_A', value: 'v1' });
  failover.coolKey('a', 0, '401', 300);
  assert.deepEqual(failover.pickKey('a'), { idx: 1, env: 'KEY_B', value: 'v2' });
  failover.coolKey('a', 1, '401', 300);
  assert.equal(failover.pickKey('a'), null, 'pool exhausted');
  assert.equal(failover.providerHasKey('a'), false, 'no literal fallback');
  failover.coolKey('a', null, '401', 300); // null idx is a no-op, not a crash
});

test('nextInChain: walks forward, skips disabled/cooled/keyless entries, null at the end', () => {
  const { failover } = makeCtx({
    models: { providers: PROVIDERS },
    routing: { chains: [['a/m1', 'b/m1', 'c/m1', 'lit/m1']], providers: {} },
    secretEnv: { KEY_A: 'va', KEY_B: 'vb', KEY_C: 'vc' },
  });
  assert.equal(failover.nextInChain('a/m1'), 'b/m1');
  failover.coolModel('b/m1', 'boom', 60);
  assert.equal(failover.nextInChain('a/m1'), 'c/m1', 'cooled model skipped');
  const r = failover.loadRouting();
  r.providers.c = { enabled: false };
  failover.saveRouting(r);
  assert.equal(failover.nextInChain('a/m1'), 'lit/m1', 'disabled provider skipped');
  failover.coolModel('lit/m1', 'boom', 60);
  assert.equal(failover.nextInChain('a/m1'), null, 'chain exhausted');
});

test('providerCooled: only when EVERY model of the provider is cooled', () => {
  const { failover } = makeCtx({ models: { providers: { multi: { apiKey: 'sk-x', models: [{ id: 'm1' }, { id: 'm2' }] } } } });
  failover.coolModel('multi/m1', 'boom', 60);
  assert.equal(failover.providerCooled('multi'), null, 'one cooled model is not a cooled provider');
  failover.coolModel('multi/m2', 'boom', 120);
  const cd = failover.providerCooled('multi');
  assert.ok(cd, 'all models cooled → provider cooled');
  assert.equal(cd.until, failover.modelCooled('multi/m2').until, 'returns the longest cooldown');
});

test('envOverrideFor: env name from apiKey field, value from the rotated pool', () => {
  const { failover } = makeCtx({
    models: { providers: { a: { apiKey: '$KEY_A', models: [{ id: 'm1' }] } } },
    routing: { providers: { a: { keyEnvs: ['KEY_A', 'KEY_B'] } } },
    secretEnv: { KEY_A: 'v1', KEY_B: 'v2' },
  });
  assert.deepEqual(failover.envOverrideFor('a'), { __keyIdx: 0, KEY_A: 'v1' });
  failover.coolKey('a', 0, '401', 300);
  assert.deepEqual(failover.envOverrideFor('a'), { __keyIdx: 1, KEY_A: 'v2' }, 'same env name, rotated value');
});

test('clearCool with keyIdx clears only the successful key — a 401-rejected key stays cooled', () => {
  const { failover } = makeCtx({
    models: { providers: { a: { apiKey: '$KEY_A', models: [{ id: 'm1' }] } } },
    routing: { providers: { a: { keyEnvs: ['KEY_A', 'KEY_B'] } } },
    secretEnv: { KEY_A: 'v1', KEY_B: 'v2' },
  });
  failover.coolKey('a', 0, '401', 300); // key A rejects -> cooled
  failover.coolModel('a/m1', 'x', 60);
  failover.clearCool('a/m1', 1); // key B (never cooled) answered successfully
  assert.equal(failover.pickKey('a')?.idx, 1, 'key B is the usable key');
  assert.ok(failover.loadRouting().state.cooldowns['a#key0'], 'the 401 key A stays cooled under the new scoped clear');
  assert.equal(failover.modelCooled('a/m1'), null);
});

test('clearCool clears the model and its provider keys, leaves others alone', () => {
  const { failover } = makeCtx({ models: { providers: PROVIDERS } });
  failover.coolModel('a/m1', 'x', 60);
  failover.coolKey('a', 0, 'y', 60);
  failover.coolModel('b/m1', 'x', 60);
  failover.clearCool('a/m1');
  assert.equal(failover.modelCooled('a/m1'), null);
  const cds = failover.loadRouting().state.cooldowns;
  assert.equal(Object.keys(cds).some((k) => k.startsWith('a#key')), false, 'provider a keys cleared');
  assert.ok(cds['model:b/m1'], "other provider's cooldown untouched");
});
