// failover.mjs — 供应商路由：回退链、模型/按键冷却、$ENV 按键轮换
export function createFailover(ctx) {
  const ctxKeys = ['SECRET_ENV', 'readJson', 'loadRouting', 'saveRouting', 'PI_MODELS'];
  for (const k of ctxKeys) {
    if (ctx[k] === undefined) throw new Error(`createFailover: missing ctx.${k} — the wiring contract drifted; fix the createFailover call site`);
  }
  const { SECRET_ENV, readJson, loadRouting, saveRouting, PI_MODELS } = ctx;

  const splitModel = (m) => { const i = (m || '').indexOf('/'); return i === -1 ? [null, m] : [m.slice(0, i), m.slice(i + 1)]; };
  function keyEnvsFor(provider) {
    const models = readJson(PI_MODELS) || { providers: {} };
    const routing = loadRouting();
    const envs = new Set();
    const ak = models.providers?.[provider]?.apiKey;
    if (typeof ak === 'string' && ak.startsWith('$')) envs.add(ak.slice(1));
    for (const e of routing.providers?.[provider]?.keyEnvs || []) envs.add(String(e).startsWith('$') ? e.slice(1) : String(e));
    return [...envs];
  }
  function hasLiteralKey(provider) {
    const models = readJson(PI_MODELS) || { providers: {} };
    const ak = models.providers?.[provider]?.apiKey;
    return typeof ak === 'string' && ak.length > 0 && !ak.startsWith('$');
  }
  function keyValue(env) {
    return SECRET_ENV[env] || process.env[env] || null;
  }
  function pickKey(provider) {
    const cds = loadRouting().state.cooldowns;
    const envs = keyEnvsFor(provider);
    for (let i = 0; i < envs.length; i++) {
      const cd = cds[`${provider}#key${i}`];
      if (cd && cd.until > Date.now()) continue;
      const value = keyValue(envs[i]);
      if (!value) continue;
      return { idx: i, env: envs[i], value };
    }
    return null;
  }
  function providerHasKey(provider) {
    // pickKey respects per-key cooldowns — a cooled key set means "no usable key".
    // a LITERAL key (plaintext in models.json) has no rotation pool: it cools under
    // `${provider}#literal`, and a 401 must be able to take it out of the chain
    if (hasLiteralKey(provider)) return !literalCooled(provider);
    return pickKey(provider) !== null;
  }
  function literalCooled(provider) {
    const cd = loadRouting().state.cooldowns[`${provider}#literal`];
    return cd && cd.until > Date.now() ? cd : null;
  }
  function coolModel(modelId, err, seconds) {
    const routing = loadRouting();
    routing.state.cooldowns[`model:${modelId}`] = { until: Date.now() + seconds * 1000, error: String(err || '').slice(0, 200) };
    saveRouting(routing);
  }
  function coolKey(provider, idx, err, seconds) {
    if (!keyEnvsFor(provider).length && hasLiteralKey(provider)) {
      // a literal key has no rotation index — the 401 must land somewhere that bites
      const rt = loadRouting();
      rt.state.cooldowns[`${provider}#literal`] = { until: Date.now() + seconds * 1000, error: String(err || '').slice(0, 200) };
      saveRouting(rt);
      return;
    }
    if (idx === null || idx === undefined) return;
    const routing = loadRouting();
    routing.state.cooldowns[`${provider}#key${idx}`] = { until: Date.now() + seconds * 1000, error: String(err || '').slice(0, 200) };
    saveRouting(routing);
  }
  function clearCool(modelId, keyIdx) {
    const [prov] = splitModel(modelId);
    const routing = loadRouting();
    const cds = routing.state.cooldowns;
    let changed = false;
    // writers are coolModel (`model:<id>`) and coolKey (`<prov>#key<idx>`) — only those two shapes.
    // With keyIdx, clear just the key that succeeded: a 401'd key A must stay cooled
    // when key B answers successfully, or rotation quietly stops rotating.
    if (cds[`model:${modelId}`]) { delete cds[`model:${modelId}`]; changed = true; }
    if (keyIdx === undefined && cds[`${prov}#literal`]) { delete cds[`${prov}#literal`]; changed = true; }
    const prefix = keyIdx === undefined ? `${prov}#key` : `${prov}#key${keyIdx}`;
    for (const k of Object.keys(cds)) {
      if (k === prefix || (keyIdx === undefined && k.startsWith(prefix))) { delete cds[k]; changed = true; }
    }
    if (changed) saveRouting(routing);
  }
  function modelCooled(modelId) {
    const cd = loadRouting().state.cooldowns[`model:${modelId}`];
    return cd && cd.until > Date.now() ? cd : null;
  }
  function providerCooled(provider) {
    const models = readJson(PI_MODELS) || { providers: {} };
    const list = (models.providers?.[provider]?.models || []).map((m) => `${provider}/${m.id}`);
    if (!list.length) return null;
    const cds = loadRouting().state.cooldowns;
    const cooled = list.map((m) => cds[`model:${m}`]).filter((c) => c && c.until > Date.now());
    return cooled.length === list.length ? cooled.reduce((a, b) => (a.until > b.until ? a : b)) : null;
  }
  function envOverrideFor(provider) {
    const pk = pickKey(provider);
    if (!pk) return null;
    const models = readJson(PI_MODELS) || { providers: {} };
    const ak = models.providers?.[provider]?.apiKey;
    if (typeof ak !== 'string' || !ak.startsWith('$')) return null;
    return { __keyIdx: pk.idx, [ak.slice(1)]: pk.value };
  }
  function nextInChain(modelId) {
    const routing = loadRouting();
    for (const chain of routing.chains || []) {
      const i = chain.indexOf(modelId);
      if (i === -1) continue;
      for (let j = i + 1; j < chain.length; j++) {
        const cand = chain[j];
        const [prov] = splitModel(cand);
        if (routing.providers?.[prov]?.enabled === false) continue;
        if (modelCooled(cand)) continue;
        if (providerCooled(prov)) continue;
        if (!providerHasKey(prov)) continue;
        return cand;
      }
    }
    return null;
  }
  return { loadRouting, saveRouting, splitModel, keyEnvsFor, hasLiteralKey, keyValue, nextInChain,
           providerHasKey, pickKey, coolModel, coolKey, clearCool, modelCooled,
           providerCooled, envOverrideFor };
}
