#!/usr/bin/env bash
# Local (no Runta) FrontierHarness trial loop for the zagent adapter.
# Usage: run-local-trials.sh --run-id ID --tasks FILE [--model zai/glm-5.3] [--out $FH_ROOT/runs] [--timeout 5400]
# FILE lists suite-prefixed ids (terminal-bench/<task> | datacurve/<task>), one per line.
# Writes <out>/<id>/run.json and trials/<suite>-<task>/{trial.json,jobs/,runner.log},
# then scores each trial with the official calculate-cost.py against pricing-glm.json.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=${FH_ROOT:-$HOME/frontierharness}
FH=${FH_SCRIPTS:-$ROOT/eval/skills/frontierharness-eval/scripts}
MODEL=zai/glm-5.3; OUT=$ROOT/runs; TIMEOUT=5400; RUN_ID=""; TASKS=""
while [ $# -gt 0 ]; do case "$1" in
  --run-id) RUN_ID=$2; shift 2;; --tasks) TASKS=$2; shift 2;; --model) MODEL=$2; shift 2;;
  --out) OUT=$2; shift 2;; --timeout) TIMEOUT=$2; shift 2;; *) echo "unknown arg $1" >&2; exit 2;; esac; done
[ -n "$RUN_ID" ] && [ -f "$TASKS" ] || { echo "need --run-id and --tasks FILE" >&2; exit 2; }
case "$TIMEOUT" in ''|*[!0-9]*) echo "--timeout must be a positive integer (seconds), got: $TIMEOUT" >&2; exit 2;; esac
RUN_DIR=$OUT/$RUN_ID; mkdir -p "$RUN_DIR/trials"
ZV=$(tar -xzOf "$ROOT/zagent-runtime.tar.gz" ./prefix/lib/node_modules/zagent/package.json 2>/dev/null | jq -r .version)
KSHA=$(tar -xzOf "$ROOT/zagent-runtime.tar.gz" ./kernel/zcode.cjs 2>/dev/null | sha256sum | cut -c1-64)
[ -f "$RUN_DIR/run.json" ] || jq -n --arg id "$RUN_ID" --arg model "$MODEL" --arg zv "${ZV:-unknown}" \
  --arg started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson timeout "$TIMEOUT" \
  --arg host "$(hostname)" --arg docker "$(docker --version)" --arg kernel "official ZCode desktop 3.11.2 kernel, sha256 ${KSHA:-unknown}" \
  '{run_id:$id, harness:"zagent", harness_version:$zv, model:$model, provider:"Z.ai GLM Coding Plan (api.z.ai)",
    cmd_template:"run_task.py --suite {suite} --task {task} --model {model} --jobs {jobs}", timeout_seconds:$timeout,
    started_at:$started, runner:{host:$host, docker:$docker, harbor:"0.22.0", pier:"0.3.1", runtime:"local Docker, one task at a time"},
    kernel:$kernel, egress_policy:{mode:"none", scope:"local Docker; Harbor/Pier native isolation only", allowed_hosts:[]},
    methodology_comparable:false,
    methodology_notes:["Local Docker run without Runta checkpoints; not leaderboard-comparable.","Model is GLM (not Kimi K3); costs use Z.ai list prices (pricing-glm.json), the Coding Plan itself is a subscription.","Kernel is the official ZCode desktop 3.11.2 kernel copied from a licensed install; zagent drives it headless."]}' \
  > "$RUN_DIR/run.json"
passed=0; total=0
while read -r entry; do
  [ -n "$entry" ] || continue; case "$entry" in \#*) continue;; esac
  suite=${entry%%/*}; task=${entry#*/}; slug="$suite-$task"; trial_dir=$RUN_DIR/trials/$slug
  if [ -f "$trial_dir/trial.json" ] && jq -e '.status=="success" or .status=="failure"' "$trial_dir/trial.json" >/dev/null 2>&1; then
    echo "$entry: already scored ($(jq -r .status "$trial_dir/trial.json"))"; total=$((total+1)); [ "$(jq -r .success "$trial_dir/trial.json")" = true ] && passed=$((passed+1)); continue; fi
  rm -rf "$trial_dir"; mkdir -p "$trial_dir/jobs"
  echo "=== $(date -u +%H:%M:%SZ) $entry start"
  start=$(date +%s)
  timeout -k 60 "$TIMEOUT" python3 "$HERE/run_task.py" --root "$ROOT" --suite "$suite" --task "$task" --model "$MODEL" --jobs "$trial_dir/jobs" > "$trial_dir/runner.log" 2>&1
  code=$?; duration=$(( $(date +%s) - start ))
  status=failure; started=false
  [ -n "$(find "$trial_dir/jobs" -name '*.json' 2>/dev/null | head -1)" ] && started=true
  if [ "$code" = 124 ] || [ "$code" = 137 ]; then [ "$started" = true ] && status=failure || status=infra_invalid; fi
  [ "$started" = false ] && status=infra_invalid
  # A quota-exhausted window (Z.ai code 1308) or an unanswered rate-limit storm is
  # infrastructure, not the harness failing the task: leave it re-runnable.
  if [ "$status" = failure ] && [ -z "$(find "$trial_dir/jobs" -path '*__*' -name result.json -exec jq -e '.verifier_result.rewards.reward != null' {} \; 2>/dev/null | grep -m1 true)" ]; then
    if grep -qsE '1308|Usage limit reached|responseStatus: 429' "$(find "$trial_dir/jobs" -name zagent.stderr | head -1)" 2>/dev/null; then status=infra_invalid; fi
  fi
  jq -n --arg id "$entry" --arg task "$task" --arg suite "$suite" --arg status "$status" \
    --argjson duration "$duration" --argjson exit_code "$code" --arg runtime "local:$(hostname)" \
    '{id:$id, title:$task, suite:$suite, status:$status, success:false, duration_seconds:$duration, exit_code:$exit_code,
      runtime:$runtime, checkpoint:"none (local Docker)", cost_first_cold_usd:null, turns:null, cache_hit_rate_normalized:null, included_in_efficiency:false}' \
    > "$trial_dir/trial.json"
  python3 "$FH/calculate-cost.py" --trial "$trial_dir" --model "$MODEL" --harness zagent --pricing "$HERE/pricing-glm.json" --score --write >> "$trial_dir/runner.log" 2>&1 || echo "$entry: scoring error (see runner.log)" >&2
  total=$((total+1)); s=$(jq -r .status "$trial_dir/trial.json"); ok=$(jq -r .success "$trial_dir/trial.json"); [ "$ok" = true ] && passed=$((passed+1))
  echo "=== $(date -u +%H:%M:%SZ) $entry $s success=$ok exit=$code ${duration}s cost=$(jq -r '.cost_usd // "n/a"' "$trial_dir/trial.json")"
done < "$TASKS"
echo "RUN $RUN_ID: $passed/$total passed"
