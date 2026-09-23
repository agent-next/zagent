# zagent harness design — what to copy from Codex, Claude Code and Grok Build

Status: design target for 0.1 → 0.2 (2026-09-14). Companion to `docs/SPEC-0.1-usable.md`
(the 0.1 bar) and `docs/V01-COVERAGE.md` (kernel coverage). Sources are the shipped
harnesses plus their official docs, read 2026-09-14: Codex CLI 0.154.0
(`codex --help`; slash commands from developers.openai.com/codex/cli/slash-commands),
Claude Code 2.1.270 (`claude --help`; code.claude.com/docs), Grok Build 1.0.30
(docs.x.ai/build/modes-and-commands, docs.x.ai/build/keyboard-shortcuts), a
2026-09-03 feature survey of the public harnesses (opencode, Cursor, Codex, Claude
Code, Grok Build), and `docs/TUI-ROADMAP.md`.

## 1. What the three harnesses agree on

Every top harness is the same shape; the differences are polish. zagent should stop
being "a client of the kernel's 20 commands" and become this shape:

1. **One engine, three front-ends.** Interactive TUI, headless `exec`/`-p` with a JSON
   event stream, and an app-server/SDK — sharing one core (Codex app-server; Claude
   Code `-p --output-format stream-json`; Grok "one binary, three front-ends").
   For zagent the engine is the ZCode kernel; zagent owns the front-ends.
2. **A merged command palette** with 40–60 commands grouped by intent, discoverable
   with `/` and a palette key, plus skills exposed as `/skill-name` (all three).
3. **A steering grammar**: Esc cancels, Tab queues a follow-up, an "interject" key
   sends text into the running turn, Esc-Esc edits/rewinds (Codex, Grok, Cursor).
4. **Modes cycled by Shift+Tab** (plan / normal / auto / always-approve), and a
   permission layer separate from any sandbox (Grok, Claude Code, Codex).
5. **Sessions as first-class objects**: new, resume, fork, rewind with file
   snapshots, rename/title, export/copy, a sessions picker (all three).
6. **Live status**: a footer or status line with model, mode, context fill, cost,
   git branch, background tasks; `/status` prints the whole thing (Codex, Grok).
7. **Extensions in one place**: skills, plugins, hooks, MCP, agents as markdown files;
   zero-config import of the other harnesses' files (Grok `/import-claude`, Cursor
   reading `.claude/agents`, Codex plugins).
8. **Self-service**: `doctor`, `update`, `terminal-setup`, `feedback`, `release-notes`.

## 2. Layering — what the kernel gives, what zagent must build

| Layer | Owner | Today | Target |
|---|---|---|---|
| Model loop, tools, MCP, skills, plugins, hooks, checkpoints, goal, subagents, usage telemetry, permission requests | ZCode kernel (protocol) | consumed via `packages/driver` | unchanged |
| 20 kernel slash commands via `host.slashCommands` | kernel | passed through | passed through, listed in the merged palette |
| Client commands, palette, keybindings, banner/status line, steering queue, permission UI, session picker, export/copy, doctor/update | zagent TUI (`packages/tui`) | quit set + kernel palette only | this document |
| CLI subcommands, headless contract, config layering, import, quota, receipts | zagent CLI (`packages/cli`) | 22 subcommands, jargon output | §5–§7 |

Rule: never fake a kernel feature (e.g. `task/create` does not exist); client commands
compose protocol calls the kernel already answers.

## 3. Interactive surface

### 3.1 Banner and status line

```
zagent 0.1.1 · runtime ZCode 3.11.2 · zai/glm-5.3 · build · effort max
/help commands · Tab queue · Esc stop · Shift+Tab mode · Ctrl+C twice exit
────────────────────────────────────────────────────────────────────────
> …
build · glm-5.3 · max · ctx 12k/1M · $0.04 · main · mcp 1/1 · agents 0
```

Status-line items (order and visibility configurable, Codex `/statusline`): mode,
model, effort, context used/window, session cost estimate, git branch, MCP
connected/total, running subagents, queued prompts, 5-hour window %.

### 3.2 Command palette (merged, grouped)

| Group | Kernel (pass-through) | zagent client commands | Reference |
|---|---|---|---|
| Session | /new /resume /fork /rewind /compact | /clear (=/new) /exit /quit /stop /status /title /sessions /export /copy [N] /transcript /find | Codex /new /clear /copy /title /status; Grok /sessions /export /find /transcript |
| Steering | — | /queue (list queued) /btw (side question) | Codex /side, Grok /btw /queue |
| Model | /model /effort /mode | /approvals (=/mode) /plan (=mode plan) /cost /usage /context | Codex /model /plan /approve /status; Grok /effort /context /usage |
| Project | /init /goal /expert /workflow /workflows | /diff /undo /memory /review /tasks | Codex /diff /review /goal; Claude Code /memory /rewind; Grok /tasks |
| Tools | /mcp /plugins /skill /locale | /skills /hooks /agents /permissions /mcps (alias) | Grok extensions modal; Claude Code /hooks /permissions /agents |
| zagent | /help /login /logout | /version /doctor /quota /update /theme /settings (=/config) /keymap /terminal-setup /feedback /bug /release-notes | Codex /keymap /theme /feedback; Grok /settings /terminal-setup /release-notes; Claude Code /doctor /bug |

Rules: exact-match typed commands run on Enter even with the palette open; aliases
resolve silently; skills show as `/skill-name` and collide-safe as `/plugin:skill`
(Claude Code and Grok convention); `/help` renders this table with one-line summaries.

### 3.3 Keybindings (essentials — Codex/Grok conventions)

| Keys | Action |
|---|---|
| Enter | send · Shift+Enter or Ctrl+J newline |
| Tab | queue the typed prompt behind the running turn (Codex) |
| Ctrl+Enter | interject into the running turn (Grok); falls back to queue when the kernel has no injection path (kernel `sendInput` is broken — verified 2026-09-07) |
| Esc | cancel the running turn · Esc Esc: clear prompt, or open rewind when empty |
| Shift+Tab | cycle mode plan → build → edit → yolo (kernel `setMode`) |
| Ctrl+P or `?` on empty prompt | command palette |
| Ctrl+R | prompt history search · Up/Down draft history |
| `!` on empty prompt | run a shell command, inject output as context (opencode/Grok) |
| `@` | file/resource completion · `$` skills · `#` conversations (shipped) |
| Ctrl+O | copy last answer · Ctrl+Y copy selection |
| Ctrl+T | todo/plan pane · Ctrl+G tasks pane (wave 3) |
| Ctrl+C twice / Ctrl+D | quit |

### 3.4 Turn rendering

Keep the shipped transcript model (tool folds, reasoning fold, markdown tables) and add:
per-turn footer (`⏱ 42s · 3 tools · 18k tokens · $0.02`, Claude/Codex style), collapsed
tool groups (changes / explore / terminal), `/raw` scrollback mode and `--no-alt-screen`
(Codex), diff previews with `/diff` and per-file expand.

### 3.5 Permissions and modes

Kernel modes: plan / build / edit / yolo (`session/setMode`). Kernel prompts:
`interaction/requestPermission` with allow_once / allow_project / deny, persisted grants
in `~/.zcode/cli/grants.json` (shipped 0.0.197). Add: a Tab-opened note on deny that
travels back to the model (Claude Code), an allow/deny rule list (`--allow`, `--deny`,
`/permissions`; Grok/Claude Code rule syntax `Tool(pattern)`), and a plan-approval screen
that yolo cannot skip (Grok invariant). No OS sandbox claim until one exists.

## 4. Sessions and steering

- Sessions are kernel task records (`tasks-index.sqlite`); zagent adds `/sessions`
  (switch/rename/close), `/title`, `--continue`/`--resume <id>`, `/fork` (kernel
  `session/fork`), `/rewind` (kernel checkpoints; 3-way restore: code / conversation /
  both, Claude Code), `/undo` (last turn's file changes), `/export` (markdown), `/copy`.
- Steering: queue (Tab, `/queue` to list/edit), stop (Esc), interject (Ctrl+Enter →
  queued with "send now" until the kernel offers injection), side question (`/btw`).
- Background: `/tasks` lists subagents (kernel `session/subagents`) and cron jobs;
  `/loop` and log monitors are wave 3.

## 5. Headless and automation contract

```
zagent -p "…" [--json | --output-format json|stream-json] [--model m] [--mode plan|build|edit|yolo]
              [--effort low|high|max] [--max-turns N] [--cwd DIR] [--session id | --continue]
zagent exec "…"           # alias of -p, reads stdin when prompt is "-"
zagent review [--base ref | --commit sha | --uncommitted]   # non-mutating review (Codex)
```

Event stream (`stream-json`): `init`, `user`, `assistant` (deltas optional),
`tool_call` started/completed with ids, `permission` (auto-answered per mode),
`result` with usage and exit status — the Cursor/Claude Code NDJSON shape. Exit codes:
0 success, 1 turn failed, 2 usage error, 3 auth/quota, 124 timeout. Never print the
kernel's usage text.

## 6. CLI subcommand tree (target, mirrors Codex/Claude Code verbs)

```
zagent [prompt]            interactive TUI (optional first prompt)
zagent exec | -p           headless
zagent review              code review (non-mutating)
zagent resume | fork       session picker or --last
zagent sessions            list / rename / archive
zagent login | logout      Coding Plan credential
zagent doctor | update | inspect | terminal-setup
zagent models | quota | usage
zagent mcp | plugins | skills | hooks | agents   list / add / remove
zagent config              show layered config with sources
zagent import              Claude Code / Codex / Cursor files (dry-run default)
zagent memory | diff | cron | task
```

Output rules: plain sentences, no internal terms, `--json` on every read command,
exit 2 on unknown commands with `Run 'zagent help'`.

## 7. Config and extensions

- Layers (closest wins, credentials never from project files — Codex): defaults →
  `~/.zcode/cli/config.json` → `~/.zcode/cli/profiles/<name>.json` (`--profile`) →
  project `.zcode/config.json` (trust-gated) → env → flags. `zagent config` prints
  every value with its source.
- Instructions: `AGENTS.md` first, `CLAUDE.md` as fallback (Cursor/Grok read both);
  `.zcode/rules/*.md` with globs later.
- Skills/commands/agents as markdown with frontmatter in `.zcode/{skills,commands,agents}`
  and `~/.zcode/…`; `zagent import` copies Claude Code files (shipped), later Codex and
  Cursor. Hooks: the kernel's 7-event contract (`zagent hooks list`, shipped); `/hooks`
  shows matchers and sources (Claude Code).
- Model routing: main = glm-5.3, lite = glm-5.3-flash for titles/summaries/subagents
  (opencode `small_model`); `/model` favorites and recents.

## 8. Observability, errors, self-service

- `/status`, `/cost`, `/usage`, `/context`, `/quota` (5-hour window, monthly tool
  calls) — all local reads; no telemetry, ever.
- Error classes shown to the user: rate limited (429/1302 → "retry n/m in Xs"),
  5-hour window exhausted (1308 → reset time), network, auth (→ `zagent login`),
  runtime not found (→ `zagent doctor`), permission denied by rule.
- `zagent doctor` names auto-fixes; `zagent update` checks npm and updates on
  confirm; `zagent feedback` opens the public issue URL; `zagent release-notes` prints
  CHANGELOG for the installed version.

## 9. Non-goals

ADE panes (browser/PDF/Office/CUA/workflow panel), OS sandboxes we do not ship,
cloud agents, image/video generation commands, idle-time ticket inference.

## 10. Delivery

| Wave | Content | Oracle |
|---|---|---|
| 1 (in flight, 0.1) | merged palette + client commands of §3.2 rows "Session/Model/zagent" minimum set (`/exit /clear /status /version /cost /usage /context /diff /undo /export /copy /doctor /quota /update /theme /hooks /agents /permissions /memory /feedback /stop`), banner/version, retry classes; CLI wording, `--version`, unknown-command, GLM-first models, human quota; runtime order+version, installed-package smoke | `npm test`, `scripts/test-ux-audit.mjs`, TUI journeys, maintainer re-test |
| 2 (0.1.x) | steering grammar (Tab queue, `/queue`, `/btw`), Shift+Tab modes, `/sessions` `/title` `/find` `/transcript`, `/review`, `/tasks`, per-turn footer, `/statusline`, `--continue/--resume`, `stream-json` events, `exec`/`review` subcommands, `--model/--mode/--effort` flags | journeys per command; headless contract test with a fake kernel |
| 3 (0.2) | permission rules + deny notes + plan-approval screen, `/loop` + monitors, `/raw`/`--no-alt-screen`, config layering + `zagent config`, Codex/Cursor import, `/keymap` `/terminal-setup`, todo/tasks panes | same + real-terminal matrix |

Each wave ships behind the same gates as `docs/SPEC-0.1-usable.md`: hermetic tests,
independent review, an audit run on the merged tree, and a maintainer first-use test.

## 11. Open decisions

1. Alt-screen or inline scrollback by default (Codex offers both; zagent is inline today).
2. Whether `zagent review` should call the kernel's `/expert` workflow or a plain prompt.
3. Naming: `/mode` (kernel) vs `/approvals` (Codex) as the primary verb — this doc keeps
   `/mode` primary and `/approvals` as alias.
