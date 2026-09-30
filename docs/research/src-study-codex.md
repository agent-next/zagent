# src-study: openai/codex `codex-rs/tui` (ratatui + crossterm)

- Source: `https://github.com/openai/codex` shallow clone @ `c51cb968e43fd52255aacf568220aed4654c3f97` (dated 2026-09-15), cloned to a scratch directory, deleted after the study.
- Scope: `codex-rs/tui` (~769 files, ~359k LOC under `src/`), plus `codex-rs/config` for the keymap surface. No live turns; static source only.
- All citations are `path:line` inside `codex-rs/` of that clone.

## 0. Big picture

The Codex TUI is **not** an alt-screen app. It runs an *inline viewport* anchored to the bottom of the
terminal: finalized transcript lines are written **above** the viewport into the terminal's native
scrollback via DEC scroll regions (`tui.rs:425`), and only the "live" region (active streaming cell +
bottom pane) is repainted inside the viewport. Alt-screen is used only for overlays (transcript pager
Ctrl+T, agents dashboard). This is the single most important architectural choice — scrollback,
selection, and native terminal search all come for free.

The loop is a single `tokio::select!` over ~6 sources (`app/startup.rs:1063-1208`):
`app_event_rx` (unbounded mpsc, `app/startup.rs:184`), `active_thread_rx` (per-turn mpsc of
`ServerNotification`s from the embedded/remote app-server), `tui_events.next()` (merged crossterm +
draw-broadcast stream), `app_server.next_event()`, reconnect future, and timer arms (rate-limit poll,
terminal-title refresh, **commit-animation interval**). Redraws are never done inline; everything goes
through a 120 FPS frame-request coalescer.

---

## 1. RENDER LOOP — scheduling, diffing, flicker

- **Frame requests:** `FrameRequester` (clonable handle, `tui/frame_requester.rs:31-57`) sends
  `Instant` deadlines over an unbounded channel to a spawned `FrameScheduler` actor
  (`tui/frame_requester.rs:76-127`). The scheduler keeps `next_deadline = min(requests)` and emits
  exactly one `()` on a `broadcast` channel when it fires — never emits inline, so bursts coalesce
  (`tui/frame_requester.rs:113-116`). Rate-clamped to **120 FPS** (`MIN_FRAME_INTERVAL = 8.33ms`,
  `tui/frame_rate_limiter.rs:13`); a late draw still rate-limits the next one.
- **Draw event delivery:** `TuiEventStream` merges the draw broadcast + crossterm events and polls
  them **round-robin** to avoid starvation (`tui/event_stream.rs:314-336`). A lagged broadcast
  receiver degrades gracefully to `Draw` (`tui/event_stream.rs:251-252`).
- **The draw:** `App::handle_tui_event` on `Draw|Resize|Resume|FocusGained` runs `pre_draw_tick`,
  then `render_chat_widget_frame` → `tui.draw_with_resize_reflow(desired_height, ...)`
  (`app.rs:942-959`, `app.rs:1012-1051`). Desired height = `ChatWidget::desired_height(width)` — the
  viewport grows/shrinks with content, capped at screen height.
- **Flicker avoidance:** the entire draw is wrapped in crossterm `stdout().sync_update` — DEC
  synchronized-output mode 2026 — including pending-history flushes and viewport growth
  (`tui.rs:1002-1078`). Everything the terminal sees for one frame is atomic.
- **Diff:** `CustomTerminal` is a fork of ratatui's `Terminal` with a `viewport_area` sub-rect.
  `diff_buffers` (`custom_terminal.rs:602-711`) does cell-level diff via ratatui `diff_iter`, then
  adds a per-row `ClearToEnd` optimization: it scans each row for the last "meaningful" cell
  (non-space, bg≠trailing-bg, modifier, or `AlwaysUpdate`) and emits one `EL` instead of trailing
  space Puts (`custom_terminal.rs:614-657`). It also repairs the ratatui `ForcedWidth` shrink case
  (styled wide cell getting narrower invalidates covered cells, `:664-698`) and respects
  `Skip`/`AlwaysUpdate` cell diff options. `invalidate_viewport()` marks every cell `AlwaysUpdate`
  for a forced repaint after raw terminal writes (`custom_terminal.rs:525-534`).
- **Resize plumbing:** `SizeMonitor` spawns a 500 ms polling thread *only under tmux* to recover lost
  SIGWINCH notifications (`tui/size_monitor.rs:18-50`); samples wake the draw channel and become
  `TuiEvent::Resize` (`tui/event_stream.rs:286-292`).

## 2. STREAMING — delta flow, throttling, tail behavior

- **Transport:** deltas arrive as `ServerNotification::AgentMessageDelta` /
  `PlanDelta` / `CommandExecutionOutputDelta` on the turn-scoped mpsc and are dispatched in
  `chatwidget/protocol.rs:96-151`. The UI layer never talks raw SSE; the app-server core owns the
  wire protocol.
- **Newline-gated accumulation:** `MarkdownStreamCollector` appends deltas to one raw source string
  and only *commits* source up to the last `\n` (`markdown_stream.rs:87-96`). A delta without a
  newline renders nothing in the stable region — a partial markdown line can change meaning when the
  rest arrives. Unterminated text gets a separate bounded `ProsePreview` (and pending-math preview)
  that never advances the stable boundary (`streaming/controller.rs:141-193`).
- **Two-region model:** each stream splits into a *stable region* (committed lines queued for the
  commit animation, then written to scrollback) and a mutable *tail region* rendered as a transient
  `StreamingAgentTailCell`/`StreamingPlanTailCell` in the active-cell slot
  (`streaming/controller.rs:1-10`, `chatwidget/streaming.rs:590-650`). `sync_active_stream_tail`
  equality-compares the rebuilt tail cell against the current one and returns `false` without
  requesting a redraw when unchanged (`chatwidget/streaming.rs:602-614`) — a cheap no-op redraw
  filter.
- **Commit animation:** when `push()` reports the stable queue changed, the widget sends
  `AppEvent::StartCommitAnimation` (`chatwidget/streaming.rs:572-575`), which installs a
  `tokio::time::interval` at `COMMIT_ANIMATION_TICK = TARGET_FRAME_INTERVAL` = **8.33 ms / 120 Hz**
  (`app.rs:434`, `app/event_dispatch.rs:741-749`, `MissedTickBehavior::Delay`). Each tick drains via
  `run_commit_tick` → `AdaptiveChunkingPolicy` (`streaming/commit_tick.rs:64-80`).
- **Adaptive chunking:** Smooth mode drains **one line per tick** (typewriter pacing); CatchUp mode
  drains the whole queue. Enter catch-up on high queue depth/age, exit on lower thresholds with
  hold windows — hysteresis to avoid flapping (`streaming/chunking.rs:14-78`). An opportunistic
  `CatchUpOnly` tick also runs inline on every delta so backlogs clear between frames
  (`chatwidget/streaming.rs:474-476`).
- **Table holdback:** an incremental scanner detects pipe-table header+delimiter and pins everything
  from the table header onward as mutable tail until finalize, since a new row re-widths all prior
  rows (`streaming/controller.rs:12-20`).
- **Cursor-at-end:** the active cell renders **bottom-anchored** — `TranscriptAreaRenderable` computes
  `overflow = rendered_height - area.height` and `paragraph.scroll(y)` so the newest lines are always
  visible (`chatwidget/rendering.rs:227-251`). There is no user-scrollable main viewport; "scroll up"
  = native terminal scrollback or the Ctrl+T transcript overlay.
- **Finalize:** `flush_answer_stream` re-renders the *full raw source* canonically (never stitches
  transient lines), sends `AppEvent::ConsolidateAgentMessage` to replace the run of streamed cells
  with one source-backed `AgentMarkdownCell` that re-renders on resize, and stops the animation when
  queues are idle (`chatwidget/streaming.rs:86-149`, `streaming/controller.rs:195-213`). Item-completed
  is authoritative — deltas dropped on a saturated transport can't truncate the transcript
  (`chatwidget/streaming.rs:194-196`).
- **Exec output deltas** get a separate bounded accumulator: `LiveCommandOutput` keeps ≤1 MB total;
  beyond that it retains first-50 + last-50 completed lines plus the in-progress line, each line
  capped ~10 KB head/tail (`exec_cell/live_output.rs:5-11,15-16`).

## 3. MARKDOWN — renderer, code chrome, highlighting

- **Parser:** `pulldown-cmark` 0.10 (with `html` feature). `markdown_render.rs` is a hand-rolled
  event→styled-`Line` renderer (2 768 LOC): headings bold/underline/italic tiers, `code` cyan,
  strong/em/strike, light-blue ordered markers, green blockquotes, cyan-underlined links
  (`markdown_render.rs:91-127`).
- **Fences:** fenced blocks with a known language are *buffered* then `highlight_code_to_lines`
  (`markdown_render.rs:658-663,883-897`). No border, no language label, no copy hint — code renders
  as bare highlighted text and deliberately **does not wrap** to preserve copy/paste whitespace
  (`markdown_render.rs:1947`). Indented code gets a 4-space indent span.
- **Syntax highlighting:** `syntect` 5 + `two-face` bundles (~250 languages, 32 embedded themes) in
  `render/highlight.rs`; `SYNTAX_SET` is a `OnceLock` (`:57-70`), theme is swappable for live theme
  preview. Guards: `MAX_HIGHLIGHT_BYTES = 512 KB`, `MAX_HIGHLIGHT_LINES = 10 000`,
  `MAX_HIGHLIGHT_LINE_BYTES = 4 KB` (`render/highlight.rs:585-599`). `StreamingCodeHighlighter` +
  `OpenCodeFence` (`streaming/code_fence.rs:1-60`) is a conservative fast path that incrementally
  highlights the single open trailing fence while streaming — anything ambiguous falls back to the
  canonical pulldown re-render.
- **Tables:** full custom layout — spillover-row filtering, column classification
  (Narrative/TokenHeavy/Compact), iterative width shrinking, `━`/`─` separators, and a key/value
  transpose fallback when columns can't fit (`markdown_render.rs:10-37`). `unwrap_markdown_fences`
  unwraps ```` ```markdown ```` fences that contain tables so pulldown parses them natively
  (`markdown.rs:248`).
- **Extras:** local file links rendered cwd-relative, OSC-8 web hyperlinks on styled text, math
  blocks (`$$`/`\[`), file citations (`markdown_render/` submodules).

## 4. INPUT — events, editor, history, paste, unicode

- **Event source:** one shared `crossterm::event::EventStream` behind `EventBroker`
  (`tui/event_stream.rs:53-124`). Pause/resume **drops and recreates** the stream because a parked
  crossterm reader thread keeps stealing stdin from external programs (spawn-vim problem,
  `tui/event_stream.rs:11-19`). On resume, `tcflush`/Win32 `FlushConsoleInputBuffer` discards buffered
  typeahead (`tui.rs:389-420`). Mouse events are dropped entirely (`tui/event_stream.rs:304`).
- **Terminal capabilities:** bracketed paste + Kitty keyboard enhancement enabled at startup
  (so Shift+Enter etc. disambiguate; `tui.rs:231-251`), with a startup OSC probe for cursor position,
  default colors, and enhancement support (`tui.rs:442-492`). Kitty enhancement is a *stack* —
  pushed/popped so the shell recovers (`tui/keyboard_modes.rs`, restore paths `tui.rs:308-343`).
- **Editor:** hand-rolled `TextArea` (4 619 LOC, `bottom_pane/textarea.rs`) — single `String`,
  grapheme-cluster cursor movement via `unicode_segmentation::GraphemeCursor`
  (`textarea.rs:1881-1907`), width-cached wrapped-line index (`textarea.rs:2051-2069`), plus a full
  optional **vim mode** (normal/insert/operator-pending/text-objects/search —
  `bottom_pane/textarea/vim*.rs`). `chat_composer.rs` (13k LOC) layers submit-keys, `!` shell mode,
  @-mentions, image attachments, and `BottomPaneView` popups on top.
- **CJK/width:** `unicode_width` everywhere; `char_width` special-cases halfwidth sound marks
  U+FF9E/FF9F as width 1 to match ratatui/terminal cell semantics (`width.rs:19-34`).
- **Paste:** two paths. (a) Bracketed-paste `Event::Paste` → CRLF/CR normalized to LF →
  `handle_paste` (`app.rs:924-941`). (b) Unbracketed **paste-burst detection** (`PasteBurst` state
  machine, `bottom_pane/paste_burst.rs`): plain chars arriving <8 ms apart, ≥3 chars → buffered and
  flushed as one paste after ~60 ms idle (Windows; 8 ms on unix — paste_burst.rs:167-170 is cfg-gated); first ASCII char held ≤8 ms for flicker suppression;
  retro-capture pulls already-inserted prefix back out of the textarea when a stream is reclassified;
  Enter inside a burst window (120 ms) inserts newline instead of submitting
  (`paste_burst.rs:159-170`). Pastes >1000 chars collapse to an atomic `[Pasted Content N chars]`
  placeholder element stored in `pending_pastes` (`chat_composer.rs:372,1989-1990`). Pasted file
  paths that look like images become attachments instead of text.
- **History:** `ChatComposerHistory` merges a persistent cross-session log with local in-session
  entries; Up/Down fetch persistent entries lazily per-entry, Ctrl+R incremental search switches to
  bounded *batches* and dedups within a session; stale log IDs are rejected
  (`bottom_pane/chat_composer_history.rs:1-22,127-160`).
- **Keymap:** fully declarative — actions named per context
  (`Global/Chat/Composer/Editor/Vim*/Pager/List/Agents/Approval`, `keymap/bindings.rs:250-320`),
  parsed from `tui_keymap` config with aliases (`escape`→`esc`), chord support, and conflict
  detection that reserves plain `esc` as chord-cancel (`config/src/tui_keymap.rs`,
  `keymap/chords.rs:489-491`).
- **Input routing:** `BottomPane` gives an active view first shot at Ctrl+C (dismiss), then history
  search (cancel), then `ChatWidget` may interrupt (`bottom_pane/mod.rs:7-16`). `interrupt_turn` is a
  chat-context action → `AppCommand::interrupt()` (`chatwidget/interaction.rs:46-56`). Ctrl+Z is a
  real Unix suspend with cursor-y bookkeeping for correct `fg` resume
  (`tui/job_control.rs:25`, `tui.rs:358-362`).

## 5. TOOL/CALL DISPLAY — inline cells

- **Model:** everything in the transcript is a `HistoryCell` (`history_cell/mod.rs:187-256`):
  `display_lines(width)` for the live view, `transcript_lines(width)` for the pager/export,
  `desired_height`, downcast `as_any`. Cells are `Arc`'d and cheap to retain.
- **Exec:** `ExecCell` (`exec_cell/model.rs`) groups calls by `call_id`. Read/List/Search calls merge
  into an **"Exploring/Explored"** group that collapses consecutive reads into
  `Read a, b, c` (`exec_cell/render.rs:255-350`). Single commands render
  `• Running|Ran|You ran $ <bash-highlighted cmd>` (magenta `$`, syntect bash highlight), output
  under a `"  │ "` gutter, wrapped *then* truncated head+tail with
  `… +N lines (ctrl + t to view transcript)` (`exec_cell/render.rs:352-497,247-253`). Display caps:
  `TOOL_CALL_MAX_LINES = 5` rows, user shell = 50 (`exec_cell/render.rs:33-34`). Success `•` green /
  failure red; transcript mode appends `✓/✗ • duration` and full output (`:195-239`).
- **MCP:** `• Calling|Called server.tool(args)`; compact Node-REPL variant shows title cyan; results
  dimmed under `  └ `/`    ` tree prefix, `TOOL_CALL_MAX_LINES`-truncated
  (`history_cell/mcp.rs:147-299`).
- **Approval/updates** are modal `BottomPaneView`s, not history; completed flows commit summary cells.
- **`replace_visible_history_tail`** can rewrite already-committed rows still visible above the
  viewport so a finalized cell can update its own just-committed tail without a full reflow
  (`tui/history_tail.rs:15-43`).

## 6. SCROLLBACK — viewport & long sessions

- **Native scrollback is the buffer.** `insert_history_*` writes wrapped `HyperlinkLine`s above the
  viewport: Standard mode sets DECSTBM `[viewport_top..screen_bottom)` and emits `\x1bM` (reverse
  index) to push the viewport down, then a `[1..viewport_top)` region where `\r\n` + line writes
  scroll content into history, all cursor-position-neutral (`insert_history.rs:165-217`, diagram
  `:188-202`). Zellij uses `scroll_region_up`; Windows Terminal and some paths use a full-screen
  print+scroll (`tui/scrollback.rs:19-103`).
- **Wrap policy:** `PreWrap` re-wraps lines before committing, except URL-only lines are left intact
  so terminals keep link detection; `Terminal` (raw-output mode) lets the emulator soft-wrap
  (`insert_history.rs:120-131,230-267`, `app/resize_reflow.rs:228-234`).
- **Pending batching:** `insert_history_lines` only accumulates `pending_history_lines` and schedules
  a frame; the write happens inside the next synchronized draw (`tui.rs:897-929,1054-1059`).
- **Resize reflow:** terminal scrollback is *repaired*, not tolerated — `TranscriptReflowState`
  debounces 75 ms after the last resize, then `reflow_transcript_now` clears Codex-owned scrollback +
  screen and re-emits all retained cells at the new width (`transcript_reflow.rs:18`,
  `app/resize_reflow.rs:421-514`). Per-terminal caps bound the rebuild: VS Code 1 000 rows, WezTerm
  3 500, Windows Terminal 9 001, Alacritty 10 000 (`resize_reflow_cap.rs:19-22`); underfilled
  scrollback tops up from paginated session history (`app/resize_reflow.rs:517-534`). Reflows that
  run mid-stream flag `ran_during_stream` so consolidation forces one final source-backed rebuild
  (`transcript_reflow.rs:138-167`).
- **Very long sessions:** resume replay buffers rendered lines and keeps only the newest
  `max_rows` (oldest dropped, mirroring real terminal scrollback) with a truncation notice
  (`app/resize_reflow.rs:124-189,236-251`). The Ctrl+T pager overlay renders the full retained cell
  list with scroll, on alt-screen (`pager_overlay.rs:1-18`).

## 7. ARCHITECTURE — tree, ownership, update loop

- **Pattern:** single-writer actor loop. All state lives in `App` + `ChatWidget`; side-tasks
  communicate *inward* only via `AppEvent` on one unbounded mpsc (`AppEventSender` wrapper also logs
  events for session replay, `app_event_sender.rs:23-44`). No shared mutable widget state; no
  locks in the render path.
- **Immediate-mode retained-cells hybrid:** widgets don't paint themselves — `Renderable` is a pure
  `render(area, buf) + desired_height(width)` interface with optional `render_scrolled` fast path and
  `cursor_pos/cursor_style` for hardware cursor placement (`render/renderable.rs:16-32`). Layout is
  Flutter-style: `FlexRenderable` column with flex factors (`render/renderable.rs:272-405`). The chat
  frame = flex column: active cell + pending/live transcript cells at flex 1, `BottomPane` pinned at
  flex 0 with a 1-row top inset (`chatwidget/rendering.rs:122-205`).
- **Height-driven viewport:** `App` asks the widget its desired height, grows the inline viewport to
  it (scrolling scrollback up when needed), renders, then places the cursor where the widget asked
  (`app.rs:1012-1051`, `tui.rs:1028-1077`).
- **Cell caches:** transient cells can declare `has_stable_transcript_height()`; the renderable then
  caches desired/rendered height keyed by (cell identity, revision, width, render mode, theme rev)
  (`chatwidget/rendering.rs:147-155,271-294`). The transcript overlay caches the live tail on
  `(width, active-cell revision, continuation flag, animation tick)` (`pager_overlay.rs:8-18`).
- **Interrupt ordering:** stream lifecycle events are queued in `InterruptManager` while a stream
  controller is active and flushed FIFO at stream end so ExecEnd can never precede its ExecBegin
  (`chatwidget/streaming.rs:512-543`).
- **State handoff for external programs:** `with_restored` drops the event stream, restores cooked
  mode + stderr, runs the program, re-arms modes, flushes stdin, and schedules a size recheck
  (`tui.rs:754-794`).

---

## RECOMMENDATIONS — porting to a hand-rolled Node TUI

| Capability | Why | How it ports to a hand-rolled Node TUI |
|---|---|---|
| Inline viewport + native scrollback via DECSTBM | Zero scrollback machinery: copy/scroll/search/select all free from the terminal; the viewport only repaints a small live region | Write finalized lines *above* the live region: `CSI <top>;<bottom> r` scroll region + `\r\n` writes, or reverse-index `ESC M` to push the viewport down when it's not bottom-pinned. All ANSI you already emit. Guard: zellij/Windows Terminal need full-screen-print fallback — keep a per-terminal strategy enum (Codex: `scrollback.rs:19-37`). |
| Frame-request coalescer at 120 FPS | Deltas/animations request redraws from many places; naive immediate repaint = flicker + CPU | One `scheduleFrame(at?)`: collapse to `min(pending)` deadlines on a `setTimeout`/`setImmediate` chain, emit one "draw" event on your event bus. ~80 lines. (`frame_requester.rs:96-127`). |
| DEC 2026 synchronized-update wrap per frame | Eliminates partial-frame tearing during scroll-region writes + repaints | `sync_update` is `ESC[?2026h` … `ESC[?2026l` around the whole frame write. Trivial to emit; degrade gracefully if unsupported (Codex just writes anyway — it's ignored). |
| Cell-buffer diff + ClearToEnd row scan | Bandwidth and flicker: rewrite only changed cells; one `EL` beats N space writes | Keep `prev`/`next` `Cell[][]` (char,fg,bg,attrs,wide-flag). Diff rows, then for each row emit `ClearToEnd` from last-nonblank. Codex's scan rule (non-space OR bg≠trailing OR modifier OR force) at `custom_terminal.rs:614-657` is directly portable. Handle wcwidth wide-char continuation cells — the ForcedWidth repair loop `:664-698` is the subtle part. |
| Newline-gated streaming + tail cell | Renders markdown only at line boundaries; unterminated partial syntax never flashes malformed | Accumulate raw deltas in a string; on each `\n` commit `src[..last_nl]` through the markdown renderer; render the pending tail line separately in the active cell (`markdown_stream.rs:87-96`, `chatwidget/streaming.rs:590-650`). Equality-check the rebuilt tail before requesting a draw. |
| Commit-animation queue (typewriter) | Perceptual pacing: stable lines appear 1-per-tick at 120 Hz; backlog auto-catches-up | FIFO of rendered lines + a ~8 ms interval. Smooth=1 line/tick; if queue depth or oldest-age crosses thresholds, drain all (CatchUp). Hysteresis windows prevent mode chatter (`streaming/chunking.rs`). Cheap and feels *very* polished. |
| Table holdback | A streamed table row re-widths all prior rows — committing it early flickers | Scan committed source for `|…|\n|---|`; once seen, pin everything from the header into the mutable tail until stream finalize (`streaming/controller.rs:12-20`). ~100 lines. |
| Bottom-anchored active cell | "Cursor at end" with no scroll state: active content always shows its tail | Active cell = last flex child above the pinned input pane; render `lines[overflow..]` where `overflow = height - area.height` (`chatwidget/rendering.rs:227-251`). |
| `HistoryCell` interface (display_lines / transcript_lines / desired_height) | One abstraction for messages, exec calls, diffs, notices; enables resize reflow + pager export for free | Each transcript item keeps its *source* (markdown/cmd/result) and renders lines at a given width. Transcript variant emits full content; display variant truncates. This is what makes resize reflow and Ctrl+T trivial (`history_cell/mod.rs:187-256`). |
| Resize reflow (rebuild scrollback) | Width changes corrupt pre-wrapped scrollback; Codex clears its own region and replays cells at new width, debounced 75 ms | Track which screen region you own; on settled resize clear it and re-emit `display_lines(new_width)` for retained cells, capped per-terminal (1k–10k rows). High effort — a v2 feature; the *cell-source-of-truth* model is the prerequisite worth taking now. |
| Paste-burst state machine | Windows/non-bracketed terminals deliver pastes as char floods; without it, `?` toggles popups and Enter submits mid-paste | Time-keyed heuristic: plain chars <8 ms apart, ≥3 → buffer, flush as paste after ~60 ms idle; suppress Enter→submit inside the window; retro-capture the already-inserted prefix. All implementable on `readline`-free raw key events (`paste_burst.rs`). |
| Large-paste placeholder `[Pasted Content N chars]` | Keeps composer readable; paste is atomic element that delete removes in one shot | If paste >1000 chars, insert placeholder token + store text in side table; expand at submit (`chat_composer.rs:372,1989`). |
| `EventBroker` pause/resume | A parked stdin reader steals keys from external editors (vim) and eats OSC replies | In Node: keep one `readline`/raw parser you can `.pause()`/`unpipe` + `tcflush`-equivalent (drain `process.stdin`) before handing the terminal to a child (`tui/event_stream.rs:11-19`). |
| Desired-height flex layout | The input pane grows with content; transcript area takes the rest | `desiredHeight(width)` + `render(rect,buf)` protocol with a vertical flex stack — trivially portable; no ratatui needed. |
| Keyboard-enhancement probe (Kitty flags) | Shift+Enter/Ctrl+letter disambiguation for multiline submit | Push `CSI > flags u` at startup with a probe + fallback; pop on exit. Optional; Node fallback is Shift/Ctrl-Enter often indistinguishable without it. |
| Grouped "Exploring" exec cell | Collapses read/list/search spam into `• Explored … Read a, b, c` | Semantic classification of tool calls → one cell; port the renderer pattern not the Rust types (`exec_cell/render.rs:255-350`). |
| Per-line live-output head/tail truncation | Bounded memory + bounded repaint for chatty tools | Ring: first 50 + last 50 lines, ≤1 MB, per-line ~10 KB head/tail split (`exec_cell/live_output.rs:5-16`). |
| AppEvent single-channel inbox | One queue = deterministic ordering, replayable session log | Node: one `EventEmitter`/queue for all async→UI messages (deltas, timers, child proc exits); the loop `select`s on it plus stdin and draw events. Matches Node's natural single-threaded model. |

### Notes / gotchas for a Node port
- crossterm/ratatui equivalents don't exist off-the-shelf: you'll need `wcwidth`-correct cell buffers
  (use `string-width`-style logic but with the U+FF9E/FF9F halfwidth-mark fix, `width.rs:19-34`) and
  grapheme-cluster cursor steps (`Intl.Segmenter` covers `unicode-segmentation` well).
- syntect parity isn't portable; `shiki` (TextMate grammars, same lineage) or `highlight.js` covers
  the common case. Keep the byte/line caps.
- pulldown-cmark → `marked`+custom renderer or `mdast`/`remark` for a structured event stream; the
  newline-gated *commit boundary* matters more than parser choice.
- The 120 Hz commit tick is cheap in Rust; in Node use a single `setInterval(8)` gate — fine, since
  the queue drain is O(lines), but don't tie it to `setImmediate` or you'll starve under paste floods.
