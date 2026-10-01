# glm-5.3 reset run 1: raw cells

The raw per-cell measurements of a 60/60 run live in `bench/results-glm53-reset-run1/`
(`cell-000.json` .. `cell-059.json`, `manifest.json`, `summary.json`). Re-running costs
Coding Plan quota and cannot reproduce the same wall times, so these records are the
only copy of the measurement.

From REPORT.md: model glm-5.3, source commit 98a9fc2bdc83f7c24b9856d667984742c6f11a11,
previous package version 0.0.171, tarball SHA-256
0cb609f58255c659b231f8a10d992eb361a88663600bab0f3324cc31f7c919e5, observed 60/60,
measurement valid: true, acceptance passed: false.

Each cell records task, lane (`zcode` vs `claude_code`), repeat, pass, failureCategory,
wallMs and the provider usage object. The caveats stated in REPORT.md hold: wall time
includes client boot and internal retries, provider-side cache warmth is not controlled,
and the two clients have different prompts and retry policies.

Publication edits: the private lane alias became `claude_code` (and the alias-prefixed manifest and
summary keys became `claudeCode*`), the private package name in `manifest.json` became
`previous-package`, and account wording was trimmed. The hashes are unchanged, so the
manifest SHA-256 quoted in PAIRED-RESULTS.md refers to the original file.

## The report for this data

[PAIRED-RESULTS.md](../PAIRED-RESULTS.md) is the analysis of these
cells, and `bench/paired-release.mjs` + `bench/paired-core.mjs` are the harness that
produced them. Headline: the previous package's CLI passed 29/30 cells, claude_code
30/30; no winner, equal-quality or cost-saving claim is supported.
