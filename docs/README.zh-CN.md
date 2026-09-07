# zagent（中文）

> English: [README.md](../README.md)

**开源、GLM 原生的终端编码 agent。** 在终端直接驱动 GLM——用于脚本与 CI 的无头一次性执行，或完整的交互式
TUI——运行在你自己安装的 ZCode runtime 与 GLM Coding Plan 之上。

> 非官方，与 Z.ai 无隶属或背书关系，**不分发其任何二进制**；zagent 只驱动你已安装的 runtime，使用你自己的账户与密钥。

```bash
npx zagent -p "解释这个仓库"   # 无头一次性执行
npx zagent                    # 交互式 TUI
```

## 特性
- **GLM 原生**：在终端直连 Z.ai 桌面端所用的同一 GLM 引擎。
- **无头或交互**：`zagent -p "…" --json` 适合脚本/流水线，或进入完整 TUI。
- **复用你已有的**：驱动你自己安装的 ZCode runtime / GLM Coding Plan，用你自己的 key，不打包、不回传。
- **开箱即用**：额度、会话、diff、memory、定时 prompt、插件，全在 CLI。
- **跨平台发现**：Linux / macOS / Windows 都能找到 runtime。

## 环境
- **Node.js ≥ 22.5**
- 你自己的 **ZCode runtime + GLM 账户**（交互 TUI 需第三方 `zcode-app-cli`；desktop bundle 提供无头运行）。
- GLM API key（`ZAI_API_KEY`），通过你自己的密钥管理提供。

## 安装与上手
```bash
npm install -g zagent      # 或 npx zagent
export ZAI_API_KEY=…       # 你自己的 key，切勿提交
zagent doctor             # 确认 runtime 被发现（doctor --fix 可写配置）
zagent -p "把 utils.py 重构得更易读" --json
zagent                    # 或进入交互式 TUI
```
若未自动发现 runtime：`export ZCODE_RUNTIME=/绝对路径/runtime-entry.cjs`。`za` 是 `zagent` 的短别名。

## 说明
zagent 是轻量的协议优先客户端，只**发现并驱动**你已安装的 runtime，不分发任何二进制，需你自己的账户；运行会以你的权限执行工具并可能产生真实费用，请只在可信工作区使用并审查改动。task/memory/diff/quota 输出可能含私有数据，分享前请脱敏，切勿提交凭据。机器人、独立 compact、常驻 daemon、RPC bridge、plugin-validate 为**仅源码实验功能**，不进入 npm 包。当前 Linux 为完整验收目标，macOS/Windows 已在代码层支持但尚未真机验收。

## 许可
[MIT](LICENSE)。定位为**非商业**的个人互操作与研究，请自行遵守 Z.ai 的服务条款；MIT 允许商业使用，"非商业"是项目意图而非许可证限制。互操作与责任免责声明见 [NOTICE](NOTICE)。
