# TUI conversation-core coverage spec

Synthesized 2026-09-16 from the parity research matrix. This is the entry
document for the TUI release, whose goal is to match the best agent harness.
Every slice below carries what / why /
how / status / acceptance. A slice ships only when its acceptance oracle is green;
the release ships only when the side-by-side PTY judge passes on every wave.

## Sources

| Study | Write-up (docs/research/) |
| --- | --- |
| opencode 1.17.11 behavioral PTY | `tui-study-opencode.md` |
| codex 0.154.0 behavioral PTY | `tui-study-codex.md` |
| Grok CLI 1.0.30 behavioral PTY | `tui-study-grok.md` |
| opencode source study @e03db9b | `src-study-opencode.md` |
| codex-rs/tui source study @c51cb96 | `src-study-codex.md` |
| 116-screen installed-CLI baseline | `cli-ux-comparison.md` (+ `cli-ux-comparison/`) |

Capture primitive: `scripts/pty-capture.py` (pexpect+pyte). Judge: side-by-side
PTY captures vs codex/Grok CLI/opencode on identical prompts; an independent
vision-capable judge answers "would a human call this broken?".

## Wave 1 — streaming delta render — DONE

| Slice | What | Status |
| --- | --- | --- |
| Delta consumption | `events.mjs` accumulates `text_delta`/`reasoning_delta` into the live stream entry | DONE |
| Progressive draw | the streaming transcript region repaints incrementally during a turn, not once at end | DONE — PTY oracle asserts partial output on screen before turn completion |
| Frame pacing | `SPINNER_MS=90` draw tick; deltas request draws through the same `draw()` | DONE (min-interval coalescing landed — W5 frame coalescer) |

## Wave 2 — transcript: user echo + markdown — DONE

| Slice | What | Status |
| --- | --- | --- |
| Mid-turn user echo | the submitted user message commits to scrollback mid-turn, not at end | DONE (oracle) |
| Markdown blocks | headings / bullets / strong / fenced code + language label / quote gutter / GFM tables | DONE (markdown.mjs + oracle) |
| Reasoning fold | collapsible thinking block (`○ thinking` header); ctrl-e toggles all | DONE (fold machinery, `toggleAllThinking`); elapsed duration DONE — `· Ns` rides the block's trailing live line (count line, or a faint footer when all lines show): the header commits to scrollback before the duration exists, so a header suffix would rewrite a committed line and re-print the block |

Hardening pulled from the studies — all three landed:

| Slice | Why | How | Source |
| --- | --- | --- | --- |
| Newline-gated markdown commit — DONE | today a line committed before its closing delimiter keeps that partial render forever — `**bol` frozen as literal once `**` arrives on a later line | commit `src[..last_nl]` through the renderer per delta batch; keep the tail line mutable until its newline | src-study-codex §streaming |
| Table holdback — DONE | a streamed table row re-widths prior rows — committing early flickers | pin from the `|---|` header into the mutable tail until finalize | src-study-codex |
| Fenced-code syntax colors — DONE | readability baseline every peer meets | small per-language regex/tokenizer (~10 scope classes) mapped to theme; do NOT port tree-sitter/syntect | src-study-opencode, tui-study-grok |

## Wave 3 — tool-call display — DONE

| Slice | What | Status |
| --- | --- | --- |
| One-line tool call | `name + significant arg + duration` on one line; result body under the result glyph | DONE (oracle) |
| Fold/expand | per-turn h/l fold on a selected user turn + global ctrl-e; single-entry fold via a j/k cursor + `o` toggle over the selected turn's foldables, named in the peek | DONE |
| Head+tail output truncation | a 1208-line output must cost ~4 rows; the conclusion of a long output (error/result) must survive | overflow renders first-N + last-N around one `… +N lines` marker — the maxResultLines budget split symmetric (6 → 3+3), degrading to head-only under a one-line budget; ingestion keeps head 48 + tail 16 of the 64-line bound so the rendered tail is the output's true end | DONE |

Hardening pulled from the studies — both landed:

| Slice | Why | How | Source |
| --- | --- | --- | --- |
| Grouped "Explored" cell | read/search sweeps spam 50+ `Ran` lines | semantic-classify read/list/search calls into one foldable `• Explored …` cell | DONE |
| Diff rendering | peers show colored diffs for edit calls | unified diff + filetype coloring; split view >120 cols later | DONE — the runtime's per-call `workspace_file_before_change` artifact attaches to the tool row (bounded `entry.diff`) and renders colored +/- rows with the file's own syntax inside; multi-file label rows, head+tail budget kept |

## Wave 4 — input quality — DONE

Done: up/down history recall (+ runtime `recallPreviousInput`), alt+enter newline,
bracketed paste verbatim, CJK/EAW-correct widths, hardware cursor parked in
the box, alt+letter meta chords, typed-during-turn queueing,
double-ctrl-c exit, Esc clears bare `/`, slash popup with live filtering.

| Slice | Why | How | Status |
| --- | --- | --- | --- |
| Large-paste chip | a 300-line paste must not flood the composer; delete removes it in one shot | `>150 chars or ≥3 lines` → placeholder `[Pasted ~N lines]` token in the buffer + side table; expand at submit (opencode threshold; codex uses 1000 chars) | DONE — paste-chips.mjs + index.mjs; chip is atomic on any delete-key touch, message-bound through queue/history, the submit payload expands |
| Paste-burst suppression | non-bracketed terminals deliver pastes as char floods; Enter mid-flood submits early | chars <8 ms apart ×≥3 → buffer; suppress Enter→submit in a ~60 ms window; retro-capture the inserted prefix | DONE — paste-burst.mjs collector between decoder and dispatch; mid-flood Enter joins the buffer as `\n` (CRLF collapses via the raw byte), a trailing Enter submits only a single-line payload, multi-line floods land for review via the chip path; covered by unit + in-process + PTY journeys |
| Double-Esc armed interrupt | one stray Esc must not kill a turn | first Esc → "esc again" hint (5 s window); second aborts. Today Esc interrupts immediately — decide deliberately (opencode PTY-verified double-esc; codex's Esc behavior is unverified in our notes) | DONE — design pick = opencode armed model: first busy-Esc arms + status hint flips to "esc again to interrupt", second inside 5 s aborts; `deps.escInterruptMs` test seam; arm resets on turn end / any idle Esc. Modals (completion/prompt/chooser/permission) still own their Esc first |
| IME double-defer on submit | last composed CJK char must flush before submit | defer submit one extra tick; read the live buffer not a cached copy | DONE — probe verdict: NOT NEEDED architecturally. `applyKey` mutates `ui.input` synchronously and submit reads the live buffer; the paste-burst collector already orders held text before a trailing Enter (flush-then-enter). Pinned by collector oracles (IME commit + hot Enter, non-BMP) and runtui drives (`'你好\r'`/`'今天天气不错\r'` submit intact) |
| Persistent JSONL history | history survives restarts | append-per-submit `~/.zcode/cli/history.jsonl`, cap ~50, parse-defensively, self-heal corrupt lines | DONE — history.mjs (cap 50, user-only 0600 file, chip-aware entries, corrupt→rewrite, `/login <key>`-style lines never persist); runtui oracle proves cross-session recall |
| Up-history guards | never clobber a half-typed multi-line draft | arrows move the cursor inside a multi-line draft; recall only at the first/last-line boundary | DONE — applyKey up/down move the cursor within a multi-line draft; recall only at the first/last-line boundary; the typed draft is stashed (chips included) and restored past the newest entry |
| Draft retention on clear | ctrl+u on a real draft shouldn't lose it | push input ≥20 chars to history before wipe | DONE — a wipe whose deleted span is ≥20 chars records the whole input (chips copied non-destructively) before the delete runs |
| Kitty keyboard probe | Shift+Enter / Ctrl+letter disambiguation | `CSI > flags u` push at startup + pop on exit, graceful fallback | DONE — `CSI >1u` (disambiguate) pushed with the bracketed-paste arm and `CSI <u` popped on both exit paths (clean + fatal); keys.mjs decodes CSI-u so shift+enter is a newline, ctrl+i/m/h keep tab/enter/backspace, every bound ctrl+letter survives, alt+key stays a meta chord; unsupported terminals ignore the push. `kitty-keyboard-left-on` invariant + replay CSI-grammar widening cover the harness |

## Wave 5 — layout & comfort — DONE

Done: committed scrollback + live-region paint with ledger-tracked erase
(screen.mjs), resize reflow, permission prompt as a renderable below
the transcript, slash completion popup, status line (spinner + activity/elapsed +
interrupt hint + context meter + model/effort + subagent count; quota is a
startup transcript notice + `/quota`, NOT a status-line field), zh-CN strings, raw-mode restore on crash incl. SIGHUP/stdin-EOF/rejection.

| Slice | Why | How | Status |
| --- | --- | --- | --- |
| DEC `?2026` sync-update wrap | no torn frames during streaming repaints | wrap each frame write `ESC[?2026h`…`ESC[?2026l`; ignored where unsupported | DONE (screen.paint wraps the whole frame, cursor park inside) |
| Frame-request coalescer | many delta/animation sources → one paint; kill flicker + CPU | `scheduleFrame(at?)` collapsing to min deadline; ~80 lines | DONE (frames.mjs: all draw sites schedule; 16 ms window, min-deadline collapse, paint composes at fire time; `deps.frameMs 0` test seam) |
| Cell-buffer diff + ClearToEnd | bandwidth + flicker on large repaints | prev/next cell buffers, row diff, `EL` from last-nonblank; wide-char continuation cells | DONE — paint() keeps the painted region as a cell grid (cells.mjs): commit-free same-width frames rewrite only `changedRows` (CUU/CUD + CR + serializeRow + EL; growth rows via '\n' so the screen bottom still scrolls; surplus rows one `\x1b[0J`), identical frames emit nothing, cost-losing diffs and commit/resize/cleared-screen frames keep the classic erase+redraw |
| Native scrollback via DECSTBM | copy/scroll/select free from the terminal | write finalized lines above a scroll region; per-terminal strategy enum + full-screen fallback | DONE — slice 1: `replayTerminal` bounded oracle; slice 2: pinned writer in createScreen behind `ZAGENT_TUI_SCROLL=pinned` (margin hugs transcript tail, SU/RI grow/shrink, CUP live repaint) + test-screen-pinned oracles; slice 3: `auto` default + TERM/TERM_PROGRAM/ZELLIJ blocklist + journey/probe migration to replayTerminal |
| Contextual hint bar | teach keys in context | idle `Enter:send · Alt+Enter:newline`; during turn `Esc:interrupt · Ctrl+C×2:exit`. NOTE: `Shift+Tab` today only steps queue items — showing a mode hint implies adding a mode-cycle binding | DONE — renderHintBar: one faint row under the status line; idle `enter send · alt+enter newline · ? shortcuts`, busy `esc to interrupt · ctrl+c twice to exit`, armed flips to `esc again`; zh-CN localized; no shift+tab claim until the mode-cycle binding exists |
| Turn-status row | "working vs stuck" must be glanceable | the status line already renders `⠋ working 1.5s` + interrupt hint during a turn | DONE — phase labels + byte counter landed: `waiting` until the first observable model output (any main-turn delta or a scheduled tool call), `responding` after, `⇣`+UTF-8-byte counter beside the interrupt hint (ascii `v`; host-named activities still win; stale host `str` falls back to `working`) |
| Exit summary + resume hint | sessions are resumable objects | auto session title + `zagent --resume <id>`/`zagent -c` hint on exit | DONE — exit() writes a faint `session <title|id>` + `resume: zagent -c · zagent --resume <id>` after teardown, only when a session actually started |
| Timestamps on blocks | audit trail | right-aligned faint per-entry timestamp, config-gated | DONE — `{"tui":{"timestamps":true}}` in `~/.zcode/cli/config.json` stamps each entry right-aligned HH:MM on its first line (last line when the header fills the row; envelope timestamp when the event carries one); a line with no free cell yields rather than clipping |
| "esc interrupt" / error honesty | errors stay in scrollback, never silent | errors as styled transcript lines (mostly true today); codex's silent-quota-death is the anti-pattern — we already differ correctly | DONE in spirit — keep asserting in journeys |

## Cross-cutting oracles (every wave)

- PTY journey asserting the behavior on the fake host (packages/tui/test-journeys*.mjs).
- `screen-replay` grid oracle where the claim is visual.
- Side-by-side capture vs codex/Grok CLI/opencode on the same prompt before the wave
  is called done at release time.
- Honesty invariant: no claim without an oracle; a failed oracle is a finding, not
  a skipped line.

## Explicitly out of scope for this spec

- Not attempted: G11 `!` shell mode, G12 trust prompt, settings slicing (F8).
- GUI-local / cloud-gated surfaces (F3/F5/F6/F7/F12/F14/F16) — deferred.
- Full app-server thin-client split (opencode pattern) — an architecture decision,
  not a conversation-core slice.
