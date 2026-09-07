# zagent

**The open-source, GLM-native terminal coding agent.** Drive GLM straight from your
terminal — a headless one-shot for scripts and CI, or a full interactive TUI — on top of
your own ZCode runtime and GLM Coding Plan.

> Unofficial. Not affiliated with or endorsed by Z.ai. **No Z.ai binaries are redistributed** —
> `zagent` drives the runtime you already installed, with your own account and key.

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

---

## 中文

**开源、GLM 原生的终端编码 agent。** 在终端直接驱动 GLM——用于脚本与 CI 的无头一次性执行，或完整的交互式
TUI——运行在你自己安装的 ZCode runtime 与 GLM Coding Plan 之上。

> 非官方，与 Z.ai 无隶属或背书关系，**不分发其任何二进制**；zagent 只驱动你已安装的 runtime，使用你自己的账户与密钥。

```bash
npx zagent -p "解释这个仓库"   # 无头一次性执行
npx zagent                    # 交互式 TUI
```

### 特性
- **GLM 原生**：在终端直连 Z.ai 桌面端所用的同一 GLM 引擎。
- **无头或交互**：`zagent -p "…" --json` 适合脚本/流水线，或进入完整 TUI。
- **复用你已有的**：驱动你自己安装的 ZCode runtime / GLM Coding Plan，用你自己的 key，不打包、不回传。
- **开箱即用**：额度、会话、diff、memory、定时 prompt、插件，全在 CLI。
- **跨平台发现**：Linux / macOS / Windows 都能找到 runtime。

### 环境
- **Node.js ≥ 22.5**
- 你自己的 **ZCode runtime + GLM 账户**（交互 TUI 需第三方 `zcode-app-cli`；desktop bundle 提供无头运行）。
- GLM API key（`ZAI_API_KEY`），通过你自己的密钥管理提供。

### 安装与上手
```bash
npm install -g zagent      # 或 npx zagent
export ZAI_API_KEY=…       # 你自己的 key，切勿提交
zagent doctor             # 确认 runtime 被发现（doctor --fix 可写配置）
zagent -p "把 utils.py 重构得更易读" --json
zagent                    # 或进入交互式 TUI
```
若未自动发现 runtime：`export ZCODE_RUNTIME=/绝对路径/runtime-entry.cjs`。`za` 是 `zagent` 的短别名。

### 说明
zagent 是轻量的协议优先客户端，只**发现并驱动**你已安装的 runtime，不分发任何二进制，需你自己的账户；运行会以你的权限执行工具并可能产生真实费用，请只在可信工作区使用并审查改动。task/memory/diff/quota 输出可能含私有数据，分享前请脱敏，切勿提交凭据。机器人、独立 compact、常驻 daemon、RPC bridge、plugin-validate 为**仅源码实验功能**，不进入 npm 包。当前 Linux 为完整验收目标，macOS/Windows 已在代码层支持但尚未真机验收。

### 许可
[MIT](LICENSE)。定位为**非商业**的个人互操作与研究，请自行遵守 Z.ai 的服务条款；MIT 允许商业使用，"非商业"是项目意图而非许可证限制。互操作与责任免责声明见 [NOTICE](NOTICE)。
