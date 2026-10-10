# Changelog

All notable changes. Dates are 2026. Format follows Keep a Changelog loosely.

## 1.2.5 — 2026-10-10

### Fixed (wave-15 review)
- **Electron shell files are integrity-covered too**: CI writes `shell-manifest.json` (sha256 per shell file) at pack time; a packaged app refuses to start when the shell tree fails verification — same fail-closed semantics as the runtime manifest.
- The provider-test OpenAI-compatible **fallback branch** (after a 400/422) now carries `max_tokens: 512` like the primary path — a reasoning relay can no longer bill unbounded output on the retry.
- Every JSON response sends `Cache-Control: no-store` — configs, sessions and usage summaries no longer linger in browser or proxy caches.
- The token file gets an explicit Windows ACL (`icacls /inheritance:r /grant:r <user>:F`) — POSIX had 0600, Windows inherited broad ACLs.
- Cron `daily` validates the time range (00:00–23:59) — `99:99` passed the old format check and silently never fired.
- `knownProject()` compares through the same case-folded `projectKey` as registration — on Windows, a differently-cased path no longer fails project-boundary checks (file browser, git routes, cron cwd).
- `engines.node` raised to `>=22.19.0` (pi 0.85.0's floor) — the old 22.13 floor promised a range that cannot run the shipped engine.
- Backup import uses a unique temp name plus an in-flight mutex (two concurrent imports could race the same `.imp-<pid>` file), and the backup zip parser runs with a 64 MB total budget (down from 1 GB).
- The MCP bridge caps a tool result at 256 KB with an explicit truncation marker — a runaway MCP server can no longer pour unbounded text into pi's context.
- The thinking-level dropdown asks pi (`get_available_thinking_levels`) and offers only the levels the current model supports, instead of always listing off…max.
- Session tree's `activePath` is clipped to the nodes actually returned (a >4000-node session no longer highlights nodes the UI never received).
- `readJsonl` returns exactly `max` lines (the cap fired one line late and the trailing-line path bypassed it); the usage chip marks the 300-session scan window with ⚠ and a tooltip carrying the real disk count.

### Rebutted (with source refs)
- "provider test lacks `max_tokens`" — the primary paths carry 16 and 512 (server.mjs:307/324); only the 400/422 fallback was missing it (fixed above).
- "`collectProc()` kills only the direct child" — it tree-kills (lib/io.mjs:95, comment in place).
- "usage stats silently truncate" — the 300-session window sets `truncated`/`diskSessions` (lib/sources.mjs:189-191) and the 256 KB rollout cap renders an explicit warning (lib/sources.mjs:406); the panel chip now marks it too.
- "backups include plaintext keys by default" — the API defaults to excludeKeys (server.mjs:1229, `!== '0'`); including keys is an explicit opt-out.
- "ledger confuses cache-read with cache-write" — the fallback chains are strictly per-field (ledger.mjs:19-20).
- "9 release assets vs 7" — GitHub lists the two auto-generated source archives alongside the 7 uploaded assets.

## 1.2.4 — 2026-10-09

### Fixed (release integrity)
- **v1.2.3 shipped with part of its claimed fixes missing from the tag** (an aborted `git add` batch was repaired with only six files restored). Everything claimed in the 1.2.3 notes is actually in the binaries from this release on: StringDecoder JSONL reading (multibyte chars split across the 1MB chunk boundary used to corrupt), the orphan-tab sweep fix, `PIWB_PORT` in the Electron shell, real provider error text for failover, the send-clears-history guard, and camelCase usage in the ledger.
- **Release assets now publish with a `SHA256SUMS.txt`** covering every installer and the SBOM.
- The runtime manifest now covers `extensions/` (the MCP bridge could previously be swapped without failing verification), and both desktop shells **fail closed** when a packaged install is missing its manifest.
- README's clean-checkout build path works now: `npm run prepare-runtime` assembles `pkg-build/` from the committed runtime lockfile — the same dependency set CI installs.

### Fixed (process & resource governance)
- **Closing a tab kills pi's whole process tree** (MCP servers, shell tools), not just the direct child: POSIX spawns pi in its own process group, Windows uses `taskkill /T /F`. Same for the cron killer and the model probe.
- **A pi stdout flood can no longer OOM the server**: an unterminated line buffer is capped at 16 MB (tail kept).
- **Cron run logs are capped at 10 MB**; cron `cwd` is held to registered projects both at save time and at run time (the same boundary as the terminal API).
- The WS offline queue is bounded (200 frames); WS frames pass a light string-type schema gate; **MCP install now awaits `npm ci`** (lockfile-pinned integrity) and reports failure instead of claiming success.

### Fixed (desktop shells)
- Electron honors `PIWB_PORT` (matches server + Tauri behavior); the token reaches the renderer via the process environment, not the command line.
- Tauri opens external pages in the system browser — app-owned viewer webviews for remote pages are gone.

### CI
- The gate worked on its first run: the shipped runtime tree carries pi 0.85.x's pinned `undici` 8.9.0 (10 GHSAs, fixed 8.10.2+) and `brace-expansion` 5.0.9 (3 DoS GHSAs, fixed 5.0.12). The runtime lockfile now holds both at the fixed versions — npm's `overrides` engine silently ignores them on this tree (npm 11.12.1), so the lockfile is the enforcement and the audit gate is the tripwire.
- The shipped runtime dependency tree gets its own `npm audit` gate in addition to the root tree; `cargo audit` gates the Tauri shell; same-repo PRs now run the full e2e/build gates.

## 1.2.3 — 2026-10-09

### Fixed
- **Async handler rejections no longer hang requests**: the route dispatch never awaited handler promises, so an exception after the first await escaped the error filter as an unhandledRejection and the client waited forever. Every handler error now returns a JSON 500.
- Request bodies that parse to `null`/scalars are coerced to `{}` (handlers destructure; a `null` body used to throw the same way).
- **WS `open` validates `sessionPath`** with the same realpath containment as every session endpoint — a crafted frame could point `pi --session` outside the sessions dir.
- **Cron fixes**: stale `running` flags clear once at server start (a panel view used to clear a live run's lock and double-spawn); settings saves keep a live run's `running` flag; payload validation tightened (string name/prompt, unique ids, ≥0.5 min finite interval, ≤100 jobs).
- **Orphan-tab TTL actually reaps now**: the sweep skipped tabs marked `adoptedEver` at creation, so nothing was ever reaped — ownerless pi children were immortal.
- Failover now receives the **real provider error text** from the assistant turn (401/429 classification finally works from the UI path).
- Ordinary prompts **no longer wipe the visible conversation history** (only the hero empty state clears).
- 403 reload-loop source removed: the once-guard is cleared by the first successful request instead of every page load.
- `atomicWrite` uses unique temp names (concurrent config writes shared one tmp path).
- `readJsonl` uses StringDecoder (a multibyte char split across a 1MiB chunk boundary corrupted) and skips >32MB single lines.
- Ledger accepts camelCase usage shapes (ZCode rollouts counted in imports but never in the ledger).
- MCP extension pins typebox exactly and installs with `--ignore-scripts`; manifest includes the bundled node binaries; CI copies the runtime manifest anchors under their canonical names; chat-e2e self-heal only kills node/chrome images.

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
