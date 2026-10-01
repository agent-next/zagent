# TUI & Architecture Roadmap — surveyed from public agent harnesses (2026-09)

Sources: a survey of public harnesses.
Phase: applies AFTER GUI-parity v0.x; the TUI is the base, these patterns upgrade it.

| # | Pattern (source) | What |
|---|---|---|
| 1 | Render loop (grok) | Presenter dirty-flag + writer-sequence ack + min draw interval; animation ticks ONLY while work runs (idle loop parks at zero wakeups). |
| 2 | Event loop discipline (grok) | biased select with explicit starvation policy; input drained fully; timers last. |
| 3 | Permission pipeline (grok) | modes = frequency baseline; allow/ask/deny glob rules on top, deny wins across scopes; remembered grants per-project OUTSIDE repo; shell allowlist split on operators so "ls && rm -rf" still prompts. |
| 4 | inspect command (grok) | one command dumps every contributing config layer + discovered skills/agents/MCP with token counts + trust verdict. Debug + migration + support in one. |
| 5 | Session storage (grok) | per-session dir: summary.json + append-only updates.jsonl + rewind_points.jsonl; JSONL > sqlite for the replay log. |
| 6 | Steering grammar (codex) | Tab queue / Enter inject into running turn / Esc-Esc edit-and-fork. |
| 7 | Sandbox x approval axes (codex) | orthogonal config; workspace-write default with protected .git; --add-dir over full-access. |
| 8 | Config layering (codex) | base + --profile overlay + trust-gated project layer. |
| 9 | Client-server split (opencode) | daemon owns sessions/providers/tools; TUI/headless/web/IDE are thin clients over one socket. |
| 10 | Agents as markdown (opencode) | frontmatter model/tools/permissions; per-agent model override (flash for mechanical). |
| 11 | small_model routing (opencode) | titles/summaries/compaction on glm-5.3-flash; main loop on glm-5.3. |
| 12 | Cross-harness auto-read (grok) | read Claude/Cursor/AGENTS.md state with per-vendor toggles + import preview + cutoff marker. Biggest adoption wedge. |

## First-run UX (user-friendly install)
- one-liner install (npx), 30s to first answer
- startup typeahead capture before raw-mode takeover (grok) so first-run typing is never lost
- doctor with named auto-fixes; /doctor in-TUI for live checks
- default-on inspect after install: "here is everything I found on your machine"