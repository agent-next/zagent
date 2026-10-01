# Flash vs main on a harder benchmark — 2026-09-07

Tests the **flash** coding model against **main** on the zagent product, and adds a
harder task set because the existing toy tasks cannot discriminate models.

## Setup
- Harness: `zagent` (this repo), driving the user's own `zcode-app-cli` runtime (GUI 3.11.2).
- Model pinned per session via `session/setModel` (new `bench/run.mjs --model`), no global config change.
  - **flash** = `zai/glm-5.3-flash` (the account's configured "lite" model).
  - **main**  = `zai/glm-5.3`.
- Correctness = each task's objective `test.py` oracle. Single run per cell.
- Ran inside the free-flash window (CST ~08:2x–08:3x, before 09:00), so flash calls were free.

## Result 1 — flash on the EXISTING (toy) tasks: 10/10, looks great
`glm-5.3-flash` passed all ten, and was roughly 2× faster than the earlier glm-5.3 paired run —
turn seconds: t1 5.5, t2 7.7, t3 6.5, t5 5.5, t6 6.3, t7 5.5, t8 5.5, t9 6.2, t10 20.5. The one
exception was **t4_multifile at 82s** (glm-5.3 was ~30s) — flash thrashing on the hardest existing task.

## Result 2 — flash vs main on the HARDER tasks: the gap appears
| task | flash pass | flash turn s | main pass | main turn s |
|---|:---:|---:|:---:|---:|
| h1_lru_ttl (LRU + TTL) | PASS | 15.8 | PASS | 7.6 |
| h2_expr_eval (parser + errors) | PASS | 17.7 | PASS | 16.3 |
| **h3_json_patch (RFC 6902 subset)** | **FAIL** | 35.6 | PASS | 26.0 |
| h4_topo_cycle (cycle detection) | PASS | 8.2 | PASS | 26.8 |
| h5_min_diff (LCS edit script) | PASS | 9.8 | PASS | 13.9 |
| **total** | **4/5** | | **5/5** | |

## Findings
- **Toy tasks hide the difference.** On the easy set flash is 10/10 and ~2× faster than main — a flattering, misleading picture.
- **Harder tasks expose a real correctness gap.** Flash is **4/5**, failing `h3_json_patch` (immutable apply with move/copy/test and bad-path handling); main is **5/5** and solves h3 in 26s. Flash over-generated on h3 (6097 chars) and still got the semantics wrong.
- **Flash's speed edge reverses under difficulty.** Flash is faster on the simplest work but SLOWER than main on h1 (15.8 vs 7.6) and h3 (35.6 vs 26), and spent 82s on t4_multifile. It tends to loop/over-produce on complex tasks, losing the advantage that makes it attractive.
- **Takeaway:** flash is a strong *fast/cheap* default for simple edits, but it is not a drop-in for main on complex, multi-step or semantically-strict tasks. Do not generalize from the toy-task numbers.

## Caveats (honest)
- **Single run per cell**; latencies are indicative, not significant. Use `bench/paired-stats.mjs` before any "faster" claim. This receipt claims only the correctness gap (4/5 vs 5/5) and the qualitative slowdown, not a latency ratio.
- **Model-vs-model on our harness only.** This is flash vs main inside zagent, not harness-vs-harness. A paired flash-vs-claude_code-on-flash comparison needs claude_code configured for flash (follow-up).
- **Served-model confirmation:** `setModel(glm-5.3-flash)` was accepted and behaved like a distinct faster model, but the runner's usage shape does not expose the served `modelId`, so exact server-side routing is not proven here.
- **Catalog note:** `zagent models` (coding-plan) lists `glm-4.7-flash` / `glm-4.7-flashx` as flash coding models and does NOT list `glm-5.3-flash`, yet the account config (from `zagent.mjs`) declares and the runtime accepts `glm-5.3-flash`. Worth reconciling which flash id is canonical for the benchmark.

## Reproduce
```
node bench/run.mjs zcode bench/tasks-hard/h3_json_patch flash-r1 --model zai/glm-5.3-flash
node bench/run.mjs zcode bench/tasks-hard/h3_json_patch main-r1 --model zai/glm-5.3
```
