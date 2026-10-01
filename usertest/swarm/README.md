# opencode real-user flock (SWARM S0-lite)

Goal: use opencode with a free model to test zagent like a real human user --
random, continuous, large scale -- find as many problems as possible, fix them,
and close the loop.

## What it is

Free opencode agents (`opencode/muse-spark-1.3-contributor-free`) play REAL
USERS on disposable sandboxes that have zagent installed from a packed tarball
and NO credential. Each round: fresh sandbox → one random persona card
(`scenarios.mjs`) → the agent explores like a human → reports
`FLOCK-FINDING` lines with exact command + expected + got. `--triage` prints
deduped findings to stdout; the supervising lane files them and routes fixes,
and the flock retests the fixed build (a fast-loop tarball (FLOCK_FAST_TARBALL) turns over ≤2 min
after a merge) — the closed loop.

## Why credential-free in v1

The free third-party model must never see a credential or private repo
content. The sandbox holds no key and no source; the no-credential surface
(install, help, doctor, refusal honesty, arg fuzzing, CJK, paste, non-TTY,
JSON honesty) is exactly the first-ten-minutes surface where new users are
lost. v2 adds signed-in live turns behind a local key-holding proxy so the
agent still never sees the key.

## Run

```sh
node usertest/swarm/opencode-flock.mjs                  # 4 workers, 8h cap
node usertest/swarm/opencode-flock.mjs -n 6 -r 12       # bounded batch
node usertest/swarm/opencode-flock.mjs --triage         # deduped findings
node usertest/swarm/opencode-flock.mjs --engine claude-lane    # brokered: pool key (FLOCK_LANE_API_KEYS/FLOCK_LANE_API_KEY/FLOCK_LANE_KEY_CACHE) stays host-side; refuses without one
node usertest/swarm/opencode-flock.mjs -n 5 --claude-lane-workers 1  # mixed mode: claude-lane workers brokered, the rest opencode
```

Records: `artifacts/verify/flock-data/runs.ndjson` (gitignored; override the directory with `FLOCK_DIR`). Known
findings list: `flock-data/known-findings.md` — a finding moves there once
filed (issue/PR), so `--triage` prints only NEW problems.

## Stop condition & failure path (no-bare-cron rule)

- Stop: `--max-hours` (default 8) or bounded `-r`; the scheduler that launches it
  restarts it and triages — the flock is never a silent background job.
- Failure path: 3 consecutive INFRA rounds → backoff + heartbeat log line;
  the scheduler's heartbeat surfaces flock state.
- Classification: `FINDING` (agent reported, with repro seed), `OK` (explicit
  clean verdict), `NOISY` (agent finished without a verdict line — rerun
  class), `INFRA` (opencode/tooling failure — never a product finding).

## Honesty contract on cards

Every card states the machine has no credential and what RIGHT looks like
(fast, human-readable refusal/guidance) vs BUG (stack trace, hang, silent
exit 0, fabricated data) — so a refusal is judged as correct, not as a
failure.

## Living card pool

The 14 base cards are the floor, not the ceiling. `scenarios-extra.mjs`
accumulates cards born from REAL events — every FLOCK finding, every live-session user
report, every review finding that exposes a user-facing
surface spawns a card THE SAME TICK it is learned (origin field records
where each came from). Fixed-bug cards double as regression watches.

## Model pool

`FLOCK_MODELS` (default: muse-spark-1.3, union-alpha, nemotron-3-ultra —
all via the same filtered opencode-gateway auth, zero new secrets in the
wall). Rounds rotate; triage prints cross-model agreement (`·Nmodels`) —
one finding from two model families is far stronger signal than two hits
from one.

## Direction

"Free agent models as simulated real users" is intended to become a
first-class capability, not just this repo's test infra: generalized target (any CLI),
card packs (builtin zagent pack + user-supplied), the proven
bwrap+netns+allowlisted-egress wall, triage with cross-model weighting,
and CI-friendly JSON exit.

## Lane labels

The flock runs several worker lanes; the labels used in records and flags are
neutral descriptions, not product names:

| label | what it is |
| --- | --- |
| `opencode` | opencode CLI on a free model, walled by bubblewrap + private netns |
| `claude-lane` (`--engine claude-lane`, `--claude-lane-workers K`) | Claude Code CLI pointed at a brokered Anthropic-compatible endpoint (keys via `FLOCK_LANE_API_KEYS`, `FLOCK_LANE_API_KEY` or a file named by `FLOCK_LANE_KEY_CACHE`; `FLOCK_LANE_UPSTREAM` overrides the endpoint) |
| `qwen` (`--engine qwen`, `--qwen-workers K`) | an OpenAI-compatible vLLM endpoint behind the broker (`FLOCK_QWEN_KEY` / `FLOCK_QWEN_KEY_FILE`, `FLOCK_QWEN_UPSTREAM`) |

Requirements: Linux with `bwrap` (bubblewrap) and `python3`. The wall masks
`$HOME` (override with `FLOCK_HOST_HOME`) and this checkout.
