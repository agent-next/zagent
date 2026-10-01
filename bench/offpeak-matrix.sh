#!/usr/bin/env bash
# Paced four-way matrix, run inside the free-flash window.
#
# The one-shot matrix burned the whole 5-hour quota in one go and still produced
# n=1 per cell, which cannot separate client overhead from the model's own
# run-to-run variance (measured spread on the SAME kernel and task: 1.1x-3.8x).
#
# This runner does the opposite:
#   * it only runs while `zagent offpeak` says the window is open, where
#     GLM-5.3-Flash costs zero quota, and STOPS the moment it closes;
#   * it pins every lane to flash so all four are measured on the same model —
#     the first matrix recorded no model at all, so its conditions could not be
#     rechecked afterwards;
#   * it repeats each cell, because one sample per cell measures noise;
#   * it is resumable: a valid receipt is never re-run, so it can be stopped and
#     restarted across several windows instead of one long burn.
#
#   REPEATS=3 bash bench/offpeak-matrix.sh
#
# The ZCode lanes are pinned by HOME isolation, not by editing the user's config:
# the kernel reads ~/.zcode/cli/config.json, and its documented `--settings <path>`
# flag is rejected by its own argument parser (verified 2026-09-07), so an isolated
# HOME carrying a flash-pinned copy is the only clean pin available.

set -u
ROOT="${BENCH_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"
REPEATS="${REPEATS:-3}"
RUN_ID="${MATRIX_RUN_ID:-flash}"
TASKS="${TASKS:-t1_rot13 t2_fixbug t3_toposort t4_multifile t5_json t6_regex t7_cli t8_apiclient t9_sql t10_refactor}"
LANES="${LANES:-claude_code zcode zcode-official zcode-app-cli}"
GAP="${GAP:-8}"

# --- the flash-pinned HOME ----------------------------------------------------
# Captured BEFORE any HOME override: the pin isolates config, not installed
# binaries, and a lane that locates its entry under $HOME must still find it.
export BENCH_REAL_HOME="$HOME"
# The temp home holds a copy of the provider key: mktemp -d makes it owner-only (0700),
# and it is removed on exit. A caller-supplied FLASH_HOME is theirs: left in place, mode untouched.
if [ -z "${FLASH_HOME:-}" ]; then
  FLASH_HOME="$(mktemp -d "${TMPDIR:-/tmp}/zbench-flash-home-XXXX")"
  trap 'rm -rf "$FLASH_HOME"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
fi
mkdir -p "$FLASH_HOME/.zcode/cli"
node -e '
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const src = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".zcode/cli/config.json"), "utf8"));
src.model = { main: "zai/glm-5.3-flash", lite: "zai/glm-5.3-flash" };
const out = path.join(process.argv[1], ".zcode/cli/config.json");
fs.writeFileSync(out, JSON.stringify(src, null, 2), { mode: 0o600 });
' "$FLASH_HOME" || { echo "could not build the flash config"; exit 1; }
echo "flash-pinned HOME: $FLASH_HOME"

window_open() { node "$ROOT/packages/cli/zagent-offpeak.mjs" >/dev/null 2>&1; }

if ! window_open; then
  echo "off-peak window is CLOSED — flash is not free right now. Nothing run."
  node "$ROOT/packages/cli/zagent-offpeak.mjs" || true
  exit 3
fi

done_n=0; skipped=0; invalid_n=0; stopped=""
for repeat in $(seq 1 "$REPEATS"); do
  for task in $TASKS; do
    for lane in $LANES; do
      RID="${RUN_ID}r${repeat}"
      REC="bench/results/mh_${lane}_${task}_${RID}.json"
      # A receipt only counts as done if it holds a real measurement. A cell the
      # provider throttled carries invalid:"rate-limited" and must be re-run, or
      # the resume would lock in a lane's throttling as if it were its score.
      if [ -f "$REC" ] && node -e '
        const r = JSON.parse(require("node:fs").readFileSync(process.argv[1]));
        process.exit(r.invalid ? 1 : 0);
      ' "$REC" 2>/dev/null; then
        skipped=$((skipped+1)); continue
      fi
      if ! window_open; then
        stopped="window closed"; break 3
      fi
      echo "=== $(date +%T) $RID $lane $task"
      case "$lane" in
        claude_code)  BENCH_MODEL=glm-5.3-flash ANTHROPIC_MODEL=glm-5.3-flash \
                timeout 400 node bench/run-multi.mjs "$lane" "bench/tasks/$task" "$RID" 2>&1 | head -2 ;;
        *)    BENCH_MODEL=zai/glm-5.3-flash HOME="$FLASH_HOME" \
                timeout 400 node bench/run-multi.mjs "$lane" "bench/tasks/$task" "$RID" 2>&1 | head -2 ;;
      esac
      # Back off when the provider throttled us. z.ai returns 1302 with NO
      # retry-after, so the only correct response is to wait longer and retry;
      # hammering at the fixed gap just converts the whole lane into invalid cells.
      if [ -f "$REC" ] && node -e '
        const r = JSON.parse(require("node:fs").readFileSync(process.argv[1]));
        process.exit(r.invalid ? 0 : 1);
      ' "$REC" 2>/dev/null; then
        invalid_n=$((invalid_n+1))
        reason=$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1])).invalid||""))' "$REC" 2>/dev/null)
        if [ "$reason" = "usage-limit" ]; then
          # The plan's usage window, not concurrency. It lasts hours, so every
          # further cell would be one more invalid receipt against the same wall.
          echo "    usage window exhausted — stopping. Retry after the reset; valid receipts are kept."
          stopped="usage limit reached"; break 3
        fi
        backoff=$(( GAP * 4 ))
        echo "    invalid cell ($reason) — backing off ${backoff}s"
        sleep "$backoff"
      else
        sleep "$GAP"
      fi
      done_n=$((done_n+1))
    done
  done
done

echo
echo "ran $done_n cells ($invalid_n invalid), skipped $skipped already-valid receipts${stopped:+, stopped: $stopped}"
echo "results: bench/results/mh_*_${RUN_ID}r*.json"
