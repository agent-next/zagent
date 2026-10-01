# SRC-STUDY — opencode TUI (source level)

- Target: `sst/opencode` @ `e03db9bc` (dev branch, cloned 2026-09-15, `--depth 1`, deleted after study)
- TUI version in-tree: `@opencode-ai/tui` 1.18.31 (`packages/tui/package.json`)
- Method: read-only source study of the clone. Cross-checked against the
  prior live-PTY study `tui-study-opencode.md` (opencode 1.17.11) — behaviors observed
  there map 1:1 onto the source paths cited below.
- No live turns consumed.

## Stack verdict

The TUI is **TypeScript/TSX on OpenTUI + SolidJS**, running on **Bun** — not Go, not Ink.

- `packages/tui/package.json` deps: `@opentui/core`, `@opentui/solid`, `@opentui/keymap`,
  `opentui-spinner`, `solid-js` (catalog-pinned to 0.4.5 / 0.0.7).
- `@opentui/core` 0.4.5 ships per-platform **native binaries**
  (`@opentui/core-{darwin,linux,win32}-{x64,arm64}[-musl]`, `bun.lock:2045-2059`) — a native render
  core (the opentui project is sst's own Zig-backed renderer); TS is only the component/API layer.
- App entry builds a `CliRenderer` then mounts a Solid tree
  (`packages/tui/src/app.tsx:194-206` renderer config, `:245-351` `render(() => <providers>)`).
- The monorepo also has `packages/session-ui` (Solid DOM components for the web/desktop app) and
  `packages/app` — separate from the TUI; do not confuse the two when citing behavior.

## 1. RENDER LOOP — how it draws during streaming

- **Retained-mode tree, event-driven invalidation.** Solid components build a renderable tree
  (`<box>`, `<text>`, `<scrollbox>`, `<textarea>`, `<markdown>`, `<code>`, `<diff>`,
  `<line_number>`, `<spinner>`). Nothing redraws on a timer; repaints are triggered by store
  updates flowing through Solid reactivity into the native core, which owns layout + framebuffer
  diff. This matches the PTY finding "zero frames while idle".
- **`targetFps: 60`** caps the internal frame pump (`app.tsx:196`).
- **Data-side pacing = 16 ms event batches.** SSE events are queued and flushed inside Solid's
  `batch()` at most once per 16 ms (`context/sdk.tsx:48-80`):
  `if elapsed < 16 → setTimeout(flush, 16) else flush()`. Comment at `:60`: "Batch all event
  emissions so all store updates result in a single render". This is the real throttle: bursts of
  provider deltas coalesce into one render pass — the ~25 fps median paint rate seen in the PTY
  study falls out of this + render cost, not an explicit UI throttle.
- **Fine-grained updates, not full re-render.** `setStore(path, index, reconcile(obj))` updates
  only changed leaves (`context/sync.tsx:330,385`); `message.part.delta` mutates one string field
  (`sync.tsx:398-415`). Only the affected `<markdown>`/`<text>` renderable re-lays-out.
- **Manual invalidation escape hatch:** `input.getLayoutNode().markDirty()` +
  `renderer.requestRender()` after async inserts the renderer can't observe
  (`component/prompt/index.tsx:241-247`, `:1217-1221`; `editor.ts:52`).
- **Pre-mount warmup:** palette fetch + `renderer.waitForThemeMode(1000)` before `render()` to
  avoid a first-paint theme flash (`app.tsx:240-243`).
- `useKittyKeyboard: {}` enables the kitty CSI-u protocol (`app.tsx:199`) — this is how
  Shift+Enter/Ctrl+I etc. are distinguishable.
- `externalOutputMode: "passthrough"`, `useMouse` (config-gated), `exitOnCtrlC: false`
  (`app.tsx:195-202`).

## 2. STREAMING — provider → screen

Pipeline: provider stream → server processor → global event bus → SSE → client queue → Solid store → renderables.

- **Server side** (`packages/opencode/src/session/processor.ts`): provider `text-delta` /
  `reasoning-delta` events accumulate into the in-memory part and publish
  `session.updatePartDelta({sessionID, messageID, partID, field, delta})`
  (`processor.ts:513-523`, `:294-305`). `updatePartDelta` just publishes
  `MessageV2.Event.PartDelta` on the event bus (`session/session.ts:877-885`). Whole-part
  lifecycle (`text-start/end`, tool state changes) goes through `updatePart` →
  `message.part.updated`. Orphan deltas are silently dropped (`processor.ts:296`, `:514`).
- **Event shape** (`sdk/js/src/v2/gen/types.gen.ts:5306-5325`):
  `{ sessionID, messageID, partID, field, delta }` plus optional `durable.seq` for ordering.
- **Transport:** one SSE stream `sdk.global.event` (`context/sdk.tsx:82-117`) carrying all event
  types for all sessions; reconnect = exponential backoff 1 s → 30 s cap (`:107-115`). An
  `EventSource` can alternatively be injected (`sdk.tsx:7-9,120-122`).
- **Client reducer:** single `event.subscribe` switch in `context/sync.tsx:176-446`.
  - `message.part.delta` → binary-search the part array, `part[field] += delta` (`:398-415`).
  - `message.part.updated`/`message.updated` → sorted-insert via binary search
    (`search()`, `:41-52`; keys `:54-58`) then `reconcile()` — out-of-order arrivals land in the
    right slot rather than appending.
  - **Reorder correctness** comes from sorted insert + `durable.seq` on the wire; **backpressure**
    is the 16 ms queue + `batch()` (above) — the store is the buffer, SSE just keeps feeding it.
- **Hydration/merge:** `session.sync(id)` fetches `session.messages({limit:100})` and merges
  with streamed state — tracker sets (`hydratingSessions`, `sync.tsx:152-158,598-653`) keep
  in-flight delta-built parts from being clobbered by the REST snapshot, including a guard for
  empty-snapshot-text vs streamed-text (`:637-645`).

## 3. MARKDOWN + syntax highlighting

- **Renderer:** OpenTUI's built-in `<markdown>` renderable (opentui depends on `marked@17`,
  `bun.lock:6075`) used with `streaming={true}` — incremental re-parse per delta —
  `internalBlockMode="top-level"`, `conceal`, `tableOptions={{style:"grid"}}`
  (`routes/session/index.tsx:1692-1701`). Reasoning renders through `<code filetype="markdown">`
  instead (`:1635-1643`).
- **Highlighting:** tree-sitter. `addDefaultParsers(parsers.parsers)` at `:85`; markdown/JS/TS are
  opentui built-ins (`parsers-config.ts:2`), ~35 more languages are declared as remote WASM
  parser URLs + nvim-treesitter `.scm` query URLs (`parsers-config.ts:6-385`) — fetched/cached at
  runtime, not bundled.
- **Theme→scope mapping:** `SyntaxStyle.fromTheme(getSyntaxRules(theme))`
  (`theme/index.ts:556-558`); `generateSubtleSyntax` (`:560-584`) dims every scope's fg alpha by
  `theme.thinkingOpacity` — that's the "dimmed reasoning" look.
- **Code-block chrome: none.** `<markdown>` gets only `fg`/`bg` — no borders, no language label,
  matching the PTY finding (borderless, indented only). Real chrome lives on tool blocks
  (`BlockTool`, below) and diffs.
- **Diffs:** first-class `<diff>` renderable — unified vs side-by-side `view` chosen by width
  (>120 cols → "split", `session/index.tsx:2395-2399,2411-2429`), line numbers, per-hunk bg
  colors, word wrap mode from config.

## 4. INPUT — multiline, history, IME/CJK, paste

- **Widget:** OpenTUI `TextareaRenderable` (`component/prompt/index.tsx:1369-1443`) — multiline
  editing, `minHeight 1`, `maxHeight ≈ height/3` (`:1345`), placeholder hints, `syntaxStyle` for
  extmark styling. Kitty keyboard gives Shift+Enter as newline.
- **Chips via extmarks (the big idea):** pasted/attached content is inserted as *virtual text*
  (`input.extmarks.create({virtual:true, styleId, typeId})`) — the buffer shows `[Pasted ~N
  lines]`, `[Image 1]`, `[PDF 1]`, `@file`, `@agent` chips while a `extmarkToPartIndex` map keeps
  the real payload in `prompt.parts` (`:1149-1181`, `:1224-1269`, `:1427-1429`). On submit,
  `expandTrackedPastedText` splices real text back in over the chip offsets
  (`:1026-1034`; `prompt/part.ts:24-29` — sorts desc by start so splices don't shift offsets).
  Copy-out expands chips too via `getClipboardText` override (`:1424`).
- **Paste:** `onPaste` → `decodePasteBytes` (bracketed paste), CRLF/CR normalization
  (`:1396-1420`); `pasteInputText` (`:1183-1222`): existing file path → attachment chip; ≥3 lines
  or >150 chars → `[Pasted ~N lines]` chip (KV-toggleable `paste_summary_enabled`); else inline
  insert. Image/PDF clipboard → base64 `file` part.
- **History:** JSONL at `state/prompt-history.jsonl`, 50 entries, append-dedup
  (`prompt/history.tsx:27-47,85-108`). `move()` refuses to clobber a non-empty draft that isn't
  the current history entry (`:69-84`); Up/Down bindings only fire when the cursor is already at
  buffer start/end — inside a multiline draft they navigate rows instead
  (`prompt/index.tsx:874-927`). This is the source of the PTY-observed "Up recalls only when
  empty".
- **Draft safety:** `clearPrompt` archives drafts ≥20 chars into history before wiping
  (`:1272-1286`); a full stash push/pop/list exists (`:736-794`); Esc never clears (it's the
  interrupt/dialog key — below).
- **IME/CJK:** offsets are grapheme-aware — `Intl.Segmenter` + `Bun.stringWidth` (wcwidth-style,
  CJK=2) translate between text offsets and display cells for extmark placement
  (`prompt/display.ts:1-10`). IME race documented: `onSubmit` defers twice so the last composed
  hangul flushes to `plainText` before reading (`:1391-1395`, `:950-956`).
- **Interrupt:** armed-confirm double-Esc — `session.interrupt` increments a counter, `>= 2` →
  `sdk.client.session.abort`, counter auto-resets after 5 s (`:394-421`); footer hint flips
  `esc interrupt` → `esc again to interrupt` (`:1587-1591`). Esc in shell mode exits the mode
  first (`:402-405`).
- **Modes/keymap:** `@opentui/keymap` command+mode stack (`keymap.tsx:20-90`) with addons for
  textarea layer, leader key, pending-sequence handling (`:3-9`); `!` at offset 0 enters shell
  mode, `esc`/`backspace` exits (`:830-858`); `/` and `@` trigger the `Autocomplete` overlay
  (`component/prompt/autocomplete.tsx`) — fuzzysort-filtered slash commands and file/agent
  mentions that also insert extmark chips.

## 5. TOOL DISPLAY

- **Dispatch:** `ToolPart` → `toolDisplay()` whitelist → per-tool component, `GenericTool`
  fallback (`session/index.tsx:1709-1789`, `:2626-2645`).
- **Two visual tiers:**
  - `InlineTool`/`InlineToolRow` — one muted line: icon + `Tool args` + optional `(N matches)`;
    spinner while running; error state expands the message on click; denied → strikethrough
    (`:1836-1992`). Read/Glob/Grep/WebFetch/WebSearch/Skill/Question-summary use this.
  - `BlockTool` — left-border panel on `backgroundPanel` with `# Title` header (`:1994-2044`):
    Shell (`$ cmd` + stdout), Write (line-numbered highlighted code), Edit/ApplyPatch (`<diff>`),
    TodoWrite, Question, GenericTool-with-output.
- **Truncation:** `collapseToolOutput(output, maxLines, maxChars)` — Shell caps at 10 lines,
  generic tools at 3, chars budget `maxLines × (width-6)`; overflow appends `…` and makes the
  block click-to-expand (`util/collapse-tool-output.ts:1-19`; Shell `:2052-2059`; GenericTool
  `:1802-1809`). `showDetails` KV toggle hides all *completed* tool rows (`:1713-1718`);
  `showGenericToolOutput` gates generic-tool bodies (`:1812-1819`).
- **Running state:** `$ command` swaps to a `Spinner` line while `state.status === "running"`
  (`:2084-2086`); `Task` (subagent) streams its children's current tool as `↳ Tool title` and
  click-navigates into the child session (`:2237-2311`); `execute` streams nested calls via
  `metadata.toolCalls` (`:2330-2388`).
- **Reasoning:** `ReasoningPart` — spinner `Thinking` (live title via `reasoningSummary`) →
  `Thought: title · Ns`; in "hide" thinking-mode it collapses to one clickable line that never
  shifts layout (`:1586-1684`).
- **Assistant footer:** `▣ agent · model · duration` after the last part (`:1548-1570`).
- **Spacing heuristic:** `alwaysSeparate` WeakSet + `setPreLayoutSiblingMargin` inserts a blank
  row only between blocks that need it (multi-line blocks, panels) — keeps inline tool rows
  visually dense (`:94`, `:1939-1947`).

## 6. COMPONENT ARCHITECTURE + scrollback

- **Providers:** ~20 nested context providers (exit, route, sdk, sync, theme, keymap, dialog,
  toast, kv, prompt-history/stash, plugin runtime…) — `app.tsx:245-351`. Routes: `home`
  (centered max-width hero prompt, `routes/home.tsx:72-81`) → `session` (full-width).
- **Session layout** (`session/index.tsx:1177-1362`): row → `<scrollbox>` transcript |
  collapsible `<Sidebar>` (auto when width>120, `:270-278`); below the scrollbox: permission /
  question prompts, then the `<Prompt>` (wrapped in a replaceable `pluginRuntime.Slot`,
  `:1313-1332`). `<Toast>` floats top-right (`:1336`); dialogs are a z-index-3000 centered stack
  with backdrop (`ui/dialog.tsx:28-66`, stack store `:69-80`).
- **Transcript:** `<scrollbox stickyScroll stickyStart="bottom" scrollAcceleration>` over
  `<For each={messages()}>` (`:1180-1294`) — auto-follows at bottom, holds position when scrolled
  up; `toBottom()` = deferred `scrollTo(scrollHeight)` (`:423-428`). Scroll keys: line/1/4-page,
  page, message-jump via `getChildren()` y-positions (`:377-421`, `:757-827`); mouse-wheel speed
  via `ScrollAcceleration` impl (`util/scroll.ts`).
- **10k+ line behavior:** there is **no app-level windowing/virtualization** — every message is a
  retained renderable. Boundedness comes from the data layer instead: **hard cap of the last 100
  messages per session** (`sync.tsx:341-358` drop-oldest on append; `:603,625-626` `limit:100` /
  `slice(-100)` on hydrate) plus output-collapsed tool blocks. Whether ScrollBox internally skips
  off-screen paint is inside `@opentui/core` (native, not in this repo) — but the 100-message cap
  is the real invariant.
- **Selection/copy:** `renderer.getSelection()` guards click handlers so text-select doesn't
  trigger message/tool clicks (`:1271`, `:1900-1906`); `externalOutputMode:"passthrough"` +
  optional copy-on-select interception (`app.tsx:424-448`).

## RECOMMENDATIONS for zagent's conversation-core

| capability | why it matters | concrete how (→ hand-rolled Node TUI) |
| --- | --- | --- |
| 16 ms event batching before render | bursts of deltas → one paint; this is the ~25 fps feel without a frame scheduler | queue inbound deltas; flush via `setTimeout(16)` when last flush <16 ms ago; apply all mutations then render once. Ports 1:1 — plain `setTimeout` + a dirty flag (sdk.tsx:48-80) |
| Delta events `{partID, field, delta}` separate from whole-part updates | tiny deltas keep renders cheap; full objects only at lifecycle boundaries | model transcript as `Map<msgID, parts[]>`; text append mutates a string in place; emit `part.updated` snapshots only at start/end/tool-state change (processor.ts:513-523; sync.tsx:398-415) |
| Sorted-insert + reconcile, not append | SSE/PTY replays can arrive out of order; must land mid-list | keep arrays sorted by (created, id); binary-search insert; diff-merge objects instead of replace (sync.tsx:41-58, 328-339) |
| In-place string accumulation per part | render cost ∝ changed region, not transcript size | store text per part; render path redraws only the affected block — for a hand-rolled TUI: mark block dirty, recompute only its row range (sync.tsx:404-412) |
| Streaming markdown re-parse | partial markdown (`**bol`) must render sanely mid-stream | parse incrementally per delta-batch, not per byte; tolerate unclosed constructs (treat trailing unclosed `**`/``` as literal until closed). `marked`+regex styles or `markdown-it` port fine; `streaming` flag equivalent = re-render block on each batch flush (session/index.tsx:1694) |
| Theme-driven syntax scopes, dimmed variant for reasoning | one palette drives both code and CoT dimming | map ~10 scope classes (keyword/string/number/fn/comment…) to theme colors; reasoning = same palette at ~40% alpha. Avoid full tree-sitter; a tokenizer (e.g. `highlight.js` core or a small regex set per language) covers the same visual ground (theme/index.ts:556-584) |
| Borderless code, chrome on tool blocks only | transcript stays calm; tools get the visual weight | code: indent + highlight only. Tools: left `┃` gutter + panel bg + `# Title`. Cheap to hand-roll (BlockTool session/index.tsx:1994-2044) |
| Split diff >120 cols, unified below | side-by-side diffs are a big UX win at wide terms | width check at render time; for v1 ship unified + filetype coloring, add split later (session/index.tsx:2395-2399) |
| Extmark chips for paste/attachments | multi-line paste must not flood the input line | chip model = `{start,end,virtualText,payload}` list over a plain string buffer; render chips styled; expand on submit/copy. Ports directly — it's just a decorated-range list (prompt/index.tsx:1149-1181; part.ts:24-29) |
| Paste normalization + threshold | CRLF from ConPTY, empty image pastes, file paths | normalize `\r\n`/`\r` at boundary; if text is an existing path → attach; ≥3 lines or >150 chars → chip; else inline (prompt/index.tsx:1183-1222) |
| Up-history only at buffer start | never clobber a half-typed multi-line draft | if cursor not at offset 0 → move cursor to top, don't recall; if input non-empty and ≠ current entry → refuse (prompt/index.tsx:874-887; history.tsx:69-84) |
| JSONL prompt history (50 entries) | survives restarts, self-heals corrupt lines | append JSONL per submit; parse-defensively on load; rewrite to enforce cap (history.tsx:29-60) |
| Draft retention ≥20 chars on clear | `ctrl+u`/`esc`-ish clears shouldn't lose real drafts | before wiping input, push to history if length ≥ threshold (prompt/index.tsx:1272-1286) |
| Double-Esc armed interrupt (5 s window) | one stray Esc must not kill a turn; also fixes zagent's alt+letter orphan-Esc bug | counter + timestamp; first Esc → hint "esc again"; second within window → abort. Shell-mode Esc exits mode first (prompt/index.tsx:394-421) |
| IME double-defer on submit | last composed CJK char must flush before submit | `setTimeout(() => setTimeout(submit))` or `setImmediate` twice; read buffer not cached store value (prompt/index.tsx:1391-1395) |
| Grapheme/wcwidth-aware offsets | CJK/emoji caret + chip offsets must count cells not UTF-16 units | `Intl.Segmenter` for graphemes + `string-width` for cell width; keep a display-offset↔string-index mapper (prompt/display.ts:1-10) |
| One-line tool chips + click/key expand, hide-completed toggle | transcript scannability at 50+ tool calls | default: `→ Read f.ts` one-liner w/ result count; bash gets output block capped 10 lines + `…` expander; a global "hide completed" filter (session/index.tsx:1836-1992, 1713-1718; collapse-tool-output.ts) |
| Reasoning: spinner → `Thought: title · Ns`, collapsible | proves liveness; lets users collapse CoT | spinner line while `time.end` unset; on end swap to one-line summary (first sentence as title); key/click toggles body; dimmed style (session/index.tsx:1586-1684) |
| sticky-bottom scroll + hold position when scrolled up | streaming must follow unless user scrolled | autoscroll only if viewport is at bottom before append; else keep offset + optional "new below" hint (scrollbox `stickyScroll` session/index.tsx:1193) |
| Hard cap on retained messages (100) + collapse bodies | bounds memory/render without virtualizing | cap messages/session; drop oldest + its parts; rely on collapsed outputs. For 10k-line sessions also cap *lines per block* at render (sync.tsx:341-358, 603-656) |
| Two notification tiers: modal stack vs corner toast | blocking decisions vs passive info | dialog stack (one-at-a-time, backdrop) for permission/confirm; non-blocking top-right toast for notices/errors (ui/dialog.tsx:28-80; toast in session/index.tsx:1336) |
| Status line: spinner + `esc interrupt`, context meter, agent·model·cost | real-time liveness + budget awareness | bottom row: animated spinner + interrupt hint during turns; `tokens (pct%)` from last assistant usage; `▣ agent · model · Ns` turn footer (prompt/index.tsx:1513-1690, 264-282; session/index.tsx:1548-1570) |
| Injectable event source + SSE reconnect w/ backoff | TUI can run against local server or embedded feed | abstract `subscribe(handler)` behind an interface; exponential backoff 1→30 s on stream drop (sdk.tsx:82-117) |
| Submit re-entrancy guard | double-Enter raced `session.create` → phantom empty prompt | `submitting` boolean around async submit; clear input *after* dispatch (prompt/index.tsx:930-945) |
| Selection-aware click guards | mouse select must not trigger message/tool actions | check "is a selection active" before treating mouseup as click (session/index.tsx:1900-1906) |
| Manual dirty-marking escape hatch | async inserts invisible to the reactive graph | expose `markDirty()`/`requestRender()` for post-await DOM mutations (prompt/index.tsx:1217-1221) |

## Notable extras worth knowing

- **Undo/redo** is a server-side `session.revert` — TUI renders an "N message reverted" restore
  card and refills the prompt from the reverted user message (`session/index.tsx:611-645`,
  `:1202-1260`).
- **Shell mode** (`!` prefix) routes to `session.shell`, slash-commands to `session.command`,
  everything else to `session.prompt` — three server endpoints chosen in submit
  (`prompt/index.tsx:1059-1121`).
- **Permission prompts** are separate renderables below the transcript (not dialogs): edit
  requests show a scrollable `<diff>` preview (`routes/session/permission.tsx:47-88`).
- **Terminal title** tracks route/session title (`app.tsx:455-478`); exit prints a resume
  epilogue (`sessionEpilogue`, `app.tsx:357-364`) — the "Continue opencode -s id" pointer.
- **Hydration edge case:** REST snapshot with empty text must not clobber a streamed part —
  guarded at `sync.tsx:637-645`. Worth copying as an invariant test.
- The provider tree is ~20 deep; zagent's core should resist that — group into a few stores
  (session/transport/ui) rather than a provider-per-concern.

## Evidence

- Clone @ `e03db9bc6908f75c9334d8aa997deeaac81c0298` (deleted post-study)
- Cross-ref: `tui-study-opencode.md` (PTY behavior study, v1.17.11)
- All citations are `packages/tui/src/...` unless noted; SDK types at
  `packages/sdk/js/src/v2/gen/types.gen.ts`; server at `packages/opencode/src/session/`.
