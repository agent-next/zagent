<div align="center">

# zagent

**The open-source, GLM-native terminal coding agent.**

Run GLM straight from your terminal — a headless one-shot for scripts and CI, or a full
interactive TUI — on your own **GLM Coding Plan**.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.5-brightgreen.svg)](package.json)
[![CI](https://github.com/agent-next/zagent/actions/workflows/ci.yml/badge.svg)](https://github.com/agent-next/zagent/actions/workflows/ci.yml)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

English · [中文](docs/README.zh-CN.md)

</div>

```bash
npx zagent -p "Add a --json flag to cli.py and update the tests"
```

> **Unofficial.** Not affiliated with or endorsed by Z.ai. zagent ships **no** Z.ai binaries —
> it drives the ZCode runtime you already installed, on your own account.

## What is zagent?

zagent turns your **GLM Coding Plan** into a first-class terminal coding agent. It speaks the
ZCode runtime's protocol directly, so you get the same GLM engine Z.ai ships in its desktop
app — scriptable, headless, and in the terminal where you already work.

- 🚀 **Headless or interactive** — `zagent -p "…" --json` for scripts, CI and pipelines; or a full TUI.
- 🔌 **Your plan, your machine** — runs on your own GLM Coding Plan and installed runtime. Nothing bundled, nothing phoned home.
- 🧰 **Batteries included** — quota, sessions, diffs, memory, scheduled prompts, and plugins, all from the CLI.
- 🖥️ **Cross-platform** — discovers your runtime on Linux, macOS, and Windows.
- 🪶 **Tiny & honest** — a thin protocol client; your prompts and credentials never leave your machine except to your own provider.

## Quick start

```bash
npm install -g zagent          # or run ad-hoc: npx zagent
zagent doctor                  # checks your runtime + Coding Plan setup
zagent -p "Explain this repo"  # headless one-shot
zagent                         # interactive TUI
```

### Requirements

- **Node.js ≥ 22.5**
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
| `zagent quota [balance\|preview\|reset]` | Coding-Plan usage |
| `zagent sessions` | Your task store, in the terminal |
| `zagent diff [sessionId]` | Per-turn / per-file changes |
| `zagent memory show\|index\|append` | Runtime-compatible memory |
| `zagent cron add\|list\|tick` | Scheduled prompts |
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

Task, memory, diff, and quota output can contain private workspace, prompt, or account data.
Redact before sharing logs, and never commit credentials or config files.

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING](CONTRIBUTING.md) and [SECURITY](SECURITY.md).
Questions and ideas go in [Discussions](https://github.com/agent-next/zagent/discussions).

## License

[MIT](LICENSE) — for **non-commercial**, personal interoperability and research. You are
responsible for complying with Z.ai's terms for your own account. See [NOTICE](NOTICE) for the
interoperability disclaimer.
