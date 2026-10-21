/**
 * cmd.exe command-line construction (pi-workbench v1.4.1 review, finding #2).
 *
 * Why this exists: on Windows the MCP bridge used to hand `command` and each `args` entry
 * to `cmd.exe /d /s /c` as separate argv elements. Node quotes those for
 * CreateProcess/CommandLineToArgvW, but cmd.exe then re-parses the JOINED line with its
 * own, different rules. An argument such as `a&b` contains no space, so Node left it
 * unquoted and cmd split it into two commands — a malicious or merely unusual mcp.json
 * could run something the config never named.
 *
 * The fix is to build the single command line ourselves, in cmd's dialect:
 *
 *   - a "bare-safe" token (no space, no cmd metacharacter) passes through verbatim;
 *   - anything else is wrapped in double quotes, the one escape cmd honours on a /c line:
 *     inside quotes cmd treats & | < > ^ ( ) and spaces as literal text, and the child's
 *     CommandLineToArgvW strips the quotes again;
 *   - `"`, `%`, `!` and CR/LF are REFUSED rather than half-escaped. A `"` would end the
 *     quoting, `%VAR%` and delayed `!VAR!` expansion happen no matter how the token is
 *     quoted, and a newline ends the command outright. Mangled silently is worse than a
 *     clear error telling the caller to point the bridge at an executable path.
 *
 * Callers must pass the returned string as ONE argv element with
 * `windowsVerbatimArguments: true` (so Node does not quote it a second time) and wrap it in
 * outer quotes for cmd's /s flag, which strips the first and last quote of the remainder
 * after /c. Because `"` is refused above, those outer quotes are unambiguous.
 *
 * Known residual nuance (kept deliberately simple): cmd does not treat `\` as an escape,
 * but a CRT-based child re-parses the token it receives, so an argument whose original text
 * ends in a backslash is not rewritten here. Such a value is preserved verbatim through
 * cmd and only a CRT child could observe the difference.
 */

// no space, no cmd metacharacter, no quote: safe to pass through untouched
const CMD_BARE_SAFE = /^[A-Za-z0-9_@+\-./:=\\~]+$/;
// cmd cannot faithfully escape these on a /c line
const CMD_UNREPRESENTABLE = /["%!\r\n]/;

/**
 * Quote one argument for a `cmd.exe /c` command line.
 * @param {string} arg
 * @returns {string}
 */
export function quoteCmdArg(arg) {
  if (typeof arg !== "string") {
    throw new Error(`cmd argument must be a string (got ${typeof arg})`);
  }
  if (arg === "") return '""';
  if (CMD_BARE_SAFE.test(arg)) return arg;
  if (CMD_UNREPRESENTABLE.test(arg)) {
    throw new Error(
      `argument ${JSON.stringify(arg)} cannot be passed through cmd.exe safely: ` +
        '`"`, `%`, `!` and newlines have no faithful escape on a /c line. ' +
        "Point the MCP server at an executable path instead of a .cmd shim, or drop the character.",
    );
  }
  // inside double quotes cmd treats & | < > ^ ( ) and spaces as literal text
  return `"${arg}"`;
}

/**
 * Build a single cmd.exe command line from a command and its arguments.
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
export function buildCmdLine(command, args = []) {
  return [command, ...args].map(quoteCmdArg).join(" ");
}
