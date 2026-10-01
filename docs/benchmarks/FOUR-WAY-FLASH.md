# Four-way comparison on GLM-5.3-Flash — 2026-09-08

120 cells, 30 per lane, 10 tasks x 3 repeats, every lane pinned to the same model
during the free off-peak window. **0 invalid cells.**

## Correctness and wall time

| lane | pass | median | mean |
|---|---|---|---|
| zagent (`zcode`) | 29/30 | 28.0s | 39.5s |
| `zcode-app-cli` | 29/30 | 25.9s | 34.0s |
| `zcode-official` | 28/30 | 33.2s | 42.3s |
| `claude_code` | 27/30 | 30.0s | 45.5s |

## Is any difference real? No.

Paired by (task, repeat), so each comparison is the same task on the same model:

| vs | median delta | sign test | Wilcoxon | bootstrap 95% CI | verdict |
|---|---|---|---|---|---|
| `claude_code` | −2.8s | p=0.362 | p=0.472 | [−8.8, +6.3]s | **parity** |
| `zcode-app-cli` | +1.8s | p=0.585 | p=0.233 | [−2.2, +7.0]s | **parity** |
| `zcode-official` | −2.1s | p=0.585 | p=0.217 | [−7.2, +1.0]s | **parity** |

Negative = zagent faster. **No confidence interval excludes zero**, and no test
reaches p<0.05. At n=30 per pair, with the run-to-run spread these tasks have,
nothing here supports a speed claim in either direction.

The honest summary: **zagent performs the same as claude_code, as the official runtime,
and as zcode-app-cli.** Matching claude_code was the goal; the data says it is matched.
It does not say anything is faster, and this file exists so nobody later claims
it does.

## What had to be fixed before the numbers meant anything

1. **n=1 per cell.** The first matrix ran each cell once. Same-kernel, same-task
   spread is 1.1x-3.8x, so n=1 measures noise. Now 3 repeats, paired.
2. **No recorded model.** The first matrix recorded no model at all, so afterwards
   nobody could tell which model a lane had used. Every record now carries model,
   HOME, runtime entry, node version and start time.
3. **Throttling scored as failure.** z.ai answers `[1302] Rate limit` and
   `[1308] Usage limit` with HTTP 429; the harness exited empty and that graded as
   `pass:false` — indistinguishable from a wrong answer, and biased toward whichever
   lane was not throttled. Those are now `invalid` with no verdict, and re-run.
4. **1302 and 1308 conflated.** One clears in seconds, the other lasts hours. The
   matrix now stops on a usage wall instead of grinding invalid cells into it.
5. **The flash pin broke a lane.** `zcode-app-cli` located its entry with
   `os.homedir()`, and the pin overrides HOME, so it died with MODULE_NOT_FOUND and
   scored 0/3 for a reason unrelated to the model. Entries resolve from
   `BENCH_REAL_HOME` now.

Every one of those would have produced a confident, wrong comparison.
