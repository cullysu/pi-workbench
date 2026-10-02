# Changelog

All notable changes. Dates are 2026. Format follows Keep a Changelog loosely.

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
