# zagent

**The open-source, GLM-native terminal coding agent.** Drive GLM straight from your
terminal — a headless one-shot for scripts and CI, or a full interactive TUI — on top of
your own ZCode runtime and GLM Coding Plan.

> Unofficial. Not affiliated with or endorsed by Z.ai. **No Z.ai binaries are redistributed** —
> `zagent` drives the runtime you already installed, with your own account and key.

**English** · [中文文档](docs/README.zh-CN.md)

```bash
npx zagent -p "Explain this repository"   # headless one-shot
npx zagent                                # interactive TUI
```

## Why zagent

- **GLM-native.** Talks to the same GLM engine Z.ai ships in its desktop app, from your terminal.
- **Headless or interactive.** `zagent -p "…" --json` for scripts and pipelines, or a full TUI session.
- **Uses what you already have.** Drives your own installed ZCode runtime / GLM Coding Plan with your own key — nothing bundled, nothing phoned home.
- **Batteries included.** Quota, sessions, diffs, memory, scheduled prompts, and plugins — all from the CLI.
- **Cross-platform discovery.** Finds the runtime on Linux, macOS, and Windows.

## Requirements

- **Node.js ≥ 22.5**
- **Your own ZCode runtime + GLM account** — either the third-party `zcode-app-cli` (required for the interactive TUI) or the ZCode desktop bundle (headless).
- A GLM API key (`ZAI_API_KEY`), supplied via your own secret manager.

Model access, quotas, and pricing depend on your account.

## Install

```bash
npm install -g zagent        # or run ad-hoc with: npx zagent
zagent --version
zagent doctor                # diagnose runtime + config;  doctor --fix sets it up
```

## Quick start

```bash
export ZAI_API_KEY=…                              # your own key — never commit it
zagent doctor                                     # confirm the runtime is found
zagent -p "Refactor utils.py for readability" --json
zagent                                            # or drop into the interactive TUI
```

If the runtime isn't auto-discovered, point at it explicitly:

```bash
export ZCODE_RUNTIME=/absolute/path/to/runtime-entry.cjs
```

## Commands

| Command | What it does |
|---|---|
| `zagent -p "…" [--json]` | Headless one-shot (retry-safe) |
| `zagent` | Interactive TUI |
| `zagent onboard` | First-run: doctor + live smoke + guidance |
| `zagent doctor [--fix]` | Runtime / config / key diagnosis |
| `zagent models [query]` | Search the provider model catalog |
| `zagent quota [balance\|preview\|reset]` | Coding-plan quota |
| `zagent sessions` | GUI task store, in your terminal |
| `zagent diff [sessionId]` | Per-turn / per-file change view |
| `zagent memory show\|index\|append` | Runtime-compatible memory store |
| `zagent cron add\|list\|tick` | Scheduled prompts |
| `zagent plugins` | Inspect / manage local plugins |

`za` is a short alias for `zagent`.

## How it works

`zagent` is a thin, protocol-first client. It discovers a compatible runtime — `ZCODE_RUNTIME`
first, then `zcode-app-cli` (`~/.local/opt/…` or `node_modules/`), then the ZCode desktop bundle
per OS — and drives it. It ships **no runtime binaries** and requires your own account. Running it
can make real, billable requests and execute tools with your permissions, so use trusted
workspaces and review changes. First run may create `~/.zcode/cli/config.json` (mode `0600`).

## Platform support

Runtime discovery covers Linux, macOS, and Windows (unit-tested across all three). **Linux is the
fully validated target;** macOS and Windows are supported at the code level but not yet
real-machine-validated against every GUI install layout.

## Privacy

Task, memory, diff, and quota output can contain private workspace, prompt, account, or billing
data. Redact before sharing logs, and never commit account profiles, config files, or credential
stores.

## Not included (source-only, experimental)

Chat bots (Telegram / Feishu / WeChat), the standalone compact command, warm daemon, raw RPC
bridge, and plugin-validate are experimental and excluded from the npm package.

## License

[MIT](LICENSE). Intended for **non-commercial**, personal interoperability and research — you are
responsible for complying with Z.ai's terms for your own account. (MIT permits commercial use, so
"non-commercial" is the project's intent, not a license restriction.) See [NOTICE](NOTICE) for the
interoperability disclaimer.
