# bench

Same-task benchmark harness and live probes for zagent. Everything here is opt-in:
the offline unit tests run in the normal gate (`node scripts/test-all.mjs`); anything
that calls a model or a provider account needs an explicit flag and spends quota.

## Tasks

- `tasks/` holds 15 small Python coding tasks; `tasks-hard/` holds 5 harder ones.
  Each task directory has `task.md` (the prompt) and `test.py` (the hidden oracle,
  never copied into the agent workspace). A task with an `agent_graded` marker file
  is graded on files the agent edits in place; otherwise the last code fence of the
  answer is written to `solution.py` and graded.

## Runners

All runners write one JSON receipt per cell under `bench/results/` (git-ignored) and
refuse to overwrite an existing receipt, so pick a new run ID every time.

| command | what it runs |
| --- | --- |
| `node bench/run.mjs <lane> <taskDir> <runId> [--model <provider/model>]` | dual-lane paired run; lane is `zcode` (this repo's CLI through the protocol client) or `claude_code` |
| `node bench/run-multi.mjs <harness> <taskDir> <runId>` | multi-harness run; harness is `zcode`, `zcode-app-cli`, `zcode-official`, `claude_code`, `grok-cli` or `opencode` |
| `bash bench/multi-matrix.sh` | 10 tasks x every harness with an adaptive pause between cells |
| `REPEATS=3 bash bench/offpeak-matrix.sh` | paced four-way matrix that only runs while `zagent offpeak` reports the free window open and stops when it closes |
| `node bench/paired-release.mjs` | plan only (prints the matrix); `--live --acknowledge-host-access --output <dir> --runtime <entry> --claude-code <path>` runs the installed-package comparison |
| `node bench/paired-stats.mjs <records.json>` | significance-gated verdict (sign test, Wilcoxon, bootstrap CI) over a run's records |

### Lane labels

`claude_code` is Claude Code routed to the same GLM model as zagent through the
caller's environment (for example `ANTHROPIC_BASE_URL` / `ZAI_AUTH_TOKEN`, or a
wrapper script). `grok-cli` is the Grok command-line agent. The mapping is used
consistently in receipts, statistics keys and flags.

### Configuration

No personal paths are baked in. Defaults and overrides:

- `BENCH_CLAUDE_CODE_BIN` (default `claude`): executable for the `claude_code` lane.
- `BENCH_GROK_CLI_BIN` (default `grok`): executable for the `grok-cli` lane.
- `BENCH_ROOT`: repo root for the matrix scripts (default: this checkout).
- `BENCH_REAL_HOME`: where harness binaries are installed when `HOME` is overridden
  for config isolation (default: the current home).
- `BENCH_MODEL`: model recorded in (and pinned for) a cell.
- `ZCODE_OFFICIAL_KERNEL`: path of the stock kernel for the `zcode-official` lane.
- `ZAI_AUTH_TOKEN`: provider key for `quota-probe.mjs` and the `claude_code` lane.
- `--claude-code-sha256 <hex>` (paired-release): optionally hash-lock a reviewed wrapper.
- `TASKS`, `LANES`, `REPEATS`, `GAP`, `MATRIX_RUN_ID` tune `offpeak-matrix.sh`.

## Recorded results

Write-ups and raw cells of earlier runs: [`docs/benchmarks/`](../docs/benchmarks/README.md).
`node bench/recorded-results.test.mjs` re-derives the recorded run's `summary.json` from its cells.

## Probes (live, credentialed, spend quota unless noted)

- `quota-probe.mjs --live RECEIPT.json`: four small paid calls comparing account quota deltas.
- `offpeak-probe.mjs --live|--resume RECEIPT.json`: one dedicated idle-channel ticket.
- `team-probe.mjs --live claude_code|zagent RECEIPT.json`: plan-channel team workflow acceptance (`--self-test` is offline).
- `f15-generate-text-probe.mjs`: repo-wiki `generateText` contract probe.
- `tui-boot-probe.mjs`, `slash-probe.mjs`: drive the TUI under a PTY (Linux/macOS).
- `quota-redirect-probe.mjs`: loopback-only check that credentialed quota calls do not follow redirects.
- `client-perf.mjs`: time to first frame, memory and CPU against another client.

## Offline tests

```
node bench/run-safety.test.mjs
node bench/extract.test.mjs
node bench/invalid.test.mjs
node bench/paired-core.test.mjs
node bench/paired-stats.test.mjs
node bench/paired-release.test.mjs
node bench/client-perf.test.mjs
node bench/test-offpeak-probe.mjs
node bench/recorded-results.test.mjs
```
