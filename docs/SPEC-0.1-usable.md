# SPEC — zagent 0.1 is a usable daily driver (2026-09-14)

Maintainer verdict after first-hand use (2026-09-14): not usable as a daily
driver — the TUI has too few commands, basics like exit/update are missing
versus the top agent harnesses, and the banner shows the kernel's internal
version (`0.16.5`) instead of zagent's. Until this spec is met, 0.1 does not
ship, whatever `docs/V01-COVERAGE.md` says about kernel feature coverage.

## Goal

A developer who already uses Codex CLI, Claude Code or Grok Build can install zagent,
open the TUI, and find the daily command set they expect, with plain-language output
and correct version information. The CLI subcommands read like a product.

## Non-goals

ADE panes (browser/PDF/Office/CUA/workflow panel); new kernel features; idle-time
ticket inference (dropped from 0.1 claims; campaign ends 2026-09-20); real-machine
Windows/macOS validation (stays a stated caveat).

## Findings behind the spec (measured 2026-09-14, zagent 0.0.202)

- TUI banner prints `zagent runtime 0.16.5`: the kernel's internal version string,
  not zagent's (0.0.202) nor the runtime's (desktop 3.11.2).
- Palette lists only the kernel's 20 commands; `/exit` exists in a hidden quit set but
  is not listed, and Enter with the palette open runs the highlighted suggestion.
- No `/status`, `/cost`, `/usage`, `/context`, `/diff`, `/undo`, `/export`, `/copy`,
  `/doctor`, `/quota`, `/update`, `/theme`, `/hooks`, `/agents`, `/permissions`,
  `/memory`, `/feedback`, `/stop`, `/clear`.
- `zagent foo` prints the kernel's `zcode 0.16.5 / Usage: zcode [command]`.
- `zagent help` uses internal terms ("retry-on-envelope product path", "chain proof",
  "degraded-posture", "raw service codes", "D1/D2").
- `zagent models` lists no GLM model by default; `models zai` finds nothing.
- `zagent quota` prints raw pool codes (`TIME_LIMIT [unit=5, number=1]`).
- `goal` / `usage` / `subagents` silently pick a stale session and error out.
- Turn failures caused by rate limits show as "network retry n/10".
- `doctor` prefers the third-party zcode-app-cli (3.10.2) over the installed official
  desktop runtime (3.11.2); `inspect --json` prints `runtime.version: null`.

## Reference command sets (official docs, read 2026-09-14)

Codex CLI: /agent /approve /apps /clean /clear /compact /copy /debug-config /diff /exit
/experimental /fast /feedback /fork /goal /hooks /ide /init /keymap /logout /mcp
/memories /mention /model /new /permissions /personality /plan /plugins /ps /quit /raw
/resume /review /sandbox-add-read-dir /side /skills /status /statusline /stop /theme
/title /vim.
Claude Code: /add-dir /agents /bug /clear /compact /config /context /cost /doctor /exit
/export /help /hooks /init /login /logout /mcp /memory /model /permissions /resume
/review /rewind /skills /status /theme /usage.

## Interface

### TUI slash commands (one merged, grouped palette)

| Group | Kernel (pass-through) | zagent (client-side, new) |
|---|---|---|
| Session | /new /resume /fork /rewind /compact | /clear /exit /quit /stop /status /export /copy /title |
| Model | /model /effort /mode | /approvals→/mode, /plan→/mode plan, /cost /usage /context |
| Project | /init /goal /expert /workflow /workflows | /diff /undo /memory |
| Tools | /mcp /plugins /skill /locale | /skills /hooks /agents /permissions |
| zagent | /help /login /logout | /version /doctor /quota /update /theme /feedback /bug |

Banner: `zagent <package version> · runtime <version or kind> · <model>`. Exact-match
typed commands run on Enter even with the palette open. Retry notices name the cause
(rate limited / 5-hour window / network).

### CLI

`help` grouped and plain; `--version` shows zagent and runtime versions; unknown
commands never print kernel usage; `models` GLM-first; `quota` human wording with
correct pool rules; session-scoped commands explain which session and why; `remote`
hides device ids; `offpeak` three plain lines; `memory show` exits 0 when empty;
runtime preference: ZCODE_RUNTIME → official desktop → zcode-app-cli, with version.

## Acceptance oracles

- `npm test` green, including new `packages/tui/test-commands.mjs`, journeys for each
  new slash command, `scripts/test-ux-audit.mjs` (banned-term and exit-code audit).
- Installed-package smoke (`scripts/verify-public-package.mjs`) covers `--help`,
  `doctor`, `inspect --json`.
- Independent review per PR; a second review pass re-runs the audit on the merged
  tree; the maintainer repeats the first-use test and does not object.
- Both verdicts recorded before any 0.1 tag.
