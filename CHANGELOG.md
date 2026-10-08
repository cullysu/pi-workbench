# Changelog

All notable changes. Dates are 2026. Format follows Keep a Changelog loosely.

## 1.2.2 — 2026-10-08

### Fixed
- Pre-import backup snapshots are chmod'd `0600` on POSIX — they carry the same plaintext keys as the files they protect.
- README: installer example version, server size figure.

## 1.2.1 — 2026-10-08

### Fixed
- **Electron main-window navigation guard**: the window can never leave the local origin (external URLs open in the system browser) — the token injection can no longer land on a foreign page.
- **Token reaches the page before page scripts run**: sandboxed preload (contextBridge over the argv channel) — the boot race where the first API calls fired unauthenticated is closed.
- **Export button works in the real UI**: plain `<a>` navigation cannot carry `x-api-token`; replaced with header-carrying fetch + blob download.
- `sessionTree` uses realpath containment on both ends; cron merge keeps `lastRunMs`/`lastRunDay` (toggling a switch no longer re-runs interval jobs); `/api/config` validates shapes; routing chains filtered; discover sends the selected API type; orphan tabs reaped after 30 minutes; MCP config GET masks env values (sentinel round-trip) and writes atomically.

### Added
- pkg-build runtime is lockfile-driven (committed runtime-package.json + package-lock.json, CI `npm ci`) — shipped transitive deps no longer float; SBOM identifies the runtime properly.
- chat-e2e runs in the CI e2e job; reproducible archives (sorted walk, SOURCE_DATE_EPOCH).

## 1.2.0 — 2026-10-08

### Added
- **Bootstrap-token auth model**: desktop shells generate a per-launch secret, hand it to the server via `PIWB_TOKEN`, and inject it into the page out-of-band — the token never sits in the public HTML, so local processes/users cannot self-serve credentials from `GET /`. Launchers may pin `PIWB_TOKEN`; plain `node server.mjs` keeps the embedded mode via `PIWB_EMBED_TOKEN=1` plus a 0600 token file.
- Port identity handshake upgraded to token possession (Electron + Tauri).
- WS: Origin validation on upgrade, foreign `open` ownership rejection, 8MB frame cap.
- Bundled Node v22.21.0 (pi 0.85.0 declares engines >=22.19.0); downloads SHA-256 verified on all three platforms.
- CI: `GITHUB_TOKEN` contents:read, per-job timeouts; server spawn strips NODE_OPTIONS/NODE_PATH; MCP bridge 16MB stdout cap; zip local-header + duplicate-entry checks; WS client cap 32; README states the data flow plainly.

## 1.1.9 — 2026-10-03

### Fixed
- **The bundled Node runtime was never actually used by the Electron shell**: `nodeExe` was resolved at module load, before the runtime was extracted, so the candidate list never saw the bundled node and the shell silently ran on system Node (or failed on a Node-less machine). Resolution now happens at server-start time, after extraction, with `X_OK` verification and full fallback.
- **POSIX exec bit survived the zip round-trip**: `createZip` now stores unix modes in the central directory and the extraction chmods them back (the bundled `node` would previously extract as 644 and EACCES).
- Single-entry decompression is capped (`maxOutputLength`), closing the inflate-before-cap memory spike.
- Backup import: snapshot failures abort the import before any write (a silent snapshot gap made rollback destructive in edge cases); restored files and exported zips get `0600` on POSIX; all workbench configs are written `0600`.
- `clearCool` with a key index only clears the key that succeeded — a 401'd key A no longer resurrects when key B answers.
- git status joins diff/worktrees behind the registered-project gate; `runGit` has a 60s ceiling; templates/skills reject unknown project roots.
- Tauri shell: port identity handshake (loads only the real workbench page), `PIWB_PORT` honored, Windows exit tree-kills the server's pi children.
- WS client cap (32); "本地优先 · 面板数据不出本机" copy now says what it means.

## 1.1.8 — 2026-10-03

### Added
- **WS heartbeat**: server pings every 30s; clients missing two beats are torn down (protocol-level pongs keep live connections untouched) — zombie sockets no longer linger holding adopted-tab state.
- **Tiered failover cooldowns**: `429 / rate limit / quota` errors cool the model for 300s (quota windows are minutes); other failures keep the 120s chain step; 401/403 still rotate keys.

## 1.1.7 — 2026-10-03

### Added
- **`MAX_TABS = 16`**: bounds the live pi child-process fan-out; an open past the cap gets `open-denied` with a reason (replacing an existing tabId stays allowed).
- CI lint job runs `npm audit --omit=dev --audit-level=high` on the runtime dependency tree.

## 1.1.6 — 2026-10-03

### Added
- `tests/failover.test.mjs`: real unit tests for the routing brain (10 cases — cooldown expiry, per-key rotation, chain walking); suite is 35 tests / 8s.
- Docs trio: `docs/TROUBLESHOOTING.md`, `CONTRIBUTING.md`, `CHANGELOG.md`; `public/vendor/README.md` pins vendored lib versions.

### Fixed
- `logErr` redacts secrets before they reach disk (sk-* keys, GitHub/Slack token shapes, Bearer headers) and rotates to `server.log.old` instead of dropping history.
- Windows Program Files resolved via environment variables (no hardcoded C:).

## 1.1.5 — 2026-10-02

### Added
- **Bundled Node runtime in every installer** (win-x64 / linux-x64 / darwin-x64, pinned via `NODE_BUNDLE_VERSION`): no system Node.js needed anymore; Apple Silicon runs the x64 binary via Rosetta. Installer sizes grow accordingly (Electron 143→168MB, Tauri 33→63MB, AppImage 136→171MB).
- Backup export **key-free option**: `?excludeKeys=1` skips `models.json`; the UI warns that keys are written in plaintext and offers the safe export.
- `package.json` metadata: author, keywords, repository, bugs, homepage.

### Fixed
- chat-e2e chain assertion made deterministic (okB's unique reply is the chain-step signal; the ~300ms statusline text is corroborating only).

## 1.1.4 — 2026-10-02

### Added
- API keys are write-only: `GET /api/models` masks literal keys with `***` (`$ENV` refs stay readable); POST restores the stored key on sentinel round-trip.
- WS **adopt handshake**: an ownerless tab's frames stop fanning out; a reopened window must `{type:'adopt'}` to reattach (rpc/close require ownership or adoption).
- Tauri shell verifies the runtime manifest (sha256) — parity with Electron.
- `scripts/failover-e2e.mjs` in CI: real pi + 3 mock providers verify the chain semantics.
- ui-probe runs in the CI e2e job (playwright Chromium).
- SBOM (CycloneDX 1.5) artifact on every build.

### Fixed
- Backup import is failure-atomic: per-file tmp+rename writes; mid-loop failure rolls back from the pre-import snapshot.
- Session export streams line-by-line with backpressure (was: whole file in memory).
- `realContains` resolves not-yet-existing targets through their nearest existing ancestor (macOS `/var` symlink flipped a second delete into 400).
- Runtime zip extraction checks the realpathed root (symlinked appRoot).

## 1.1.3 — 2026-10-01

### Added
- Host header validation (DNS rebinding) on HTTP and WS upgrade; cross-site Origin rejection on `/api`.
- Provider adapters: Anthropic `x-api-key` header; Google generativelanguage real discover/probe/test shapes.
- Runtime manifest (sha256 per file, verified by the Electron shell before spawn); AppImage boot test asserts `/api/kernel` reports the bundled pi.
- `uncaughtException` marks the boot degraded (`/api/kernel.degradedSince`).
- Route sweep in the ubuntu CI leg; e2e job (ws-probe).
- Issue/PR templates; aria-labels on icon-only buttons.

### Fixed
- 905s → 5s test suite on Windows (tree-kill with absolute taskkill path; spawned pi children inherit stdio pipe handles; cron killer timer unref'd).
- `node:sqlite` import made genuinely soft (65f3579 had only added the flag) + `engines >= 22.13`.
- route-sweep node discovery via `shutil.which` (was hardcoded Windows path).

## 1.1.2 — 2026-10-01

### Fixed
- **v1.1.0/v1.1.1 installers were broken on first boot** (assembly omitted `lib/` + `ledger.mjs` → ERR_MODULE_NOT_FOUND). Fixed at the source and guarded by `scripts/check-runtime.mjs` in all build jobs.
- Inlined zip reader in electron-main (AppImage AppRun PATH hijack made spawned unzip fail silently); `asar: false` (Node ESM dynamic import cannot resolve inside app.asar).
- appendLog: mkdir + stdout mirror (boot logs became visible in CI).

### Added
- macOS x64 dmg (Intel); AppImage boot test in xvfb (HTTP 200 + forensic dump on failure).

## 1.1.1 — 2026-09-30

### Added
- Linux AppImage + macOS arm64 dmg channels (first release with all three desktop platforms).

## 1.1.0 — 2026-09-30

### Added
- First five-channel release attempt (Windows NSIS ×2 + AppImage + dmg).

## 1.0.0 — 2026-09-16

- First stable release: multi-provider models, failover chains, cron, skills, usage analytics, 7-source session import, backup/restore, MCP bridge.
