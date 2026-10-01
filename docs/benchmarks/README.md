# Benchmark results and write-ups

Recorded results for the harness in [`bench/`](../../bench/README.md). These are
historical receipts: read each file's caveats before quoting a number, and use the
paired, significance-gated comparison (`bench/paired-stats.mjs`) for any new claim.

| file | what it is |
| --- | --- |
| [RESULTS.md](RESULTS.md) | first breadth benchmark (zcode vs claude_code) and the multi-harness matrices that followed |
| [MULTI-HARNESS-RESULTS.md](MULTI-HARNESS-RESULTS.md) | first multi-harness matrix (34 of 50 cells) |
| [PAIRED-RELEASE.md](PAIRED-RELEASE.md) | protocol of the installed-package paired benchmark |
| [PAIRED-RESULTS.md](PAIRED-RESULTS.md) | its 60-cell GLM-5.3 result |
| [glm53-reset-run1/](glm53-reset-run1/REPORT.md) | generated report and provenance of that run |
| [HARD-FLASH.md](HARD-FLASH.md) | flash vs main on the hard task set |
| [FOUR-WAY-FLASH.md](FOUR-WAY-FLASH.md) | 120-cell four-way flash matrix |

## Raw data

- `bench/results-glm53-reset-run1/`: the 60 cells, `manifest.json` and `summary.json` of the
  paired GLM-5.3 run. `node bench/recorded-results.test.mjs` re-derives `summary.json` from
  the cells with `summarize()` and checks the paired-stats verdict.
- `bench/recorded-cells.jsonl`: 524 per-cell receipts of the earlier dual-lane and multi-harness
  runs (`bench/results/` is git-ignored because new runs write there).
  One line per cell, `{"file":"<name>.json","cell":{...}}`, sorted by file;
  `<lane>_<task>_<run>.json` are dual-lane cells, `mh_<harness>_<task>_<run>.json` are
  multi-harness cells. Unpack to `bench/recorded-cells/` as described in `bench/README.md`. Cells of the aider, codex, gemini and opencode harnesses were
  authentication or spawn failures of the benchmark setup, not measurements of those tools,
  and are not included; RESULTS.md reports them as infrastructure failures.
- `bench/frontierharness/`: adapter that runs the published FrontierHarness task set with
  zagent; see its README.

## Lane labels

The recorded runs used private shell aliases as lane names. They were renamed, consistently
in cells, statistics keys and prose, to these labels:

| label here | meaning |
| --- | --- |
| `zcode` | the zagent CLI driven through the protocol client |
| `zcode-app-cli`, `zcode-official` | the desktop app's launcher and the stock runtime |
| `claude_code` | Claude Code routed to the same GLM model through the caller's environment or a wrapper |
| `claude_direct` | the plain `claude` executable, used in the early multi-harness matrix |
| `grok-cli` | the Grok command-line agent |

Fields named `claudeCode*` in manifests and summaries carry what were alias-prefixed fields. Home
directories inside cells are written as `$HOME`. SHA-256 values are kept as recorded; the
manifest hash quoted in PAIRED-RESULTS.md is that of the file before redaction.
