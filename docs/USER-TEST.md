# zagent Real Human User Test Protocol (v1)

Every feature must pass. A feature "passes" only when a human tester who has never seen
the codebase completes the task without the test facilitator intervening.

## Test environment design

### Option A: Clean Linux user (fastest, this machine)
```bash
sudo useradd -m zctest -s /bin/bash
sudo su zctest -c 'mkdir -p ~/bin && ln -s "$ZAGENT_REPO/bin/zagent" ~/bin/zz'   # ZAGENT_REPO = path of your zagent checkout
# zctest now has: no ~/.zcode, no ~/.claude — a genuine fresh profile
# But HAS the repo (symlinked) — tests discovery of runtime + config bootstrap
```
Teardown: `sudo userdel -r zctest`

### Option B: Docker (hermetic, CI-able)
```dockerfile
FROM node:22
RUN useradd -m zctest
# Install runtime: either npm i -g zcode-app-cli or copy the desktop app's bundled runtime
# Copy the zagent repo to /opt/zagent, symlink bin/zagent as zz
```

### Option C: Fresh VM/cloud instance (full zero-state, ~5 min)
```bash
# Spin up a tiny cloud instance, clone the repo, run the test script
```

**Recommendation**: A for now (fastest iteration), B for CI, C for pre-release.

## Test suites

### S1: Cold Start (never used ZCode before) — 10 min max
| # | Task | Pass criteria | Time limit |
|---|---|---|---|
| 1.1 | Run `zz doctor` | Prints runtime + config info, no crash | 30s |
| 1.2 | Set key: `export ZAI_API_KEY=...` then `zz doctor --fix` | Says "fixed: config created" | 30s |
| 1.3 | Start `zz` | Fullscreen TUI renders, input box visible | 10s |
| 1.4 | Type "hello" and press Enter | Gets a response within 30s | 30s |
| 1.5 | Type "what is 2+2" | Gets "4" or equivalent | 30s |
| 1.6 | Press Ctrl+C or type /exit | Clean exit, no hang | 5s |

### S2: GUI User Migration (has ZCode desktop installed) — 5 min max
| # | Task | Pass criteria | Time limit |
|---|---|---|---|
| 2.1 | Run `zz` (desktop already installed + logged in) | TUI opens, NO /login prompt, model shows zai/glm-5.3 | 10s |
| 2.2 | Type a question, get answer | Answer arrives, no retries | 30s |
| 2.3 | Run `zz sessions` | Shows sessions from both GUI and CLI | 10s |
| 2.4 | Run `zz quota reset` | Returns real 5h/weekly reset data | 10s |

### S3: Core Coding (daily driver replacement) — 30 min max
| # | Task | Pass criteria | Time limit |
|---|---|---|---|
| 3.1 | "Read this repo's README and summarize in 2 sentences" | Accurate summary | 2 min |
| 3.2 | "Find and fix the bug in [file with known bug]" | Bug fixed, file edited | 5 min |
| 3.3 | "Write a unit test for [function]" | Test file created, test passes | 5 min |
| 3.4 | "Refactor [messy function] keeping tests green" | Refactored, tests still pass | 5 min |
| 3.5 | "What files did you change? Show me the diff" | Correct diff displayed | 2 min |
| 3.6 | "Undo your changes" (rewind) | Files restored to original | 2 min |
| 3.7 | Headless: `zz -p "count lines in README.md" --json` | JSON output with answer | 1 min |

### S4: Agentic Multi-file — 15 min max
| # | Task | Pass criteria | Time limit |
|---|---|---|---|
| 4.1 | "Add an area() method to Circle in shapes.py and update describe() in report.py" | Both files edited correctly | 5 min |
| 4.2 | "Run the tests to verify" | Tests invoked, result shown | 2 min |
| 4.3 | "Now add a Rectangle class with the same interface" | New class + both files updated | 5 min |
| 4.4 | Verify all tests still pass | All green | 2 min |

### S5: Feature Surface — 15 min max
| # | Task | Pass criteria | Time limit |
|---|---|---|---|
| 5.1 | `/help` | Shows command list | 5s |
| 5.2 | `/model` | Shows model picker, can switch to flash | 10s |
| 5.3 | `/status` | Shows session info | 5s |
| 5.4 | `/compact` | Compaction runs, context shrinks | 30s |
| 5.5 | Attach an image (Ctrl+V or /paste-image) | Image visible in TUI | 10s |
| 5.6 | "Describe this image" | Correct description (vision works) | 30s |
| 5.7 | `/rewind` | Shows rewind picker, can select | 10s |
| 5.8 | `zz quota balance` | Returns billing data | 10s |
| 5.9 | Browser task: "Open [URL] and tell me the page title" | Browser-use works | 3 min |

### S6: Session Management — 10 min max
| # | Task | Pass criteria | Time limit |
|---|---|---|---|
| 6.1 | Create 2 sessions (different cwds) | Both listed in `zz sessions` | 5 min |
| 6.2 | `/resume` | Can resume a previous session | 30s |
| 6.3 | `/fork` | Can fork from a checkpoint | 30s |
| 6.4 | Exit and `zz --resume <id>` | Session restored with context | 30s |

### S7: Quota & Campaign (time-dependent) — 5 min
| # | Task | Pass criteria | Time limit |
|---|---|---|---|
| 7.1 | `zz quota balance` | HTTP 200, plans/balances data | 10s |
| 7.2 | `zz quota reset` | 5h/weekly reset info | 10s |
| 7.3 | During 23:00-09:00 CST: flash request | Zero quota consumption | 1 min |

### S8: Stress & Recovery — 10 min
| # | Task | Pass criteria | Time limit |
|---|---|---|---|
| 8.1 | Send 5 rapid prompts | All answered, no crash | 5 min |
| 8.2 | Ctrl+C mid-response | Clean interrupt, TUI stays alive | 10s |
| 8.3 | Disconnect network mid-request | Graceful error, reconnects | 2 min |
| 8.4 | Corrupt ~/.zcode/cli/config.json | `zz doctor` catches it | 30s |

## Scoring

| Suite | Points | Pass threshold |
|---|---|---|
| S1 Cold Start | 6 × 10 = 60 | 60/60 (100%) |
| S2 GUI Migration | 4 × 10 = 40 | 40/40 (100%) |
| S3 Core Coding | 7 × 10 = 70 | 65/70 (93%) |
| S4 Agentic | 4 × 10 = 40 | 40/40 (100%) |
| S5 Feature Surface | 9 × 10 = 90 | 85/90 (94%) |
| S6 Sessions | 4 × 10 = 40 | 35/40 (88%) |
| S7 Quota | 3 × 10 = 30 | 25/30 (83%) |
| S8 Stress | 4 × 10 = 40 | 35/40 (88%) |
| **TOTAL** | **410** | **≥390 (95%)** |

Each task scored: 10 (clean pass) / 5 (pass with hesitation or workaround) / 0 (fail/abandoned).

## Facilitator rules

1. **Never touch the keyboard** during the test.
2. **Record the screen** (asciinema/OBS).
3. **Timer visible** to the tester (they know the limit).
4. **Note every** facial expression change, verbal frustration, reach for another tool.
5. **Post-test interview** (5 min): "What was confusing? What would you change first?"
6. Any task the tester abandons = automatic 0 for that task + note the abandonment time.

## Running it now (any Linux machine)

```bash
# S1: fresh user
sudo useradd -m zctest -s /bin/bash
# ZAI_API_KEY must be exported in your shell. It is piped into su and read
# there — never expanded into su's argv, where /proc/*/cmdline would expose
# it to every local user for the whole run, and never written to disk. The
# TUI gets the terminal back via /dev/tty after the one-line read.
printf '%s\n' "$ZAI_API_KEY" | sudo su zctest -c "export PATH=$ZAGENT_REPO/bin:\$PATH; read -r ZAI_API_KEY; export ZAI_API_KEY; exec timeout 300 zz < /dev/tty"
# Watch the screen, score each task
sudo userdel -r zctest

# S2: GUI user (a machine that already has the ZCode desktop app)
# Just run zz as your own user (existing profile)

# S3-S6: use a small multi-file task workspace (for S4: shapes.py, report.py and a test file)
cd "$TASK_WORKSPACE" && zz

# S7: run during the campaign window (23:00-09:00 CST)
# S8: rapid-fire test
```

## What "all features must pass" means

- **Every suite ≥ its threshold** AND total ≥ 95%.
- **Zero S1/S2 failures** (cold start and GUI migration must be 100% — these are the
  first-touch moments that determine adoption).
- Any abandonment (tester gives up on a task) = automatic suite failure regardless of score.
- Results are recorded per run with per-task scoring + the screen recording.
