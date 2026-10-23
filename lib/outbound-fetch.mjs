// outbound-fetch.mjs — every request pi-workbench makes to a USER-SUPPLIED endpoint.
//
// v1.4.3 review #1 / #11 / #25: this logic lived inline in server.mjs, which made it
// invisible to the test suite — the redirect credential leak the reviewer reproduced had
// no regression lock because there was nowhere to put one. The policy is the same at every
// hop, so it belongs in one function, in one file, exercisable directly.
//
// Two rules, both fail-closed:
//   1. Only http(s) may leave the box, and with PIWB_DISALLOW_LOCAL_URLS=1 no loopback /
//      link-local / private target either — on the INITIAL url and on EVERY redirect hop.
//   2. A redirect to a different ORIGIN carries only content-negotiation headers. A
//      provider's `headers` map is arbitrary user JSON, so an allow-list (not a list of
//      known credential names) is the only rule that closes the set: Ocp-Apim-Subscription-Key
//      and every future vendor spelling are covered by construction.

const LOCAL_URL_HOSTNAMES = new Set(['localhost']);

export const isLocalUrlHostname = (hostname) => {
  const h = String(hostname || '').toLowerCase();
  if (LOCAL_URL_HOSTNAMES.has(h) || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h === '[::1]' || h === '::' || h.endsWith('.ipv6-literal.net')) return true;
  // IPv4 literals: loopback / link-local / private ranges that must never be probed on a shared host
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const o = h.split('.').map(Number);
    if (o[0] === 127 || o[0] === 10 || o[0] === 0 || (o[0] === 169 && o[1] === 254) || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)) return true;
  }
  return false;
};

// only http(s) may leave the box (no file:, ftp:, data:...). Local addresses stay allowed
// BY DEFAULT — ollama/LM Studio on 127.0.0.1 are first-class providers; a shared host can
// forbid them with PIWB_DISALLOW_LOCAL_URLS=1.
export const assertHttpUrl = (raw, env = process.env) => {
  let parsed;
  try { parsed = new URL(String(raw || '')); } catch { return null; }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return null;
  if (env.PIWB_DISALLOW_LOCAL_URLS === '1' && isLocalUrlHostname(parsed.hostname)) return null;
  return parsed;
};

// headers that describe the REQUEST rather than the caller's identity — the only ones that
// survive an origin change
export const SAFE_REDIRECT_HEADERS = new Set(['accept', 'accept-encoding', 'accept-language', 'content-type', 'user-agent', 'cache-control']);
export const MAX_REDIRECT_HOPS = 3;

// fetch + streaming size cap: a misbehaving endpoint must not balloon server memory
// (content-length alone is not enough — chunked responses omit it)
export async function fetchJsonCapped(url, opts = {}, maxBytes = 2e6, env = process.env) {
  let current = String(url);
  let hopOpts = opts;
  for (let hop = 0; ; hop++) {
    const r = await fetch(current, { ...hopOpts, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) return { r, j: {} };
      if (hop >= MAX_REDIRECT_HOPS) throw new Error(`too many redirects (> ${MAX_REDIRECT_HOPS})`);
      const next = new URL(loc, current); // relative Locations resolve against the current hop
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error(`redirect to a non-http(s) URL refused: ${next.protocol}`);
      // the same predicate the caller's URL passed, applied to EVERY hop
      if (env.PIWB_DISALLOW_LOCAL_URLS === '1' && isLocalUrlHostname(next.hostname)) {
        throw new Error(`redirect to a local address refused by PIWB_DISALLOW_LOCAL_URLS: ${next.hostname}`);
      }
      const sameOrigin = next.origin === new URL(current).origin;
      const headers = {};
      for (const [k, v] of Object.entries(hopOpts.headers || {})) {
        if (sameOrigin || SAFE_REDIRECT_HEADERS.has(String(k).toLowerCase())) headers[k] = v;
      }
      current = String(next);
      hopOpts = { ...hopOpts, headers };
      continue;
    }
    let buf;
    if (r.body && typeof r.body.getReader === 'function') {
      const reader = r.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) { try { await reader.cancel(); } catch { /* already cancelled */ } throw new Error(`response too large (> ${maxBytes} bytes)`); }
        chunks.push(value);
      }
      buf = Buffer.concat(chunks);
    } else {
      buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`response too large (> ${maxBytes} bytes)`);
    }
    let j = {};
    try { j = JSON.parse(buf.toString('utf8')); } catch { j = {}; }
    return { r, j };
  }
}
