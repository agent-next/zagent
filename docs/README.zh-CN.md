<div align="center">

# zagent（中文）

**开源、GLM 原生的终端编码 agent。**

在终端直接驱动 GLM——用于脚本与 CI 的无头一次性执行，或完整的交互式 TUI——运行在你自己的
**GLM Coding Plan** 之上。

[English](../README.md) · 中文

</div>

```bash
npx zagent -p "给 cli.py 加一个 --json 参数并更新测试"
```

> **非官方**，与 Z.ai 无隶属或背书关系。zagent **不分发任何** Z.ai 二进制——它只驱动你已安装的
> ZCode runtime，使用你自己的账户。

## 这是什么？

zagent 把你的 **GLM Coding Plan** 变成一等公民级的终端编码 agent。它直接讲 ZCode runtime 的协议，
因此你在终端里用到的就是 Z.ai 桌面端所用的同一 GLM 引擎——可脚本化、可无头、就在你日常工作的终端里。

- 🚀 **无头或交互**：`zagent -p "…" --json` 适合脚本 / CI / 流水线；或进入完整 TUI。
- 🔌 **你的套餐、你的机器**：跑在你自己的 GLM Coding Plan 与已安装 runtime 上，不打包、不回传。
- 🧰 **开箱即用**：额度、会话、diff、memory、定时 prompt、插件，全在 CLI。
- 🖥️ **跨平台**：在 Linux / macOS / Windows 上自动发现 runtime。
- 🪶 **轻量而诚实**：只是一个薄协议客户端；你的 prompt 与凭据只发给你自己的 provider。

## 快速上手

```bash
npm install -g zagent          # 或临时运行：npx zagent
zagent doctor                  # 检查 runtime 与 Coding Plan 配置
zagent -p "解释这个仓库"        # 无头一次性执行
zagent                         # 交互式 TUI
```

### 环境
- **Node.js ≥ 22.15**（Node 23 需 ≥ 23.5）
- 一个 **GLM Coding Plan**，以及你自己安装的 **ZCode runtime**——第三方 `zcode-app-cli`（交互 TUI 必需）
  或 ZCode desktop bundle（无头）。

### 认证——你的 GLM Coding Plan
zagent 跑在**你的 GLM Coding Plan 订阅之上，而不是按量计费的 API key。** 提供一次你的 Coding Plan
凭据，zagent 会写入一个本地 `0600` 配置：

```bash
export ZAI_API_KEY=<你的 GLM Coding Plan 凭据>   # 或复用 ~/.config/ccz/.api_key
zagent doctor --fix                              # 写入 ~/.zcode/cli/config.json
```
`zagent doctor` 会告诉你还缺什么。凭据只留在你机器上，且只发往你自己的 provider。

## 命令

| 命令 | 作用 |
|---|---|
| `zagent -p "…" [--json]` | 无头一次性执行（可重试） |
| `zagent` | 交互式 TUI |
| `zagent onboard` | 首次运行：检查 + live 冒烟 + 引导 |
| `zagent doctor [--fix]` | runtime / Coding-Plan / 配置诊断 |
| `zagent models [query]` | 搜索模型目录 |
| `zagent quota [balance\|preview\|reset]` | Coding-Plan 额度 |
| `zagent sessions` | 终端里的任务库 |
| `zagent diff [sessionId]` | 每轮 / 每文件的改动 |
| `zagent memory show\|index\|append` | runtime 兼容的 memory |
| `zagent task list\|archive\|pin\|rename\|delete` | 查看或修改 runtime 任务记录 |
| `zagent cron add\|list\|tick` | 定时 prompt |
| `zagent offpeak [--refresh\|--json]` | GLM-5.3-Flash 当前是否免费（exit 0 = 是） |
| `zagent plugins` | 管理本地插件 |

`za` 是 `zagent` 的短别名。

## 工作原理

zagent 是一个薄的、协议优先的客户端。它按 `ZCODE_RUNTIME`、`zcode-app-cli`、再到各系统的 ZCode
desktop bundle 顺序发现兼容 runtime，并通过其原生协议驱动它。它**不分发**任何 runtime 二进制，使用
**你的** Coding Plan；运行会以你的权限执行工具并可能产生真实请求，请只在可信工作区使用并审查改动。
若未自动发现：`export ZCODE_RUNTIME=/绝对路径/runtime-entry.cjs`。

## 平台支持

runtime 发现覆盖 Linux / macOS / Windows（三平台均有单测）。**Linux 为完整验收目标**；macOS/Windows
已在代码层支持，正针对各 GUI 安装布局做加固。

## 隐私

task / memory / diff / quota 输出可能含私有工作区、prompt 或账户数据。分享日志前请脱敏，切勿提交凭据或配置。

## 参与贡献

欢迎 issue 与 PR，见 [CONTRIBUTING](../CONTRIBUTING.md) 与 [SECURITY](../SECURITY.md)；问题与想法请到
[Discussions](https://github.com/agent-next/zagent/discussions)。

## 许可

[MIT](../LICENSE)——用于**非商业**的个人互操作与研究，请自行遵守 Z.ai 的服务条款。互操作与责任免责声明见 [NOTICE](../NOTICE)。
