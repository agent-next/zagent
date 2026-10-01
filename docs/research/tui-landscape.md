# TUI landscape DR (light mode, 2026-09-18) — must-have vs differentiator

A light-mode deep-research pass on the TUI question (30–120s, citations
preserved), with a synthesis against zagent's state at the time.

## Must-have checklist (per DR; our status)

| Feature | Priority | zagent status |
| --- | --- | --- |
| Streaming text | Must | ✅ newline-gated commits |
| Markdown rendering | Must | ✅ fenced+syntax colors, GFM tables |
| Tool event blocks | Must | ✅ one-liners + colored diffs |
| Permission prompts | Must | ⚠️ partial (permission-surface package queued — #1 gap confirmed again) |
| Slash palette | Must | ⚠️ exists; popup fuzzy/discovery quality untested (PTY cards land this) |
| Multiline editor | Must | ✅ alt+enter etc. |
| History search | Must | ✅ up-arrow recall; search untested |
| Bracketed paste | Must | ✅ paste chips |
| Unicode correctness | Must | ✅ CJK-safe width math |
| Resize safety | Must | ⚠️ cell-diff + DECSTBM landed; shrink-after-transcript untested |
| Scrollback virtualization | Must | ⚠️ DECSTBM pinned writer behind flag |
| Inline diffs | Must | ✅ colored per-call diffs |
| Status bar | Must | ⚠️ landed; busy≠idle + phase display to verify via PTY cards |
| Ctrl-C layers | Must | ⚠️ landed; esc-layers PTY card is the oracle |
| Session resume | Must | ✅ exit hint + `-c` |

## Differentiators (per DR)

Semantic transcript folding (✅ fold cursor), smart tool summaries (✅ Explored
cells), diff review navigation (partial), agent phase visualization (queued),
failure diagnosis cards, timeline replay, AI-searchable palette, context-
compression visualization — the "next battlefield": not polish but **human
control during autonomy** (what the agent believes / is doing / changed /
what irreversible action comes next).

## Top user complaints (validate our priorities)

1. Approval fatigue → grouped approvals + trust scopes (ties to the mode
   picker + permission management).
2. Long unreadable output → summaries + expandable blocks (we have; PTY cards
   verify).
3. Lost context on scroll → persistent header/status (PTY layout card).
4. Terminal bugs (rendering/resize) — empirical 2026 study lists terminal
   problems as a top bug class in Claude Code/Codex/Gemini CLIs → our
   resize/esc/PTY card pack is exactly the right spend.

## Actions fed

- Confirms the permission surface as the #1 gap (independent signals:
  maintainer judgment, DR complaints data).
- Adds to the resize work: a shrink-after-transcript resize matrix.
- Parity metrics unchanged; add "approval interruptions per task" as a
  measured number (DR complaint #1).

Sources: codex slash-commands docs; OpenAI Codex CLI help; opencode.ai/docs;
arXiv 2603.20847 (empirical bug study).
