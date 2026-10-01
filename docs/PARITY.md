# Parity ledger — zagent vs ZCode GUI 3.11.2 + 3.12.1 (runtime 2.1.0)

> STATUS v0.0.215 (2026-09-16): the 3.12.1 compat wave (section L) is landed and released;
> headless + TUI verified against both 3.11.2 and extracted 3.12.1 kernels. 0.0.215 adds the
> TUI/auth slice (L17): `/login` completable, persistent input history, paste chips,
> options-less permission synthesis, and the internal `zmax`→`zagent` rename. Earlier headline
> (v0.0.177, 2026-09-06): **35 complete / 12 partial / 0 open** (87% weighted). Cross-platform:
> CI matrix green on ubuntu+windows+macos (CP-1..6,8 done; CP-7, a real-Windows install, not exercised).

Benchmark summary (same-task bench against a Claude Code wrapper on the same GLM plan):
latency better, token use better, correctness at parity. Among the harnesses tried, the vendor
`zcode-app-cli` leads on speed and the zagent protocol-level path lands at 7-8s.

Status: [ ] todo · [~] in progress · [x] landed+verified · [?] parked/blocked
Sources: a static survey of the desktop bundle (11 topic surveys, 2026-09-03), protocol and
identity surveys, and the A1 handshake spike. Strategy: **interop-first** — CLI shares GUI state
(~/.zcode/v2/tasks-index.sqlite, setting.json, credentials read-only) so both coexist.

## A. Protocol foundation (driver)
- [x] A1 driver: app-server NDJSON client (list/create/read; requestRuntimePreferences) — v0.0.2
- [x] A2 session/send + streaming events E2E (session/event notification kinds: turn.*, model.streaming, tool.*) — first model-calling path
- [x] A3 v4 gateway COMPLETE (0.0.144 subscribe/replay + 0.0.151 event catalog: 6 live types on desktop-continuous; fileChanges/fileRewindPreview are relay-lane payloads — boundary documented, observable only with a controller peer)
- [~] A5 NATIVE TUI (0.0.182) — v0.1 target is MAX official-feature coverage; host contract 24/28, measured 2026-09-14. zagent implements the '@zcode/tui' module the official kernel
  imports and z.ai does not ship, injected via a Node ESM resolve hook — interactive use no
  longer requires the third-party zcode-app-cli. 28-member host contract, 13 event types,
  11 stream kinds enumerated BY EXECUTION.
  Covers streaming answers w/ markdown (incl. GFM tables since 0.0.201), separated reasoning,
  tool calls, slash-command output, permission prompts, input queueing, large-paste chips
  (0.0.215+). Untrusted text is sanitised of terminal control bytes. KNOWN GAPS: the
  workflow PANEL is GUI-only (refreshWorkflowPanel throws "not available in this client").
  Permission prompt live-exercised against the official kernel
  (packages/driver/test-permission-live.mjs, PASS 2026-09-14); on 3.12.1 the kernel sends
  options-less requests and the driver synthesizes allow_once/allow_always/deny (0.0.215+).
- [x] A4-minimal (zagent entry: discovery+bootstrap+pass-through); tabs still queued (zagent-sessions panel live; tmux multi-pane next): N app-server children + switcher (tmux first, TUI tabs later)

## B. Shared state interop (GUI↔CLI coexistence)
- [~] B0 tasks-index interop: tasks table exact schema; `zagent task list|archive|pin|rename|delete` landed (0.0.19x line); create/group + auto-archive sweep predicate remain
- [x] B1 enc:v1 decrypt (ZCODE_CREDENTIAL_SECRET / fallback key) — SPIKE, read-only
- [x] B2 /quota COMPLETE: balance+preview (MITM identity) + reset/status (dual-token) — zagent-quota {balance,preview,reset}
- [x] B3 setting.json read/write parity: recentProjects cap-10, lastWorkspaceSession, indexing keys

## C. Idle-time (off-peak) tasks
- [x] C1 off-peak REST client (availability live, can_take_number: true) — exactly 4 calls: GET /ticket/availability, POST /ticket, POST /ticket/status (≤100 ids), POST /ticket/{id}/settle — SPIKE (auth shape)
- [x] C2 poll loop (nextDelayMs, backoff, clamp — 24/24 tests): server next_poll_after (default 5s, clamp 5–300s), error backoff 10s·2^n cap 5min, ticketless re-take on tick
- [x] C3 turn execution (offPeakTurn via synthetic provider) via synthetic provider offpeak-idle-plan → {origin}/api/v1/off-peak/anthropic/v1/messages (Bearer jwt + x-coding-plan-api-key)
- [x] C4 error classification (classifyOffPeakError: 3102 abort/3105 wait/3103 quota/3101 eligibility): off_peak_tasks columns; 3102/3001 abort+retake+resume('resume'); 3103 quota retry at next_take_at; 3101 eligibility
- [x] C5 create-gate UX parity: gray config, allowed_models, can_take_number, human countdown

## D. Remote & bots
- [x] D1 relay device registration (registerDevice live; fresh sid per call — cache in D2)
- [x] D2 device daemon (auth challenge-proof flow + 10s heartbeats verified live; awaiting controller = D3)
- [~] D3 phase 2 (data-envelope routing live in connectDevice) + phase 3 rpc-frame bridge CORE landed 0.0.89 (desktop-zod-exact schemas, build/assemble/ack, 24/24 tests); rpc-BRIDGE landed 0.0.111 (codec→bridge→real-runtime live loopback, 50-session framed response); only the physical relay-wire hop (second device) remains untested
- [~] D4 Feishu bot: @larksuiteoapi/node-sdk WSClient (no webhook needed); parseCallback pipeline; markdown cards chunked 1900 (driver+CLI landed 0.0.88, docs-verified + live server smoke; tenant round-trip pending app credentials)
- [~] D5 Telegram bot: REST long-poll (25s), offset persist, setMyCommands, 3900-char markdown (driver+CLI landed 0.0.86; live round-trip pending a bot token)
- [~] D6 WeChat bot (REVERSED 2026-09-06: iLink Bot API is PUBLIC — QR login, ilinkai.weixin.qq.com, errcode -14 expiry, DM-only, plain-text; driver landed 0.0.156 via optional-peer @wechatbot/wechatbot SDK — QR login + default-deny + plain-text; live round-trip needs the dependency installed and a QR scan)
- [x] D7 automations/cron parity: automations + automation_runs tables; 20s tick claim SQL (BEGIN IMMEDIATE, 10-min stale recovery, retry 30s·2^n cap 15min, 5-strike); --cron|--delay-minutes|--interval mutually exclusive; run-now idempotent (zagent cron landed 0.0.103: matcher+tick+heartbeat). 0.0.214: the kernel's `automation/*` surface turned out to be HOST-served — the driver now answers it itself (local cron store, audit lines, standard grammar) and `zagent automation list|create|update|delete|check-binding` manages it.

## E. Chat & review UX parity
- [~] E1 task chat: streamed message/thought/tool events, tool grouping (changes/explore/terminal), permission_request + plan_approval prompts (elicitation), message queueing, @-mentions, attachments (0.0.107 tool calls; 0.0.118 GUI grouping lens changes/explore/terminal + daemon autoAllow fix — daemon edits were silently denied before; mentions 0.0.134 + attachments 0.0.139 (detect+disclose on both bots — text plan cannot forward binaries); E1 substrate complete, prompts/queues remain GUI-side
- [~] E2 slash palette: commands/skills/subagents from services (CLI native already) — mostly free (0.0.142: zagent help palette — completion/complete is NOT protocol-registered (-32601), the GUI palette is TUI-internal; CLI-native equivalent delivered)
- [x] E3 diff surfaces → per-file jsdiff hunks; two-step undo (preview {canApply, safe/unsafe/ignored} → apply); hash-compare external_modified safety; state='reverted' semantics
- [x] E4 checkpoint/rewind: per-tool-call JSON artifacts {version:1, kind:'workspace_file_before_change', files[{path, beforeContent, afterContent, structuredPatch}]}; 0.0.214: `zagent rewind list|latest|<id>|changes|preview` CLI over the kernel's runtime/workspace_checkpoint ledger + v4 fileChanges/fileRewindPreview
- [x] E5 /compact steer parity (activeTurnKind 'compact', queued/running/duplicate states)
- [x] E6 memory parity (load/save/append global + project): MEMORY.md load/save/clear + project memories read (cheapest high-value)
- [x] E7 context usage: used, cache read/write, by-model — via usage.delta telemetry (live-verified). context breakdown via session/usage inputBaselineBySource (live-verified 2026-09-05); E5 compact steer done via session/compact

## F. Out-of-scope for terminal parity (documented 2026-09-04, RE-REVIEWED 2026-09-06 — holds)
- embedded browser panes/whiteboard/treemapping/model-trajectory inspector/Office-PDF preview panes (display-only; report-only equivalents where cheap: controlled-tab list, screenshots via image blocks)
- CUA OS-permission panel / macOS drag-to-Settings / pip live preview (desktop OS integration)
- browser-use IAB-only extras (user-tab claiming, WebM recording, filechooser upload) — runtime `--browser-use headless` covers the agent side

## G. Known gaps / parked
- [?] i18n full string inventory (agent died 429; the renderer-map survey already enumerates screens/settings/tab kinds — refine only if needed)
- [?] renderer remote-pairing QR UX detail (the relay-protocol survey covers device side; controller UX later)
- [~] credentials-providers deep (the identity survey + B1/B2 suffice; 0.0.127: the desktop's OFFICIAL provider catalog parsed — 10 providers/130 models, zagent models CLI — provider-list half done, credential-per-provider flow remains)
- [x] repo snapshot indexing — **won't-implement**: host-side `RepoSnapshotSidecarService` packs the whole workspace (`.git` history included) + prompt text + global config into `~/.zcode/v2/checkpoints/`, wraps it with a server-held RSA key and posts it to OSS on every GUI prompt; no settings toggle gates it. Collection, not a feature to reproduce. zagent mitigation: the staging dir is kept locked by an auto-guard on every run (`zagent snapshot status|lock|unlock`, driver/snapshot-guard.mjs)

## H. Benchmark (evidence for "why zcode is best for GLM")
- [~] H1 dual-harness benchmark harness + objective tasks (pilot validated; full matrix queued)

## I. Borrow queue (docs/research/BORROW.md)
- [x] I1 plugin contract (zquota-panel plugin + marketplace + validator live) (manifest/marketplace/hooks 7-event/userConfig)
- [x] I2 idle-task queue state machine (0.0.122: pure transitions + C4 error routing, 15/15)
- [x] I3 off-peak scheduler helper — routeToFlash/inOffPeak/offPeakTurn with 24-checkpoint tests (0.0.72-74 era, re-verified 2026-09-06)
- [x] I5 robustness trio — withModelRetry/isQuotaError/mcpVersionDiagnostic + test-robustness PASS (audit 2026-09-06; retry now product-wired in headless since 0.0.95/0.0.97)
- [~] I6 per-turn execution summary + duration footer; headless skips memory extraction (turnSummary landed 0.0.120: outcome·duration·tools·tokens line in zagentd; duration-footer-in-TUI is runtime-owned)
- [x] I7 plugin update semantics (marketplace vs installed version badge; suppressed-builtin marker) (0.0.123: marketplace↔installed version badges + suppressed marker, live-verified vs official marketplace)
- [x] I8 undocumented built-in inventory: browser-use-plugin 0.4.1, zcode-cua-plugin 0.5.13, zcode-guide-plugin 0.1.0 (beyond docs' 5) (census 2026-09-06: 8 builtins live-verified, not 3; version-nested cache layout added to the scanner)
- [x] I9 kernel-vs-GUI ledger split (CORRECTED 2026-09-06): 3.9.2–3.10.2 deltas were Electron-side (kernel stayed 0.16.5) — excluded from CLI parity; BUT the 3.11.2 update SHIPPED a kernel bump (bundle carries both 0.16.5-era strings and 2.1.0; protocol surface grew: session/goal, session/fork, setMode/setThoughtLevel, subagents — all live-probed and landed in section J). Ledger target updated to GUI 3.11.2 / runtime 2.1.0.
- [x] I3 off-peak scheduler (pure fns + live configs; routeToFlash integrated pending) (data-driven window; X says 09-18, docs say 09-20 — docs authoritative, recheck 09-20)
- [x] I4 (merged into I5)

## Post-0.0.x (top-agent references — research/reference-matrix.json)
sandbox×approval orthogonal axes, hooks architecture, subagents-as-markdown, steering grammar,
inspect command, cross-harness config compat, stream-json contract, agent dashboard. NOT in scope.

## K. Cross-platform official-artifact audit (CP-8, 2026-09-06)
All 6 targets of 3.11.2 + all-version linux-x64 audited: kernel BYTE-IDENTICAL cross-platform (e9f1868c…); macOS layout VERIFIED; win layout = electron-builder default (root needs CP-7 real install); 6 kernels in 6 releases (only 3.10.1→3.10.2 unchanged).

## J. 3.11.2 New Features (auto-detected 2026-09-05, runtime 2.1.0 compatible)
- [~] J1 PDF (0.0.151: READ verified live via the runtime's built-in Read tool parsing a real PDF; artifacts/exec unregistered (-32601); upload/preview are GUI panes)
- [x] J2 Media preview — documented-skip (display pane, renderer-side; runtime media INPUT already works via config modalities)
- [x] J3 plugin installation (0.0.148: installPlugin download+sha256-gate+flatten, zagent plugins install; LIVE official-CDN verified; per-workspace scoping = config-level, runtime-owns)
- [x] J4 Plugin update notification (0.0.147: zagent plugins badges + exit-3 scriptable signal; cachePath builtin parsing fixed; one-click apply = J3 install scope)
- [x] J5 Blocked action shows specific reason (0.0.145: permissionReason/blockedLine from the request's own reason+riskLevel; live-printed on a real denial)
- [x] J6 Middle-click close sidebar tabs (GUI-only, skip)
- [x] J7 Draft tasks viewable from sidebar (GUI-only, skip)
- [x] J8 Browser remembers window size (GUI-only, skip)

## L. 3.12.x wave (2026-09-15/16 — desktop 3.12.1, extracted read-only)
Probed against the extracted 3.12.1 kernel and the installed 3.11.2.
- [x] L1 launch env: ZCODE_BUILTIN_PROVIDER_CONFIG_FILE set on every kernel spawn (0.0.204)
- [x] L2 catalog: `zagent models` reads config/provider/zcode-builtin.json (8 plans incl.
  start/offpeak-idle, 17 templates, 84 model rules) (0.0.204)
- [x] L3 version: runtime version from asar build-meta.json; doctor warns on pending desktop
  update (0.0.204)
- [x] L4 headless flag parity: every kernel-parseArgs flag forwarded; --print/--max-turns/
  --allowed-tools/--permission-mode/--settings refused exit-2 (kernel rejects them too) (0.0.206)
- [x] L5 `offpeak tools on|off` via workspace/updateOffPeakToolPolicy, persisted +
  session/create application (0.0.207)
- [x] L6 `models test` via provider/testModelConnectivity — strict {workspace,selection}
  contract probed live (0.0.208)
- [x] L7 `inspect --storage` — official resource-manager classifier over ~/.zcode (0.0.205)
- [x] L8 quota key provenance: `quota`/`quota usage` report keySource + plan (0.0.209)
- [x] L9 3.12.x TUI credential unblock: standalone account-provider records provisioned
  (0.0.210); live-journey sandbox seeds v2 store + device.json + credential secret (0.0.214)
- [x] L10 `quota reset use five-hour|week` + `quota reset claim` over the coding-plan reset
  REST surface, confirm-gated + idempotent (0.0.214)
- [x] L11 `usage stats` over usage/stats (0.0.214)
- [x] L12 `automation/*` is host-served: driver answers it; `zagent automation` CLI (0.0.214)
- [x] L13 rewind surface: workspace_checkpoint ledger + session/fork + fileChanges/
  fileRewindPreview; `zagent rewind` CLI (0.0.214)
- [x] L14 permission requests on 3.12.1 arrive options-less; the driver synthesizes
  allow_once/allow_always/deny on the proven {decision} reply contract (0.0.215)
- [?] L15 cloud-gated/GUI-local features (settingsSync, webRemoteControl,
  manualClaimPlan, ssh, cuaPermission, feedback, settings slicing) — deferred after
  the surface probes; conversation share landed earlier via E-surface. Bots split out
  by the F3 probe: the "bots" channel is host-internal MessagePort RPC, not
  cloud-gated — read-only `zagent bots list|show|status` over the shared
  bot-config.v3/bot-state.v3 store landed; bot mutations,
  credential writes, and `bots serve` are not implemented
- [x] L16 direction probe (2026-09-16): `interaction/browser*`, `controller/*`,
  `tasks/*` are host-served (-32601 client→kernel — the F4 automation/* trap again; fprobe
  verdicts corrected). F11 covered by `--browser-use headless`, F13 by `task`/`sessions`.
  F15 `workspace/generateText` confirmed callable — contract
  {workspace,selection:{providerId,modelId},querySource,prompt|messages}; live gen probe
  DONE 2026-09-16 (~09:00Z): full contract adds
  required `selection.options.reasoningLevel` (live GLM-5.3 = low/high/max only) +
  top-level `maxOutputTokens`; result {text,selection,finishReason,usage,toolCalls?};
  `git_commit_message` querySource verified (commit-message surface reachable).
  F15a `zagent commit-msg` shipped: staged→unstaged diff → generateText
  `git_commit_message`, fence-stripped single line out; selection from --model or
  cli model.main (builtin:* → account rule map), reasoningLevel low|high|max
- [x] L17 0.0.215 TUI/auth slice: `/login` completable end to end (provider chooser, OAuth
  URL inline, masked api-key prompt; credential lines never persisted to history;
  `--no-browser` first leg live-verified 2026-09-16 (emits the chat.z.ai authorize URL and
  awaits callback); the full OAuth round-trip stays human-gated — needs a real browser auth);
  up-arrow history persists at `~/.zcode/cli/history.jsonl` (0600, home-scoped); large
  pastes collapse to atomic `[Pasted ~N lines]` chips; internal entrypoints/modules renamed
  `zmax`→`zagent` with `ZAGENT_*` env preferred (`ZMAX_*` still read)

## M. Open-source corrections (2026-09-21, zai-org/ZCode 3.14.0)

Upstream open-sourced 2026-09-20 (snapshot commit 872ad96, history squashed). Source-verified
corrections to earlier inventory interpretations (full audit not included here):

- F10 modelTrajectory is a per-call model debug pane (packages/ui/src/ModelTrajectory*, 8
  files), NOT usage-over-time graphs; the graphs surface is usage-stats
  (packages/services/src/usage-stats/, RPC `usage/stats`). L11 already targets the right surface.
- F14 settingsSync is first-run + manual IMPORT of config from 17 external agents
  (claudeCode/codexCli/openCode/goose/qwenCode/windsurf/trae...; providers/skills/commands/
  plugins/mcpServers; copy|symlink), NOT cloud cross-device sync.
- F3 "bots" is superseded by Subagents (markdown personas, RPC `session/subagents`,
  packages/services/src/subagents/); only storage remnants remain under v2/bots-*.
- F5 webRemoteControl + F15 repoWiki: ABSENT from the OSS tree, but CONFIRMED PRESENT in the
  shipped 3.12.1 desktop binary (webRemoteControl version-gated >=3.4.0; repoWiki feeds the
  RepoSnapshotSidecar capture path) — closed-source-in-product, stop CLI probing. F6 manualClaimPlan
  absent from both tree and binary surface probes; nearest is StartPlan/upgrade UI.
- F2/W2g note: the coding-plan quota reset ACTION family is `/api/v1/coding-plan/reset/*`
  (types in packages/shared/src/coding-plan-reset.ts: FIVE_HOUR|WEEK, idempotencyKey,
  opportunity check). `provider/updateAccountConfig` is NOT the reset — it is host->agent
  provider-config delivery (revision + providers + states). L10 already implements the reset
  correctly; recorded to prevent future misrouting.
- v4 protocol is exactly 34 commands (V4_WIRE_PROTOCOL_VERSION=3; full enumeration in the
  audit section 7); official CLI TUI is OpenTUI-based with 19 builtin slash commands (no
  /workflow builtin — ours is a zagent extension).
- [F12] probe DONE kernel owns wire surface (v4/cua observation notify, operation-event, official_cua grant-rule target, broker env capture + fail-closed darwin gate); host owns broker/helper, GUI owns drag-panel grant UX; 28 i18n keys exact
- [F13] probe DONE kernel owns session/workspace selectors+settings, host owns pin/archive/group/unread sidebar state in tasks-index.sqlite; i18n census 244 keys
