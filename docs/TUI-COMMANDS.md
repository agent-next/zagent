# TUI slash commands

The zagent TUI palette is one merged list: the kernel's commands (delivered over
`host.slashCommands` and submitted to the runtime verbatim) plus zagent's own
client commands (answered inside the TUI, never sent to the runtime). Groups are
ordered **Session · Model · Project · Tools · zagent**.

| Command | Group | Source | What it does | Live |
| --- | --- | --- | --- | --- |
| `/exit` (`/q`, `/bye`) | Session | zagent | leave the session | — |
| `/quit` | Session | zagent | leave the session | — |
| `/stop` | Session | zagent | interrupt the running turn (same as Esc) | — |
| `/clear` | Session | zagent | new session (kernel `/new`) and clear the transcript view | — |
| `/diff` | Session | zagent | this session's per-file changes (+A/-D and hunks) | — |
| `/undo` | Session | zagent | revert the last turn's file changes (asks y/N first) | — |
| `/export` | Session | zagent | write the transcript as Markdown and print the path | — |
| `/copy` | Session | zagent | copy the last assistant message to the clipboard | — |
| `/new` | Session | kernel | start a new session | ✓ 2026-09-14 |
| `/resume` | Session | kernel | resume a previous session | ✓ 2026-09-14 |
| `/fork` | Session | kernel | fork the session at a checkpoint | ✓ 2026-09-14 |
| `/rewind` | Session | kernel | rewind to a checkpoint | ✓ 2026-09-14 |
| `/compact` | Session | kernel | compact the context | ✓ 2026-09-14 |
| `/login` | Session | kernel | log in | — |
| `/logout` | Session | kernel | log out | — |
| `/locale` | Session | kernel | switch the UI locale | ✓ 2026-09-14 |
| `/approvals` | Model | zagent | choose the permission mode (the `/mode` picker) | — |
| `/plan` | Model | zagent | switch to plan mode (`/mode plan`) | — |
| `/model` | Model | kernel | switch model | — |
| `/effort` | Model | kernel | set the reasoning effort | — |
| `/mode` | Model | kernel | switch the permission mode | — |
| `/expert` | Model | kernel | expert mode | ✓ 2026-09-14 |
| `/hooks` | Project | zagent | list configured ZCode hook events (read-only) | — |
| `/permissions` | Project | zagent | persisted always-allow/deny grants | — |
| `/memory` | Project | zagent | show project and global memory | — |
| `/init` | Project | kernel | initialise the project (AGENTS.md) | ✓ 2026-09-14 |
| `/goal` | Project | kernel | show or set the session goal | ✓ 2026-09-07 |
| `/skill` | Project | kernel | run a skill | ✓ 2026-09-14 |
| `/agents` | Tools | zagent | running subagents in this session | — |
| `/mcp` | Tools | kernel | manage MCP servers | ✓ 2026-09-14 |
| `/plugins` | Tools | kernel | manage plugins | ✓ 2026-09-14 |
| `/workflow` | Tools | kernel | run a workflow | ✓ 2026-09-14 |
| `/workflows` | Tools | kernel | list workflows | ✓ 2026-09-14 |
| `/status` | zagent | zagent | version, runtime, model, session and token state | — |
| `/version` (`/v`) | zagent | zagent | print the zagent and runtime versions | — |
| `/usage` (`/cost`) | zagent | zagent | session tokens and a list-price estimate | — |
| `/context` | zagent | zagent | context meter and input baseline breakdown | — |
| `/doctor` | zagent | zagent | runtime/config/credential diagnosis (same checks as `zagent doctor`) | — |
| `/quota` | zagent | zagent | Coding Plan quota: 5-hour window and monthly tool-call pool | — |
| `/update` | zagent | zagent | check npm for a newer zagent and offer to install it | — |
| `/theme` | zagent | zagent | switch the palette: `/theme light \| dark \| auto` | — |
| `/feedback` | zagent | zagent | where to report bugs and feedback | — |
| `/bug` | zagent | zagent | report a bug | — |
| `/help` (`/?`) | zagent | zagent | show this command list | — |

## Notes

- Typing `/` opens the palette; fuzzy filtering matches a subsequence. A command
  typed in full — name or alias — runs on Enter even while the palette is open.
- Kernel commands marked `(runtime)` in `/help` are executed by the runtime;
  everything else runs in the TUI itself.
- `/usage` and `/quota` report different things: `/usage` is this session's token
  telemetry plus a list-price estimate (the Coding Plan is a subscription, not
  metered billing); `/quota` is the plan's actual remaining allowance.
- `/undo` only reverts file changes that the runtime's checkpoint artifacts can
  verify are untouched since the turn; anything edited since is refused.
- `/update` never runs `npm i -g` without an inline y/N confirmation.
- **Live** column: `✓` = exercised against the real runtime under the PTY probe
  on the date shown. In the 2026-09-14 run `/init` was verified as turn-start —
  the probe stops bounded turns — and `/compact` completed through rate-limit
  retries. `—` = implemented, not live-verified in a probe run.
