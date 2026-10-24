// mcp-scrub.mjs — argv credential masking for MCP server configs.
//
// v1.4.3 review #2: the old rule tested each argv element in ISOLATION, so the split
// spelling — ["--token", "secret"] — matched nothing and the GET /api/mcp response
// returned the credential verbatim. The rule is now array-shaped (the flag consumes its
// successor), covers `--flag=value`, `-H`/`--header`, and the common auth-token variants.
// Extracted from server.mjs so the endpoint and the unit test share one implementation.

// v1.4.4 review: the flag pattern was ANCHORED to a bare name, so every compound spelling
// slipped through — `--session-token` (AWS CLI's real flag), `--auth`, `--x-api-key`, and the
// `-H=Authorization: ...` equals form. The point of this file is to close that door, so the
// match is now "any flag whose NAME contains a credential word", plus env-style argv
// (`API_KEY=abc`), which is how a server is handed a key without a flag at all.
// `key` alone must match: `API_KEY=abc` is an env-style argv element and `-H=…` is the
// equals form of the header flag. Both were left unmasked by the first cut.
const CRED_WORD = '(?:key|auth|token|passw|secret|credential|session|cookie|bearer)';
// `--anything-with-a-credential-word` (allows --session-token, --auth-token, --x-api-key …)
const FLAG_WITH_CRED = new RegExp(`^--?[A-Za-z0-9_.-]*${CRED_WORD}[A-Za-z0-9_.-]*$`, 'i');
const HEADER_FLAG = /^(?:-H|--header)$/i;
// `-H=` / `--header=` carry a whole header line (often `Authorization: Bearer …`)
const IN_PLACE = new RegExp(`^((?:-H|--header)|--?[A-Za-z0-9_.-]*${CRED_WORD}[A-Za-z0-9_.-]*)=`, 'i');
// an argv element that IS an assignment, not a flag: KEY=value / KEY: value
const ENV_ASSIGN = new RegExp(`^([A-Za-z_][A-Za-z0-9_]*${CRED_WORD}[A-Za-z0-9_]*)=`, 'i');

export const scrubArgSecrets = (args) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') { out.push(a); continue; }
    const inPlace = IN_PLACE.exec(a);
    if (inPlace) { out.push(`${inPlace[1]}=***`); continue; }
    const envAssign = ENV_ASSIGN.exec(a);
    if (envAssign) { out.push(`${envAssign[1]}=***`); continue; }
    if ((FLAG_WITH_CRED.test(a) || HEADER_FLAG.test(a)) && i + 1 < args.length && typeof args[i + 1] === 'string') {
      out.push(a, '***');
      i++; // the value is consumed, not re-examined as a flag
      continue;
    }
    out.push(a);
  }
  return out;
};
