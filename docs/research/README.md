# Research

Design research behind zagent: how peer agent CLIs behave, what is worth borrowing,
and the feature matrix they were compared on. Everything here is a point-in-time
study (dates in each file); it is reference material, not a spec. The TUI spec that
consumes these studies is [`../TUI-CORE-SPEC.md`](../TUI-CORE-SPEC.md) and the GUI
parity ledger is [`../PARITY.md`](../PARITY.md).

Benchmark configurations that appear in other documents use neutral labels:
`claude-code` is the Claude Code CLI, `grok-cli` is xAI's Grok Build CLI (`grok`).
"Grok CLI" / `grok` in these studies is that public product, not an internal name.

| File | What it is |
| --- | --- |
| [`BORROW.md`](BORROW.md) | Borrow list: what to take from official ZCode, its plugin repo, Grok Build, codex and opencode, with upstream line citations |
| [`reference-matrix.json`](reference-matrix.json) | Feature matrix of public peer harnesses (opencode, codex, Claude Code, Cursor CLI, Grok Build), one record per feature with source URLs |
| [`references-upstreams.md`](references-upstreams.md) | The upstream repositories the research cites, to re-clone |
| [`src-study-codex.md`](src-study-codex.md) | Source study of the codex Rust TUI (architecture, streaming, cell buffer) |
| [`src-study-opencode.md`](src-study-opencode.md) | Source study of the opencode TUI |
| [`tui-study-codex.md`](tui-study-codex.md) | Behavioral PTY study of the codex TUI |
| [`tui-study-grok.md`](tui-study-grok.md) | Behavioral PTY study of the Grok CLI |
| [`tui-study-opencode.md`](tui-study-opencode.md) | Behavioral PTY study of the opencode TUI |
| [`tui-landscape.md`](tui-landscape.md) | Must-have versus differentiator TUI checklist and the complaints it answers |
| [`cli-ux-comparison.md`](cli-ux-comparison.md) | Cross-CLI UX comparison of codex, claude, Grok CLI and opencode against zagent |
| [`cli-ux-comparison/`](cli-ux-comparison/) | Its evidence: `help/` holds `--help` captures, `screens/` holds 116 rendered PTY screens (`<cli>-<mode>--<screen>.txt` plus `--meta.json` capture scripts) |
| [`spikes/cloud-registry/`](spikes/cloud-registry/) | Design spike: a shared defect registry so a fan-out of fuzz agents on Cloudflare files one issue per defect; `node spikes/cloud-registry/test-registry.mjs` runs its offline tests |

Conventions: captured third-party output has had home and scratch paths replaced by
`~` / `<scratch-dir>` and account e-mails by `<user-email>`. Raw frame captures and
the capture drivers are not stored here; `scripts/pty-capture.py` (shipped with the test tooling) is the capture tool
the studies reference.
