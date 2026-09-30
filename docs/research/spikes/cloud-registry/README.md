# zagent fuzz cloud — the loop, on Cloudflare

The local tmux fuzz loop already finds real bugs for free. This is the part
that is missing when the same loop runs as N stateless containers instead of three
panes: a **shared registry**, so the fan-out produces signal rather than N copies of
the same issue.

## Why a registry is the blocking piece

`journey-fuzz.mjs` decides "have I seen this defect?" with
`readdirSync(artifacts/fuzz)`. In a container that directory is empty on every cold
start and gone on every shutdown. So at N agents you get N duplicate issues and N
triage model calls for one defect — and the finding itself dies with the disk.

`claim()` replaces that question with one that has a correct answer across machines:
**exactly one agent is told to file it, everyone else bumps a counter.**

## Measured (2026-09-07, this workstation)

| | |
|---|---|
| `journey-fuzz` peak RSS | **54 MiB** (self + children) → `lite` (256 MiB) is enough |
| CPU | **~1% of wall** (0.35 s user / 37.7 s wall) — billed CPU is near zero |
| Round | 40 journeys in **295 s** |
| Cost per agent | ~**$0.0028/hr** → 10 agents ≈ $0.67/day, 1,000 ≈ $67/day |
| Platform ceiling | 1,500 vCPU / 6 TiB per account ≈ **24,000 lite instances** |

## Shape

```
Workflow FuzzLoop            durable clock — survives restarts; 365-day sleep cap
  └── fan out N containers   one round each, then exit (ephemeral by design)
        └── journey-fuzz     hermetic: no runtime, no credential, no quota, NO MODEL
              └── finding → POST /claim → exactly one filer
                                └── triage (free model) → GitHub issue
                                      └── existing review gate — never merges
```

Two properties worth keeping:

- **The finder spends no model at all.** Only writing a failure up costs anything,
  and only for defects that are new *and* already reproduced twice.
- **`never merges` is unchanged.** Scaling the finder does not scale merge authority.

## Files

| | |
|---|---|
| `schema.sql` | one table of defects, one of heartbeats |
| `registry-core.mjs` | the SQL and the pulse rule, shared by both runtimes |
| `worker.js` | the registry on Cloudflare (Worker + D1) |
| `server.mjs` | the same contract locally (node:sqlite) — used by the tests |
| `client.mjs` | what the fuzzer calls; with no `FUZZ_REGISTRY_URL` it is today's directory |
| `containers-worker.js` | the fan-out: N disposable agents |
| `fuzz-workflow.js` | the durable clock, with a stop condition |
| `Dockerfile` | the agent image (`lite`) |
| `triage-worker.js` | findings -> a free-model write-up -> a GitHub issue -> marked triaged |
| `journey-fuzz-registry.patch` | the ~15-line change to `scripts/journey-fuzz.mjs` (cut 2026-09-07 against an earlier revision of that script; does NOT apply after the `dedupMemory` refactor — port by replacing the `dedupMemory(dirs)` call with `registry({ dir })` + `await reg.claim(fp, record)`) |

## A defect this work found in the original shell triage script

The shell triage script instructed the model to end each issue with
`node scripts/journey-fuzz.mjs --seed <seed>` — but the finding record has no `seed`
field (`columns, exitCode, fingerprint, foundAt, invariants, screenAtRest, script,
spec, timedOut`). Asked for a value that is not in its input, the model invents one:
running that exact prompt against the real finding `d950776c54bd` on
`opencode/deepseek-v4-flash` produced the closing command `reproduce d950776c54bd`,
which does not exist.

A seed alone would not repro either — the RNG advances per journey, so a replay needs
the seed *and* the journey index. `script` is the only deterministic part of a record.
`triage-worker.js` therefore builds the reproduction block itself and tells the model
to emit it verbatim, instead of asking the model to find one.

## Deploy

```bash
wrangler d1 create fuzz-registry           # put the id in wrangler.jsonc
wrangler d1 execute fuzz-registry --file schema.sql --remote
wrangler secret put REGISTRY_TOKEN
wrangler deploy
curl -X POST "$WORKER/fan-out?n=10"        # start with 10
```

Deploying needs a Cloudflare API token with Workers, D1 and Containers permissions; the
token is supplied through the environment and never committed.

## Tests

`node --test test-registry.mjs` — 6 tests. The first one asserts the *current*
duplicate-storm behaviour so the fix has something to be a fix of. Mutation-checked:
breaking `(hits = 1) AS claimed` fails exactly the two dedup tests.
