<div align="center">

# zagent（中文）

**把 Z.ai 的编码 agent 搬进终端 —— Z.ai 自己没发的那一块。**

[![npm](https://img.shields.io/npm/v/zagent.svg)](https://www.npmjs.com/package/zagent)
[![downloads](https://img.shields.io/npm/dm/zagent.svg)](https://www.npmjs.com/package/zagent)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.15-brightgreen.svg)](../package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](../CONTRIBUTING.md)

[English](../README.md) · 中文

</div>

```bash
npx zagent -p "给 cli.py 加一个 --json 参数并更新测试"
```

> **非官方**，与 Z.ai 无隶属或背书关系。zagent **不分发任何** Z.ai 二进制——它只驱动你已安装的
> ZCode runtime，使用你自己的账户。

## 为什么会有这个项目

Z.ai 桌面端里的 ZCode runtime 本来就带终端模式。但在原装环境里跑,它直接挂掉:

```console
$ zcode tui
Error: Cannot find package '@zcode/tui'
```

runtime 会 import 这个模块,而 Z.ai 从未发布它。所以在每一台装了 ZCode 的机器上,终端这条路都是
一个死掉的 import。

**zagent 就是那个缺失的模块** —— 一个照着 runtime 自己那份 28 成员 host 契约写的原生 TUI ——
外加围绕它的整套 CLI。它通过 Node ESM resolve hook 提供 `@zcode/tui`,runtime 是**就地读取**的:
不复制、不打补丁、不往它的安装目录里写任何东西。你用的就是桌面端跑的那个 GLM 引擎,在你本来就
在用的终端里,花的还是你已经付过的 Coding Plan。

## 你会得到什么

| | |
|---|---|
| **真正的 TUI** | 流式输出、工具调用、权限确认、模型/effort 选择器、斜杠命令、`@` 文件补全。宽字符正确(中日韩、emoji),且每一段渲染文本都做过消毒 —— 模型输出无法注入 ANSI 或 bidi 控制符。 |
| **也能无头跑** | `zagent -p "…" --json` 适合脚本 / CI / 流水线。退出码是真的:一轮失败就是失败,命令打错就是错。 |
| **你的套餐、你的机器** | 跑在你自己的 GLM Coding Plan 与已安装 runtime 上,不打包、不回传。 |
| **产品的其余部分** | 额度、会话、每轮 diff、memory、定时 prompt、插件、off-peak 路由 —— 全在 CLI 里。 |
| **跨平台** | 在 Linux / macOS / Windows 上自动发现 runtime。 |

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
| `zagent quota [status\|usage [--days 1..30]\|balance\|preview\|reset] [--json]` | Coding-Plan 额度 |
| `zagent sessions` | 终端里的任务库 |
| `zagent diff [sessionId]` | 每轮 / 每文件的改动 |
| `zagent memory show\|index\|append` | runtime 兼容的 memory |
| `zagent task list\|archive\|pin\|rename\|delete` | 查看或修改 runtime 任务记录 |
| `zagent cron add\|list\|tick` | 定时 prompt |
| `zagent offpeak [--refresh\|--json]` | 活动时间窗口（exit 0 = 开放；实际计费未验证） |
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

`zagent quota` 查询实时 Z.ai Coding Plan 额度池；`zagent quota usage --days 7 --json`
查询账户合计调用次数和服务端 token（支持最近 1–30 个新加坡日历日，含尚未结束的当天）。
token 不等于计费 credits，共享账户的用量无法按 ccz / zagent 归因；缺失额度保持未知，百分比可能取整。
`ZAI_API_KEY` 显式覆盖查询账户，否则使用 CLI 当前 provider 的 key；仅当 CLI 配置不存在时回退到 ccz key 文件。
`balance` / `preview` 查询独立的桌面账单，空余额不代表 Coding Plan 用量为零；`reset` 仅读取重置卡状态，不消耗卡。

task / memory / diff / quota 输出可能含私有工作区、prompt 或账户数据。分享日志前请脱敏，切勿提交凭据或配置。

## 参与贡献

欢迎 issue 与 PR，见 [CONTRIBUTING](../CONTRIBUTING.md) 与 [SECURITY](../SECURITY.md)；问题与想法请到
[Discussions](https://github.com/agent-next/zagent/discussions)。

## 许可

[MIT](../LICENSE)——用于**非商业**的个人互操作与研究，请自行遵守 Z.ai 的服务条款。互操作与责任免责声明见 [NOTICE](../NOTICE)。
