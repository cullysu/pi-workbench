// Cross-file provider mutations.
//
// A provider is not one document. models.json holds it, config.json may point
// defaultModel at one of its models, and routing.json may list its models in a
// fallback chain or name one as the probe model. The UI used to write those files
// itself, one request at a time, so a failure halfway left a partial commit on disk
// (provider saved, chain still naming a model that no longer exists) and the only
// recovery was "reload and hope" — the review's 1st shortcoming.
//
// This module makes the whole change ONE commit: every file is written through
// atomicWrite, and if any write fails the pre-images are restored before the error is
// returned. What was never there is deleted again rather than left as an empty file,
// because "absent" and "empty object" are different states to every reader here.
//
// Honesty note: this is pre-image rollback, not a journal. A crash *between* two
// writes leaves a partial commit just like before, and a rollback that itself fails
// is reported (never swallowed) so the caller can tell the user the disk may be torn.

import fs from 'node:fs';
import path from 'node:path';

const CTX_KEYS = ['MODELS_FILE', 'ROUTING_FILE', 'CFG_FILE', 'readJson', 'atomicWrite', 'isSafeKey'];

export class ProviderError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

export function createProviders(ctx) {
  for (const k of CTX_KEYS) {
    if (ctx[k] === undefined || ctx[k] === null) throw new Error('createProviders: missing ctx.' + k);
  }
  const { MODELS_FILE, ROUTING_FILE, CFG_FILE, readJson, atomicWrite, isSafeKey } = ctx;

  const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const readOr = (file) => asObject(readJson(file)) || {};

  // Raw bytes, not parsed values: a rollback has to reproduce the file as it was,
  // including "it did not exist".
  // v1.4.2 review M9: the old catch treated EVERY read error as "file absent", so a
  // transient EACCES/EISDIR on routing.json would end in a rollback that UNLINKED a real
  // file. ENOENT stays "absent"; anything else fails the save before the first write.
  function snapshot(files) {
    const out = new Map();
    for (const f of files) {
      try {
        out.set(f, fs.readFileSync(f, 'utf8'));
      } catch (e) {
        if (e && e.code === 'ENOENT') out.set(f, null);
        else throw new ProviderError(500, `无法读取 ${path.basename(f)}（${(e && e.code) || (e && e.message) || e}）——无法保证回滚正确，本次保存未写入任何文件`);
      }
    }
    return out;
  }

  function restore(snap) {
    const failed = [];
    for (const [f, raw] of snap) {
      try {
        if (raw === null) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
        else atomicWrite(f, raw);
      } catch (e) { failed.push(`${path.basename(f)}: ${(e && e.message) || e}`); }
    }
    return failed;
  }

  function commit(writes) {
    const snap = snapshot([...new Set(writes.map(([f]) => f))]);
    try {
      for (const [f, raw] of writes) {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        atomicWrite(f, raw);
      }
    } catch (e) {
      const rollbackFailed = restore(snap);
      const err = new ProviderError(500, `写入失败：${(e && e.message) || e}`);
      err.rollback = rollbackFailed;
      err.detail = rollbackFailed.length
        ? `已回滚，但以下文件回滚失败，磁盘可能处于部分更新状态：${rollbackFailed.join('；')}`
        : '已回滚到修改前的状态';
      throw err;
    }
  }

  function validateProvider(name, provider) {
    if (!isSafeKey(name)) throw new ProviderError(400, `provider name not allowed: ${name}`);
    if (!asObject(provider)) throw new ProviderError(400, `provider ${name} must be an object`);
    if (provider.models !== undefined && provider.models !== null && !Array.isArray(provider.models)) {
      throw new ProviderError(400, `provider ${name}: models must be an array`);
    }
    // v1.4.2 review H3: the array SHAPE was checked, not its ELEMENTS. A hand-edited or
    // restored `{"models":[null]}` passed validation, was written to disk verbatim, and
    // then exploded every consumer that reads `m.id` — failover's providerCooled threw
    // `Cannot read properties of null (reading 'id')`, taking the routing page, cooldown
    // checks and cron paths down with it. Model rows are objects with a string id.
    if (Array.isArray(provider.models)) {
      for (const m of provider.models) {
        if (!m || typeof m !== 'object' || Array.isArray(m)) throw new ProviderError(400, `provider ${name}: every model must be an object (got ${JSON.stringify(m) ?? String(m)})`);
        if (typeof m.id !== 'string' || !m.id.trim()) throw new ProviderError(400, `provider ${name}: every model needs a non-empty string id`);
      }
    }
    return { ...provider, models: Array.isArray(provider.models) ? provider.models : [] };
  }

  // One provider write, plus the two references that can dangle because of it.
  // Every requested change is validated BEFORE the first byte is written.
  function save({ name, provider, testModel = null, defaultModel = null }) {
    const clean = validateProvider(name, provider);

    const models = readOr(MODELS_FILE);
    models.providers = asObject(models.providers) || {};
    models.providers[name] = clean;
    const writes = [[MODELS_FILE, JSON.stringify(models, null, 2)]];

    let routing = null;
    if (typeof testModel === 'string' && testModel) {
      routing = readOr(ROUTING_FILE);
      routing.providers = asObject(routing.providers) || {};
      routing.providers[name] = { ...(asObject(routing.providers[name]) || {}), testModel };
      writes.push([ROUTING_FILE, JSON.stringify(routing, null, 2)]);
    }

    let config = null;
    if (typeof defaultModel === 'string' && defaultModel) {
      config = readOr(CFG_FILE);
      config.defaultModel = defaultModel;
      writes.push([CFG_FILE, JSON.stringify(config, null, 2)]);
    }

    commit(writes);
    return { name, models, routing, config, routed: !!routing, defaulted: !!config };
  }

  // Deleting a provider has to take its references with it in the SAME commit:
  // a defaultModel pointing at a deleted provider makes every new session fail, and a
  // chain entry naming one of its models can never resolve.
  function remove(name) {
    if (!isSafeKey(name)) throw new ProviderError(400, `provider name not allowed: ${name}`);

    const models = readOr(MODELS_FILE);
    models.providers = asObject(models.providers) || {};
    const existed = Object.hasOwn(models.providers, name);
    delete models.providers[name];
    const writes = [[MODELS_FILE, JSON.stringify(models, null, 2)]];
    const swept = [];

    let config = null;
    const cfgRead = readOr(CFG_FILE);
    if (typeof cfgRead.defaultModel === 'string' && cfgRead.defaultModel.startsWith(name + '/')) {
      config = cfgRead;
      config.defaultModel = null;
      writes.push([CFG_FILE, JSON.stringify(config, null, 2)]);
      swept.push('默认模型');
    }

    let routing = null;
    const rtRead = readOr(ROUTING_FILE);
    if (Array.isArray(rtRead.chains)) {
      const next = rtRead.chains
        .map((c) => (Array.isArray(c) ? c.filter((m) => typeof m !== 'string' || !m.startsWith(name + '/')) : c))
        .filter((c) => Array.isArray(c) && c.length > 0);
      if (JSON.stringify(next) !== JSON.stringify(rtRead.chains)) {
        routing = rtRead;
        routing.chains = next;
        writes.push([ROUTING_FILE, JSON.stringify(routing, null, 2)]);
        swept.push('回退链');
      }
    }

    commit(writes);
    return { name, existed, swept, models, routing, config };
  }

  return { save, remove };
}
