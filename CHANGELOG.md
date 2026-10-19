# Changelog

All notable changes. Dates are 2026. Format follows Keep a Changelog loosely.

## 1.3.8 — 2026-10-20

### Fixed (from the independent v1.3.7 review — 14 items; release architecture, credential boundary, input validation)

**The macOS arm64 dmg carries an arm64 runtime (P1-1):**
- The build downloaded one `darwin-x64` Node and packed it into BOTH dmgs, so the "arm64" build only started under Rosetta 2. Each architecture now fetches its own tarball, asserts it with `lipo -archs` before zipping, and builds its own `pkg-runtime-<arch>.zip`; the dmgs are built in separate `electron-builder` invocations and then **the artifacts themselves are mounted, their `runtime.zip` extracted and the bundled `node` arch verified** — the claim is checked against what ships, not against the build inputs.

**The GUI admin token no longer reaches the agent (P1-2):**
- `server.mjs` captures `PIWB_TOKEN` and then deletes it (plus `PIWB_EMBED_TOKEN`) from its own environment before any spawn. Every child — pi, MCP servers, tool shells, cron runs, git — used to inherit it, so pi could read the credential that unlocks `/api/term/exec`, `/api/config`, backups and cron. The MCP bridge strips it again as defence in depth. (The token the shells hand the page is unchanged; only the subprocess environment lost it.)

**A refused queue entry can no longer eat the prompt (P2-3):**
- `wsSend`/`rpcTo` report acceptance. `submitPrompt` builds the frame first, and only after the wire accepts it clears the composer / consumes the pending image and draws the user bubble; a refusal restores the draft, the attachment and says why.

**A successful session open now resolves (P2-4):**
- The v1.3.7 deferred only had a reject path: the `opened` and `pi-session-file` frames took the reject function and dropped it, so `startInProject` and the new-session button waited out the 20 s backstop and then threw. One `{resolve, reject, timer}` per tabId now settles on arrival, denies on `open-denied`, and clears its timer either way. (Self-inflicted in v1.3.7; the old contract test only asserted the strings, never that the promise settles.)

**Cron stops leaking descriptors (P2-5):**
- The cross-process run lock was unlinked but never closed on either path (settle and spawn-prep failure). Both now close before unlinking.

**Imports are bounded (P2-6):**
- Session import stats the file first and refuses >100 MB with 413, and the reply is capped at the newest 20 000 entries with `truncated` + `total` reported. Claude/Gemini/Aider readers used to hand whatever size the file was to `readFileSync`.

**Malformed documents are 400s, not 500s (P2-7):**
- Cron jobs, routing providers and model rows are validated **member by member** (object shape, string ids) instead of only checking that the container is an array/object. `{"jobs":[null]}`, `{"providers":{"x":null}}` and a null model row used to reach `j.name` / `meta.enabled` / `m.id` and surface as 500s.

**`__proto__` can no longer poison the process (P2-8):**
- Provider names pass an `isSafeKey` gate (`__proto__`/`constructor`/`prototype` rejected) and provider rows are created with `Object.hasOwn`. `{"providers":{"__proto__":{...}}}` used to write `enabled` onto `Object.prototype` — every plain object in the process then read as a disabled provider.

**Saving JSON really saves it (P2-9, P2-10):**
- The advanced-JSON save reloads `state.modelsDoc` from the server response (the next provider-form save used to rewrite the pre-edit document over it). Deleting a provider now also clears a `defaultModel` that pointed at it and prunes routing chains naming it.

**Numbers are escaped like everything else (P3-13):**
- `contextWindow`/`maxTokens` go through `esc(String(...))` before landing in an attribute.

**Tauri supervises its server (P3-11):**
- The shell gained the same 1.5 s grace + two-restart budget + five-minute stability reset Electron has, and a `QUITTING` flag so shutdown cannot resurrect the process. Before this, any abnormal server exit left the window talking to a dead port until the app was restarted.

**Path checks and syscalls name the same file (P3-12):**
- `resolveInside()` returns the resolved realpath and every file API (session delete/export, file list/read, import) uses that resolved path for the actual operation. Residual documented: a directory component can still be swapped (no `O_NOFOLLOW` on Windows).

**CI supply chain (P3-14):**
- Every workflow action is pinned to a commit SHA with the release tag in a comment (SHAs resolved through the API, not invented). Code signing remains the one gap a certificate account must close.

**Contract tests:** 23 new wave-27 assertions (67 total) covering the per-arch runtime + dmg verification, token scrub in both server and bridge, `__proto__` gate, member-level validation, import caps, lock fd, queue receipt, open settle, modelsDoc reload, chain pruning, attribute escaping, Tauri supervisor + quit guard, and resolved-path file APIs.

## 1.3.7 — 2026-10-17

### Fixed (from the independent v1.3.6 review — 5 items; draft safety, queue honesty, save rollback)

**A refused open can no longer eat the composer draft (P2-1):**
- The composer no longer clears the input before the session opens — the clear happens only at the point of no return (tab id confirmed on the wire). An `open-denied` frame now REJECTS the pending open promise (reject fn reachable from the WS handler via `state._openReject`, with a 21 s backstop for a lost frame) and `submitPrompt` catches it: the statusline says 会话打开失败 and the draft plus pending attachments stay in place.

**The offline queue stops discarding user turns (P2-2):**
- At the 200-frame cap only refresh-class RPC (`get_state` / `get_entries` / `get_available_models` / `get_available_thinking_levels`) is dropped — their answers are stale the moment they flush. When the queue holds no droppable frame, the NEW send is refused with an explicit statusline naming the operation instead of silently discarding someone's open/prompt/close/set_model/adopt.

**Save paths check the backend's answer (P3-3, P3-4):**
- Both set-default-model sites check the `/api/config` ack before updating cfg/chip — a 500 used to update the optimistic UI anyway.
- Provider save works on a CLONE of `modelsDoc` (the pre-POST in-place mutation no longer survives a refused save); a mid-sequence failure (models→routing→config) reloads all three docs from disk via the new `reloadConfigState()` so memory matches what actually got saved.

**collectProc caps are strict (P3-5):**
- Each stdout/stderr chunk is sliced to the REMAINING cap at receive time and the close path truncates again — a single oversized chunk (5000 chars vs a 200-char cap) used to slip through whole.

**Contract tests:** 5 new wave-26 assertions in `scripts/verify-audit-fixes.mjs` (composer-clear ordering, open-denied rejection wiring, queue policy, ack checks + clone/reload, chunk-level caps).

## 1.3.6 — 2026-10-17

### Fixed (from the independent v1.3.5 audit — 50 items; process identity, credential scope, cross-process locking, UI truthfulness)

**A shell service proves who it is (F01):**
- **"Something answers on the port with HTTP/1.x 200" is no longer accepted as the workbench** — both desktop shells send a fresh random nonce to the new unauthenticated `GET /api/identify?n=<hex>` and require `x-piwb-proof = HMAC-SHA256(API_TOKEN, nonce)`. A port squatter that happened to answer 200 used to be handed the API token; it cannot forge the HMAC. Electron and Tauri implement the same challenge (hand-rolled HMAC over `sha2`, constant-time compare, 3 s read timeout).

**Credentials stay inside their trust domain (F02–F04, F17–F19, F32, F38):**
- **The keys-free backup states its scope and enforces it** — the manifest carries `scope`/`scopeNote`, `config.json`/`settings.json` are packed as redacted copies, `baseUrl` userinfo and credential-looking query values are scrubbed, and provider rows are shape-validated before a restore.
- **The MCP sentinel stops following a changed command** — `***` env/args restore only when command + args are the SAME identity; the config file is written stage-then-swap after `mkdir`.
- **Write-only key fields are masked everywhere they appear** (`scrubUrlCreds` / `scrubArgSecrets` / `maskApiKeys`), and a masked `models.json` round-trip restores the stored `baseUrl` instead of destroying it.
- **Key cooldowns bind to the credential's env NAME, not its array position** (`provider#env:NAME`) — a reordered or relocated key used to cool a different slot. `keyEnvsFor` returns `[]` for a provider with a literal key (nothing to rotate), and `nextInChain` refuses a provider/model that is not in `models.json` instead of treating it as keyless.
- Corrupt config copies land in `corrupt-backups/`, capped at 3, created 0600.
- **Windows credential-file ACLs are no longer token-only (F08)** — the same per-user DACL (`icacls /inheritance:r /grant:r <user>:F`) is applied to every credential-bearing file the server or the backup module writes: `token`, `config.json`, `models.json`, `mcp.json`, `routing.json`, `cron.json`, `settings.json`, `model-meta.json`, exported zips, restore snapshots and restore temps. POSIX 0600 was already right; Windows ignored it.

**Log redaction states its real scope (F05, F06):**
- Cron run logs are created 0600 (F05).
- `docs/TROUBLESHOOTING.md` no longer implies "logs are redacted": it lists exactly which patterns are replaced and which secrets (other key formats, Cookie values, URL query tokens, child-process stderr) are NOT, and tells the user to review before pasting (F06).

**Cron has one writer and an honest window (F09–F16):**
- **Cross-process single writer** — a per-job lock file (`openSync('wx')`, 0600, stale takeover after 30 min, bootReset sweep) stops two service instances from running the same job (F09/F10).
- **The daily window is consumed only AFTER a successful spawn** — a spawn that throws, or a cooled key/model, defers the day instead of burning it (F11–F13).
- settle records the provider/model/key identity it actually ran with, and `__keyIdx` is stripped from the child env (F14).
- **Live jobs can be cancelled** — disabling or deleting a job terminates its child; `settleWatch` guarantees a settled run even when `close` never arrives; the log fd is 0600 (F15/F16/F05).

**The UI stops showing optimistic fiction (F20–F22, F40–F45):**
- WS open resolves the effective model (default + disabled-provider gate) and pins the routing key env; a cross-provider `set_model` restarts that tab's pi and reports `pi-restarted` (F20/F21).
- **Auto-resend after a failure is suppressed for a turn that used tools** — side effects no longer repeat without the user confirming (F22).
- The model chip reverts when `set_model` is not acknowledged (F41); the goal dialog answers a waiting modal before replacing it (F42); goals/theme/provider/skill/cron and the advanced JSON editor check the backend answer and roll back on failure (F43/F40); structured API errors render as errors, not as "empty file"/"no sessions"/"0 today" (F44); attachments are size-gated before they can exceed the 8 MiB WS frame (F45).

**Readers and ledgers stop losing data (F23–F31, F34):**
- Codex import keeps genuinely repeated turns (the dedupe that merged distinct rounds is gone); pi/Claude importers keep raw timestamps and tool-error semantics; every session parser null-guards its head reads (F23/F24/F29/F30).
- **Session export follows the active branch by default** (`?all=1` for every branch), emits a visible error block instead of a silently truncated 200, and degrades to a text notice rather than an empty file (F25/F28).
- The Claude ledger is last-wins per `message.id` (the first row used to win and drop the final usage); the session tree reports `windowed`; `readJsonl` returns `{items, truncated}` and usage/ledger expose `cappedFiles`/`truncatedFiles` (F26/F27/F31).
- `saveModelMeta` writes tmp+rename (F34).

**Development parity and docs (F49):**
- README code fence fixed; README.en gains the prepare-runtime + embed-token flow it was missing; `prepare-runtime.mjs` copies `data/` so a development KB is not silently empty.

**Contract tests:** 23 → 39 assertions in `scripts/verify-audit-fixes.mjs` (16 new wave-25 locks: env-name key identity, literal-key providers, chain validation, daily-window deferral, export branch/empty-transcript, error-shape rendering), and `scripts/ui-contract-probe.mjs` now checks the F01 challenge-response against the running app.

Known and queued (with the audit's own caveats): **F07** release signing (awaiting a certificate account — hash manifests detect corruption, not a malicious release), **F33** crash-safe restore journal, **F35** Tauri child-service supervision, **F36** automatic runtime-ZIP recovery after a failed validation, **F46** sidebar rescan cost, **F47** lifetime resource budgets, **F48** keyboard/AT paths and modal semantics, **F50** installer-level acceptance and supply-chain depth (pinned action digests, signed Node checksums, SBOM layering, Windows/macOS installer smoke tests). Code signing is the one item that cannot be closed from this repository alone.

## 1.3.5 — 2026-10-12

### Fixed (from the independent v1.3.4 audit — 43 behavior items; failure paths and trust contracts)

**Service survives hostile input:**
- **A malformed WebSocket upgrade target can no longer kill the whole service** — `new URL()` on `//[` threw before auth, hit the global handler, which reaps every tab and cron child and EXITS. The parse is guarded; the async HTTP handler answers 400 instead of dying as an unhandled rejection.
- **An empty/absent tabId can no longer broadcast to every client** — tab-scoped frames require a non-empty string id (broadcast's owner lookup fell through to an all-client send).
- **pi-exit frames go only to the tab's former owner/adopters** — the generic broadcast ran AFTER the Map delete and leaked exit events to every connection.
- External terminal spawns on Windows/macOS carry async error handlers (an ENOENT can no longer become an uncaughtException); a FIFO passed the old !isDirectory check — reads now require a regular file.

**"No-keys backup" becomes trustworthy (fail-closed):**
- **Cookie-class credential headers are covered** — the mask/redaction pattern is deliberately broad (`auth|cookie|token|key|secret|credential|session|subscription`); over-masking round-trips safely, missing one leaks it.
- **Corrupt cron.json in a keys-free export is OMITTED, not packed raw** — redaction failure used to fall back to the original file.
- **Export filenames carry a random suffix** — same-second "without keys" then "with keys" used to overwrite the first path with a keys-bearing zip.
- Secret files (configs, zips, restore temps) are created 0600 at write time, not chmod'd after.

**Credential ownership requires a KNOWN endpoint:**
- Save and restore both treated "old provider has a key but no baseUrl" as the SAME endpoint and inherited the credential onto a new URL. Sentinel keys/headers now restore only when BOTH sides name the same baseUrl; an unknown old endpoint is not a match.

**Config poisoning blocked at the door:**
- Backup import validates routing.json deeper: scalar `state:1` (which threw on `.cooldowns` assignment and took every routing API down) and `[null]` chains are rejected; `loadRouting` normalizes both defensively for every consumer.

**Failover does what the chain promises:**
- **`sameModelNewKey` respects model cooldowns** — a 429-cooled model is not "same model, fresh key"; the frontend used to re-open the cooled model on possibly the SAME key while a healthy successor sat in the chain.
- **Keyless providers (local Ollama/LM Studio, header-auth) enter the fallback chain** — "no managed key" was conflated with "broken".
- **Same-provider set_model keeps the key identity** — switching models reset `routeKeyIdx` to null while the process still served on its original key, so a later failure cooled the wrong slot.

**Cron: no double starts, no lost dailies:**
- **A restart-interrupted job can no longer spawn twice** — bootReset leaves a distinguishable status and a spawn ALWAYS persists its running flag (a status-only dirty check used to skip the write, and the next tick re-read `running:false` and spawned again).
- **The deferral marker reaches EVERY daily** a full budget squeezes out (only the first got it), and the contract test now drives the real sequence through tick(): intervals occupy slots → dailies come due → both deferred → slots free → both fire.

**The UI stops lying:**
- **open-denied/rpc-denied are handled** — a refused spawn kills the optimistic tabId and says why, instead of leaving a user bubble no one will answer; sendPrompt stops clearing the draft on known rejections.
- **Every save surface checks the backend answer** — the api helper resolves non-2xx to `{error}`; models/routing/config saves and provider toggles report "已保存" only on confirmation.
- **Late responses carry request identity**: discover results are dropped when the user switched providers mid-await; import list/content races are sequenced.
- **"切回" switches, never kills** — a live tab detaches to the bar first; the dangerous close-on-reattach is gone. The 4th detached tab now ends the oldest WITH a notice instead of silently unmanaging it.
- New sessions sync `selModel` to the model actually opened (chip and failure reports describe reality); abnormal pi exits reach the failover path (the old trigger sat in a listener that never sees WS frames); a shared modal answers the waiting extension before being replaced; replay resets the streaming node so continuing deltas are visible; restore refreshes in-memory config (saving stale state used to write pre-import values back); the health page no longer reports "本地服务 ok" when /api/kernel failed; GOAL_DONE must be a standalone last line; the 50-session cap says it is a window.

**Data correctness:**
- A bare `null` JSONL line can no longer kill session lists/stats/trees (skipped at the reader).
- Codex import dedupes the response_item/event_msg double representation; Gemini reads `.content` (string/parts/wrapper); Claude ledger dedupes by message id (one API call was billed once per row carrying its usage); Codex counter resets clamp per-dimension instead of booking negatives.
- The session tree reports `truncated` at the read cap; file previews declare truncation; ZIP central directories carry correct made-by/needed versions.

**Contract tests:** 16 → 23 assertions — the weak v1.3.4 checks the audit called out (a `||` that could mask failure, a deferral test that bypassed the scheduler) are replaced with tick-driven sequence tests; new locks: bootReset double-start, scalar routing rejection, unknown-endpoint restore, Cookie-class redaction, fail-closed cron export, unique export paths.

Known and queued (unchanged): code signing (awaiting a certificate account), installer-level acceptance on Windows/macOS, Tauri server auto-restart parity, full-release SBOM layering, real pagination, a11y/i18n, session-identity architecture unification, sync-IO budgets.

## 1.3.4 — 2026-10-12

### Fixed (from the independent v1.3.3 audit — execution identity, credential ownership, real pi protocol)

**Credential ownership follows the endpoint, everywhere:**
- **Discover no longer mails the stored key to a moved URL** — a changed `baseUrl` with an empty key field now refuses to attach the stored credential and asks for the new endpoint's key instead (the save path had this guard; the discover path didn't).
- **Restore no longer grafts this machine's key onto a renamed endpoint** — the models.json merge compares `baseUrl` before inheriting `apiKey`/headers (same provider name + different URL = different trust domain).
- **Credential headers survive a masked round-trip** — GET masks `Authorization`-class headers to `***`; POST now restores the stored value instead of silently destroying it, and a changed URL clears sentinel credential headers just like keys.
- **"No-keys" backups strip cooldown/cron error text** — routing.json cooldown entries keep the first 200 chars of upstream errors, which can embed the key that triggered them; a keys-free backup redacts them (cron `lastOutput` likewise).

**Execution identity:**
- **A prompt can no longer travel to a tab running another project** — `submitPrompt` verifies the tab's open cwd against the current project and detaches on mismatch, closing the whole class (title click, add project, remove project, config reload) rather than each known entry. Project switches now **detach** the live tab (server marks it unmanaged; the 30-minute orphan TTL bounds it) and a notice bar offers **切回 / 结束** — the old behavior forgot the tab entirely, leaving an unmanaged, un-reapable child.
- **Extension confirm/select/input replies return to the tab that ASKED**, not whichever tab is current at click time.
- **A detached tab's session-file event no longer rebinds the composer**, and the failover response applies **only when the armed context is still current** — a stale reply can no longer re-dress the new project in the failed task's fallback model (the fail report also carries the armed tabId, cooling the right key slot).
- **Deleting the current project ends its running tab** (stated in the confirm dialog).

**Real pi protocol:**
- **set_model rebind now actually fires** — pi 0.85 answers with the Model OBJECT (`{provider, id}`); the v1.3.3 handler read `data.model` strings that never exist, so the routing identity never re-bound and a later 401 cooled the wrong provider/key slot. Verified against the shipped rpc-types.
- **Same-model key rotation is wired end to end** — `/api/routing/fail` answers `sameModelKey` when the failing model's provider still has a usable key; the frontend re-opens the SAME model (fresh key via `envOverrideFor`) before jumping providers.
- **`${KEY}` rotation actually reaches pi** — the env override wrote the literal name `{KEY}`; it now writes the bare `KEY` that the models.json reference resolves.
- **Explicit opens honor the provider kill switch** — `enabled: false` now denies `open` (it only filtered the fallback chain before).

**Cron:**
- **Default-model jobs run the default model's rotation state** (they bypassed `envOverrideFor` entirely), and an **all-cooled provider fails closed** (`keys cooled`) instead of launching on the stale env.
- **A daily squeezed out by already-running intervals is deferred, not lost** — it stays eligible for the rest of today and fires when a slot frees (sorting alone can't fix a closed window). Window consumption moved into the spawn path, so refusals stop churning cron.json.

**Frontend / import / fork:**
- Imported view: late `get_entries` replays can't replace it; the export button refuses (it used to export the previous live session); clicking a list entry actually navigates to the workbench.
- Tool-result pairing reads `data-id` (the attribute cards actually carry; `dataset.callId` was never set).
- Replay keeps the tool-card map alive for tools still running when a replay lands; fork points invalidate on every prompt and after a fork; a stale 6s fork timeout can no longer settle a newer request; duplicated fork-cancel branch and double `get_state` deduped.
- Form-save default model no longer lies on the chip while a live tab runs another model (new sessions follow the default via `openPiSession`).

**MCP bridge / processes:**
- Stale child stdout/stderr can't pollute a replaced client (identity guards, like the exit guard v1.3.3 added); a literal `null` line no longer TypeErrors; failure paths and shutdown kill the whole tree (`taskkill /T` on Windows, process group on POSIX) instead of just the cmd wrapper; the main pi stdin has an async EPIPE handler (a write during child death can't uncaughtException the server).
- Tauri shell: the identity handshake read has a 3s timeout (a silent port-holder can't stall setup forever) and strips `NODE_OPTIONS`/`NODE_PATH` from the spawned runtime (matching Electron).

**Docs/supply-chain:** README dev quickstart says how to get a working page (`PIWB_EMBED_TOKEN=1`); MCP panel text matches the real lazy/eager default; TROUBLESHOOTING points at the real Electron log file (`server.log`); SBOM parses multi-file vendor rows again (uPlot was silently missing); repo description no longer claims "10MB / data never leaves".

**Contract tests:** `verify-audit-fixes.mjs` grows from 5 to 16 assertions (rotation env names, same-model key, cooled-out gates, deferred daily, restore grafting, error-text redaction, tree cycle) and now runs in CI's e2e job — the previous release shipped three claims its tests never locked (set_model shape, tree cycle guard, tool pairing) and all three were broken.

Known and queued (unchanged): code signing (awaiting a certificate account), macOS arm64 native runtime split, real install-and-launch acceptance for the Windows/macOS channels, full-release SBOM layering, list pagination, a11y/i18n pass, session-identity architecture unification, Tauri-side server auto-restart parity.

## 1.3.3 — 2026-10-12

### Fixed (from the independent v1.3.2 audit, 42 items)
- **A stale pi process can no longer speak for a replaced tab** — the stdout/stderr pump now checks process identity, not just the tab id, so a late event from an old spawn can never land in the new owner's timeline.
- **A confirmed model switch re-binds the tab's routing identity** — after `set_model` succeeds, the tab's provider/key state follows; a later 401 cools the provider the tab actually uses, not the one it started with.
- **Failover snapshots the armed tab BEFORE its await** — a user who switches tabs while the fail-report is in flight keeps the switch; the resend targets the tab that was armed, not "whatever is current".
- **Project-title click detaches the live tab** — switching projects no longer leaves the composer bound to the previous project's tab/session.
- **Reconnect restores the busy state** — a `get_state` reply with `isStreaming:false` clears a stuck streaming indicator; a fork that reports `cancelled` leaves the view alone, and a completed fork re-reads the session identity.
- **Imported history stays inert**: regenerate/edit buttons are gated while an imported transcript is on screen, and imported tool results pair with their call by `callId ?? id` instead of always the last card.
- **Cron: a dead project fails closed** — the job reports "project missing" instead of silently degrading to HOME; a spawn-prep throw releases the concurrency budget (two throws used to stop cron for the process lifetime); daily jobs get scheduling priority over hot interval jobs so they cannot be starved out of their window; unattended runs honor the interactive key rotation (a cooled-out key no longer arms an unattended job).
- **JSON `null` WebSocket frames** are rejected before property access.
- **Provider credentials do not follow a moved endpoint** — changing a provider's baseUrl with the masked sentinel clears the stored key instead of shipping it to the new URL.
- **Backup redaction covers credential headers** (`Authorization`/`x-api-key`/`token`-like), and restore merges a redacted models.json with the current machine's stored keys instead of dropping them.
- **Failover key envs accept `${NAME}` refs** the same way as `$NAME`.
- **MCP bridge**: a stale child's exit no longer tears down a newer client; stdin EPIPE is swallowed; the final buffered line is flushed before pending requests are rejected; lazy tool name collisions dedup with a numeric suffix.
- **collectProc settles 5s after a timeout kill** even if orphaned grandchildren hold the pipes.
- Usage: Gemini imports read `m.parts` (PartListUnion), session-tree parent chains are cycle-guarded, and the merged totals layer keeps cacheWrite/costEst so breakdowns and totals agree.
- Docs: CHANGELOG 1.3.0/1.3.1 headers un-glued (the duplicate on-line headers were a botched earlier edit).

## 1.3.2 — 2026-10-11

### Fixed (from the independent v1.3.1 audit)
- **Cron lifecycle leak**: settled children are now removed from the shutdown set — the set grew by one exited ChildProcess per run, retaining listeners and closures forever.
- **uncaughtException degrades into a safe restart**: the server reaps tab children and cron processes, then exits — the desktop shells restart it automatically. Continuing as a healthy service after an uncaught exception traded a diagnosable crash for silent corruption. `PIWB_NO_EXIT_ON_UNCAUGHT=1` is the debug hatch.
- **File browsing joins the same project identity** (case folds only where the filesystem folds) — the file list used a stricter comparison than registration/git/terminal, so the same directory could read as "known" in one panel and "unknown" in another.
- **Provider test retry actually removes the token cap now** — the "uncapped retry" resent the identical `max_tokens: 512` body, which could not succeed where the first attempt failed.
- **Reproducibility over build-time drift**: `cargo update` removed from the audit and Windows build steps — the committed Cargo.lock is both the audited and the built tree (the audit/build lockfile split from v1.3.0 is closed).
- **pin-runtime-deps verifies tarball integrity** against the committed lockfile (a version match alone would accept re-authored content).
- Docs: README version examples and the Tauri size line corrected; search placeholder says what it does.

Known and queued (unchanged): code signing (awaiting a certificate account), macOS arm64 native runtime split (Rosetta documented), deeper install-and-launch smoke for the Windows/macOS channels, full-release SBOM layering.

## 1.3.1 — 2026-10-11

### Fixed
- Ships the two server.mjs fixes that were accidentally reverted out of the v1.3.0 packaging commit: run-now answers accepted/rejected (503 when the concurrency budget rejects) instead of always-ok, and cron children join the server shutdown reap.
- Version files bumped to 1.3.1 — the v1.3.0 tag carried 1.3.0-named binaries (correct there); this tag now carries 1.3.1-named binaries built from this exact commit.

## 1.3.0 — 2026-10-11

### Fixed (P1, all reproduced by the independent v1.2.9 audit)
- **Cron budget is released on every settle** — the running counter only ever incremented, so after two successful runs no job started again until a server restart ("max 2 concurrent" had become "max 2 per lifetime"; audit repro 1,2,2). Also: malformed daily times skip instead of crashing the whole tick, run-now reports accepted/rejected instead of always-ok, and cron children join the server shutdown reap.
- **Failover can no longer talk to a tab the user moved to** — the resend re-anchored its identity onto whatever tab was current inside the second timer, which blessed every switch; the claim now happens exactly once, right after the failover opens its own tab.
- **Imported history is really read-only now** — the wave-18 read-only wiring was lost to a partial patch write-back (only the submit-guard survived); the real openImported entry, the live-event hold-out, the exit-on-open and the cross-project click sync are re-applied and locked by the contract probe.
- **Modal dialogs answer exactly once** — an explicit click cleared the cancel hook before closing, so OK used to emit confirmed:false then confirmed:true for one request.
- **CHANGELOG / CI claim honesty**: the v1.2.9 notes said the contract probe runs in CI — it did not (the workflow edit had been lost the same way). The probe is wired into the e2e job now, and packaging jobs require every quality gate.

### Fixed (P2)
- Usage aggregation: provider rows carry cacheWrite and day rows fold costEst — totals and breakdowns can no longer contradict (total $3 vs day $0); provider rows stop estimating against provider names as if they were models.
- Codex ledger: the FIRST cumulative sample is real usage (a null baseline dropped it), and events bucket on their own timestamp before the session-start fallback.
- Backup: excluding keys now keeps a redacted models.json (provider URLs and model lists survive; re-enter keys after restore); imports validate members, not just top-level shapes ([null] projects and time-less daily jobs used to pass — the latter crashed the whole scheduler tick); 0644 window before rename closed; compressed input capped at 128MB; rollback failures are reported.
- readJsonl drops an unterminated giant line DURING the read (the v1.2.9 check sat inside the newline loop where a newline-less flood could never reach it).
- MCP: transport/timeout failures now throw into pi's execution layer (matching pi-agent-core's contract: fulfilled ⇒ success), and timeouts send the protocol-level cancel so the remote tool stops.

### Docs
- README.en/CONTRIBUTING Node floor corrected to ≥22.19; English backup wording aligned with the redaction default; search placeholder now says it filters the current project's sessions.

## 1.2.9 — 2026-10-10

### Fixed
- **Extension confirm/select Escape answers really ship now**: the v1.2.8 wave-18 batch claimed the modalCancel wiring, but the edit was lost when that patch aborted early on a different failed anchor — the shipped build still left a dismissed extension waiting forever. The new browser-level contract probe caught it on its first run. The wiring is in, and the probe locks it.
- **MCP user aborts reach the MCP server**: pi hands every tool execute an AbortSignal — the bridge was dropping it. The signal now threads into `tools/call`, cancels the local call, and sends the protocol-level `notifications/cancelled` so the server stops the work.

### Added
- `scripts/ui-contract-probe.mjs` — browser-level reverse tests for the front-end state contracts (import isolation blocks submission and emits zero frames; Escape on extension confirm replies on the wire; canary sanity on the frame recorder). Wired into the CI e2e job. (Cross-project session sync and reconnect replay remain covered by code review + existing probes; deeper DOM-level cases for them are queued.)

## 1.2.8 — 2026-10-10## 1.2.8 — 2026-10-10

### Fixed (the queued product specials from the v1.2.6 review)
- **Clicking a session under another project now moves the panel with it**: the session's block carries its project, and the click syncs the panel project (title, tree, goal banner) before the open — title/file/git/goal context no longer describe the previous project.
- **Imported history is a real read-only view**: an import-view flag blocks the execution entry point (composer and goal-continue both land there, with an explanatory status line), holds live pi-events and pi-exit frames out of the imported timeline, and any real session open leaves the view. The running agent keeps running — it just can't bleed into what you're reading or swallow new input.
- **Reconnect bridges the gap**: after the socket returns, the current tab gets a `get_state` plus a full `get_entries` replay from disk — content streamed during the drop is recovered instead of leaving a busy spinner and a missing final answer (skipped while an import view is open).
- **Escape on extension confirm/select now answers the extension** (confirmed:false / cancelled:true) — a dismissed dialog no longer leaves a timeout-less extension waiting forever.

Verification: lint 0 / tests 40-40 / route sweep 47 PASS / ws-probe, failover-e2e, ui-probe, chat-e2e ALL PASS. The four behaviors are front-end state contracts — dedicated browser-level reverse tests are queued with the next probe expansion.

## 1.2.7 — 2026-10-10

### Fixed (verified defects from the independent v1.2.6 review)
- **Stop semantics**: fallback resends became cancellable executions armed with an immutable snapshot (session, project, prompt) plus a generation token; stop, tab switch, project switch or a newer failover invalidates them, re-checked at fire time. New sessions receive the pre-selected thinking level.
- **Ledger correctness**: the cost estimate no longer compounds on every read (usageCache returns the same agg object and the old fold mutated it); cacheWrite flows into model/provider/day breakdowns and day buckets carry their own estimates; the zcode ledger reads rollout's real field names (cacheReadTokens/cacheWriteTokens were zeroed); codex cumulative totals are diffed and bucketed per day.
- **Failover**: a 401 on a LITERAL key now actually removes the provider from the chain (the old cooldown wrote a slot literal keys never read); failover-e2e assertions rewritten to demand exactly that (they used to bless the bug as PASS).
- **Security**: DOMPurify upgraded 3.1.7 → 3.4.16 and vendored libraries enter the SBOM; the runtime manifest covers nested node_modules (13,954 entries measured — an old walk guard skipped every nested tree); afterPack fails loudly; the shell manifest rejects an empty file set.
- **Also**: cron run-now consumes the daily window, a global concurrency budget (2) bounds unattended fan-out, UI-created jobs carry the project cwd, backup import enforces per-file field shapes, readJsonl drops an unterminated giant line mid-read, MCP failures throw into pi's execution layer, the lazy MCP catalog lists parameters.

## 1.2.6 — 2026-10-10

### Fixed (the two P1 blockers from the independent v1.2.5 review)
- **macOS builds now generate the shell integrity manifest**: the afterPack hook only knew the Windows/Linux `resources/app` layout — on macOS it silently produced nothing while the packaged app refuses to boot without it. Both layouts are handled; the hook fails loudly if neither is found.
- **MCP one-click install now installs something pi can discover**: pi loads a subdirectory extension only through its `index.js` entry — the bridge was installed as `mcp-bridge.js`, the API returned ok, and the engine found nothing. Installed under the entry name; the bundled typebox also ships inside the runtime, so a clean machine never needs a system npm for first install.
- **The shipped runtime now physically carries the audited fixed deps**: CI's SBOM — which reads the actual tree — proved v1.2.4/v1.2.5 shipped undici 8.9.0 even though the lockfile said 8.11.2 (npm's overrides AND lockfile edits are ignored by its installer on this tree). A pack-time pin step overwrites the transitive copies and the SBOM step hard-asserts the pinned versions, so the audit gate and the shipped bytes can no longer disagree.

### Fixed (state consistency & correctness)
- Cron: the second boot-reset inside the first tick (which could double-spawn a manually started job) is gone; a settings save no longer resurrects a running flag stale past the zombie timeout; unattended jobs now run with the panel's skills switches and default model.
- Key rotation: the success report carries `tabId`, so clearCool is scoped to the key that actually served (a healthy key B's success no longer unfreezes dead key A).
- POSIX shutdown: a dying server reaps its own pi process groups (each tab is detached — SIGTERM to the server never reached them).
- The goal auto-continue timer re-checks stop state and tab identity at fire time; a pi exit releases the dead tabId instead of letting the composer swallow sends; replay registers tool cards so tool results have somewhere to land; the session export no longer silently requires a fork list nobody fetched; session trees render from window-clipped roots; `markRouteOk` never reports a healthy-model success into a dead tab.
- Provider "real reply" test treats an empty HTTP 200 as a failure; MCP tool failures are prefixed `[MCP error]` instead of parsing as success; `tools/list` follows `nextCursor` pagination; the lazy meta-tool describes each tool's parameters.
- Usage: per-model cost estimates now fold into the session total (it stayed 0 while models had values); daily stats carry cacheWrite; zcode rollouts keep cacheWriteTokens and never print a model object as `[object Object]`; codex records outside the query window are dropped instead of bucketed into it.
- readJsonl drops an unterminated oversized line immediately instead of accumulating it to EOF; config writes chmod 0600 **before** the rename (no 0644 window); backup import validates structure (syntax-valid garbage is rejected); project identity folds case only on Windows; the Electron port probe sends `Host: 127.0.0.1:port` (the portless Host made our own server look like a squatter); fresh installs create their log file; the runtime manifest covers `node_modules` and both shells reject an empty manifest; Tauri routes `target=_blank` to the system browser.

### Documented limitations (unchanged, by design or awaiting users)
- The shell→port identity probe cannot distinguish a same-user squatter (challenge data is visible to it) — same-user code execution remains the trust boundary; README states it.
- Cross-project session restore keeps panel-side file/git/goal context of the previous project (pi itself restores the session's cwd); read-only imports still share the live composer — both are queued as product work, not patches.

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
