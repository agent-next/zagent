#!/usr/bin/env bash
# Multi-harness matrix: 10 tasks x 1 run per harness, adaptive stagger.
# Lanes: claude_code (Claude Code routed to the same model) is the performance baseline. zcode-official is the
# stock kernel with no client of ours in the path — the control for our overhead,
# and the honest stand-in for the desktop GUI, which cannot be driven headlessly.
cd "${BENCH_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
GAP=5; CLEAN=0
for task in t1_rot13 t5_json t6_regex t9_sql t2_fixbug t3_toposort t7_cli t8_apiclient t4_multifile t10_refactor; do
  for harness in claude_code zcode zcode-app-cli zcode-official; do  # add opencode or grok-cli here where they run
    RID="${MATRIX_RUN_ID:-m1}"
    REC="bench/results/mh_${harness}_${task}_${RID}.json"
    if [ -f "$REC" ] && node -e '
      const r = JSON.parse(require("node:fs").readFileSync(process.argv[1]));
      process.exit(r.invalid ? 1 : 0);
    ' "$REC" 2>/dev/null; then
      echo "=== skip $RID $harness $task (valid receipt)"; continue
    fi
    echo "=== $(date +%T) $RID $harness $task"
    out=$(timeout 400 node bench/run-multi.mjs "$harness" "bench/tasks/$task" "$RID" 2>&1 | head -2)
    echo "$out"
    if echo "$out" | grep -qE '"pass":false.*spawn_error":"[^n]|error|timeout|FATAL' || [ -z "$out" ]; then
      GAP=$(( GAP < 60 ? GAP * 2 : GAP )); CLEAN=0; echo "--- gap -> $GAP"
    else
      CLEAN=$(( CLEAN + 1 )); [ $CLEAN -ge 3 ] && GAP=$(( GAP > 5 ? GAP / 2 : 5 ))
    fi
    sleep "$GAP"
  done
done
echo "MULTI-MATRIX-DONE $(date +%T)"
