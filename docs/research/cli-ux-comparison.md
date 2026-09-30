# CLI UX comparison — codex, claude, Grok CLI, opencode vs zagent (2026-09-14)

Audit of the zagent TUI against the current top agent CLIs; baseline = the REAL installed CLIs,
enumerated empirically, never from memory.
Every claim below comes from a captured screen or `--help` text under
`cli-ux-comparison/` next to this file (`screens/<cli>-<mode>--<screen>.txt`, `help/*.txt`).
Captures were made with `scripts/pty-capture.py` (real PTY, 120x40, `TERM=xterm-256color`,
rendered through a VT100 emulator, so each file is what a human would SEE, not the byte stream).
Sanitized: the account e-mail replaced by `<user-email>`; absolute home and scratch paths replaced by `~` / `<scratch-dir>`; a terminal-query echo artifact of the
capture tool (`Ga=d,d=i,i=1,q=2`, Grok CLI only) stripped. Model turns: none were scripted; one
accidental prompt reached zagent (`zagent-real3--theme`, a mistyped shift-tab) and shows the
rate-limit retry notice — kept as evidence.

## 0. Versions (all `<cli> --version`, `help/`)
| CLI | version | binary |
|---|---|---|
| codex | codex-cli 0.154.0 | standalone musl ELF (`~/.codex/packages/standalone/…`) |
| claude | 2.1.270 (Claude Code) | native ELF (`~/.local/share/claude/versions/2.1.270`) |
| Grok CLI | grok 1.0.30 (04b7ffed98c6) | ELF (`~/.grok/downloads/grok-1.0.30-linux-x86_64`) |
| opencode | 1.17.11 | ELF via npm `opencode-ai` |
| zagent | 0.0.203 · runtime desktop-bundle 3.11.2 | npm global (node 22.22.0) |

## 1. First run in an EMPTY HOME (`screens/<cli>-fresh--firstrun.txt`, `--after-enter.txt`)
| CLI | what a new user sees | exit |
|---|---|---|
| codex | ASCII art + "Sign in with ChatGPT / Sign in with Device Code / Provide your own API key" menu; Enter → browser URL + "On a remote or headless machine? Press esc and choose Device Code" | stays open |
| claude | theme picker (7 styles, live diff preview) → "Select login method" (subscription / Console / 3rd-party) | stays open |
| Grok CLI | device-code screen: code `<device-code>` (redacted; one-time code, expired), "Approve in your browser", copy/URL fallbacks, "Waiting for approval…", `ctrl+q quit` | stays open |
| opencode | full TUI immediately; "Tip Run /connect to add an AI provider and start coding" | stays open |
| **zagent** | one stderr line `zagent: no GLM Coding Plan credential — set ZAI_API_KEY (see doctor)` | **exit 1 after 0.5 s** |

zagent has `zagent login` (kernel OAuth) and `zagent onboard`, but the first-run path mentions neither
and never opens the TUI. Every competitor keeps the user inside the product and offers 2–3 sign-in paths.

## 2. Home screen (`--home.txt`)
| CLI | header | input hint | footer / status |
|---|---|---|---|
| codex | box: version, model + reasoning, directory, permissions; tips; ⚠ MCP/agent warnings; usage-reset note | "Ask Codex to do anything" | model · effort · dir · repo · branch · "Context 100% left · 0% used" |
| claude | logo, version, "Fable 5.1 with max effort · Claude Max", cwd · session name; safe-mode banner; session-limit line "97% of your session limit · resets 7pm · /upgrade" | "Try \"fix lint errors\"" | permission mode "bypass permissions on (shift+tab to cycle)" |
| Grok CLI | welcome card: version, "New /learn skill!", New worktree ctrl+w, Resume ctrl+r, Changelog, Quit ctrl+q; telemetry opt-in banner | ❯ | "Grok 4.6 (high) · always-approve" on the box; footer "Enter:send │ Shift+Tab:mode │ Ctrl+.:shortcuts"; top bar cwd + "1.5K / 500K │ [Dashboard]" |
| opencode | logo | "Ask anything… \"Fix a TODO in the codebase\"" · "Build · Kimi K2.5 Turbo (Developer Pass) Fireworks AI" | "tab agents  ctrl+p commands"; tip line; cwd · version · branch |
| zagent | "⏺ zagent 0.0.203 · runtime desktop-bundle 3.11.2 · zai/glm-5.3"; cwd · branch; "/help for commands · esc to interrupt · ctrl+c twice to exit"; "mcp node_repl: connecting" | boxed "> Ask a task about this workspace" | ">> build · zai/glm-5.3 · max · mcp 0/1" |

Missing on zagent's home: any context/quota figure (codex, claude, Grok CLI all show one), a mode-cycle
hint, and a "what's new"/update line (Grok CLI card, codex tip, claude usage line).

## 3. Slash palette (`--palette*.txt`; distinct commands seen: codex 36, claude 36 of ~60, Grok CLI 59, opencode 25 built-in + custom, zagent 48)
| CLI | rows shown | presentation |
|---|---|---|
| codex | 8 | name + one-line description, filters as you type, ↑↓ scroll |
| claude | 5 (+ tall descriptions) | grouped in `/help` modal (General / Commands / Custom commands tabs) |
| Grok CLI | 8, plus a searchable grouped **Commands** modal (`/help`: Session / Context / Model & Input / Tools …, `ctrl+p` palette with search box, `[Dashboard]`) | badges `built-in` |
| opencode | 10 in a bordered list; `ctrl+p` global command palette | custom commands (LoopX) mixed in alphabetically |
| zagent | **6** + "+38 more · tab to cycle" (tab moves ONE row) | `/help` prints a grouped list (Session / Model / Project / Tools / zagent) — good, but only after you know `/help` |

zagent command set (44 + aliases): client `/exit /quit /stop /clear /status /version /usage /context /diff /undo /export
/copy /doctor /quota /update /theme /hooks /agents /permissions /memory /feedback /bug /approvals /plan /help` + kernel `/login /logout
/compact /init /expert /effort /workflow /workflows /fork /locale /mcp /plugins /mode /model /new /resume /rewind /skill /goal`.

Quirk (verified): Esc closes the palette but leaves the typed `/`; typing `/help` then yields `//help` and the
KERNEL answers "Unknown command: //help. Available commands: /help, /login, … /goal" — a list that omits every
zagent client command (`zagent-real--help.txt`).

## 4. Help & shortcuts (`--help.txt`, `codex-real2--shortcuts.txt`, `claude-real2--help.txt`)
| CLI | help surface | shortcut discoverability |
|---|---|---|
| codex | `?` overlay: "/ for commands · ! for shell · ctrl+j newline · tab submit · @ files · ctrl+v images · ctrl+g editor · esc esc edit previous · ctrl+r history · alt+,/. reasoning · shift+tab mode · ctrl+t transcript · ← agents · /keymap" | one keystroke |
| claude | `/help` modal: shortcuts table (! shell, / commands, @ files, /btw, double-esc clear, shift+tab auto-accept, ctrl+o verbose, ctrl+t tasks, shift+⏎ newline, ctrl+shift+_ undo, ctrl+z suspend, ctrl+v images, alt+p model, ctrl+s stash, ctrl+g editor, /keybindings) | modal |
| Grok CLI | `/help` grouped Commands modal + footer hints + `Ctrl+.` shortcuts | always-visible footer |
| opencode | `/help` = "Press ctrl+p to see all available actions"; footer "tab agents ctrl+p commands" | footer |
| zagent | `/help` and `?` print the grouped command list (no shortcut section); banner line has 3 hints | none beyond the banner |

## 5. Status, usage, context (`--status.txt`, `--usage.txt`, `--context.txt`, `--cost.txt`, `--quota.txt`)
| CLI | status | usage / limits | context |
|---|---|---|---|
| codex | `/status` card: account e-mail + plan, model + reasoning, directory, permissions, AGENTS.md files, session id, **weekly / 5h limits as bars with reset times** | `/usage` | "Context window: 100% left (0 used / 272K)" |
| claude | `/status` tabbed (Status / Config / Usage / Stats): version, session id/kind, cwd, login method, org, model, setting sources | `/cost`: $ cost, API/wall duration, lines added/removed, session % + week % bars with reset times | `/context` grid |
| Grok CLI | `/session-info` modal | `/usage` modal: weekly bar 22%, reset date, session usage | `/context` modal at t=0: **breakdown by system prompt / messages / tools / skills / workflows / MCP / AGENTS.md** + auto-compact threshold |
| opencode | `/status`: MCP servers, formatters, plugins | `stats` CLI | — |
| zagent | `/status`: version, runtime + kernel build, model/effort/mode, session, cwd/branch, mcp, tokens, elapsed | `/quota`: "5-hour window: 94% used · resets 19:24 · monthly tool calls 928/4000 · plan: max"; `/usage`: tokens + list-price estimate | `/context`: "not reported yet (the meter fills in after the first turn)" |

## 6. Diff, undo, sessions, doctor
| CLI | diff / undo | sessions | doctor |
|---|---|---|---|
| codex | `/diff` (git diff incl. untracked); `/review` | `resume` picker/`--last`, `fork`, `agents` dashboard, `queue`, `archive/delete/rename` | `codex doctor`: ⚠ notes (rollouts size, sandbox, config, threads), environment, disk thresholds, runtime, install, search |
| claude | ctrl+shift+_ undo; no /diff | `--resume` picker, `-c`, `/fork`, `--bg` background sessions, `/rename` | `claude doctor`: version/commit/platform/path/install method/search/auto-update/managed settings/remote control |
| Grok CLI | `/undo`, `/rewind`, `/jump` | ctrl+r resume, `/history`, `/transcript`, `/find`, `/rename`, `/delete` | `/doctor` in TUI |
| opencode | `/diff` full-screen viewer (file tree, hunk nav, mark reviewed), `/undo`, `/redo` | `/sessions` modal (search, pin, delete, rename), `session list` CLI, `export/import` | `debug config|lsp|rg|file|skill|startup|paths|info` |
| zagent | `/diff` per-file hunks (after first turn), `/undo` (y/N) | `zagent sessions` (30 rows: age, id, state, kind, title, cwd), kernel `/resume` `/fork`; `task rename/archive/delete` CLI only | `zagent doctor`: 3 lines (runtime, TUI, config) (+credential in `/doctor`) |

## 7. Error UX (offline, `help/` + shell transcript in this report)
| input | codex | claude | Grok CLI | opencode | zagent |
|---|---|---|---|---|---|
| unknown flag | clap error + tip + usage, exit 2 | "error: unknown option", exit 1 | clap error, exit 2 | prints banner + usage, exit 1 | "zagent: unknown option '--bogus' / Run 'zagent help'", exit 2 |
| unknown word | treated as prompt ("stdin is not a terminal", exit 1) | treated as prompt | treated as prompt → "No such device or address (os error 6)", exit 1 | treated as project path → "Failed to change directory", **exit 0** | "unknown command 'bogus' / Run 'zagent help'", exit 2 |
| no credential | sign-in menu | login menu | device code | TUI + tip | one-liner, exit 1 |
| rate limit (observed) | — | "97% of your session limit · resets 7pm" on home | weekly bar in `/usage` | — | transcript lines "rate limited · retry 1/10" and status "working 10.4s · 2 retries" — no reset time in the notice (`zagent-real3--agents.txt`) |

## 8. Headless (from `help/`)
| CLI | entry | output | session control | inputs |
|---|---|---|---|---|
| codex | `codex exec [PROMPT]` (stdin when omitted or `-`) | `--json`, `-o` file, `--json-schema`? (n/a), `--color` | `exec resume --last`, `exec fork`, `exec review` | `-i image`, `--cd`, `-s sandbox`, `-a approval`, `--add-dir`, `--search` |
| claude | `claude -p` | `--output-format text\|json\|stream-json`, `--input-format stream-json`, `--json-schema`, `--include-partial-messages` | `-c`, `-r id`, `--session-id`, `--fork-session`, `--bg`, `--max-budget-usd` | `--allowed-tools`, `--permission-mode`, `--model`, `--effort`, `--add-dir`, `--mcp-config` |
| Grok CLI | `grok -p`? (`--output-format streaming-messages-json`, `--json-schema`) | json / streaming | `-c`, `--resume`, `--fork-session` | `--allow/--deny`, `--max-turns`, `-m model`, `--agent` |
| opencode | `opencode run [message..]` | `--format json`, `--thinking` | `-c`, `-s id`, `--fork`, `--share`, `--title` | `-f file`, `-m model`, `--agent`, `--variant`, `--dir`, `--attach server` |
| zagent | `zagent -p "…"` | `--json` (single final object) | none documented | `--cwd`; official kernel flags pass through only when they FOLLOW `-p` (`--attach --mode --max-turns --allowed-tools --resume -c --target --locale`, undocumented, not verified by execution); no `--model`/`--effort` at all (the kernel CLI has none; the desktop switches via `session/setModel`) |

## 9. Ranked UX gap list for zagent (UX-GAP → ledger)
| # | gap | evidence | proposed fix (size) |
|---|---|---|---|
| G1 | First run exits with a one-liner; no in-product sign-in | §1 | TUI onboarding card: 1 `zagent login` (OAuth) · 2 paste API key (ZAI_API_KEY, saved 0600) · 3 quit; `-p` prints the same three lines; exit 2 not 1 (M) |
| G2 | Headless flags undocumented / model-effort-mode not selectable for `-p` | §8 | document passthrough, accept leading flags, add `--model --effort --mode --continue --resume --stdin(-)` via the protocol client (session/setModel etc.) (L) |
| G3 | Palette shows 6 rows, tab moves one row | §3 | 10 rows, page keys, type-to-filter hint, count "n/44" (S) |
| G4 | `/context` empty until first turn; no context/quota figure on home | §2, §5 | show `contextWindow` and the 5-hour window % at start; baseline breakdown when the kernel reports it (S–M) |
| G5 | `/status` lacks account/plan and limit bars with reset times | §5 | fold `/quota` (plan, window %, reset) + account identity into `/status`; bar rendering (S) |
| G6 | No shortcuts help; `?` = `/help` | §4 | shortcuts section in `/help` + footer hint rotation (S) |
| G7 | Rate-limit notice has no reset time / alternative | §7 | "rate limited (5-hour window, resets 19:24) · try /model GLM-5.3-Flash or zagent offpeak" (S) — verify against the kernel event payload |
| G8 | `doctor` is 3 lines | §6 | node + kernel build + desktop version + pending update, credential source, config path, plugins/hooks/MCP counts, disk free, log dir (M) |
| G9 | `//help` unknown-command reply lists kernel commands only; Esc keeps `/` | §3 | client-side unknown-command handler with the merged list; Esc clears an input that is only `/` (S) |
| G10 | Session management is CLI-only (rename/archive/delete) | §6 | `/rename /archive /delete` TUI wrappers over `task` (S) |
| G11 | No `!` shell passthrough (codex, claude) | §4 | `!cmd` runs locally, output into transcript, never sent to the model (M) |
| G12 | No directory-trust prompt (codex, claude ask on first visit) | §2 | observation only — a product decision; kernel `--mode` default is `build` in TUI |

## 10. UX-TEST — the human-journey suite this inventory demands (spec for the next wave)
Drive the REAL installed `zagent` (npm global) through a REAL PTY with a sandbox HOME seeded from the
real config (the usertest emulator already does this; `scripts/pty-capture.py` is the capture
primitive). Each journey names its oracle and whether it spends a model turn:
| id | journey | keys | oracle | cost |
|---|---|---|---|---|
| J1 | fresh install, first run | empty HOME, `zagent` | screen offers sign-in paths, process stays open or exits 2 with the three lines | offline |
| J2 | help discoverability | `--help`, `/help`, `?`, `/` | every command in `packages/tui/commands.mjs` + kernel list appears; shortcuts section present | offline |
| J3 | ask a question | TUI prompt "reply pong" and `-p … --json` | answer text; usage numbers > 0; exit 0 | 1–2 turns |
| J4 | edit → diff → undo | "create hello.txt containing hi" → `/diff` → `/undo` → y | `/diff` shows +1 line; file exists; after undo file gone | 1 turn |
| J5 | quota / cost check | `/quota /usage /context /status` after J3 | window %, reset time, tokens > 0, context meter filled | offline (after J3) |
| J6 | error paths | bogus cmd/flag, no credential, `ZCODE_RUNTIME=/nonexistent`, injected 429 via fake-host | exit 2 + hint; doctor explains; retry notice names limit + reset | offline |
| J7 | headless ergonomics | `-p` with `--json`, stdin prompt, `--continue` | JSON parses; exit codes; second turn continues the session | 2 turns |
| J8 | outsider install | `scripts/outsider-smoke.mjs` | `--help doctor inspect --json` as a stranger | offline |
| J9 | exit paths | ctrl+c twice, `/exit`, `/quit`, SIGTERM mid-turn | terminal sane (`stty -a` unchanged), no orphan `zcode.cjs` | offline |
Live journeys run only behind `ZAGENT_LIVE=1` and skip LOUDLY when `/quota` reports the 5-hour window
above 90 % (the 94 % window during this audit is exactly the case). Lesson recorded from this audit: any
typed line + Enter that is not a slash command IS a model turn — journey scripts must assert the input
box content before pressing Enter.

## 11. Not verified / limits
- Palette captures show what fits on screen; counts are lower bounds (claude has ~60 commands, 36 seen).
- Headless flag behaviour of the four competitors is from `--help`, not executed; zagent passthrough not executed.
- codex/claude captures in the scratch dir stopped at their directory-trust dialogs (kept as
  `codex-real--*`, `claude-real--*`); the usable captures are `codex-real2--*`, `claude-real2--*` from the trusted repo dir.
- Grok CLI captures contain no artifacts after sanitization; the `[Dashboard]`/`ctrl+.` features were not opened.
