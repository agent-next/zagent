# zagent

An unofficial terminal client for a **separately installed ZCode runtime**.
Not affiliated with or endorsed by Z.ai. No Z.ai runtime binaries are included.

## Release candidate, not a published release

Version `0.0.180` is being prepared for review. Do not assume that `npx zagent`
currently resolves to this project or version. Verify the registry owner and
artifact before installing. Repository visibility and publication require owner
approval; a working local package is not evidence of publication.

## Requirements and installation

- Node.js >=22.5. **Linux is the validated release target; macOS and Windows are
  supported at the driver/CI level** (three-platform unit matrix green; runtime
  discovery and zip extraction dispatch per-OS) but are not yet real-machine-validated
  for the official GUI install layout (in progress).
- Your own compatible ZCode runtime and account. Interactive TUI requires the
  separately installed third-party `zcode-app-cli`; the desktop bundle alone is
  a headless runtime, not a bundled TUI.
- Model access, quotas, prices and third-party terms depend on your account.

For a reviewed local tarball:

```bash
npm install --global ./zagent-0.0.180.tgz
zagent --version
zagent --help
zagent doctor
```

Runtime discovery uses an explicit `ZCODE_RUNTIME` entry file when set, otherwise
the app-cli installation under `~/.local/opt/zcode-app-cli`, the working
directory's `node_modules/zcode-app-cli`, then the desktop bundle under
`/opt/ZCode/resources/glm/zcode.cjs`. A launcher on PATH alone is insufficient.
`ZCODE_RUNTIME` must identify a compatible JavaScript entry, not a shell wrapper.

```bash
export ZCODE_RUNTIME=/absolute/path/to/compatible/runtime-entry.cjs
# Supply ZAI_API_KEY through your own secret manager, not a committed file.
zagent doctor
zagent -p 'Explain the current repository' --json
```

Help and version are offline. `doctor` diagnoses configuration; `doctor --fix`
can create it. Starting the runtime can make paid/live requests and execute tools
with your user's permissions. Use only trusted workspaces and review changes.
First run may create `~/.zcode/cli/config.json` with mode 0600. Existing config is
used; legacy provider config may be migrated. If `ZAI_API_KEY` is absent, the
launcher also checks `~/.config/ccz/.api_key`. Do not share either file.

## Candidate scope

The package includes the launcher, headless retry handling, runtime diagnostics,
and local helpers for models, sessions, existing task records, diffs, memory,
plugins and scheduling. `zagent --help` lists commands. Quota, onboarding, compact
and scheduled prompts can contact the provider; local tests do not validate
account eligibility or live compatibility with every runtime release.

Task, memory, diff and quota output can contain private workspace, prompt,
account or billing data. Redact it before sharing logs, and never commit account
profiles, configuration files or credential stores.

Bots (Telegram, Feishu, WeChat), the standalone compact command, warm daemon, raw RPC bridge and
`plugin-validate` are **source-only experimental** and excluded from the npm
candidate. They are not a supported remote or multi-user product. In particular,
wire integration, per-chat session isolation and live bot loops remain unproven.
The upstream interactive TUI's native `/compact` remains available; it is not
the excluded `zagent compact` command.
The emulator is developer tooling, not a consumer command or a safe live test to
run against an existing account profile.

## Evidence and limits

Historical m4 results covered ten small tasks, one run per task: zcode 10/10,
median process wall time **9.50s**; comparison harness 9/10, **35.85s**. The later
zcode-only m6 run measured 10/10 and **8.65s**, not a paired comparison rerun.
These small historical samples do not establish general speed, quality parity,
current-version correctness or billed-cost savings. No free-access campaign or
future pricing is promised. Current offline verification and remaining manual
gates are recorded separately in the source release receipt.

Only the README, license and notice are bundled as package documentation.
Licensed under the [MIT license](LICENSE). Intended for non-commercial, personal
interoperability and research; you are responsible for complying with Z.ai's terms
for your own account. The [NOTICE](NOTICE) carries the interoperability and liability
disclaimer.

---

## 中文

zagent 是驱动**独立安装的 ZCode runtime** 的非官方终端客户端，与 Z.ai 无隶属或
背书关系，不分发其二进制。`0.0.180` 是待审发布候选，**不代表已公开或已上 npm**；
不要假定 `npx zagent` 当前指向本项目。安装前应核对包归属、版本和校验值。

当前目标平台是 Linux + Bash + Node.js >=22.5；macOS/Windows 尚未验收。
交互界面依赖单独安装的第三方 zcode-app-cli；desktop bundle 仅提供无头运行能力。
可用上述命令安装已审查的本地 tarball，再执行 `zagent --version`、`zagent --help`、
`zagent doctor`。模型权限、额度、价格及第三方使用条款取决于你的账户。

发现顺序：显式 `ZCODE_RUNTIME` JavaScript 入口，其次用户目录下的 app-cli、
当前目录 node_modules 下的 app-cli，最后 `/opt/ZCode/resources/glm/zcode.cjs`。
只有 PATH 中的 launcher 不够。help/version 离线；doctor 默认诊断，`--fix` 可写配置。
运行会使用当前用户权限执行工具，并可能产生真实请求及费用；只在可信工作区使用。
首次运行可能创建权限 0600 的 `~/.zcode/cli/config.json`，并可能迁移旧 provider 配置。
没有 `ZAI_API_KEY` 时也会读取 `~/.config/ccz/.api_key`；不要提交或分享凭据文件。

候选包含启动器、无头重试、诊断，以及模型、会话、既有任务记录、diff、memory、
插件和调度等辅助命令。额度、onboard、定时 prompt 可联网；离线测试不等于
账户或所有上游版本 live 验收。机器人、常驻 daemon、原始 RPC bridge 和
plugin-validate 是**仅源码保留的实验功能，不进入 npm 包**；不承诺多用户隔离或
端到端远程可用。emulator 是开发工具，不应直接对真实账户配置执行。

task、memory、diff 和 quota 输出可能包含私有工作区、prompt、账户或账单数据；
分享日志前必须脱敏，切勿提交账户 profile、配置文件或凭据存储。独立 `zagent compact`
命令不随候选发布；上游交互 TUI 内置的 `/compact` 不受此限制。

历史 m4 为 10 个小任务各运行一次：10/10、耗时中位 9.50 秒，对照 9/10、35.85 秒。
m6 的 10/10、8.65 秒仅重跑 zcode，不能当成同步对照。这些样本不能证明普遍更快、
质量等同、当前版本正确或账单更低；不承诺免费活动及未来价格。
当前离线证据、人工／live 缺口及公开授权门分别记录于源码发布文档。

许可与用途：源码采用 [MIT 协议](LICENSE)。本项目定位为非商业的个人互操作与研究，请仅对你自己的账户与运行时使用，并自行遵守 Z.ai 的服务条款；MIT 允许商业使用，“非商业”是项目意图而非许可证限制。互操作与责任免责声明见 [NOTICE](NOTICE)。
