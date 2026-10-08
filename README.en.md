# pi-workbench (English)

[![CI](https://github.com/cullysu/pi-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/cullysu/pi-workbench/actions/workflows/ci.yml)

A local-first desktop workbench for the [pi coding agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`). Cross-platform desktop app: Windows dual shells (Electron full + Tauri lightweight, ~32MB installer), Linux AppImage, macOS dmg (arm64/x64). Chinese UI.

pi-workbench does not fork or modify pi. It drives `pi --mode rpc` (stdin/stdout JSONL) as a subprocess: sessions are pi-native (`~/.pi/agent/sessions`), custom models live in `~/.pi/agent/models.json`, and everything is fully interoperable with the pi CLI.

## Features

- **Multi-provider with real failover**: model-level fallback chains, key cooldown/rotation, auto-resend after provider failures (waits for pi's own auto-retry first)
- **Data flow, stated plainly**: panel data (config, keys, sessions) stays on this machine; prompts, project context and tool results are sent to whichever model providers you configure
- **Model knowledge base**: discover models from any OpenAI-compatible/Anthropic/Google upstream; context window, max output, and first-tier pricing auto-filled from a built-in KB; qualified model picker everywhere
- **Cron jobs (built-in scheduler)**: schedule prompts daily or every N minutes; the server spawns headless pi runs and records output to per-run logs; no external scheduler needed
- **Skills management**: scans pi Agent Skills (global + project), toggle per skill; disabled skills are excluded from new sessions
- **Usage & cache analytics**: per-turn, daily, per-provider, per-model token and cache-hit stats parsed from native session files
- **MCP support**: ships an MCP bridge extension — standard `mcpServers` config (same format as Claude/Cursor), tools registered as native pi tools; mark a server `"lazy": true` for zero startup cost (two meta-tools, spawns on first call)
- **Import**: read-only browsing of Codex / Claude / ZCode / OpenCode / OMP / Gemini / Grok CLI / Aider session history
- **Extras**: git diff, project file browser, built-in terminal, backup/restore zip, config migration, live event log, goal mode (auto-continue until done)


## Architecture at a glance

- **Single-file server**: `server.mjs` (~1000 lines) = 42 named handlers + one declarative route table + a single dispatch loop; auth and 404 live in exactly one place
- **All logic lives in nine `lib/` modules**: factories with explicit ctx injection, and **every factory verifies its wiring contract at boot** (a missing dependency crashes startup loudly instead of silently dying at 9am); IO collapses to four primitives in `lib/io.mjs`
- **Secure defaults**: per-boot random token + CSP nonce (no `unsafe-inline` scripts), DOMPurify fail-closed sanitization, `path.relative` + realpath containment (symlinks/junctions cannot escape the project root), Origin checks, provider URLs forced to http(s) with capped responses, atomic config writes (tmp+rename, corrupt files preserved for forensics), CRC-checked backup zips with extraction limits, cron job ID allowlist
- **Four verification layers** (all committed and re-runnable): repo-wide `eslint` 0/0, 23 API tests + a 47-route acceptance sweep (`scripts/route-sweep.py`), integration probes (`scripts/ws-probe.mjs`: a real pi child through the full WS chain), and a browser-level probe (`scripts/ui-probe.mjs`: headless Chromium asserts replay bubbles, all 17 panels, zero console errors)
- **Five-channel builds**: every push to main produces five installers — Windows Electron NSIS, Windows Tauri NSIS, Linux AppImage (boot-tested in xvfb: HTTP 200 plus a /api/kernel check that the bundled pi answers), macOS dmg arm64 + x64; assembly writes a sha256 manifest the shell verifies before spawning (a broken install fails loudly at boot), and a CycloneDX SBOM artifact rides along

## Install

Download the installer for your platform from [Releases](../../releases) (1.2.1 shown):

| Platform | File |
|---|---|---|
| Platform | File | Which one |
| Windows (Electron) | `PiWorkbench-Setup-<version>.exe` | the default, full-featured shell — pick this if unsure |
| Windows (Tauri lightweight) | `PiWorkbench-<version>-Tauri-x64-setup.exe` | same feature surface, smaller (system WebView2) |
| Linux | `PiWorkbench-<version>-linux.AppImage` | the Linux channel; `chmod +x` and run |
| macOS (Apple Silicon) | `PiWorkbench-<version>-macOS-arm64.dmg` | pick by CPU; both dmgs bundle the same x64 Node (ARM runs it via Rosetta — the both-compatible trade-off) |
| macOS (Intel) | `PiWorkbench-<version>-macOS-x64.dmg` | same as above |

The installers **bundle a Node runtime** (Windows/Linux official x64 binaries; macOS x64 — Apple Silicon runs it via Rosetta), so **no system Node.js is needed**. `package.json` `engines >= 22.13` only constrains development from source:

- Windows installers follow system language (Chinese/English), per-user install, desktop + start menu shortcuts
- Upgrades keep config and sessions; uninstall leaves `~/.pi-workbench` and `~/.pi` untouched
- First launch extracts the bundled runtime (bundled Node + pi — works out of the box)

## Docs

- [Troubleshooting](docs/TROUBLESHOOTING.md): boot failures, port conflicts, MCP, empty sessions, log locations
- [Contributing](CONTRIBUTING.md): setup, required gates, code conventions
- [Changelog](CHANGELOG.md): behavior changes per version
- Frontend library versions: [public/vendor/README.md](public/vendor/README.md)

## Configuration

Everything is local, nothing is committed to this repo:

- **Keys**: API keys live in `~/.pi/agent/models.json` (use `$ENV_NAME` to reference an environment variable; the API answers `***` for literal keys — leave the field empty when editing to keep the stored one). Backup zips contain keys in plaintext for restore — keep them safe.
- `~/.pi-workbench/config.json` — workbench config (projects, theme, language, default model, skill toggles, optional `relaySecret`)
- `~/.pi-workbench/routing.json` — fallback chains and cooldown state
- `~/.pi/agent/models.json` — providers and models (pi-native format)

Provider keys support `$ENV_NAME` references. The repo contains no keys, endpoints, or personal data.

## Development

```bash
npm install
npm start              # server on http://127.0.0.1:32123
npm test               # API test suite (isolated HOME)
npm run electron       # Electron shell
npx tauri build        # Tauri NSIS installer (from tauri/, ~10MB)
npm run dist           # Electron NSIS installer (artifact in dist_electron/)
```

## License

MIT — see [LICENSE](LICENSE). Third-party notices in [ThirdPartyNotices.txt](ThirdPartyNotices.txt).
