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

// IPv4 ranges that must never be probed on a shared host. Shared by the dotted-quad path and
// the IPv4-mapped-IPv6 path, because `::ffff:127.0.0.1` and `127.0.0.1` are the same target.
const isLocalIPv4 = (o) => (
  o[0] === 127 || o[0] === 10 || o[0] === 0 || (o[0] === 169 && o[1] === 254)
  || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)
);

// v1.4.4 review: the IPv6 half of this predicate only knew `::1`, `::` and the
// `.ipv6-literal.net` spelling, so `[fe80::1]` (link-local), `[fd12::1]` (ULA) and
// `[::ffff:127.0.0.1]` (IPv4-mapped loopback) all classified as PUBLIC and were followed
// even with PIWB_DISALLOW_LOCAL_URLS=1. The predicate is shared by the initial URL and every
// redirect hop, so that one hole was the whole policy. It is now a real prefix check:
//   ::/128 unspecified · ::1/128 loopback · fe80::/10 link-local · fc00::/7 unique-local
//   ::ffff:0:0/96 IPv4-mapped → judged by the IPv4 rules above
// The zone id (`%25eth0` in a URL, `%eth0` in a bare host) is stripped first — `fe80::1%eth0`
// is still fe80::1.
const parseIPv6 = (raw) => {
  let h = String(raw || '').toLowerCase().replace(/^\[|\]$/g, '');
  const pct = h.indexOf('%');
  if (pct !== -1) h = h.slice(0, pct);
  if (!h.includes(':')) return null;
  // an embedded dotted quad in the last 32 bits (::ffff:127.0.0.1)
  let tail = [];
  const lastColon = h.lastIndexOf(':');
  const maybeV4 = h.slice(lastColon + 1);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(maybeV4)) {
    const o = maybeV4.split('.').map(Number);
    if (o.some((n) => n > 255)) return null;
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    h = h.slice(0, lastColon + 1);
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side) => (side ? side.split(':').filter((x) => x !== '') : []);
  const left = parseSide(halves[0]);
  const right = halves.length === 2 ? parseSide(halves[1]) : [];
  const toInt = (g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : null);
  const li = left.map(toInt);
  const ri = right.map(toInt);
  if (li.some((n) => n === null) || ri.some((n) => n === null)) return null;
  const fill = 8 - (li.length + ri.length + tail.length);
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  return [...li, ...Array(halves.length === 2 ? fill : 0).fill(0), ...ri, ...tail];
};

const isLocalIPv6 = (groups) => {
  if (!groups || groups.length !== 8) return false;
  if (groups.every((g) => g === 0)) return true; // :: unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 loopback
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  // ::ffff:0:0/96 — IPv4-mapped. Same target as the dotted quad, same verdict.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return isLocalIPv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  return false;
};

export const isLocalUrlHostname = (hostname) => {
  const h = String(hostname || '').toLowerCase();
  if (LOCAL_URL_HOSTNAMES.has(h) || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h.endsWith('.ipv6-literal.net')) return true;
  // IPv4 literals (dotted quad)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const o = h.split('.').map(Number);
    if (o.some((n) => n > 255)) return false;
    return isLocalIPv4(o);
  }
  // anything with a colon is an IPv6 literal (bracketed in a URL hostname)
  if (h.includes(':')) return isLocalIPv6(parseIPv6(h));
  return false;
};

// exported for the regression lock: the parse must reject malformed input rather than
// silently classifying it as public
export const __parseIPv6 = parseIPv6;

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
  // v1.4.4 review: the file header claimed "the policy is the same at every hop" but the
  // INITIAL url was only checked by the caller (assertHttpUrl). Three call sites did; a
  // fourth would not, and one missed call would bypass the whole policy. The first hop is
  // now checked here too — the claim is enforced instead of documented.
  const first = assertHttpUrl(url, env);
  if (!first) throw new Error(`refused to fetch a non-http(s) or local URL: ${String(url).slice(0, 120)}`);
  let current = String(first);
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
