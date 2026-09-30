# TUI behavioral study — opencode CLI

- Target: `opencode` **1.17.11** (installed binary; TUI offered an update to v1.18.31)
- Method: `pexpect` spawn in a real PTY, **40 rows × 120 cols**, `TERM=xterm-256color`, real `$HOME`,
  a scratch project dir. Byte stream replayed through `pyte`; raw timestamped frames (`# t=+s len=N` markers; not included here);
  rendered screens `NN-name.txt`, color-annotated `NN-name.color.txt` (`{fg|bg|b}` spans).
- Live-turn accounting: config default `fireworks-ai/…/kimi-k2p5-turbo` is dead
  ("Model not found, inaccessible, and/or not deployed") → run 1 produced **2 failed turns** (error
  evidence kept). Model then pinned to `opencode/big-pickle` via the project's `opencode.json`;
  run 2 produced **2 successful turns** (+1 tiny headless `opencode run` sanity check).
  Total successful interactive turns: **2**, within budget.
- Session geometry: empty session uses a centered ~94-col "hero" column (chrome starts col 24);
  once a transcript exists the layout goes full-width (gutter col 3, assistant text col 6).

## P1 — streaming, echo, thinking (r2, turn 1, t≈+20–30s)

- **User message echoes immediately** into the transcript as a guttered block: blue `┃`
  (`5c9cf5`) at col 3, body on panel bg `141414`, text `eeeeee`.
- **Streaming is incremental, not line-dumps**: 307 frames / ~10 s, median paint every 0.04 s
  (~25 fps), chunks 86–450 B. Screen text grows smoothly between 2 s/5 s/10 s snaps.
- **Thinking**: braille spinner `⠸ Thinking` while reasoning; on completion replaced by
  `Thought: 1.9s` (orange `97682c`). Reasoning text is shown, dimmed `939393` — visually
  distinct from the `eeeeee` answer text.
- **Turn footer**: `▣ Build · Big Pickle` while generating → `▣ Build · Big Pickle · 9.9s`
  on completion (agent · model · elapsed).
- **Status bar mutates during a turn**: left shows an animated block bar `■■■⬝⬝⬝⬝⬝` +
  `esc interrupt`; right swaps `tab agents` for a **context meter `26.8K (13%)`**.
- **Idle is silent**: zero frames between t=30 s and t=75.6 s — no repaints when nothing changes.

```
     ⠸ Thinking                                     <- t+2s, spinner row
  ┃  $ ls -la <project-dir>/hello.txt …             <- t+5s, tool block mid-turn
     ▣  Build · Big Pickle · 9.9s                    <- done, footer with elapsed
```

## P2 — tool-use display (same turn)

- **bash**: rendered as a `┃`-gutter panel (gutter glyph bg-only `0a0a0a|141414`, panel `141414`)
  containing `$ <command>` then the command's stdout lines. `ls -la …` executed **with no
  permission prompt** — no modal/chip appeared (default config auto-allowed this read-only call).
- **read**: a single muted one-liner `→ Read hello.txt` (all `808080`) — collapsed style,
  result body is not displayed (goes to the model only). No expand/collapse UI observed.
- Tool rows sit inline in the transcript between reasoning paragraphs — no spinners per tool.

## P3 — interrupt (r2, turn 2, essay)

- **Single Esc does NOT interrupt.** Status hint flips `esc interrupt` →
  `esc again to interrupt` — an armed-confirm (double-Esc) gesture. Armed state persisted
  ≥3.7 s; generation **kept streaming** the whole time (snaps 18→20→21 show text growing).
- Partial output is fully retained on screen; nothing collapses or truncates.
- (Only one Esc was sent per the ≤2-turn budget; the second-press commit path is inferred from
  the hint text, marked unverified.)

## P4 — input behavior

- **CJK `你好世界`**: echoes correctly, caret/width handled (2-cell glyphs aligned in field).
- **Up-arrow history**: recalls the last submitted prompt **only when the input is empty**
  (with text present, Up does nothing/cursor-move; verified both ways: `08-hist-up` no-op vs
  `22-hist-recall` recalled `Write a 250-word essay about the ocean.`).
- **Esc does NOT clear the input** — text survived multiple Esc presses (`07-cleared` still
  shows prior content). Esc is reserved for dialogs/interrupt-arm.
- **Bracketed paste of 3 lines** collapses to an inline chip **`[Pasted ~3 lines]`** at the
  caret — input stays one line; chip **expands to the full text on submit** (transcript shows
  `alpha line one / beta line two / gamma line three` as separate message lines).
- **Shift+Enter** (kitty `\x1b[13;2u`) inserts a real newline — input grows a row, no submit.
- **`/` opens an inline autocomplete menu** above the input: `┃ /agents  Switch agent ┃`,
  `/connect`, `/diff`, `/editor`, `/exit`, `/help`, `/init`, project custom commands — each
  with a right-aligned description; filters as you type.

## P5 — layout, chrome, colors (opencode theme, dark)

- Content:chrome ≈ 30:6 rows at 40×120 (transcript ~30, input box 5 incl. footer line +
  `╹▀…` border, status bar 1). Assistant text col 6; user/tool gutter col 3.
- Palette: bg `0a0a0a`; panels `141414`/input `1e1e1e`; accent blue `5c9cf5` (gutters, `▣`,
  agent name); text `eeeeee`/`ffffff`; muted `808080`; reasoning `939393`; `Thought:` `97682c`;
  tip `f5a742`; error toast borders `e06c75`.
- **Code blocks: syntax-highlighted, borderless, no language label** — `def` purple `9d7cd8`,
  fn names `fab283`, params `e06c75`, operators `56b6c2`, numbers `f5a742`; indent only.
- **Dialogs = centered modals**: Update card (title/body/`Skip`/`Confirm` buttons, `esc` hint);
  Themes picker (title, `Search` field, scrolling list, current marked `●`).
- **Toasts = top-right bordered mini-cards** (`┃ Update Failed ┃`, red for errors) — non-blocking.
- Boot extras: ASCII logo centered; rotating `● Tip` line in dead space; status bar =
  `cwd … version` (`<project-dir> … 1.17.11`); hints `tab agents · ctrl+p commands`.
- Exit: `/exit` (or cleanup) prints `Session New session - <ts>` + `Continue opencode -s ses_…`
  to scrollback — a resumable pointer.
- **Hazard observed**: the boot-time "Update Available" modal swallowed early keystrokes; my
  Enter hit `Confirm` → self-update attempt → `Update Failed` toast. First-run modals steal keys.

## Coverage recommendations for zagent

| capability | why it matters for humans | zagent should copy/differ |
| --- | --- | --- |
| ~25 fps incremental streaming paints | text visibly "types"; batch flushes feel frozen | copy — repaint on delta, not per line |
| zero repaints when idle | no flicker, no CPU burn, clean `script` captures | copy — event-driven paint only |
| braille spinner → `Thought: N.Ns` | proves liveness + how long reasoning took | copy — spinner + elapsed label |
| dimmed reasoning vs bright answer (`939393`/`eeeeee`) | humans skim CoT vs final answer differently | copy — distinct dim style for reasoning |
| double-Esc armed interrupt ("esc again to interrupt") | one stray Esc must not kill a long turn | **copy — fix, don't just match**: zagent has a known orphan bug (alt+letter→Escape abort); an armed-confirm also fixes that |
| Esc never clears the input box | typed drafts survive dialog/interrupt keys | copy — keep Esc for dialogs/interrupt only |
| `[Pasted ~N lines]` chip, expands on submit | multi-line paste stays readable, nothing floods | copy — render chip in input, expand at send |
| Up-history only on empty input | never clobbers a half-typed draft | copy |
| Shift+Enter newline (kitty `\x1b[13;2u`) | multi-line prompts without submit | copy — accept kitty + `\`-continuation |
| collapsed tool rows (`→ Read f`), `$`-block for bash w/ output | transcript stays scannable; details on demand | copy — one-line tool chips; zagent may add expand key (differ: expandable) |
| no permission prompt for read-only `ls`/`Read` | zero friction on safe calls | copy the *policy*; keep prompts for write/exec |
| syntax-highlighted borderless code blocks | readability without box noise | copy — highlight, skip borders/lang label optional |
| context meter `26.8K (13%)` in status during turns | humans budget context in real time | copy — cheap, high-value status element |
| turn footer `▣ agent · model · Ns` | per-turn accountability/duration | copy |
| inline `/` autocomplete with descriptions | discoverability without leaving the box | copy |
| centered modal for decisions, top-right toast for notices | blocking vs passive priority signaling | copy — two notification tiers |
| rotating `● Tip` in empty space | free onboarding surface | optional copy |
| `Continue <cli> -s <id>` printed on exit | session resumability is discoverable | copy — print resume pointer at exit |
| boot modal steals keystrokes (update prompt) | my Enter triggered an update attempt | **differ — do not gate input on a boot modal**; make updates a toast or status item |
| hero column → full-width after first message | cosmetic polish | optional |
| model-error path: toast + inline error block | failure is visible both transiently + in history | copy — errors belong in the transcript too |

## Anomalies worth noting

- Default model in this host's `~/.config/opencode/config.json` (`fireworks … routers/kimi-k2p5-turbo`)
  is undeployed → every turn fails fast with an inline `Model not found` block + toast. Unrelated
  to TUI correctness but it means a fresh user on this host sees only the error path.
- `Esc` and `Ctrl+U` did not reliably clear multi-line input in either run — leftover input was
  submitted with the live prompt (visible in transcript). Treat input-clear as a weak spot.

Raw frame captures (run 1 and run 2) are not included here.
Driver reusable for other CLIs: `pty-cap2.py --out DIR --cmd <cli> --step wait:N --step type:X …`.
