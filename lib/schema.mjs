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
  if (p.headers !== undefined && p.headers !== null) {
    if (!isPlainObject(p.headers)) return `provider ${name}: headers must be an object`;
    // v1.4.4 review: only the container was validated while every consumer guards
    // `typeof v === 'string'` — a header whose value is an object or a number was ACCEPTED
    // and then silently DROPPED at request time. Accepting what the consumer ignores is how
    // "I configured that header" becomes "it never went out".
    for (const [hk, hv] of Object.entries(p.headers)) {
      if (typeof hv !== 'string') return `provider ${name}: headers["${hk}"] must be a string`;
    }
  }
  return null;
}
export function modelsDocProblem(doc) {
  if (!isPlainObject(doc)) return 'models document must be an object';
  if (doc.providers === undefined) return null; // a providers-less doc is legal (empty config)
  if (!isPlainObject(doc.providers)) return 'providers must be an object';
  for (const [name, p] of Object.entries(doc.providers)) {
    // v1.4.4 review: routingDocProblem rejects a null row while this door let it through —
    // the same shape got opposite verdicts depending on which file it was in. A null row is
    // a row the user thinks they have and no reader will use: reject it at both doors.
    if (p === null || p === undefined) return `provider ${name} must be an object (got ${String(p)})`;
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
  // v1.4.4 review: `Number.isFinite(Number(meta.priority))` accepted '' and '   ' — Number('')
  // is 0, so an empty string passed validation and then normalised to priority 0, an explicit
  // LOWEST priority, when "absent" was meant (default 1). Numbers and numeric strings only,
  // and a blank string is a value error rather than a silent re-meaning.
  if (meta.priority !== undefined && meta.priority !== null) {
    const blank = typeof meta.priority === 'string' && !meta.priority.trim();
    if (blank || !Number.isFinite(Number(meta.priority)) || typeof meta.priority === 'boolean') {
      return `routing.providers.${name}.priority must be a number (got ${JSON.stringify(meta.priority)})`;
    }
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
    if (doc.state.cooldowns !== undefined && doc.state.cooldowns !== null) {
      if (!isPlainObject(doc.state.cooldowns)) return 'state.cooldowns must be an object';
      // v1.4.4 review: the container was checked, the VALUES were not. failover reads
      // `cd.until > Date.now()`; a cooldown whose `until` is a string or missing compares
      // false and the entry silently behaves as "not cooled" — a fail-open in the one place
      // that decides whether a dead key is retried.
      for (const [k, cd] of Object.entries(doc.state.cooldowns)) {
        if (cd === null || cd === undefined) continue; // tolerated, treated as absent
        if (!isPlainObject(cd)) return `state.cooldowns["${k}"] must be an object`;
        if (!Number.isFinite(Number(cd.until))) return `state.cooldowns["${k}"].until must be a timestamp`;
      }
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
// v1.4.4 review: dropping a poisoned row is the safe direction, but doing it SILENTLY means
// a hand-edited file loses a whole provider on the next start with no trace anywhere. The
// caller passes `onDrop(reason)` and loadRouting() logs it, so "my provider disappeared" is
// answerable from the server log instead of being a mystery.
const numOr = (v, dflt) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v === 'string' && !v.trim()) return dflt;
  if (typeof v === 'boolean') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

export function normalizeRoutingDoc(doc, { onDrop = null } = {}) {
  const drop = (why) => { if (onDrop) { try { onDrop(why); } catch { /* a logging sink must not break loading */ } } };
  const r = isPlainObject(doc) ? doc : {};
  if ((!r.providers || !Object.keys(r.providers).length) && isPlainObject(r.routes)) {
    const migrated = {};
    for (const [name, meta] of Object.entries(r.routes)) {
      if (!isSafeKey(name) || !isPlainObject(meta)) { drop(`legacy routes.${name} is not an object — skipped`); continue; } // review #4: null meta threw at meta.enabled
      migrated[name] = { enabled: meta.enabled !== false, priority: numOr(meta.priority, 1), keyEnvs: [] };
    }
    r.providers = migrated;
    delete r.routes;
  }
  if (!isPlainObject(r.providers)) r.providers = {};
  for (const k of Object.keys(r.providers)) {
    const why = routingMetaProblem(k, r.providers[k]);
    if (why) { delete r.providers[k]; drop(`routing provider dropped: ${why}`); }
    else {
      const m = r.providers[k];
      if (m.keyEnvs == null) m.keyEnvs = [];
      if (m.priority != null) m.priority = numOr(m.priority, 1);
      if (m.enabled == null) m.enabled = true;
    }
  }
  if (Array.isArray(r.chains)) {
    const kept = r.chains.filter((c) => Array.isArray(c) && c.every((m) => typeof m === 'string' && m));
    if (kept.length !== r.chains.length) drop(`${r.chains.length - kept.length} malformed fallback chain(s) dropped`);
    r.chains = kept;
  } else r.chains = [];
  if (!isPlainObject(r.state)) r.state = {};
  if (!isPlainObject(r.state.cooldowns)) r.state.cooldowns = {};
  // a cooldown whose `until` is not a number compares false and behaves as "not cooled" —
  // keep it out of the map instead of leaving a fail-open entry that looks like data
  for (const [k, cd] of Object.entries(r.state.cooldowns)) {
    if (cd === null || cd === undefined) { delete r.state.cooldowns[k]; continue; }
    if (!isPlainObject(cd) || !Number.isFinite(Number(cd.until))) {
      delete r.state.cooldowns[k];
      drop(`cooldown "${k}" dropped: until is not a timestamp`);
    }
  }
  return r;
}

const safeJson = (v) => {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
};
