<div align="center">

# zagent

**A coding-agent terminal for the GLM engine you already pay for — streaming TUI, tool calls, checkpoints, quota insight — driving your installed ZCode runtime from the shell.**

[![npm](https://img.shields.io/npm/v/zagent.svg)](https://www.npmjs.com/package/zagent)
[![downloads](https://img.shields.io/npm/dm/zagent.svg)](https://www.npmjs.com/package/zagent)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.15-brightgreen.svg)](package.json)
[![CI](https://github.com/agent-next/zagent/actions/workflows/ci.yml/badge.svg)](https://github.com/agent-next/zagent/actions/workflows/ci.yml)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

English · [中文](docs/README.zh-CN.md)

</div>

```bash
npx zagent -p "Add a --json flag to cli.py and update the tests"
```

> **Unofficial.** Not affiliated with or endorsed by Z.ai. zagent ships **no** Z.ai binaries —
> it drives the ZCode runtime you already installed, on your own account.

## Why this exists

The ZCode runtime Z.ai ships in its desktop app already has a terminal mode. Try it on a stock
install and it dies:

```console
$ zcode tui
Error: Cannot find package '@zcode/tui'
```

The runtime imports that module. Z.ai does not publish it. So the terminal path is a dead import
on every machine that has ZCode installed.

**zagent is that missing module** — a native TUI written against the runtime's own 28-member host
contract — plus the CLI around it. It supplies `@zcode/tui` through a Node ESM resolve hook, so
the runtime is read **in place**: nothing copied, nothing patched, nothing written into its
install root. You get the same GLM engine the desktop app runs, driven from the terminal you
already work in, on the Coding Plan you already pay for.

```console
$ zagent
⏺ zagent 0.0.214 · runtime desktop-bundle 3.12.1 · account:zai/GLM-5.3
  ~/src/myproject
  ? shortcuts · / commands · @ files

╭──────────────────────────────────────────────────────────────╮
│ > refactor the parser to use a lookup table                  │
╰──────────────────────────────────────────────────────────────╯
  ⠋ working 4.2s · esc interrupt

I'll replace the if/elif chain with a dispatch table…

⏺ Read(src/parser.py)
  ⎿ 214 lines

⏺ Edit(src/parser.py)
  ⎿ +18 −31

    parser = {
      "INTEGER": parse_int,
      "STRING":  parse_string,
    }

plan max · 5-hour window: 23% used · resets 14:25
build · account:zai/GLM-5.3 · max · mcp 0/2
```

## What you get

| | |
|---|---|
| **A real TUI** | Token-by-token streaming with live reasoning preview, rendered markdown (fenced code with language labels, tables), one-line tool calls with results, permission prompts, model/effort pickers, 25+ slash commands, `@`-file completion, session folds. Wide-character correct (CJK, emoji); every rendered string sanitised against ANSI/bidi injection. |
| **Headless too** | `zagent -p "…" --json` for scripts, CI and pipelines. Real exit codes: a failed turn fails, a typo'd command fails. |
| **Your plan, your machine** | Runs on your own GLM Coding Plan and your own installed runtime. Nothing bundled, nothing phoned home. |
| **The rest of the product** | Quota, sessions, per-turn diffs, memory, scheduled prompts, and plugins — all from the CLI. |
| **Cross-platform** | Runtime discovery on Linux, macOS and Windows. |

## Highlights

- **Undo any turn** — `zagent rewind latest` restores the files a turn changed, from real
  checkpoints; `rewind changes` shows what a turn did before you decide.
- **Know what you're spending** — `zagent quota` shows the 5-hour window, plan level and reset
  time right in the TUI status line; `quota reset` manages your reset cards (confirm-gated).
- **Scheduled agents** — local `cron` and server-side `automation` schedules that run prompts
  when you're not there.
- **Usage analytics** — `zagent usage stats` gives per-model/per-tool breakdowns, cache-hit
  rate and streaks from the same data the desktop app shows.
- **Your CLIs, imported** — `zagent import` brings Claude Code instructions, commands and
  skills over.

## Quick start

```bash
npm install -g zagent          # or run ad-hoc: npx zagent
zagent doctor                  # checks your runtime + Coding Plan setup
zagent -p "Explain this repo"  # headless one-shot
zagent                         # interactive TUI
zagent update                  # stay on the latest release
```

### Requirements

- **Node.js ≥ 22.15** (Node 23 needs ≥ 23.5). Check `node --version` before installing — on macOS a stale
  `/usr/local/bin/node` (an old Intel-Homebrew install) can shadow the current one in PATH. To install or
  upgrade Node on macOS: `brew install node` (or `nvm install --lts`).
- **`npm install -g` permission errors (EACCES)?** Your npm global prefix is root-owned — common with
  `/usr/local` on Intel Macs. Prefer a user-level toolchain (nvm, or `npm config set prefix ~/.npm-global`
  and add `~/.npm-global/bin` to PATH) over `sudo`. After install, `zagent`/`za` must be on PATH: they live
  in `$(npm prefix -g)/bin`.
- **A GLM Coding Plan** and your own installed **ZCode runtime** — the ZCode desktop app, or the
  third-party `zcode-app-cli`. Either works for both headless and interactive use: zagent brings
  its own TUI, so no third-party package is required. Verified against ZCode desktop 3.11.2 and
  3.12.1 — headless `-p` works with existing credentials; the interactive TUI on 3.12.1 additionally
  needs the new `account-provider` credential that only a 3.12.1-era sign-in writes (a 3.11.2-era
  credential store is not migrated by the kernel).

### Authentication — your GLM Coding Plan

zagent runs on **your GLM Coding Plan subscription — not a metered pay-per-token API key.**
Provide your Coding Plan credential once and zagent writes a local, `0600` config:

```bash
export ZAI_API_KEY=<your GLM Coding Plan credential>   # or reuse ~/.config/ccz/.api_key
zagent doctor --fix                                    # writes ~/.zcode/cli/config.json
```

`zagent doctor` tells you exactly what's missing. Your credential stays on your machine and is
sent only to your own provider endpoint.

## Commands

| Command | What it does |
|---|---|
| `zagent -p "…" [--json] [options]` | Headless one-shot (retry-safe; `zagent -p --help` lists options) |
| `zagent` | Interactive TUI |
| `zagent onboard` | First-run: checks + live smoke + guidance |
| `zagent doctor [--fix]` | Runtime / Coding-Plan / config diagnosis |
| `zagent update [--check]` | Update zagent itself from npm |
| `zagent models [query]` | Search the model catalog; `models test <provider/model>` checks a connection |
| `zagent quota [status\|usage [--days 1..30]\|balance\|preview\|reset] [--json]` | Coding-Plan usage |
| `zagent sessions` | Your task store, in the terminal |
| `zagent diff [sessionId]` | Per-turn / per-file changes |
| `zagent rewind [list\|latest\|<checkpointId>\|changes\|preview [<checkpointId>]] [--message id] [--session id] [--json]` | Inspect or restore workspace checkpoints (undo a turn's file edits) |
| `zagent memory show\|index\|append` | Runtime-compatible memory |
| `zagent task list\|archive\|pin\|rename\|delete` | Inspect or modify runtime task records |
| `zagent cron add\|list\|tick` | Scheduled prompts (local crontab) |
| `zagent automation list\|create\|update\|delete\|check-binding` | Server-side scheduled prompts (ZCode 3.12.x+) |
| `zagent offpeak [--refresh\|--json\|tools [on\|off]]` | Campaign time-window check (billing not verified); `tools` toggles the 3.12.x off-peak tool port |
| `zagent plugins` | Manage local plugins |
| `zagent hooks list [--json]` | List configured ZCode hook events (does not run them) |
| `zagent inspect [--storage] [--json]` | Dump runtime/config/skills; `--storage` = ~/.zcode category sizes (read-only) |
| `$using-zagent` | Bundled skill: what zagent is, how to tell it from the GUI, how to drive it |
| `zagent import [--dry-run\|--apply] [--force] [--json]` | Import Claude Code instructions, commands, and skills |
| `zagent goal [show\|set <text>\|pause\|resume\|clear] [--session id] [--json]` | Show or control the current session objective |
| `zagent subagents [--session id] [--json]` | List running and ended child session ids |
| `zagent usage [--session id] [--json]` | Session token totals + context baseline breakdown |
| `zagent usage stats [--range all\|7d\|30d] [--json]` | App-usage dashboard: totals, cache hit rate, streaks, per-model/tool breakdown (ZCode 3.12.x+) |
| `zagent remote [status\|connect] [--json]` | This-host relay device id / last ack (D1/D2; no second-device control) |

`za` is a short alias for `zagent`.

Context compaction runs inside the interactive TUI as `/compact` — live sessions are
process-local, so there is no standalone `zagent compact` command.

## How it works

zagent is a thin, protocol-first client. It discovers a compatible runtime — `ZCODE_RUNTIME`
first, then the ZCode desktop bundle per OS, then `zcode-app-cli` — and drives it over its native
protocol.

The interactive TUI is zagent's own (`packages/tui`). The ZCode runtime imports a `@zcode/tui`
module that z.ai does not ship, so on a stock desktop install `zcode tui` fails with
`Cannot find package '@zcode/tui'`; zagent supplies that module through a Node ESM resolve hook.
The runtime is read **in place** — nothing is copied, patched, or written into its install root.
Set `ZAGENT_TUI=runtime` to hand off to a TUI the runtime vendors instead.

It ships **no** runtime binaries and uses **your** Coding Plan. Running it can make real
requests and execute tools with your permissions, so use trusted workspaces and review changes.

Not auto-discovered? Point at it explicitly:

```bash
export ZCODE_RUNTIME=/absolute/path/to/runtime-entry.cjs
```

## Platform support

Runtime discovery covers Linux, macOS, and Windows (unit-tested across all three). **Linux is
fully validated;** macOS and Windows are supported at the code level and being hardened against
every GUI install layout.

## Privacy

`zagent quota` reads the live Z.ai Coding Plan pools; `zagent quota usage --days 7 --json`
reads account-wide calls and reported tokens (1–30 Singapore calendar days, including
the partial current day). Reported tokens are not billed credits, and shared-account
usage cannot distinguish ccz from zagent. Missing quota amounts remain unknown;
percentages can be rounded. `ZAI_API_KEY` explicitly overrides the queried account;
otherwise the selected CLI provider key is used, with the ccz key file as a fallback
only when CLI configuration is absent. `balance` / `preview` query separate desktop
billing records; an empty balance is not proof of zero Coding Plan usage. `reset`
reads reset-card availability without consuming a card.

Task, memory, diff, and quota output can contain private workspace, prompt, or account data.
Redact before sharing logs, and never commit credentials or config files.

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING](CONTRIBUTING.md) and [SECURITY](SECURITY.md).
Questions and ideas go in [Discussions](https://github.com/agent-next/zagent/discussions).

## License

[MIT](LICENSE) — for **non-commercial**, personal interoperability and research. You are
responsible for complying with Z.ai's terms for your own account. See [NOTICE](NOTICE) for the
interoperability disclaimer.
