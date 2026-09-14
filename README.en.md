# pi-workbench (English)

A local-first desktop workbench for the [pi coding agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`). Windows desktop app (Tauri + WebView2, NSIS installer), Chinese UI.

pi-workbench does not fork or modify pi. It drives `pi --mode rpc` (stdin/stdout JSONL) as a subprocess: sessions are pi-native (`~/.pi/agent/sessions`), custom models live in `~/.pi/agent/models.json`, and everything is fully interoperable with the pi CLI.

## Features

- **Multi-provider with real failover**: model-level fallback chains, key cooldown/rotation, auto-resend after provider failures (waits for pi's own auto-retry first)
- **Model knowledge base**: discover models from any OpenAI-compatible/Anthropic/Google upstream; context window, max output, and first-tier pricing auto-filled from a built-in KB; qualified model picker everywhere
- **Cron jobs (built-in scheduler)**: schedule prompts daily or every N minutes; the server spawns headless pi runs and records output to per-run logs; no external scheduler needed
- **Skills management**: scans pi Agent Skills (global + project), toggle per skill; disabled skills are excluded from new sessions
- **Usage & cache analytics**: per-turn, daily, per-provider, per-model token and cache-hit stats parsed from native session files
- **MCP support**: ships an MCP bridge extension — standard `mcpServers` config (same format as Claude/Cursor), tools registered as native pi tools, lazy connections
- **Import**: read-only browsing of Codex / Claude / ZCode / OpenCode / OMP / Gemini / Grok CLI / Aider session history
- **Extras**: git diff, project file browser, built-in terminal, backup/restore zip, config migration, live event log, goal mode (auto-continue until done)

## Install

Download `Pi Workbench_x.y.z_x64-setup.exe` from [Releases](../../releases):

- Chinese/English installer follows system language; per-user install; desktop + start menu shortcuts
- Upgrades keep config and sessions; uninstall leaves `~/.pi-workbench` and `~/.pi` untouched
- First launch extracts the bundled runtime (uses system Node, no bundled node.exe)

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
npx tauri build        # Tauri NSIS installer (from tauri/)
```

## License

MIT — see [LICENSE](LICENSE). Third-party notices in [ThirdPartyNotices.txt](ThirdPartyNotices.txt).
