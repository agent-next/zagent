# zagent — agent guide

Org rules: https://github.com/agent-next/.github/blob/main/AGENT-STANDARD.md
(hard limits, PR/merge policy).

## Purpose

zagent is the public npm package `zagent` (MIT): an unofficial coding-agent
terminal for the GLM engine — streaming TUI, tool calls, checkpoints, quota
insight — that drives a locally installed ZCode runtime on the user's own
Coding Plan. Status: active. Release state lives in `VERSION` and
`CHANGELOG.md`; contributor-facing notes in `CONTRIBUTING.md`.

## Orient

```sh
git status --short
git branch --show-current
git worktree list
gh pr list --repo agent-next/zagent --state open
```

Read first: `README.md`, `CONTRIBUTING.md`, `package.json`. Layout: `bin/`
(CLI entry points), `packages/{cli,driver,tui}/` (shipped runtime modules),
`scripts/` (test/verify tooling), `skills/`, `docs/`.

## Setup

`make setup` runs `npm install` (sole dependency: `ws`). Requires Node
`^22.15.0 || >=23.5.0` (`package.json` engines); CI runs Node 22.

## Check

`make check` runs `npm test` = `node scripts/verify-public-package.mjs`: packs
the publish payload, installs the tarball into a temp prefix, and exercises the
installed `zagent`/`za` bins (`--version`, `--help`, `doctor`,
`inspect --json`) plus a syntax check of every shipped `.mjs`. It needs no
ZCode runtime, account, or API key. The same `npm test` is the gate CI runs on
ubuntu/windows/macos in `.github/workflows/test-matrix.yml`. For a focused
syntax check: `node --check <file.mjs>`.

## Boundaries

- Public repository: never commit secrets, credentials, device identity, or
  unredacted logs.
- The publish payload is allowlisted: `allowed`/`forbidden` in
  `scripts/verify-public-package.mjs`. Anything matching `forbidden` (tests,
  docs, node_modules, `.env`, internal-only modules) must not ship; keep
  `package.json` `files` and the allowlist in sync.
- Running the CLI for real drives an installed ZCode runtime on a paid GLM
  Coding Plan; the check gate needs neither.
- Unofficial project, not affiliated with Z.ai; ship no Z.ai binaries.

## Done

Branch per change -> PR to `master`. New code needs a test with a real oracle;
`make check` green locally and CI green before merge. Put receipts (commands +
output) in the PR body.
