// schema.mjs — the ONE deep-shape contract for the two documents that poison the whole
// process when they are structurally wrong: models.json and routing.json.
//
// v1.4.3 review #3 / #4 / #25: three entry points wrote those files and each carried its
// own partial validator — `POST /api/models` checked model ELEMENTS, `POST /api/routing`
// checked provider OBJECT-ness, and the backup importer checked neither. A restored
// `{"providers":{"p":{"models":[null]}}}` therefore walked past the importer, landed on
// disk, and threw `Cannot read properties of null (reading 'id')` out of failover's
// providerCooled — taking /api/routing, the cron provider gate and the routing page with
// it. Validating "the container is an array" at one door and "the elements are objects"
// at another is how that gap opens. Both doors now call these, and loadRouting() applies
// the same normalisation to whatever is already on disk (a file can predate the gate).
//
// Policy: these return a REASON string (null = fine) rather than throwing, so a caller can
// answer 400 with a specific message and a loader can silently drop the bad row.

export const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const isSafeKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= 200 && !UNSAFE_KEYS.has(k);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ---------- models.json ----------
// A provider row: object, optional string apiKey/baseUrl, optional object headers,
// and a models array whose EVERY element is an object with a non-empty string id.
export function providerRowProblem(name, p) {
  if (!isSafeKey(name)) return `provider name not allowed: ${name}`;
  if (!isPlainObject(p)) return `provider ${name} must be an object`;
  if (p.models !== undefined && p.models !== null) {
    if (!Array.isArray(p.models)) return `provider ${name}: models must be an array`;
    for (const m of p.models) {
      if (!isPlainObject(m)) return `provider ${name}: every model must be an object (got ${safeJson(m)})`;
      if (typeof m.id !== 'string' || !m.id.trim()) return `provider ${name}: every model needs a non-empty string id`;
    }
  }
  if (p.apiKey !== undefined && p.apiKey !== null && typeof p.apiKey !== 'string') return `provider ${name}: apiKey must be a string`;
  if (p.baseUrl !== undefined && p.baseUrl !== null && typeof p.baseUrl !== 'string') return `provider ${name}: baseUrl must be a string`;
  if (p.headers !== undefined && p.headers !== null && !isPlainObject(p.headers)) return `provider ${name}: headers must be an object`;
  return null;
}
export function modelsDocProblem(doc) {
  if (!isPlainObject(doc)) return 'models document must be an object';
  if (doc.providers === undefined) return null; // a providers-less doc is legal (empty config)
  if (!isPlainObject(doc.providers)) return 'providers must be an object';
  for (const [name, p] of Object.entries(doc.providers)) {
    // a `null` row is dropped by every reader already; it is not a poisoning shape
    if (p === null || p === undefined) continue;
    const why = providerRowProblem(name, p);
    if (why) return why;
  }
  return null;
}

// ---------- routing.json ----------
// Deep, because routing is read by failover on EVERY failure decision:
//   providers[name].keyEnvs   iterated with for...of → must be string[]
//   providers[name].testModel / .priority / .enabled → scalar or absent
//   chains                    array of arrays of "provider/model" strings
//   legacy routes[name]       object, because the migration reads meta.enabled
export function routingMetaProblem(name, meta) {
  if (!isSafeKey(name)) return `provider name not allowed: ${name}`;
  if (!isPlainObject(meta)) return `routing.providers.${name} must be an object`;
  if (meta.keyEnvs !== undefined && meta.keyEnvs !== null) {
    if (!Array.isArray(meta.keyEnvs) || meta.keyEnvs.some((e) => typeof e !== 'string')) {
      return `routing.providers.${name}.keyEnvs must be an array of strings`;
    }
  }
  if (meta.testModel !== undefined && meta.testModel !== null && typeof meta.testModel !== 'string') {
    return `routing.providers.${name}.testModel must be a string`;
  }
  if (meta.priority !== undefined && meta.priority !== null && !Number.isFinite(Number(meta.priority))) {
    return `routing.providers.${name}.priority must be a number`;
  }
  if (meta.enabled !== undefined && meta.enabled !== null && typeof meta.enabled !== 'boolean') {
    return `routing.providers.${name}.enabled must be a boolean`;
  }
  return null;
}
export function routingDocProblem(doc) {
  if (!isPlainObject(doc)) return 'routing document must be an object';
  if (doc.providers !== undefined && doc.providers !== null) {
    if (!isPlainObject(doc.providers)) return 'routing.providers must be an object';
    for (const [name, meta] of Object.entries(doc.providers)) {
      // v1.4.3 review #4: a `null` row is not a shape we write — a restore carrying one
      // is silently LOSING a provider the user believes they restored. Reject at the door;
      // the loader (normalizeRoutingDoc) still tolerates it for files that predate this.
      if (meta === null || meta === undefined) return `routing.providers.${name} must be an object (got ${String(meta)})`;
      const why = routingMetaProblem(name, meta);
      if (why) return why;
    }
  }
  if (doc.chains !== undefined && doc.chains !== null) {
    if (!Array.isArray(doc.chains)) return 'chains must be an array';
    for (const c of doc.chains) {
      if (!Array.isArray(c)) return 'every chain must be an array of model ids';
      for (const m of c) if (typeof m !== 'string' || !m) return 'every chain entry must be a non-empty model id string';
    }
  }
  if (doc.state !== undefined && doc.state !== null) {
    if (!isPlainObject(doc.state)) return 'state must be an object';
    if (doc.state.cooldowns !== undefined && doc.state.cooldowns !== null && !isPlainObject(doc.state.cooldowns)) {
      return 'state.cooldowns must be an object';
    }
  }
  // the PySide-era `routes` map is migrated on load, which reads meta.enabled —
  // `{"routes":{"p":null}}` threw there (review #4, second half)
  if (doc.routes !== undefined && doc.routes !== null) {
    if (!isPlainObject(doc.routes)) return 'routes must be an object';
    for (const [name, meta] of Object.entries(doc.routes)) {
      if (!isPlainObject(meta)) return `routes.${name} must be an object (legacy routing migration reads it)`;
    }
  }
  return null;
}

// ---------- normalisation for already-on-disk documents ----------
// A file written before these gates existed must not be trusted either. Dropping the bad
// row is the safe direction: a provider with a poisoned row simply stops participating in
// failover instead of taking the endpoint down.
export function normalizeRoutingDoc(doc) {
  const r = isPlainObject(doc) ? doc : {};
  if ((!r.providers || !Object.keys(r.providers).length) && isPlainObject(r.routes)) {
    const migrated = {};
    for (const [name, meta] of Object.entries(r.routes)) {
      if (!isSafeKey(name) || !isPlainObject(meta)) continue; // review #4: null meta threw at meta.enabled
      migrated[name] = { enabled: meta.enabled !== false, priority: Number(meta.priority) || 1, keyEnvs: [] };
    }
    r.providers = migrated;
    delete r.routes;
  }
  if (!isPlainObject(r.providers)) r.providers = {};
  for (const k of Object.keys(r.providers)) {
    if (routingMetaProblem(k, r.providers[k])) delete r.providers[k];
    else {
      const m = r.providers[k];
      if (m.keyEnvs == null) m.keyEnvs = [];
      if (m.priority != null) m.priority = Number(m.priority);
      if (m.enabled == null) m.enabled = true;
    }
  }
  r.chains = Array.isArray(r.chains)
    ? r.chains.filter((c) => Array.isArray(c) && c.every((m) => typeof m === 'string' && m))
    : [];
  if (!isPlainObject(r.state)) r.state = {};
  if (!isPlainObject(r.state.cooldowns)) r.state.cooldowns = {};
  return r;
}

const safeJson = (v) => {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
};
