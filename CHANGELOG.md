# Changelog

This file is the public-facing release log for the npm package `zagent`.

## 0.0.239 — 2026-09-23

- fix(tui): provision standalone accounts from the cli key when v2/config.json is absent — lifts the kernel's "Model not set" login wall on 3.12+ hosts without a GUI-written config (#564)
- chore(release): align package-lock.json with the shipped version (#563)
- docs(readme): refresh stale example version string (#566)
- fix(flock): exempt the sk-dummy123 scenario literal from the escape audit (#567)
- feat(release): FLOCK_GATE_ADJUDICATED degraded-gateway release mode (#568)

## Unreleased

## 0.0.238 — 2026-09-21

- Live-user-testing fixes: `quota reset use` checks credentials before its
  confirmation gate; `doctor` names severity and remedy on the snapshot-locked
  line; quota credential errors name the sign-in class; `-p --help --mode` no
  longer prints a refused auto value; the TUI screen model survives resize and
  kitty scrollback forms; unknown commands now match transposition typos in
  did-you-mean.
- Arguments after `--` are treated as positionals everywhere — selection and
  print scans stop at the separator.
- `offpeak --json`'s `open` field agrees with the exit code again after the
  2026-09-20 campaign end.

## 0.0.237 — 2026-09-18

- Fixed the first-run sign-in chooser on a credential-less terminal: the
  interactive `sign in [1/2/3]` prompt never actually waited for input —
  a `readline` promise quirk (nodejs/node#57035) made the card print and
  zagent exit 2 immediately. The chooser now prompts correctly, the
  browser sign-in option runs with a normal terminal, and a pasted API
  key is no longer echoed to the screen.


## 0.0.236 — 2026-09-18

- `zagent onboard` no longer stalls through the whole live smoke turn on a
  bad credential: a classified credential check now runs between the doctor
  checks and the smoke turn — a rejected or missing key fails in about a
  second with the sign-in guidance instead of tens of seconds ending in an
  opaque `Turn execution failed`, and a provider-reported exhausted quota
  window fails fast with the reset pointer. A signed-in user, a transient
  rate-limit, or a network flap still run the real smoke turn.

## 0.0.235 — 2026-09-18

- `zagent models test <provider/model>` on a provider this machine does
  not have configured now fails before the runtime is spawned —
  `provider 'x' is not configured on this machine` with the sign-in next
  step — instead of relaying the runtime's unlocalized registry error
  verbatim; runtime-side registry misses are translated to English too.
  `zagent login --help` now names the sign-up path and the `ZAI_API_KEY`
  alternative, and `zagent -p --help` groups `--target` under "not valid
  with -p" and explains what every permission mode does
  (plan/build/edit/yolo/auto).

## 0.0.234 — 2026-09-18

- Remembered permission grants are no longer opaque: each grant now
  stores a bounded, secret-redacted, terminal-safe `pattern` beside its
  hash, so `/permissions` and the new `zagent permissions` command show
  WHAT was allowed — `Bash(npm test) — allow_always` — instead of a bare
  tool name. `zagent permissions [list|revoke <pattern|all>|--reset]
  [--json]` lists grants and revokes by pattern substring or tool name;
  `all`/`--reset` clears the store, and an empty or absent store reports
  `no persisted permission grants` without creating the file.

## 0.0.233 — 2026-09-18

- `zagent -p --help` now discloses the dangerous default: the `--mode`
  row says that yolo runs every tool with no confirmation and names
  `--mode plan` as the opt-out, with a `safety:` note under the options
  table repeating it.

## 0.0.232 — 2026-09-18

- `zagent quota --json` failure objects now carry a `class` field —
  `auth`, `limit`, `network`, or `null` when unclassified — on both the
  `{http, ...body}` failure object and the `{"error"}` envelope, so
  scripts can branch on the problem kind without parsing prose. An
  unprovisioned device identity reports `auth` like a missing
  credential, and the `http` field can no longer be overridden by a
  server-supplied body field.

## 0.0.231 — 2026-09-18

- `zagent quota` errors name the problem class — "sign-in problem" with
  the fix (`zagent login` / `ZAI_API_KEY`), "quota-window problem" with
  the reset pointer, or "network problem" — across `status`, `usage`,
  `balance`, `preview`, and `reset`.
- `quota status`/`usage` resolve the plan key `zagent login` provisions
  into `~/.zcode/v2/provider_config.json` (`keySource:
  "provider-config"`), so signing in fixes quota on the first retry.

## 0.0.230 — 2026-09-17

- `--json` error paths emit the JSON error envelope on stdout: `-p
  --json` credential/no-runtime gates and `quota --json`
  failure/usage/refusal paths no longer fail silently; `zagent sessions`
  on a fresh install stays quiet about an absent tasks index.
- `zagent goal list [--all] [--json]` lists sessions read-only;
  `zagent plugins list` is a verb; a bare `zagent mcp` prints guidance
  and exits 2 instead of a silent 0.
- Paths under the user's home now render as `~/...` in `doctor`,
  `import`, `inspect`, TUI `/doctor` + `/status`, and `-p` error
  output.

## 0.0.229 — 2026-09-17

- On a credential-free machine, `quota balance`, `quota preview`, and the
  `quota reset` family now print `No ZCode credentials; run \`zagent login\`
  to sign in first` instead of a raw ENOENT path — the same no-credential
  gate `quota status` already had. A credential store missing the JWT gets
  the same message.

## 0.0.228 — 2026-09-17

- `zagent -p --browser-use` now warns up front (stderr) when the resolved
  kernel cannot resolve `playwright-core` — e.g. the desktop-bundle
  3.12.1 runtime, where headless browser support needs the app-managed
  runtime — instead of failing mid-turn. The flag still forwards
  verbatim; the warning is advisory, not a gate.

## 0.0.227 — 2026-09-17

- New `zagent bots list|show <id>|status [--json]` — a read-only view of
  the shared bot store; an absent or corrupt store reports zero bots
  and credential references are presence booleans only.

## 0.0.226 — 2026-09-17

- `--effort` now matches each model's real reasoning-level vocabulary
  (resolved from the kernel's merged provider rules): an unsupported
  level is refused up front instead of failing mid-turn, and the same
  check covers `zagent commit-msg` and the MCP `zagent_turn` tool.

## 0.0.225 — 2026-09-17

- The TUI now keeps streaming output glued to the bottom of the terminal
  with a scroll-margin (DECSTBM) writer — smoother streaming with less
  flicker on fast output. On by default (`auto`) on capable terminals
  with an automatic fallback; `ZAGENT_TUI_SCROLL=pinned|off` overrides.

## 0.0.224 — 2026-09-17

- The TUI repaints streaming frames by cell diff — only changed rows are
  rewritten, and identical frames emit no bytes — for smoother, cheaper
  streaming output. Kitty keyboard-protocol (CSI-u) keys are decoded.
- Rate-limit advice now quotes the provider's wire `retry-after`
  ("retry in ~Ns (provider retry-after)") instead of claiming none.

## 0.0.223 — 2026-09-17

- `zagent mcp` is new: a zero-dependency stdio MCP server that exposes
  zagent to any MCP-capable agent — `zagent_turn` (`mode:"plan"` is
  read-only), `zagent_quota`, `zagent_models`, `zagent_doctor`.
- File-changing tool calls render a colored unified diff under their
  transcript row, and a fold cursor (`j`/`k` + `o`) collapses single
  entries.
- Repeated network-retry status emits refresh one row in place instead
  of stacking, and stale retry counters leave the idle footer.
- `zagent task list` prints an empty state on a fresh machine instead
  of crashing, and the help palette lists `login`/`logout` with
  correctly named subcommand verbs.

## 0.0.222 — 2026-09-17

- TUI `thinking` blocks now show the reasoning phase's duration
  (`· Ns`), bounded by the first answer delta so streaming time is
  not billed as thinking.

## 0.0.221 — 2026-09-16

- Fenced code blocks in the TUI transcript now paint syntax colors,
  and streaming output commits at newline boundaries with open tables
  held until they close — no torn tables or duplicated scrollback.
- `zagent <cmd> --help` answers the command's usage row, flag notes,
  and an example for every routed verb.
- Unknown options mid-argv are refused with exit 2 before the
  credential gate, with a bounded did-you-mean suggestion.
- `-p --model` on reasoning-required models embeds the catalog
  reasoningLevel so the provider accepts the turn.
- The offpeak ticket queue bounds requeues so a crashed worker can no
  longer cycle a ticket forever.

## 0.0.220 — 2026-09-16

- The TUI transcript collapses consecutive read/list/search tool calls
  under a single `Explored` cell, and long tool output keeps its head
  and tail around the `… +N lines` marker instead of head-only.
- Turn status names the phase (`waiting`/`responding`) and counts
  received bytes; a contextual hint bar shows interrupt keys while a
  turn runs, and exiting names the session and how to resume it.
- Headless `-p` no longer retries the kernel's own argv-validation
  rejections, and `--prompt`/`-p=`/`--print=` spellings behave exactly
  like `-p`.
- `offpeak`, `stat`, and `cron` reject stray arguments as usage errors;
  `cron add` honors `--json` and `stat --attach` pre-flights its paths.

## 0.0.219 — 2026-09-16

- `zagent -p`/`--prompt` with a missing, empty, or flag-shaped value now
  fails with zagent's own usage error (exit 2) instead of leaking the
  kernel's `Usage: zcode` block.
- `--effort` is validated client-side against `low|high|max` on both `-p`
  headless runs and `commit-msg` — invalid values exit 2 before reaching
  the provider.
- The TUI coalesces frame requests to one paint per 16 ms window and
  flushes a held frame on exit, so a crash can't leave a dangling
  repaint.

## 0.0.218 — 2026-09-16

- `zagent commit-msg` drafts a commit message from your staged (or
  unstaged) diff and prints it fence-free, ready to pipe into
  `git commit -m`; `--model` picks the provider/model.
- Busy TUI turns now interrupt with armed double-Esc: Esc once arms it
  (the status hint says so), Esc again within 5 s aborts the turn.
- `zagent cron list --json` emits real JSON; cron verbs reject extra
  arguments instead of ignoring them.
- The TUI `/model` picker reads the 3.12.x kernel registry correctly —
  media flags render instead of `[object Object]` and the current-model
  marker matches exact ids.
- `zagent inspect` lists the plugins actually installed, sorted.
- `models`, `diff`, `plugins`, `doctor`, `inspect`, `onboard`, `memory`,
  `cron`, and `task` reject stray arguments as usage errors, and
  `plugins --json` always emits a JSON envelope.

## 0.0.217 — 2026-09-16

- `zagent models test zai/glm-5.3` works — the provider/model spec that
  `zagent models` prints now round-trips instead of failing as ambiguous.
- `zagent sessions --json` and `zagent task list --json` emit real JSON
  (`{count, total, sessions}` / `{count, tasks}`) instead of silently
  printing the human table; unknown flags are usage errors.
- Pasted bursts typed without escape markers can no longer submit the
  composer line-by-line via a trailing Enter.

## 0.0.216 — 2026-09-16

- First-run sign-in card no longer dumps a TypeError stack when stdin closes
  early (ctrl+D, hung-up terminal); it declines quietly instead.

## 0.0.215 — 2026-09-16

- `/login` works end to end in the TUI: the bare command opens the provider
  chooser, OAuth picks submit and show the authorization URL while sign-in is
  pending, and api-key picks open a masked prompt. Credentials are never
  echoed, queued, or recorded in plaintext, and the sign-in pseudo-session no
  longer hijacks the active session.
- Input history persists across sessions at `~/.zcode/cli/history.jsonl`
  (owner-only `0600`): up-arrow recalls past prompts, recall never clobbers a
  half-typed multi-line draft, and credential-carrying commands stay
  in-session only.
- Large pastes collapse to a `[Pasted ~N lines]` chip — atomic under delete
  keys, restorable via recall, expanded only at submit.
- Permission prompts on ZCode 3.12.x offer Allow once / Allow always / Deny
  even when the runtime sends a bare request.
- On a Node below the engines floor the interactive launch fails with an
  actionable message (and `doctor` reports it) instead of a bare SyntaxError.
- Internal entrypoints renamed `zmax` → `zagent`; `ZAGENT_*` environment
  variables are read first with `ZMAX_*` still accepted.

## 0.0.214 — 2026-09-16

- `zagent rewind` lands end to end: `rewind list` reads the runtime's real
  checkpoint ledger, `rewind latest|<id>` restores the files a turn changed
  (finished `-p` sessions are resumed so the fork works on them too), and
  `rewind changes|preview` shows a turn's file edits before you revert them.
- `zagent automation` manages scheduled prompts — the automation surface is
  served locally by the driver, backed by a cron store with standard grammar.
- `zagent usage stats [--range all|7d|30d] [--json]` shows the app-usage
  dashboard: totals, cache-hit rate, streaks, per-model and per-tool tables.
- `zagent quota reset use five-hour|week` consumes a reset card and
  `quota reset claim` claims an available one; consuming is confirm-gated and
  idempotent across retries.
- `zagent -p` accepts `--model` and `--effort`.
- TUI: streaming replies show a live reasoning preview; wide CJK/emoji
  characters measure correctly; a crash restores the terminal instead of
  leaving it in raw mode; large pastes collapse to `[Pasted ~N lines]` chips.
- TUI on ZCode 3.12.1: permission prompts now offer Allow once / Allow always /
  Deny instead of a Deny-only card.

## 0.0.213 — 2026-09-15

- `zagent update [--check]` self-updates from npm.

## 0.0.212 — 2026-09-15

- Plugin fetches now refuse redirects and pin the full CDN origin including the
  port, so a redirect or a look-alike host:port cannot reroute a download.
- TUI `/quota` copy no longer suggests `offpeak` as a window remedy, and the
  shown reset time comes from the live monitor.

## 0.0.211 — 2026-09-15

- Plugin installs pin the artifact source to https on the official CDN host
  before any fetch and fail closed after 30 s — a poisoned marketplace catalog
  can no longer turn install into a fetch-and-unpack of attacker-chosen bytes.
- `zagent cron` accepts the full standard 5-field grammar its usage line
  advertises (ranges, steps, lists, month/day names).
- Source tree: the `feishu` bot webhook binds loopback by default with a
  per-run verify token (bot channels are not part of the npm package).

## 0.0.210 — 2026-09-15

- The TUI no longer boots to "No model access configured" on 3.12.x runtimes:
  standalone account-provider credentials are provisioned at first run.

## 0.0.209 — 2026-09-15

- `zagent quota` / `quota usage` name which configured plan the key belongs to.

## 0.0.208 — 2026-09-15

- `zagent models test <provider/model|model> [--json]` runs the desktop's
  connection check against a provider/model pair.

## 0.0.207 — 2026-09-15

- `zagent offpeak tools on|off` toggles the runtime's off-peak tool port
  (ZCode 3.12.x).

## 0.0.206 — 2026-09-15

- Headless option parity with the official CLI: every flag the runtime's parser
  accepts is forwarded; `zagent -p --help` documents the verified set.

## 0.0.205 — 2026-09-15

- `zagent inspect --storage [--json]` reports `~/.zcode` disk usage by category
  (read-only).

## 0.0.204 — 2026-09-15

- ZCode desktop 3.12.1 compatibility: the runtime launches with the new builtin
  provider catalog, `models` reads the 3.12.x catalog, and version detection
  reads the runtime's own build metadata.

## 0.0.203 — 2026-09-14

- TUI gains a merged command palette (`/exit /clear /status /quota /diff
  /undo /export /theme /permissions /memory …`) and the banner reports the
  real product version.
- CLI help is grouped in plain language; unknown commands exit 2 without
  dumping runtime usage text.
- Quota and off-peak HTTP calls refuse redirects and time out instead of
  hanging; `zagent inspect` redacts camelCase secret keys.

## 0.0.202 — 2026-09-11

- TUI status line shows running subagent count; headless answers
  user-input requests with a safe decline instead of failing.

## 0.0.201 — 2026-09-11

- TUI opens slash-selection pickers (`/rewind`, `/fork`, `/resume`, …) and
  renders GFM markdown tables.

## 0.0.200 — 2026-09-11

- TUI status line shows the official context meter; `zagent usage` reports
  session token totals.

## 0.0.199 — 2026-09-11

- `zagent goal` / `zagent subagents` / `zagent remote` wrap the official
  session-goal, subagent and relay status surfaces.

## 0.0.198 — 2026-09-11

- Bundled `$using-zagent` skill ships in the npm package.

## 0.0.197 — 2026-09-10

- Permission prompts are exercised live against the official runtime;
  Always/Never grants persist in `~/.zcode/cli/grants.json`.

## 0.0.196 — 2026-09-10

- `zagent import` copies workspace commands into the project `.zcode/commands`;
  `zagent hooks list` reads only the paths the runtime reads.

## 0.0.195 — 2026-09-10

- TUI feature drop: `$skill` / `#conversation` completion, `/skill` `/mcp`
  `/goal` pickers, thinking/tool folds, queued-message actions, permission
  Tab cycling.

> Note: `zagent@0.1.0` on npm was a premature tag and is deprecated — the
> supported line is 0.0.xx.

## 0.0.194 — 2026-09-10

- Idle-time helper uses the selected personal desktop configuration.

## 0.0.193 — 2026-09-10

- `zagent quota` reads the real Coding Plan quota monitor by default.

## 0.0.192 — 2026-09-08

- TUI input decodes split escape sequences and bracketed pastes correctly —
  a terminal may split either across chunks.

## 0.0.191 — 2026-09-07

- A permission prompt can no longer trap the session — ctrl+c interrupts it.

## 0.0.190 — 2026-09-07

- ctrl+c twice exits even while a turn is running.

## 0.0.189 — 2026-09-07

- Up-arrow input history works from the first session.

## 0.0.188 — 2026-09-07

- A failed turn stops the status line instead of spinning forever.

## 0.0.187 — 2026-09-07

- Quota-window exhaustion prints a short actionable message instead of a
  stack trace.

## 0.0.186 — 2026-09-07

- README rewritten around what the project actually is.

## 0.0.185 — 2026-09-07

- `zagent <cmd> --help` prints real per-command help.

## 0.0.184 — 2026-09-07

- The published package is correctly named `zagent`.

## 0.0.183 — 2026-09-07

- The installed-package verification gate ships with the package.

## 0.0.182 — 2026-09-07

- zagent ships its own TUI: interactive sessions run against a stock ZCode
  desktop install — no third-party package required.

## 0.0.181 — 2026-09-07

- Source tree: WeChat bot login survives unscanned QR windows (bot channels
  are not part of the npm package).

## 0.0.180 — first public release

- Open-source, GLM-native terminal coding agent that drives your own installed
  ZCode runtime / GLM Coding Plan (BYO key). Headless one-shot (`zagent -p`)
  and interactive TUI.
- Commands: doctor, onboard, models, quota, sessions, diff, memory, cron,
  plugins.
- Cross-platform runtime discovery (Linux / macOS / Windows); Linux fully
  validated.
- Ships no upstream binaries; MIT, non-commercial intent. See NOTICE for the
  interoperability disclaimer.
