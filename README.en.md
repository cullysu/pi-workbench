# pi-workbench (English)

[![CI](https://github.com/cullysu/pi-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/cullysu/pi-workbench/actions/workflows/ci.yml)

A local-first desktop workbench for the [pi coding agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`). Cross-platform desktop app: Windows dual shells (Electron full + Tauri ~10MB lightweight), Linux AppImage, macOS dmg (arm64/x64). Chinese UI.

pi-workbench does not fork or modify pi. It drives `pi --mode rpc` (stdin/stdout JSONL) as a subprocess: sessions are pi-native (`~/.pi/agent/sessions`), custom models live in `~/.pi/agent/models.json`, and everything is fully interoperable with the pi CLI.

## Features

- **Multi-provider with real failover**: model-level fallback chains, key cooldown/rotation, auto-resend after provider failures (waits for pi's own auto-retry first)
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
- **Five-channel builds**: every push produces five installers — Windows Electron NSIS, Windows Tauri NSIS, Linux AppImage (boot-tested in xvfb before it counts), macOS dmg arm64 + x64

## Install

Download the installer for your platform from [Releases](../../releases) (1.1.2 shown):

| Platform | File |
|---|---|
| Windows (Electron) | `PiWorkbench-Setup-<version>.exe` |
| Windows (Tauri lightweight) | `PiWorkbench-<version>-Tauri-x64-setup.exe` |
| Linux | `PiWorkbench-<version>-linux.AppImage` |
| macOS (Apple Silicon) | `PiWorkbench-<version>-macOS-arm64.dmg` |
| macOS (Intel) | `PiWorkbench-<version>-macOS-x64.dmg` |

The desktop shells require system Node.js **≥ 22.13** (mirrored in `package.json` engines; older Node only degrades the OpenCode importer — everything else works; no bundled node.exe):

- Windows installers follow system language (Chinese/English), per-user install, desktop + start menu shortcuts
- Upgrades keep config and sessions; uninstall leaves `~/.pi-workbench` and `~/.pi` untouched
- First launch extracts the bundled runtime (uses system Node)

## Configuration

Everything is local, nothing is committed to this repo:

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
