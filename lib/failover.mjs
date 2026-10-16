// failover.mjs — 供应商路由：回退链、模型/按键冷却、$ENV 按键轮换
export function createFailover(ctx) {
  const ctxKeys = ['SECRET_ENV', 'readJson', 'loadRouting', 'saveRouting', 'PI_MODELS'];
  for (const k of ctxKeys) {
    if (ctx[k] === undefined) throw new Error(`createFailover: missing ctx.${k} — the wiring contract drifted; fix the createFailover call site`);
  }
  const { SECRET_ENV, readJson, loadRouting, saveRouting, PI_MODELS } = ctx;

  const splitModel = (m) => { const i = (m || '').indexOf('/'); return i === -1 ? [null, m] : [m.slice(0, i), m.slice(i + 1)]; };
  function keyEnvsFor(provider) {
    // F17 (v1.3.5 audit): a LITERAL plaintext key has no applicable env override —
    // envOverrideFor can never act on one. Advertising routing keyEnvs as a rotation
    // pool for a literal provider promised rotation that could never be applied
    // (sameModelNewKey true, envOverrideFor null). The pool is honest only for
    // `$ENV`-referenced keys, so a literal key collapses the pool to empty.
    if (hasLiteralKey(provider)) return [];
    const models = readJson(PI_MODELS) || { providers: {} };
    const routing = loadRouting();
    const envs = new Set();
    const ak = models.providers?.[provider]?.apiKey;
    if (typeof ak === 'string' && ak.startsWith('$')) envs.add(ak.startsWith('${') ? ak.slice(2, -1) : ak.slice(1)); // pi also accepts the ${NAME} spelling
    for (const e of routing.providers?.[provider]?.keyEnvs || []) {
      const s2 = String(e);
      envs.add(s2.startsWith('${') ? s2.slice(2, -1) : s2.startsWith('$') ? s2.slice(1) : s2);
    }
    return [...envs];
  }
  // env NAME at a pool position — identity for cooldown bookkeeping (F19). The
  // server records this on the tab at spawn so a 401 cools the credential that
  // actually ran, even if the pool was reordered in between.
  function keyEnvAt(provider, idx) {
    const envs = keyEnvsFor(provider);
    return Number.isInteger(idx) && idx >= 0 && idx < envs.length ? envs[idx] : null;
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
      // F19 (v1.3.5 audit): cooldowns are keyed by the env NAME, not the array
      // index — reordering keyEnvs must not transplant a cooldown onto a
      // different credential.
      const cd = cds[`${provider}#env:${envs[i]}`];
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
    // `${provider}#literal`, and a 401 must be able to take it out of the chain.
    // a provider with NO managed credentials at all (local Ollama/LM Studio, header-
    // based auth) is keyless by design, not keyless-broken — availability is decided
    // by the model/provider cooldowns, not by the absence of a key pool (audit #13)
    if (hasLiteralKey(provider)) return !literalCooled(provider);
    if (!keyEnvsFor(provider).length) return true;
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
  // key is a pool position (number) or — preferred — the env NAME (string) captured
  // at spawn time (tab.routeKeyEnv), so a mid-run reorder cannot cool the wrong
  // credential (F19).
  function coolKey(provider, key, err, seconds) {
    const envs = keyEnvsFor(provider);
    if (!envs.length && hasLiteralKey(provider)) {
      // a literal key has no rotation index — the 401 must land somewhere that bites
      const rt = loadRouting();
      rt.state.cooldowns[`${provider}#literal`] = { until: Date.now() + seconds * 1000, error: String(err || '').slice(0, 200) };
      saveRouting(rt);
      return;
    }
    const envName = typeof key === 'string' && key ? key : (Number.isInteger(key) ? (envs[key] || null) : null);
    if (!envName) return;
    const routing = loadRouting();
    routing.state.cooldowns[`${provider}#env:${envName}`] = { until: Date.now() + seconds * 1000, error: String(err || '').slice(0, 200) };
    // one-time legacy cleanup: pre-1.3.6 index-keyed entries are dead weight
    if (Number.isInteger(key)) delete routing.state.cooldowns[`${provider}#key${key}`];
    saveRouting(routing);
  }
  function clearCool(modelId, key) {
    const [prov] = splitModel(modelId);
    const routing = loadRouting();
    const cds = routing.state.cooldowns;
    let changed = false;
    // writers are coolModel (`model:<id>`) and coolKey (`<prov>#env:<NAME>` —
    // legacy `<prov>#key<idx>` entries are still cleaned up). With a key identity,
    // clear just the key that succeeded: a 401'd key A must stay cooled when key B
    // answers successfully, or rotation quietly stops rotating.
    if (cds[`model:${modelId}`]) { delete cds[`model:${modelId}`]; changed = true; }
    if (key === undefined && cds[`${prov}#literal`]) { delete cds[`${prov}#literal`]; changed = true; }
    const envs = keyEnvsFor(prov);
    const envName = typeof key === 'string' && key ? key : (Number.isInteger(key) ? (envs[key] || null) : null);
    if (envName && cds[`${prov}#env:${envName}`]) { delete cds[`${prov}#env:${envName}`]; changed = true; }
    if (envName && Number.isInteger(key) && cds[`${prov}#key${key}`]) { delete cds[`${prov}#key${key}`]; changed = true; }
    if (key === undefined) {
      // no specific key identity: clear every key-shaped entry for this provider
      // (env-name keys plus any leftover legacy index keys)
      const keyPrefix = `${prov}#env:`;
      const legacyPrefix = `${prov}#key`;
      for (const k of Object.keys(cds)) {
        if (k.startsWith(keyPrefix) || k.startsWith(legacyPrefix)) { delete cds[k]; changed = true; }
      }
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
    // the env NAME must lose the sentinel: `${KEY_A}` → KEY_A — writing `{KEY_A}`
    // left pi reading the original (cooled-out) KEY_A and rotation never happened
    const name = ak.startsWith('${') ? ak.slice(2, -1) : ak.slice(1);
    return { __keyIdx: pk.idx, [name]: pk.value };
  }
  function nextInChain(modelId) {
    const routing = loadRouting();
    const models = readJson(PI_MODELS) || { providers: {} };
    for (const chain of routing.chains || []) {
      const i = chain.indexOf(modelId);
      if (i === -1) continue;
      for (let j = i + 1; j < chain.length; j++) {
        const cand = chain[j];
        const [prov] = splitModel(cand);
        if (routing.providers?.[prov]?.enabled === false) continue;
        // F18 (v1.3.5 audit): a chain entry naming a provider that does not exist
        // in models.json is NOT "keyless-available" — it is a dangling reference
        // (typo, deleted provider) and must be skipped, not served as the next
        // failover target. The audit explicitly scoped this to the PROVIDER: "不同 pi
        // 对未列出 model 支持可能不同，但完全不存在 provider 不应被宣称可用". An
        // earlier cut of this fix also required the model to be listed, which silently
        // emptied the chain for providers whose models.json lists a subset (the
        // failover-e2e / chat-e2e fixtures list only m1 while the chain names m3) —
        // that is a promise pi, not this function, is the authority on.
        const prow = models.providers?.[prov];
        if (!prow || typeof prow !== 'object') continue;
        if (modelCooled(cand)) continue;
        if (providerCooled(prov)) continue;
        if (!providerHasKey(prov)) continue;
        return cand;
      }
    }
    return null;
  }
  // TRUE when THIS model still has a usable key on its own provider — the failover
  // answer can then re-open the same model (fresh key) instead of jumping providers.
  // A cooled MODEL (429/quota) is NOT eligible: re-opening the same model on "a fresh
  // key" would just re-hit the same quota with possibly the SAME key (audit #31)
  function sameModelNewKey(modelId) {
    if (modelCooled(modelId)) return false;
    const [prov] = splitModel(modelId);
    if (!prov) return false;
    if (hasLiteralKey(prov)) return false; // a literal key has no pool to rotate within
    return keyEnvsFor(prov).length > 1 && pickKey(prov) !== null;
  }
  // TRUE when the provider HAS managed credentials and every one of them is cooled —
  // unattended runs must fail closed on key availability, not launch on the stale env
  function providerCooledOut(provider) {
    if (hasLiteralKey(provider)) return !!literalCooled(provider);
    const envs = keyEnvsFor(provider);
    if (!envs.length) return false; // ambient-env providers have nothing to gate on
    return pickKey(provider) === null;
  }
  return { loadRouting, saveRouting, splitModel, keyEnvsFor, keyEnvAt, hasLiteralKey, keyValue, nextInChain,
           providerHasKey, pickKey, coolModel, coolKey, clearCool, modelCooled,
           providerCooled, envOverrideFor, sameModelNewKey, providerCooledOut };
}
