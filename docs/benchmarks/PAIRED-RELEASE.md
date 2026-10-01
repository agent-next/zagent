# Installed CLI package versus claude_code: benchmark protocol

Status: live testing needs quota to be available; results must be read from
receipts, not this protocol. No timer or scheduled job is created. Both clients
must use the same GLM Coding Plan account.

## Matrix and comparison boundary

- One full matrix: 10 existing tasks x 2 clients x 3 repeats = 60 cells.
- Run GLM-5.3 and GLM-5.3-Flash as separate matrices. Both together are 120 cells;
  do not pool model scores or costs into a single headline.
- ZCode lane packs the current committed package, installs that tarball in a
  disposable prefix and invokes its `zagent` executable. It does not substitute
  the protocol driver or source entry for the installed package.
- claude_code lane uses the explicitly selected local Claude Code executable or wrapper
  (`--claude-code`). Both lanes use the
  same selected credential and canonical Z.AI Anthropic API endpoint, with main
  and auxiliary model settings pinned to the chosen model.
- Preserve each client's normal prompt and internal retries. This measures a
  client/product difference, not a pure model comparison. Internal retry counts
  and observed model identities are unknown if the clients do not expose them.
- Each task/repeat pair alternates which client runs first. Execution is serial,
  with a minimum 10-second gap. Local profiles are fresh per cell; server-side
  prompt-cache warmth and shared-account usage by other sessions are not controlled.

| Task | Work | Grading |
| --- | --- | --- |
| t1_rot13 | ROT13 implementation | Hidden Python oracle |
| t2_fixbug | Bug repair response | Hidden Python oracle |
| t3_toposort | Topological sort | Hidden Python oracle |
| t4_multifile | Edit multiple files | Hidden oracle against edited files |
| t5_json | JSON processing | Hidden Python oracle |
| t6_regex | Pattern matching | Hidden Python oracle |
| t7_cli | CLI task | Hidden Python oracle |
| t8_apiclient | API-client task | Hidden Python oracle |
| t9_sql | SQL task | Hidden Python oracle |
| t10_refactor | Refactor existing code | Hidden oracle against edited files |

The task prompt and oracle hashes are recorded. `test.py` is not placed in the
agent's workspace and model-generated `test.py` is never used for grading.
This is **profile/workspace isolation, not an OS security sandbox**. Host files
remain accessible to tool-enabled agents. Do not use untrusted tasks or credentials
from another person. Shared account config/device/credential files are hash-checked
after the run, not restored over concurrent changes.

## Detailed outputs

Each run creates an exclusive new output directory:

- `manifest.json`: source commit, package version, tarball SHA-256, wrapper/runtime
  entry hashes, claude_code version, configured model, task hashes, exact matrix, limits
  and billing-evidence caveats.
- `cell-NNN.json`: task, repeat, client, configured model, completion timestamp,
  correctness result, fixed failure category, full process wall milliseconds,
  native token fields and their source. Missing fields are `null`, not zero.
- `summary.json`: completeness and duplicate/missing-cell checks, per-client
  correctness, paired-success latency medians, native usage totals and field-level
  coverage. A winner is withheld unless all expected cells pass.
- `REPORT.md`: readable per-cell table, aggregation, setup and billing caveats.

Full wall time starts at client process spawn and ends at process completion. It
includes startup, provider waits and internal retries; excludes package installation,
grading and between-cell cooldown. A 300-second limit applies equally to both
clients; the independent Python oracle has a 30-second limit. Failed cells remain
in the denominator. Latency medians show only matching successful pairs and must
not be presented as overall reliability or a model-quality win.

Rate limits, authentication errors, timeouts and other execution failures stop
the matrix after writing that cell. There is no runner-level retry or automatic
resume. Completed receipts remain; unattempted cells stay missing. Reusing an
output directory is refused. Do not rerun repeatedly to select a greener result.

## Tokens, Coding Plan credits and Flash campaign

These are separate quantities:

1. **Native token use:** per-client input, output, cache-read and cache-write counts
   when present in stdout JSON `usage`. Totals and coverage are reported by field.
   Missing fields, tool-call counts and retry counts remain unknown. Input/cache
   inclusion semantics are not assumed equal across clients; totals are not mixed.
2. **Coding Plan credits:** standard published formula, not measured charges.
3. **Account quota changes:** not measured by this runner. A billing-page or
   supported quota export before/after is needed, with other sessions paused and
   reporting delay accounted for. Shared quota deltas cannot automatically be
   attributed to one benchmark cell.
4. **Promotional entitlement:** conditional on model, time, paid-plan eligibility
   and how the provider identifies the client. Package naming is not eligibility.

Official sources verified on 2026-09-06:

- [Coding Plan overview](https://docs.z.ai/devpack/overview): model credits =
  `(input tokens * input multiplier + cached input tokens * cache multiplier + output tokens * output multiplier) / 10000`.
  Peak multipliers: GLM-5.3 = `6.9 / 1.7 / 24`; GLM-5.3-Flash = `2.3 / 0.56 / 8`.
  Off-peak model use is charged at 50%; peak is Monday-Friday 14:00-18:00 Singapore
  time. Do not apply the formula to ambiguous or double-counted native fields.
- [Flash campaign](https://docs.z.ai/devpack/notice/event-glm-5.3-flash):
  September 3-20, 2026, daily 23:00-09:00 the next day, Singapore time. Paid
  Coding Plan users using GLM-5.3-Flash **via official ZCode** have zero quota
  consumption/unlimited usage in that window. Other supported agents get doubled
  available quota. GLM-5.3 is excluded. This is not a general free API tier or a
  fixed grant of free tokens.

The unofficial installed CLI's eligibility for the official ZCode campaign is
**unverified**, even though both clients use the same Coding Plan account. This
runner does not change identity headers or spoof client identity to obtain an
entitlement. Do not claim "free Flash" or a dollar saving from this benchmark
without actual eligibility and billing evidence. Account subscription tier,
remaining credits and exact reset time are not inferred from the supplied key.

## Prepare and test without model calls

```bash
node bench/paired-core.test.mjs
node bench/paired-release.test.mjs
npm test
node bench/paired-release.mjs --dry-run
node bench/paired-release.mjs --dry-run --model glm-5.3-flash
```

Default invocation is dry-run: no credentials read, package install, model calls
or output directory writes. A dry-run is not a performance or billing result.
`--dry-run --live` is rejected. This protocol reuses the repository's task oracles for a same-model, two-client
comparison.

## Live run

Run from a clean, committed checkout. Review the local Claude Code wrapper
before selecting it; it is executable code, not a trusted opaque account label.
Pass `--claude-code-sha256 <hex>` to pin the reviewed wrapper; the runner then
rejects changes. `--acknowledge-host-access`
acknowledges that model tools and generated Python run without an OS sandbox;
fresh profiles do not prevent access to the host filesystem.
`measurementValid` means a complete, unconfounded collection; `acceptancePassed`
additionally requires every task to pass. A complete collection can include wrong answers.
Replace each path below with an explicit local path. Output must not already exist.

```bash
node bench/paired-release.mjs --live --acknowledge-host-access --model glm-5.3 \
  --runtime /absolute/path/to/zcode-app-cli/bin/zcode.js \
  --claude-code /absolute/path/to/reviewed/claude_code \
  --output /absolute/path/to/new-glm53-results

# A separate run, after the first result has been reviewed and quota is available:
node bench/paired-release.mjs --live --acknowledge-host-access --model glm-5.3-flash \
  --runtime /absolute/path/to/zcode-app-cli/bin/zcode.js \
  --claude-code /absolute/path/to/reviewed/claude_code \
  --output /absolute/path/to/new-flash-results
```

Raw answers, provider diagnostics, runtime profiles and credentials stay in the
temporary fixture and are deleted. Persisted reports contain only screened fields.
Keep manifests and receipts together for reproducibility.
