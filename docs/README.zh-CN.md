<div align="center">

# zagent（中文）

**把 GLM 引擎的编码 agent 搬进你的终端 —— 流式 TUI、工具调用、检查点、配额透明，驱动你已装的 ZCode runtime。**

[![npm](https://img.shields.io/npm/v/zagent.svg)](https://www.npmjs.com/package/zagent)
[![downloads](https://img.shields.io/npm/dm/zagent.svg)](https://www.npmjs.com/package/zagent)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/agent-next/zagent/blob/master/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.15-brightgreen.svg)](https://github.com/agent-next/zagent/blob/master/package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/agent-next/zagent/blob/master/CONTRIBUTING.md)

[English](https://github.com/agent-next/zagent/blob/master/README.md) · 中文

需要 Node ≥ 22.15 · 已安装的 ZCode runtime · 一个 GLM Coding Plan

<img src="https://raw.githubusercontent.com/agent-next/zagent/master/docs/screenshot.png" alt="zagent TUI 实拍：流式回复、thinking 折叠、Read/Edit 工具调用与结果、带 文件:行号 的改动总结" width="800">

*一轮真实会话：模型先读 `parser.py`，改动前征求许可，最后用 文件:行号 总结做了什么。这是 PTY 实拍，不是示意图。*

</div>

```bash
npx zagent -p "给 cli.py 加一个 --json 参数并更新测试"
```

> **非官方**，与 Z.ai 无隶属或背书关系。zagent **不分发任何** Z.ai 二进制——它只驱动你已安装的
> ZCode runtime，使用你自己的账户。

**[为什么](#为什么会有这个项目) · [快速上手](#快速上手) · [命令](#命令) · [工作原理](#工作原理) · [兼容性](#兼容性) · [FAQ](#faq) · [更新日志](https://github.com/agent-next/zagent/blob/master/CHANGELOG.md)**

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
| **真正的 TUI** | 逐 token 流式输出、实时 thinking 预览、渲染后的 markdown（带语言标注的围栏代码、表格）、单行工具调用与结果、权限确认、模型/effort 选择器、25+ 斜杠命令、`@` 文件补全、会话折叠。宽字符正确（中日韩、emoji），且每一段渲染文本都做过消毒 —— 模型输出无法注入 ANSI 或 bidi 控制符。 |
| **也能无头跑** | `zagent -p "…" --json` 适合脚本 / CI / 流水线。退出码是真的:一轮失败就是失败,命令打错就是错。 |
| **你的套餐、你的机器** | 跑在你自己的 GLM Coding Plan 与已安装 runtime 上,不打包、不回传。 |
| **产品的其余部分** | 额度、会话、每轮 diff、memory、定时 prompt、插件 —— 全在 CLI 里。 |
| **跨平台** | 在 Linux / macOS / Windows 上自动发现 runtime。 |

有副作用的工具会先征求许可 —— Allow once / Allow always / Deny，直接在 TUI 里选：

<img src="https://raw.githubusercontent.com/agent-next/zagent/master/docs/permission.png" alt="zagent 权限卡片：Edit needs permission — Allow once / Allow always / Deny" width="800">

## 亮点

- **撤销任意一轮** — `zagent rewind latest` 从真实 checkpoint 恢复该轮改动的文件；`rewind changes` 先看它做了什么再决定。
- **花费透明** — TUI 状态行直接显示 5 小时窗口用量、套餐档位与重置时间；`quota reset` 管理重置卡（确认后才消耗）。
- **定时 agent** — 本地 `cron` 与服务端 `automation`，人不在也跑。
- **用量分析** — `zagent usage stats` 按模型/工具分解、缓存命中率、连续使用天数。
- **迁移你的 CLI 配置** — `zagent import` 导入 Claude Code 的指令、命令与技能。

一轮正在进行的会话 —— prompt、thinking 折叠、流式回复、工具调用：

<img src="https://raw.githubusercontent.com/agent-next/zagent/master/docs/demo.gif" alt="zagent 演示：从 prompt 到总结的完整一轮" width="800">

## 快速上手

```bash
npm install -g zagent          # 或临时运行：npx zagent
zagent doctor                  # 检查 runtime 与 Coding Plan 配置
zagent -p "解释这个仓库"        # 无头一次性执行
zagent                         # 交互式 TUI
zagent update                  # 保持最新版本
```

### 环境
- **Node.js ≥ 22.15**（Node 23 需 ≥ 23.5）。安装前先 `node --version`——macOS 上一个旧 Intel-Homebrew
  的 `/usr/local/bin/node` 可能在 PATH 里挡住新版；升级用 `brew install node` 或 `nvm install --lts`。
  `npm install -g` 报 EACCES 说明全局前缀属 root（Intel Mac `/usr/local` 常见）——用 nvm 或
  `npm config set prefix ~/.npm-global` 之类的用户级方案，别用 `sudo`。
- 一个 **GLM Coding Plan**，以及你自己安装的 **ZCode runtime**——ZCode 桌面端或第三方
  `zcode-app-cli` 均可，无头与交互都能用（zagent 自带 TUI，不依赖第三方包）。

### 兼容性

已针对 ZCode 桌面端 3.11.2 与 3.12.1 验证：

| 能力 | ZCode 3.11.x | ZCode 3.12.x |
|---|---|---|
| 无头 `zagent -p` | ✓ | ✓ |
| 交互式 TUI | 未验证 | ✓ —— 需要 3.12.1 时代登录一次（3.11.2 时代的凭据存储 kernel 不迁移；从桌面端重新登录一次即可） |
| `commit-msg`、`automation`、`usage stats`、`offpeak tools` | — | ✓ |

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
| `zagent -p "…" [--json] [options]` | 无头一次性执行（可重试；选项见 `zagent -p --help`） |
| `zagent` | 交互式 TUI |
| `zagent onboard` | 首次运行：检查 + live 冒烟 + 引导 |
| `zagent doctor [--fix]` | runtime / Coding-Plan / 配置诊断 |
| `zagent update [--check]` | 从 npm 升级 zagent 自身 |
| `zagent models [query]` | 搜索模型目录;`models test <provider/model>` 测试连接 |
| `zagent login [--no-browser]` | 登录账号 |
| `zagent logout` | 退出当前账号 |
| `zagent quota [status\|usage [--days 1..30]\|balance\|preview\|reset [claim\|use five-hour\|use week]] [--json] [--yes]` | Coding-Plan 额度 |
| `zagent sessions [--json]` | 终端里的任务库 |
| `zagent diff [sessionId]` | 每轮 / 每文件的改动 |
| `zagent rewind [list\|latest\|<checkpointId>\|changes\|preview [<checkpointId>]] [--message id] [--session id] [--json]` | 查看或恢复 workspace checkpoint（撤销某轮的文件改动） |
| `zagent memory show\|index\|append` | runtime 兼容的 memory |
| `zagent commit-msg [--model provider/model\|model] [--effort <level>] [--json]` | 为已暂存（或未暂存）改动生成 commit message（ZCode 3.12.x+） |
| `zagent task list [--all] [--json]\|archive\|unarchive\|pin\|unpin\|rename\|delete` | 查看或修改 runtime 任务记录 |
| `zagent permissions [list\|revoke <pattern\|all>\|--reset] [--json]` | 查看或撤销已记住的 always-allow/deny 授权 |
| `zagent cron add [--json]\|list [--json]\|remove [--json]\|tick` | 定时 prompt（本地 crontab） |
| `zagent automation list\|create\|update\|delete\|check-binding` | 服务端定时 prompt（ZCode 3.12.x+） |
| `zagent bots [list\|show <id>\|status] [--json]` | 桌面端已配置的聊天 bot（只读） |
| `zagent offpeak [--refresh] [--json]\|offpeak tools [on\|off] [--json]` | 活动时间窗口检查（计费未验证）；`tools` 开关 3.12.x 错峰工具端口 |
| `zagent plugins [list] [name] [--json]` | 管理本地插件；`plugins install <name>` 安装插件 |
| `zagent hooks list [--json]` | 列出已配置的 ZCode hook 事件（不执行） |
| `zagent inspect [--storage] [--json]` | 打印 runtime/配置/skills；`--storage` = ~/.zcode 分类体积（只读） |
| `$using-zagent` | 随包装的 skill：zagent 是什么、怎么和 GUI 区分、怎么用 |
| `zagent import [--dry-run\|--apply] [--force] [--json]` | 从 Claude Code 导入说明、commands、skills |
| `zagent goal [list\|show\|set <text>\|pause\|resume\|clear] [--session id] [--json]` | 显示或控制当前会话目标 |
| `zagent subagents [--session id] [--json]` | 列出运行中与已结束的子会话 |
| `zagent usage [--session id] [--json]` | 会话 token 总量 + 上下文 baseline 分解 |
| `zagent usage stats [--range all\|7d\|30d] [--json]` | 应用用量面板：总量、缓存命中率、连续天数、按模型/工具分解（ZCode 3.12.x+） |
| `zagent remote [status\|connect \[--live]] [--json]` | 本机 relay 设备 id / last ack（D1/D2；不提供第二设备控制） |
| `zagent mcp` | 通过 stdio 以 MCP 工具形式提供 zagent，供其他 agent 调用 |

`za` 是 `zagent` 的短别名。

上下文压缩在交互式 TUI 内通过 `/compact` 完成 —— 活跃会话是进程内的，因此不提供独立的
`zagent compact` 子命令。

## 工作原理

zagent 是一个薄的、协议优先的客户端。它按 `ZCODE_RUNTIME`、各系统的 ZCode
desktop bundle、再到 `zcode-app-cli` 的顺序发现兼容 runtime，并通过其原生协议驱动它。它**不分发**任何 runtime 二进制，使用
**你的** Coding Plan；运行会以你的权限执行工具并可能产生真实请求，请只在可信工作区使用并审查改动。
若未自动发现：`export ZCODE_RUNTIME=/绝对路径/runtime-entry.cjs`。

## 平台支持

runtime 发现覆盖 Linux / macOS / Windows（三平台均有单测）。**Linux 为完整验收目标**；macOS/Windows
已在代码层支持，正针对各 GUI 安装布局做加固。

## 隐私

`zagent quota` 查询实时 Z.ai Coding Plan 额度池；`zagent quota usage --days 7 --json`
查询账户合计调用次数和服务端 token（支持最近 1–30 个新加坡日历日，含尚未结束的当天）。
token 不等于计费 credits，共享账户的用量无法按 ccz / zagent 归因；缺失额度保持未知，百分比可能取整。
`ZAI_API_KEY` 显式覆盖查询账户，否则依次使用 CLI 当前 provider 的 key、`zagent login` 由内核预置的 key（v2/provider_config.json）；仅当 CLI 配置不存在时回退到 ccz key 文件。
`balance` / `preview` 查询独立的桌面账单，空余额不代表 Coding Plan 用量为零；裸 `reset` 仅读取重置卡状态，`reset use` 消耗卡（稀缺额度，需确认或 `--yes`）、`reset claim` 申请卡。

task / memory / diff / quota 输出可能含私有工作区、prompt 或账户数据。分享日志前请脱敏，切勿提交凭据或配置。

## FAQ

- **这是 Z.ai 官方产品吗？** 不是。zagent 非官方、与 Z.ai 无隶属或背书，也不分发它的任何二进制——见 [NOTICE](https://github.com/agent-next/zagent/blob/master/NOTICE)。
- **除了套餐还要花钱吗？** 不用。它跑在你已付费的 GLM Coding Plan 上，不是按量计费的 API key。
- **我的凭据存在哪？** 本地 `0600` 配置（`~/.zcode/cli/config.json`），只发往你自己的 provider——zagent 没有任何遥测。
- **哪些 ZCode 版本能用？** 无头模式 3.11.x / 3.12.x 都行；TUI 在 3.12.1 上验证，且需要 3.12.1 时代登录一次——见[兼容性](#兼容性)。

## 更新日志

每个版本都有记录：[CHANGELOG.md](https://github.com/agent-next/zagent/blob/master/CHANGELOG.md) · [Releases](https://github.com/agent-next/zagent/releases)。

## 参与贡献

欢迎 issue 与 PR，见 [CONTRIBUTING](https://github.com/agent-next/zagent/blob/master/CONTRIBUTING.md) 与 [SECURITY](https://github.com/agent-next/zagent/blob/master/SECURITY.md)；问题与想法请到
[Discussions](https://github.com/agent-next/zagent/discussions)。

## 许可

[MIT](https://github.com/agent-next/zagent/blob/master/LICENSE)——用于**非商业**的个人互操作与研究，请自行遵守 Z.ai 的服务条款。互操作与责任免责声明见 [NOTICE](https://github.com/agent-next/zagent/blob/master/NOTICE)。
