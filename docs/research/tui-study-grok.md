# TUI behavioral study — Grok CLI (Grok Build) 1.0.30

- Target: `grok` — `grok 1.0.30 (04b7ffed98c6) [stable]` (installed binary)
- Method: `pexpect` spawn in a real PTY at **40 rows × 120 cols**, `TERM=xterm-256color`,
  `COLORTERM=truecolor`, a scratch cwd. Raw bytes recorded with timestamps;
  screens rendered via `pyte` after stripping kitty-graphics APC sequences (`ESC_G…ESC\`)
  that pyte cannot parse.
- Raw frame captures were not kept in this repository.
  - `session-stage1.rb`, `session-stage2.rb` — raw PTY byte streams
  - `session-*-index.jsonl` — `{t, offset, bytes}` chunk index (timing proof)
  - `screen-<stage>-<label>.txt` — rendered 120×40 screens per probe point
  - `drive.py` — the pexpect driver (reusable)
- Live budget: **2 model turns used** (P1+P3 shared turn 1, P2 turn 2). All other
  surfaces captured offline.
- Note: host account runs in `always-approve` mode (footer badge), so no permission
  dialog was observed; that surface is unprobed.

## P0 — boot / welcome (offline)

- Alt-screen fullscreen TUI (default). `--minimal` (scrollback-native) and
  `--no-alt-screen` (inline) exist as alternates; `grok doctor` detects
  terminal/multiplexer/clipboard (OSC 52 confirmed).
- Welcome card (rounded box, braille logo): `Grok Build 1.0.30`, promo line
  (`New /learn skill!`), shortcut list `New worktree ctrl+w`,
  `Resume session ctrl+r`, `Changelog`, `Quit ctrl+q`.
- Telemetry onboarding banner above the input: `Help improve Grok … [Opt out] [Opt in]`,
  "Off by default", Terms/Privacy links. Persists across screens until acted on.
- First Enter dismisses the welcome card → empty transcript view.
- On exit (Ctrl+C ×2), grok leaves alt-screen and prints a scrollback summary:
  auto-generated session title, last exchange, and `grok --resume <uuid>`.

## P1 — streaming turn (live turn 1)

Prompt: `show a 5-line python quicksort, no explanation`

- **User message is echoed** into the transcript immediately on send, right-aligned
  timestamp `3:51 PM`; with "Snap prompt to top on send" (default on) it pins to the
  top of the viewport.
- **Thinking indicator:** braille spinner `⠋/⠧/⠴/⠼` + phase label
  `Waiting for response… N.Ns`, right side shows `N.Ns ⇣1.48k [stop]`
  (elapsed, bytes/tokens received, clickable stop). Chunk index shows ~43-byte
  redraws every ~40 ms ⇒ the ticker repaints at ~25 fps even when idle-waiting.
- **Streaming is incremental**, not block-at-once: at t=7s screen shows
  `◆ Thought for 0.2s` then `def qsort(a):` mid-block; reasoning is summarized as a
  collapsed `◆ Thought for Ns` line (setting "Show thinking blocks" on).
- Spinner label changes with phase: `Waiting for response…` → `Responding…`.
- **Code block chrome:** no border, no language label — code is painted on a
  distinct band background `bg #1c1c1c` (chat bg `#141414`) with truecolor syntax
  highlighting (`qsort` = `#7aa2f7`, parens `#9abdf5` — Tokyo-Night-style palette).
- Every transcript block carries a right-aligned timestamp.
- Frame excerpt (t=7s):
  ```
   show a 5-line python quicksort, no explanation                          3:51 PM
   ◆ Thought for 0.2s
   def qsort(a):                                                           3:51 PM
       if len(a) <= 1: return a
       p = a[len(a)//2]
       return qsort([x for x in a if x < p]) + [x for x in a if x == p] + q
   ⠴ Responding… 0.9s                                             7.3s ⇣3.15k [stop]
  ```
- Rendering pipeline: each frame wrapped in DEC synchronized output
  (`ESC[?2026l`/`ESC[?2026h`) — flicker-free atomic updates; a kitty
  `ESC_Ga=d,d=i,i=1,q=2` delete-image APC is emitted per frame.

## P2 — tool call display (live turn 2)

Prompt: `read <scratch-file>.txt and tell me what it says`

- Text streams first (`I'll read that file and report its` captured mid-sentence),
  then the tool call renders as a **single collapsed line**:
  `◈ Read 1 file` — `◈` glyph + bold tool label, no args, no result body inline
  ("Group tool calls" setting on; expandable but was not expanded in this probe).
- A right-edge **scrollbar** (`▴ ─ ━━ ▾` thumb) appears once content overflows.
- Answer continues streaming after the tool line; turn ends with
  `Worked for 4.0s` status line; header context meter jumped `3.2K → 43K / 500K`.
- No permission prompt (session in `always-approve`; footer confirms).

## P3 — interrupt (Ctrl-C mid-turn)

- Sent `\x03` at ~7.3s into turn 1 while code was still streaming.
- **All partial output is retained verbatim** (4 code lines + `◆ Thought…` stay),
  and a gray marker is appended: `Turn cancelled by user in 7.3s.`
- Input re-enables instantly; hint bar reverts `Ctrl+c:cancel` → `Enter:send`.
- Esc-mid-turn not probed (Ctrl-C chosen as the interrupt key).

## P4 — input behavior

- **CJK** `你好世界`: echoed correctly inside the box at proper 2-cell width
  (`│ ❯ 你好世界`), box border intact — width handling correct.
- **History:** Up arrow produced no visible change (fresh cwd ⇒ empty history;
  cannot confirm recall works, only that it fails silently and safely).
- **Multiline:** `Alt+Enter` (`ESC CR`) inserts a newline — box grows a row,
  continuation lines indented under `❯`. Kitty-encoded Shift+Enter
  (`ESC[27;2;13~`) is ignored (typed text concatenates on same line). Consistent
  with settings: `Multiline off` (Enter=send) + hint `Enter:send`.
- **Bracketed paste** of 3 lines: collapses to a chip `❯ [Pasted: 3 lines]` plus a
  floating preview card listing all lines with
  `paste again or double-click to expand`. No premature submit.
- **Slash menu:** typing `/` opens a bordered dropdown *above* the input with
  command + description + scrollbar (`/quit`, `/session-info`, `/context`,
  `/help`, `/usage`, `/login`, `/settings`, `/goal`); filters live as you type.
- `/help` → centered **Commands modal**: search field, grouped sections
  (Session / Context / Model & Input / Tools / Other), keybinding column,
  `↑/↓ nav | Enter select | Esc close`.
- `/settings` → large **Settings modal**: `/ to search`, tree of sections
  (Appearance, Mouse, Editor & Input…), footer
  `↑/↓/j/k nav | g/G top/btm | Space toggle | Enter toggle | → expand |
   / search | d reset | F2/Esc close`. Notable defaults: timestamps on, timeline
  sidebar on, snap-prompt-to-top on, thinking blocks on, group tool calls on,
  mermaid Auto, follow-up = Queue.
- Hint bar under input is contextual: idle `Enter:send │ Shift+Tab:mode │
  Ctrl+.:shortcuts`; during turn `Ctrl+c:cancel` replaces `Enter:send`.

## P5 — layout & color (120×40)

- Header (1 row): cwd left; right = live context meter `43K / 500K` + `[Dashboard]`.
- Transcript: ~26–30 rows (~65–75% of screen). Telemetry banner eats 4 rows until
  dismissed.
- Input box (3 rows): `╭─╮` border, `❯` prompt, bottom border embeds
  `Grok 4.6 (high) · always-approve` right-aligned. Hint bar 1 row below;
  `[stable]` tag bottom-right.
- Color discipline: dark gray bg `#141414`, code bg `#1c1c1c`, chrome gray
  ~#33–#6c, secondary text ~#6c–#93, primary text #c8–#e1; accents only for
  semantics (syntax palette #7aa2f7/#bb9af7/#0db9d7/#89ddff/#f7768e/#ff9e64/#e0af68).
  Truecolor (`38;2`/`48;2`) everywhere; bold for tool names.
- Turn-status row lives directly above the input box (spinner + timer + `⇣` +
  `[stop]`), not in the header.

## Coverage recommendations for zagent conversation-core

| Capability | Why it matters for humans | zagent should copy / differ |
| --- | --- | --- |
| Incremental token streaming into transcript | Immediate feedback that work is happening; lets users read while generating | Copy. Stream text deltas into place; keep partial markdown/code renderable mid-stream |
| Phase-aware spinner (`Waiting…`→`Responding…`) + elapsed + `⇣bytes` + `[stop]` | Distinguishes "model thinking" from "stuck"; the byte counter proves liveness | Copy the phase label + elapsed; differ: drop the ~25 fps repaint (tick 4–8 Hz is enough) — 43 B/frame ×25 fps is wasteful over SSH/tmux |
| Collapsed `◆ Thought for Ns` block | Reasoning visible but doesn't flood the transcript | Copy: one-line summary, expandable on demand |
| Tool call as collapsed one-liner `◈ Read 1 file` | Tools are audit-relevant but args/results are noise by default | Copy: compact verb+target line, expandable; differ: show the permission-relevant arg (path/cmd) inline since zagent users care what was touched |
| Ctrl-C retains partial output + `Turn cancelled by user in Ns` marker | Users interrupt constantly; losing streamed work is infuriating | Copy exactly: keep partial, append an explicit cancelled marker, restore input |
| Bracketed-paste chip `[Pasted: N lines]` + preview card | Prevents 3-line pastes from firing 3 submits; user can verify content | Copy the chip; differ: preview card is optional — inline expansion hint suffices |
| Alt+Enter newline when Multiline=off | Multi-line prompts without accidental send | Copy: document the newline key in the hint bar |
| Contextual hint bar (`Enter:send` ↔ `Ctrl+c:cancel`) | Teaches keys in context, zero man-page reading | Copy: swap hints by state (idle/streaming/menu-open) |
| Live context meter `43K / 500K` in header | Users budget context; explains slowdowns/compactions | Copy: cheap, high-value; place in header/status, update per turn |
| Right-aligned per-block timestamps | Audit trail, correlating with logs | Copy (zagent already versions artifacts; align format) |
| Code blocks: bg band + syntax colors, no border/lang label | Readability without chrome noise | Copy the bg-band approach; differ: keep the language label — it helps copy/paste into the right file type |
| DEC `?2026` synchronized updates + kitty graphics cleanup | Flicker-free full repaints on capable terminals | Copy `?2026` wrap if targeting xterm-kitty class terminals; differ: skip kitty `ESC_G` deletes unless zagent draws images |
| `/`-triggered command dropdown + searchable `/help` and `/settings` modals | Discoverability without leaving the keyboard | Copy the dropdown; modals can be simpler lists until needed |
| Welcome card + telemetry opt-in banner + resume hint on exit | Onboarding, consent, and re-entry in 3 lines | Copy resume-on-exit hint (`zagent --resume <id>`); opt-in banner only if telemetry ever exists |
| Exit summary (auto session title + last exchange) | Sessions are resumable objects, not lost scrollback | Copy: auto-title + resume command on exit |
| `always-approve` shown in input footer | Permission posture must be glanceable | Copy: show permission/model mode persistently in the input frame |
| CJK double-width handling in box | Chinese userbase; broken borders look broken | Copy: wcwidth-correct cursor math; verify box borders don't shift |

### Untested / honest gaps

- Esc-as-interrupt, permission dialog (session ran `always-approve`), expanded
  tool-call view, Up-arrow history recall (empty history in probe cwd), scrollback
  navigation (vim mode), minimal/inline screen modes, error surfaces
  (rate-limit/API failure frames).
