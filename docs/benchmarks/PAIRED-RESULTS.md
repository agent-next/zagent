# Paired benchmark: GLM-5.3, 2026-09-06

Completed measurement; acceptance did not pass. The previous package's CLI (lane `zcode`) passed 29/30 cells and claude_code passed 30/30. No winner, equal-quality or cost-saving claim is supported.

> **Raw cells:** `bench/results-glm53-reset-run1/` holds the 60 per-cell JSON records plus
> `manifest.json` and `summary.json` this report summarises. Same run: source commit
> `98a9fc2`, tarball SHA-256 `0cb609f5…`, 2026-09-06T21:30-21:58. Labels were renamed for
> publication (see [README](README.md)); `node bench/recorded-results.test.mjs` checks
> that `summary.json` is reproduced from the cells.

## Provenance

- Candidate: `the previous package (version 0.0.171)`, source `98a9fc2bdc83f7c24b9856d667984742c6f11a11`.
- Installed tarball SHA-256: `0cb609f58255c659b231f8a10d992eb361a88663600bab0f3324cc31f7c919e5`.
- Manifest SHA-256 (of the file as originally written, before the package name and account wording were redacted): `b957ba91d13d8f12d2fcfe2f8d94bd901821df364504081dd041227bcce6c648`.
- claude_code version: `2.1.263`; wrapper SHA-256: `1df8edd8b520640d67c44318a3ffcc5d1b6eda6dc5dd3b203798734a8e9b8684`.
- Runtime entry SHA-256: `5c18d8ab10312add652e7c1d3fb08020b592d902fa46e0c55d95f687a57b084e`.
- 10 tasks × 2 clients × 3 repeats; 60 unique cells independently rechecked against the manifest.
- Same GLM Coding Plan account, selected credential and canonical Anthropic API route; configured main/lite model `glm-5.3`. Actual served model ID was not exposed.
- Started 2026-09-06T21:30:01.024Z; last cell 2026-09-06T21:58:58.527Z. Serial execution, alternating lane order, 10-second cooldown, 300-second per-cell timeout.

## Interpretation

The 29 pairs where both clients passed have median process walls of **13.018s (zcode)** and **13.082s (claude_code)**. This is a descriptive subset, not a speed winner; the failed pair is excluded from both timing samples. Wall time includes startup and internal retries, not installation or grading. Fresh profiles do not control provider-side cache warmth; prompts and retry policies differ.

Cell 39 (`t7_cli`, zcode, repeat 2) failed the correctness oracle after 11.249s. No rate-limit, authentication, timeout or runtime-error category occurred. The allowlisted receipt does not retain generated code or assertion diagnostics, so it does not establish the exact defect or whether its cause lies in generation, extraction or grading. Do not relabel this as an upstream outage or silently replace it with a successful rerun.

Native usage is present in 30/30 receipts per client, including the failed cell:

| Native field | zcode total | Native field | claude_code total |
| --- | ---: | --- | ---: |
| inputTokens | 472714 | input_tokens | 97259 |
| outputTokens | 23540 | output_tokens | 27300 |
| cacheReadTokens | 422400 | cache_read_input_tokens | 934400 |
| cacheWriteTokens | 0 | cache_creation_input_tokens | 0 |

These are client-reported field sums, not independently metered billing. Input/cache inclusion semantics are not validated as equivalent: do not add fields into a common total or claim a token-efficiency ratio. Actual charge, account quota delta, free-token entitlement and GLM-5.3-Flash entitlement are **unverified**. This was GLM-5.3, not a Flash run. Tool-call and internal-retry counts are unavailable.

The runner reported protected account files unchanged, fixture removed and zero unexpected tagged child processes. Tests were withheld from task directories but there was no OS sandbox. This automated coding matrix does not certify interactive TUI, real-human usability, or cross-platform runtime support.

The run used the pre-documentation tarball above. Later README edits change its digest; this result is not exact-artifact acceptance for a newer tarball. The manifest, 60 JSON receipts, summary and generated report are in `bench/results-glm53-reset-run1/` and [glm53-reset-run1](glm53-reset-run1/REPORT.md); no raw model output or credentials are published here. Reproduce the measurement with the [runner protocol](PAIRED-RELEASE.md).

## Per-cell receipts


| Index | Task | Repeat | Client | Result | Full wall ms | Native token fields |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | t1_rot13 | 1 | zcode | PASS | 9498 | {"inputTokens":8679,"outputTokens":111,"cacheReadTokens":4544,"cacheWriteTokens":0} |
| 1 | t1_rot13 | 1 | claude_code | PASS | 6690 | {"input_tokens":12996,"output_tokens":138,"cache_read_input_tokens":5504,"cache_creation_input_tokens":0} |
| 2 | t1_rot13 | 2 | claude_code | PASS | 6491 | {"input_tokens":12996,"output_tokens":131,"cache_read_input_tokens":5504,"cache_creation_input_tokens":0} |
| 3 | t1_rot13 | 2 | zcode | PASS | 13018 | {"inputTokens":8679,"outputTokens":129,"cacheReadTokens":192,"cacheWriteTokens":0} |
| 4 | t1_rot13 | 3 | zcode | PASS | 7662 | {"inputTokens":8679,"outputTokens":120,"cacheReadTokens":2368,"cacheWriteTokens":0} |
| 5 | t1_rot13 | 3 | claude_code | PASS | 6609 | {"input_tokens":516,"output_tokens":132,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 6 | t2_fixbug | 1 | claude_code | PASS | 14028 | {"input_tokens":734,"output_tokens":375,"cache_read_input_tokens":36480,"cache_creation_input_tokens":0} |
| 7 | t2_fixbug | 1 | zcode | PASS | 17435 | {"inputTokens":17565,"outputTokens":396,"cacheReadTokens":16768,"cacheWriteTokens":0} |
| 8 | t2_fixbug | 2 | zcode | PASS | 21366 | {"inputTokens":17537,"outputTokens":283,"cacheReadTokens":13248,"cacheWriteTokens":0} |
| 9 | t2_fixbug | 2 | claude_code | PASS | 17160 | {"input_tokens":737,"output_tokens":651,"cache_read_input_tokens":36480,"cache_creation_input_tokens":0} |
| 10 | t2_fixbug | 3 | claude_code | PASS | 13898 | {"input_tokens":734,"output_tokens":473,"cache_read_input_tokens":36480,"cache_creation_input_tokens":0} |
| 11 | t2_fixbug | 3 | zcode | PASS | 16795 | {"inputTokens":17545,"outputTokens":466,"cacheReadTokens":16768,"cacheWriteTokens":0} |
| 12 | t3_toposort | 1 | zcode | PASS | 11745 | {"inputTokens":8705,"outputTokens":629,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 13 | t3_toposort | 1 | claude_code | PASS | 12179 | {"input_tokens":542,"output_tokens":741,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 14 | t3_toposort | 2 | claude_code | PASS | 13298 | {"input_tokens":542,"output_tokens":857,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 15 | t3_toposort | 2 | zcode | PASS | 23091 | {"inputTokens":8705,"outputTokens":1017,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 16 | t3_toposort | 3 | zcode | PASS | 12766 | {"inputTokens":8705,"outputTokens":607,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 17 | t3_toposort | 3 | claude_code | PASS | 12776 | {"input_tokens":542,"output_tokens":739,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 18 | t4_multifile | 1 | claude_code | PASS | 24833 | {"input_tokens":1305,"output_tokens":557,"cache_read_input_tokens":74176,"cache_creation_input_tokens":0} |
| 19 | t4_multifile | 1 | zcode | PASS | 23375 | {"inputTokens":36147,"outputTokens":560,"cacheReadTokens":34816,"cacheWriteTokens":0} |
| 20 | t4_multifile | 2 | zcode | PASS | 26674 | {"inputTokens":36232,"outputTokens":653,"cacheReadTokens":34816,"cacheWriteTokens":0} |
| 21 | t4_multifile | 2 | claude_code | PASS | 35099 | {"input_tokens":13985,"output_tokens":653,"cache_read_input_tokens":80896,"cache_creation_input_tokens":0} |
| 22 | t4_multifile | 3 | claude_code | PASS | 20785 | {"input_tokens":1072,"output_tokens":378,"cache_read_input_tokens":55104,"cache_creation_input_tokens":0} |
| 23 | t4_multifile | 3 | zcode | PASS | 34892 | {"inputTokens":36251,"outputTokens":668,"cacheReadTokens":34880,"cacheWriteTokens":0} |
| 24 | t5_json | 1 | zcode | PASS | 9078 | {"inputTokens":8690,"outputTokens":328,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 25 | t5_json | 1 | claude_code | PASS | 7301 | {"input_tokens":13007,"output_tokens":464,"cache_read_input_tokens":5504,"cache_creation_input_tokens":0} |
| 26 | t5_json | 2 | claude_code | PASS | 7359 | {"input_tokens":527,"output_tokens":416,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 27 | t5_json | 2 | zcode | PASS | 8552 | {"inputTokens":8690,"outputTokens":158,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 28 | t5_json | 3 | zcode | PASS | 8230 | {"inputTokens":8690,"outputTokens":134,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 29 | t5_json | 3 | claude_code | PASS | 11168 | {"input_tokens":527,"output_tokens":596,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 30 | t6_regex | 1 | claude_code | PASS | 13082 | {"input_tokens":18541,"output_tokens":849,"cache_read_input_tokens":0,"cache_creation_input_tokens":0} |
| 31 | t6_regex | 1 | zcode | PASS | 12866 | {"inputTokens":8720,"outputTokens":713,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 32 | t6_regex | 2 | zcode | PASS | 21530 | {"inputTokens":8720,"outputTokens":1293,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 33 | t6_regex | 2 | claude_code | PASS | 14524 | {"input_tokens":557,"output_tokens":906,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 34 | t6_regex | 3 | claude_code | PASS | 11848 | {"input_tokens":557,"output_tokens":608,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 35 | t6_regex | 3 | zcode | PASS | 9166 | {"inputTokens":8720,"outputTokens":265,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 36 | t7_cli | 1 | zcode | PASS | 9841 | {"inputTokens":8703,"outputTokens":656,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 37 | t7_cli | 1 | claude_code | PASS | 19817 | {"input_tokens":540,"output_tokens":1114,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 38 | t7_cli | 2 | claude_code | PASS | 10464 | {"input_tokens":540,"output_tokens":530,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 39 | t7_cli | 2 | zcode | incorrect | 11249 | {"inputTokens":8703,"outputTokens":551,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 40 | t7_cli | 3 | zcode | PASS | 18253 | {"inputTokens":8703,"outputTokens":969,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 41 | t7_cli | 3 | claude_code | PASS | 14227 | {"input_tokens":540,"output_tokens":1082,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 42 | t8_apiclient | 1 | claude_code | PASS | 22496 | {"input_tokens":554,"output_tokens":1579,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 43 | t8_apiclient | 1 | zcode | PASS | 23801 | {"inputTokens":8717,"outputTokens":1876,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 44 | t8_apiclient | 2 | zcode | PASS | 8632 | {"inputTokens":8717,"outputTokens":288,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 45 | t8_apiclient | 2 | claude_code | PASS | 12132 | {"input_tokens":554,"output_tokens":771,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 46 | t8_apiclient | 3 | claude_code | PASS | 8917 | {"input_tokens":554,"output_tokens":728,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 47 | t8_apiclient | 3 | zcode | PASS | 36479 | {"inputTokens":8717,"outputTokens":2747,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 48 | t9_sql | 1 | zcode | PASS | 6793 | {"inputTokens":8698,"outputTokens":116,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 49 | t9_sql | 1 | claude_code | PASS | 9449 | {"input_tokens":535,"output_tokens":549,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 50 | t9_sql | 2 | claude_code | PASS | 11241 | {"input_tokens":535,"output_tokens":422,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 51 | t9_sql | 2 | zcode | PASS | 10514 | {"inputTokens":8698,"outputTokens":354,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 52 | t9_sql | 3 | zcode | PASS | 4425 | {"inputTokens":8698,"outputTokens":132,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 53 | t9_sql | 3 | claude_code | PASS | 9271 | {"input_tokens":535,"output_tokens":363,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 54 | t10_refactor | 1 | claude_code | PASS | 57475 | {"input_tokens":3175,"output_tokens":2772,"cache_read_input_tokens":95808,"cache_creation_input_tokens":0} |
| 55 | t10_refactor | 1 | zcode | PASS | 43496 | {"inputTokens":38394,"outputTokens":1938,"cacheReadTokens":35712,"cacheWriteTokens":0} |
| 56 | t10_refactor | 2 | zcode | PASS | 50871 | {"inputTokens":39890,"outputTokens":2598,"cacheReadTokens":36288,"cacheWriteTokens":0} |
| 57 | t10_refactor | 2 | claude_code | PASS | 96227 | {"input_tokens":5263,"output_tokens":4893,"cache_read_input_tokens":100032,"cache_creation_input_tokens":0} |
| 58 | t10_refactor | 3 | claude_code | PASS | 61784 | {"input_tokens":3517,"output_tokens":2833,"cache_read_input_tokens":96704,"cache_creation_input_tokens":0} |
| 59 | t10_refactor | 3 | zcode | PASS | 49339 | {"inputTokens":50417,"outputTokens":2785,"cacheReadTokens":46848,"cacheWriteTokens":0} |
