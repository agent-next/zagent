# TUI-STUDY: codex (codex-cli 0.154.0) — behavioral PTY study

- Date: 2026-09-15
- Method: pexpect spawn, pty 40x120, `TERM=xterm-256color`; raw byte stream with
  timestamps in raw frame captures (not included); rendered screens
  via pyte (screens quoted below); capture primitive: `scripts/pty-capture.py`.
- Version: `codex --version` → `codex-cli 0.154.0` (installed binary).
- Host config: `approval_policy="never"`, `sandbox_mode="danger-full-access"`
  (status card shows "permissions: YOLO mode") → no approval dialogs exist on this
  host; approval UI is therefore unobservable here.

## Rate-limit blocker (important, honest scope note)

Both local Codex profiles were quota-dead at probe time:

- Default `~/.codex` (ChatGPT plan auth): statusline `weekly 0% left`, banner
  `• You have 1 usage limit reset available. Run /usage to use one.` and after
  submit `✖ You've hit your usage limit. … try again at Sep 19th, 2026 8:48 AM.`
- A second `CODEX_HOME` profile (API-key auth): identical
  `weekly 0% left` statusline; turn accepted then produced no output.

Net: **0 model turns were consumed** (both submissions failed client-side/early),
but P1 streaming, P2 live tool spinner, and P3 Esc-mid-turn could **not** be
observed live. They are marked UNVERIFIED below; everything else is backed by
offline surfaces plus `codex resume <id>` repainting *real* past transcripts —
which shows exactly how codex renders turns, tool calls and markdown.

Interesting failure behavior itself (evidence): submitting a turn on a dead
quota produced a silent idle return on turn 1, then on the next submit the TUI
tore down with:

```
Disconnected from this task. Any running work continues.
Reconnect: codex resume 01a0a69e-b610-7cc3-9b32-6692de0d7768
Stop the current turn: run codex agents, select this task, and press ctrl + x.
```

i.e. the TUI is a **detachable client of a task daemon** (`codex app-server`);
turns outlive the UI. Afterwards the pty dropped to cooked mode (sent keys echo
literally: `^[[A^C^C`).

## P1 — turn rendering / streaming (PARTIAL; streaming UNVERIFIED)

Observed at +1s after Enter (frame `H1-t1`):

```
› show a 5-line python quicksort, no explanation


  tab to queue message                                             100% context left
```

- User message IS echoed into the transcript immediately: `› ` marker, bold+dim
  (`\x1b[1m\x1b[2m› \x1b[22m`), continuation lines indented 2 cols.
- During a turn the composer/footer swaps to `tab to queue message` +
  right-aligned `NN% context left` — i.e. **mid-turn message queueing** is a
  first-class affordance (Tab queues the next prompt while a turn runs).
- Footer/statusline returns to the idle variant when the turn ends.
- Token-by-token streaming: **UNVERIFIED** (quota dead before first delta).
  The raw stream does show codex emitting `ESC[?2026l/h` synchronized-output
  blocks around every repaint, so repaints are atomic frame updates.
- From a resumed transcript: assistant prose is emitted as `• ` blocks
  (dim `•`, normal text); `---` markdown rules render as full-width `─` rules;
  `### h` stays literal but bold+italic; inline `` `code` `` is cyan
  (`38;5;6`); CJK assistant text renders correctly.

## P2 — tool-call display (from resumed real transcripts)

Inline, minimal, collapsed-by-default:

```
• Ran pwd; git rev-parse HEAD; cat _review/meta.txt; …
  └ /path/to/verify-work/tree
    4da069885ab2ae9c68e3094234c0603aa657c507
    … +279 lines (ctrl + t to view transcript)
```

- Header `• Ran <cmd>` — dim `•`, `Ran` bold, command text normal; long
  commands wrap with a `│` left gutter (heredoc bodies shown as `│ <line>`
  plus `… +10 lines` fold).
- Output: `└` connector for first line, then head+tail preview with a
  `… +N lines (ctrl + t to view transcript)` fold marker — Ctrl+T opens the
  full transcript/output viewer. Even +1208-line outputs collapse to ~4 rows.
- Read/search operations group under a collapsible header:

```
• Explored
  └ Read MEMORY.md
    Search CODEX_HOME|exec .*codex|resume in profile2
```

- Errors are printed plainly under `└` (e.g. `/bin/bash: line 1: python:
  command not found`) — no red box, no retry chrome.
- Live spinner/inline-progress for a running call: UNVERIFIED this session
  (resume paints post-hoc collapsed state).

## P3 — Esc / Ctrl-C mid-turn (PARTIAL)

- Mid-turn Esc retention: UNVERIFIED live.
- Observed adjacent behavior: Ctrl-C at idle **clears the composer** back to the
  `› Ask Codex to do anything` placeholder (frames `C3`, `C5`); Ctrl-C while the
  UI was torn down produced no visible effect. Painted transcript survives any
  UI teardown — scrollback is terminal-native, nothing is withdrawn on failure.

## P4 — composer input

- CJK: `你好世界` echoes correctly, width correct, appended after existing text
  (`/status你好世界`) — no IME artifacts (frame `C1`).
- Multi-line: **Alt+Enter (`ESC CR`) inserts a newline** — composer shows
  `› first line` / `  second line` with 2-col continuation indent (frame `C4`).
- Bracketed paste (`ESC[200~…ESC[201~`) of a 3-line block: pasted verbatim as
  three lines in the composer — **no paste-summarization chip** like
  `[Pasted 3 lines]`; raw lines stay editable (frame `C2`).
- Slash menu: typing `/` opens a popup listing `/model`, `/fast`, `/ide`,
  `/permissions`, `/keymap`, `/vim`, `/experimental`, `/approve` … with
  one-line descriptions; Enter while popup is open completes/filters rather
  than submitting (typed `/status` + CR left `/status` in the composer).
- Up-arrow history: INCONCLUSIVE — on a healthy UI the recall may have worked
  (frame `H6` shows the prompt at `›`) but is indistinguishable from the
  transcript echo; on the dead UI it echoed `^[[A` literally.
- Composer placeholder: `› Ask Codex to do anything`.

## P5 — layout & chrome (40x120)

- Startup card (rounded box `╭─╮│╰─╯`, ~7 rows):

```
╭─────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.154.0)                  │
│                                             │
│ model:       gpt-6-astra medium  /model to change │
│ directory:   <scratch-dir>                │
│ permissions: YOLO mode                      │
╰─────────────────────────────────────────────╯
```

- Below: `Tip: New Use /fast …` line, then `⚠`/`•`/`✖` notice lines
  (warnings prepend a colored glyph + 2-col indent, wrap-aligned).
- Idle statusline (single row, `·`-separated, right-truncated with `…`):

```
gpt-6-astra · gpt-6-astra medium · /tmp/… · Context 100% left · Context 0% used · weekly 0% left · 0.154.0 · 272K window · <session-id>…
```

  Colors (raw SGR): model `rgb(246,226,183)` tan, cwd `rgb(171,223,167)` green,
  context `rgb(242,181,144)` orange, `weekly 0% left` `rgb(233,144,169)` pink
  (quota warnings are color-coded red/pink).
- Content-vs-chrome at steady state: ~1 statusline + 1-3 composer rows +
  header/notices amortized to zero → **>90% of rows are transcript**. No side
  panels, no borders around transcript items.
- Code blocks: fences are stripped; content rendered at 2-col indent with full
  **Catppuccin-style syntax highlighting** — e.g. bash `CODEX_HOME` in
  `rgb(205,214,244)`, `=` in `rgb(148,226,213)`, path `rgb(166,227,161)`,
  command `rgb(137,180,250)`. No language label, no box border observed.
- Markdown: tables → real unicode tables (`━━━` heavy separators); `###` →
  bold+italic literal; `---` → full-width `─` rule; bold `**x**` honored.
- Modal surfaces observed: trust-directory picker (`› 1. Yes, continue / 2. No,
  quit`, Enter to accept), resume working-dir picker (4 numbered options incl.
  "always" remember choices), slash autocomplete popup, usage-limit banner.
- Rendering tech: ratatui-style absolute addressing + `ESC[?2026` synchronized
  updates; transcript written to native scrollback (PgUp inside the app does
  nothing — scrolling is the terminal's job).

## Coverage recommendations → zagent conversation-core

| capability | why it matters for humans | zagent should copy / differ |
|---|---|---|
| Detachable task / `codex resume <id>` + `codex agents` | Turns survive UI death (SSH drops, crashes); reconnect mid-turn | **Copy strongly**: session-id-addressable turns + resume; zagent already has headless run records — add a reattach surface |
| `›` user / `•` agent / `• Ran`/`• Explored` glyph system | Instant scan of who-said-what and what ran, zero chrome cost | **Copy**: 3-4 glyphs max, dim markers, no boxes around messages |
| Tool output head+tail fold `… +N lines (ctrl+t transcript)` | A 1208-line output costs 4 rows; terminal stays readable | **Copy**: collapse tool output by default with expand affordance; zagent should cap preview lines and show the count |
| `• Explored` grouping of read/search ops | Verification sweeps would spam 50+ `Ran` lines; grouping keeps signal | **Copy**: group file-read/search calls under one foldable node |
| `tab to queue message` mid-turn | Humans think faster than turns finish; queueing removes wait | **Copy**: allow composing + queueing during a turn; show the hint in the footer |
| Statusline: model · effort · cwd · context% · quota · version · window · session | All live state in ONE row; quota shown red when low | **Copy**: single `·`-separated line; **differ**: zagent should surface quota/offpeak state (its differentiator) in the same slot |
| Usage-limit / error surfaces as colored transcript lines (`✖`) not modals | Errors stay in scrollback, greppable, no dismissal needed | **Copy**: errors as styled transcript entries, not popups |
| Native-scrollback transcript (no in-app pager) | Scroll/copy with the terminal's own muscle memory | **Copy**: don't build a viewport; keep PgUp = terminal scrollback |
| Markdown: tables→unicode, ###→bold+italic, `code`→cyan, fences→syntax-highlighted no border | Readable answers without leaving the terminal | **Copy**: same minimal-render set; zagent may differ by adding a language label on fences if users want copy clarity |
| `ESC[?2026` synchronized frame updates | No torn frames during streaming | **Copy** if zagent's renderer doesn't already batch repaints |
| Trust-dir / resume-dir numbered pickers | Safety + convenience decisions front-loaded, keyboard-only | **Copy pattern**: numbered-option modal for first-run/dir decisions |
| Alt+Enter newline; verbatim bracketed paste; Ctrl-C clears composer | Multi-line prompts without leaving keyboard | **Copy all three**; consider adding a `[Pasted N lines]` chip — codex lacks it and long pastes flood the composer |
| Slash-command popup that filters live, Enter completes | Discoverable commands | **Copy**; note Enter-doesn't-submit quirk — zagent should make Enter-on-exact-match submit |
| Silent failure on quota-dead submit, then UI disconnect | BAD: turn 1 vanished with no error line; turn 2 killed the UI | **Differ**: zagent must print the error inline and keep the composer content recoverable |

## Evidence inventory (not carried into this repository)

- raw frame captures — timestamped raw byte streams
- pyte-rendered screens per step (`frames/*.txt` in the capture directory)
- full recovered transcripts for S6 and T3 (633 / 161 lines)
- the probe drivers (one per probe point; the step-driven pexpect/pyte capture
  primitive they used is `scripts/pty-capture.py`, kept in this repo)
- per-frame notes

## Gaps / follow-up (when quota resets after 2026-09-19 08:48)

1. Re-run the streaming probe to capture: token streaming cadence, live `Ran` spinner,
   Esc-mid-turn retention, tool-call collapse transition.
2. `/usage` "1 usage limit reset" was NOT consumed (shared-account side effect,
   needs the account holder's authorization).
3. Approval dialog unobservable on this host (`approval_policy="never"`).
