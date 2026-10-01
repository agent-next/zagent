# zagent on FrontierHarness Eval (local adapter)

Runs the published 30-task set (21 Terminal-Bench via Harbor 0.22, 9 DeepSWE via
datacurve-pier 0.3.1) with zagent driving the official ZCode kernel headless on the
GLM Coding Plan. Results are `methodology_comparable: false` (local Docker, no Runta
checkpoint, model is GLM not Kimi K3) — the same status as the z.ai lead's GLM chart.

Files: `zagent_common.py` (install/run/usage helpers), `zagent_harbor.py`,
`zagent_pier.py` (runner adapters), `run_task.py` (one task), `run-local-trials.sh`
(trial loop + official scoring), `pricing-glm.json` (Z.ai list prices, 2026-09-14).

Layout expected under `$FH_ROOT` (default `$HOME/frontierharness`): `eval/` (frontier-harness-eval/eval clone),
`terminal-bench-2/` (laude-institute/terminal-bench-2 @ 69671fb), `deep-swe/`
(datacurve-ai/deep-swe @ 435ee89), `zagent-runtime.tar.gz` (Node 22 + `zagent` npm
prefix + `kernel/zcode.cjs` from a licensed ZCode desktop install; never redistributed),
`.zai_key` (0600; or pass `--key-file` to `run_task.py`). Prereqs: Docker + compose plugin, `uv tool install harbor==0.22.0
datacurve-pier==0.3.1`, jq, python3.

```sh
export FH_ROOT=$HOME/frontierharness
cp -r bench/frontierharness "$FH_ROOT/adapter"
cd "$FH_ROOT/adapter" && ./run-local-trials.sh --run-id smoke --tasks "$FH_ROOT/eval/skills/frontierharness-eval/smoke-tasks.txt"
# full set: the 30 ids from $FH_ROOT/eval/benchmark.json task_ids
node eval/skills/frontierharness-eval/scripts/normalize-results.mjs --run runs/<id> --label zagent --pricing adapter/pricing-glm.json
```

Cost basis: `cost_usd` is list price on observed cache reads (`zagent -p --json` has no
per-call cache detail), so the eval's `cost_first_cold_usd` stays null and its
`effective_cost_per_pass` is empty; report `sum(cost_usd) / passes` and label it
"observed-cache basis" (the same basis as the published GLM charts).
