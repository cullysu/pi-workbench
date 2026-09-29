// failover.mjs — 供应商路由/冷却/回退链（从 server.mjs 抽出，工厂注入依赖）

export function createFailover(ctx) {
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
function providerHasKey(provider) {
  // pickKey respects per-key cooldowns — a cooled key set means "no usable key"
  return pickKey(provider) !== null || hasLiteralKey(provider);
}
function pickKey(provider) {
  const cds = loadRouting().state.cooldowns;
  const envs = keyEnvsFor(provider);
  for (let i = 0; i < envs.length; i++) {
    const cd = cds[`${provider}#key${i}`];
    if (cd && cd.until > Date.now()) continue;
    if (!keyValue(envs[i])) continue;
    return { idx: i, env: envs[i], value: keyValue(envs[i]) };
  }
  return null;
}
function coolModel(modelId, err, seconds) {
  const routing = loadRouting();
  routing.state.cooldowns[`model:${modelId}`] = { until: Date.now() + seconds * 1000, error: String(err || '').slice(0, 200) };
  saveRouting(routing);
}
function coolKey(provider, idx, err, seconds) {
  if (idx === null || idx === undefined) return;
  const routing = loadRouting();
  routing.state.cooldowns[`${provider}#key${idx}`] = { until: Date.now() + seconds * 1000, error: String(err || '').slice(0, 200) };
  saveRouting(routing);
}
function clearCool(modelId) {
  const [prov] = splitModel(modelId);
  const routing = loadRouting();
  const cds = routing.state.cooldowns;
  let changed = false;
  for (const k of Object.keys(cds)) {
    if (k === `model:${modelId}` || k === prov || k.startsWith(prov + '#key')) { delete cds[k]; changed = true; }
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
