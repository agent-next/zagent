<div align="center">

# zagent

**Z.ai's coding agent, in your terminal — the part Z.ai never shipped.**

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
╭──────────────────────────────────────────────────────────────╮
│ > refactor the parser to use a lookup table                  │
╰──────────────────────────────────────────────────────────────╯
  glm-5.3 · ~/src/myproject · 12.4k tokens

⏺ Read(src/parser.py)
  ⎿ 214 lines

⏺ I'll replace the if/elif chain with a dispatch table.

⏺ Edit(src/parser.py)
  ⎿ +18 -31
```

## What you get

| | |
|---|---|
| **A real TUI** | Streaming output, tool calls, permission prompts, model/effort pickers, slash commands, `@`-file completion. Wide-character correct (CJK, emoji), and every rendered string is sanitised — no ANSI or bidi injection from model output. |
| **Headless too** | `zagent -p "…" --json` for scripts, CI and pipelines. Real exit codes: a failed turn fails, a typo'd command fails. |
| **Your plan, your machine** | Runs on your own GLM Coding Plan and your own installed runtime. Nothing bundled, nothing phoned home. |
| **The rest of the product** | Quota, sessions, per-turn diffs, memory, scheduled prompts, plugins, and off-peak routing — all from the CLI. |
| **Cross-platform** | Runtime discovery on Linux, macOS and Windows. |

## Quick start

```bash
npm install -g zagent          # or run ad-hoc: npx zagent
zagent doctor                  # checks your runtime + Coding Plan setup
zagent -p "Explain this repo"  # headless one-shot
zagent                         # interactive TUI
```

### Requirements

- **Node.js ≥ 22.15** (Node 23 needs ≥ 23.5)
- **A GLM Coding Plan** and your own installed **ZCode runtime** — the ZCode desktop app, or the
  third-party `zcode-app-cli`. Either works for both headless and interactive use: zagent brings
  its own TUI, so no third-party package is required.

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
| `zagent -p "…" [--json]` | Headless one-shot (retry-safe) |
| `zagent` | Interactive TUI |
| `zagent onboard` | First-run: checks + live smoke + guidance |
| `zagent doctor [--fix]` | Runtime / Coding-Plan / config diagnosis |
| `zagent models [query]` | Search the model catalog |
| `zagent quota [status\|usage [--days 1..30]\|balance\|preview\|reset] [--json]` | Coding-Plan usage |
| `zagent sessions` | Your task store, in the terminal |
| `zagent diff [sessionId]` | Per-turn / per-file changes |
| `zagent memory show\|index\|append` | Runtime-compatible memory |
| `zagent task list\|archive\|pin\|rename\|delete` | Inspect or modify runtime task records |
| `zagent cron add\|list\|tick` | Scheduled prompts |
| `zagent offpeak [--refresh\|--json]` | Campaign time window (exit 0 = open; billing unverified) |
| `zagent plugins` | Manage local plugins |

`za` is a short alias for `zagent`.

## How it works

zagent is a thin, protocol-first client. It discovers a compatible runtime — `ZCODE_RUNTIME`
first, then `zcode-app-cli`, then the ZCode desktop bundle per OS — and drives it over its native
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
