// mcp-scrub.mjs — argv credential masking for MCP server configs.
//
// v1.4.3 review #2: the old rule tested each argv element in ISOLATION, so the split
// spelling — ["--token", "secret"] — matched nothing and the GET /api/mcp response
// returned the credential verbatim. The rule is now array-shaped (the flag consumes its
// successor), covers `--flag=value`, `-H`/`--header`, and the common auth-token variants.
// Extracted from server.mjs so the endpoint and the unit test share one implementation.

const IN_PLACE = /^(--?(?:api[-_]?key|token|auth[-_]?token|access[-_]?token|password|passwd|secret|client[-_]?secret|credential|header))=/i;
const CONSUMES_NEXT = /^(?:--?(?:api[-_]?key|token|auth[-_]?token|access[-_]?token|password|passwd|secret|client[-_]?secret|credential)|-H|--header)$/i;

export const scrubArgSecrets = (args) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') { out.push(a); continue; }
    const inPlace = IN_PLACE.exec(a);
    if (inPlace) { out.push(`${inPlace[1]}=***`); continue; }
    if (CONSUMES_NEXT.test(a) && i + 1 < args.length && typeof args[i + 1] === 'string') {
      out.push(a, '***');
      i++; // the value is consumed, not re-examined as a flag
      continue;
    }
    out.push(a);
  }
  return out;
};
