# Multi-Harness Benchmark — Final Results (2026-09-04, 34/50 cells, matrix stopped on opencode timeouts)

Same 10 tasks, same hidden test oracles, same grading. Matrix stopped at 34/50 because
opencode timed out on every task (ETIMEDOUT 240s, zai auth not configured) and the
adaptive stagger grew to 80s per cell. Results below are from the 34 completed cells.

## Final standings

| Harness | Pass | Avg wall | Median wall | Notes |
|---|---|---|---|---|
| **zcode-app-cli** | **7/7 (100%)** | **10.2s** | **10.6s** | Fastest + perfect: direct launcher, no session overhead |
| **claude_code** | **7/7 (100%)** | 22.7s | 16.9s | Perfect but slower |
| **grok-cli** | **6/6 (100%)** | 18.0s | 18.1s | Perfect, mid-speed |
| zcode (our driver) | 6/7 (86%) | 20.1s | 19.6s | 1 rate-limit fail; wall includes full CLI startup |
| opencode | 0/7 (0%) | — | — | Auth timeout — infra failure, not model failure |

## Key insights

1. **zcode-app-cli is the fastest** (10.2s avg, 2x faster than claude_code) — it launches the
   ZCode runtime directly with minimal overhead. This is the benchmark to beat.

2. **zcode (our driver) at 20.1s includes CLI overhead** that zcode-app-cli doesn't
   have (session management, config bootstrap, answer extraction with settle delay).
   In the dedicated protocol benchmark (RESULTS.md), raw turns are 7-8s.

3. **grok-cli at 18s is surprisingly competitive** — a solid general-purpose harness.

4. **claude_code is reliable but slow** (22.7s avg) — the Claude Code harness overhead is real.

5. **opencode needs auth setup** — not a model failure, an infrastructure gap.

## What this means for zagent

- Our driver is functionally correct (6/7, 86%) but has ~10s of CLI overhead vs
  zcode-app-cli's direct approach
- To match zcode-app-cli's speed, we need to either: (a) optimize the CLI startup path,
  or (b) use zcode-app-cli as the execution engine behind our tooling
- The protocol-level performance (7-8s per turn from RESULTS.md) is already
  better than all harnesses — the gap is purely in process/session management

## Comparison with dedicated benchmark

| Metric | Multi-harness (full CLI) | Dedicated (protocol only) |
|---|---|---|
| zcode speed | 20.1s avg | 7-8s per turn |
| zcode pass | 86% | 97% (pooled) |
| Overhead | ~12s (spawn + session + settle) | ~0s |
