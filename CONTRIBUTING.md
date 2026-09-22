# Contributing to zagent

Thanks for your interest in contributing!

## Development setup

```console
git clone https://github.com/agent-next/zagent.git
cd zagent
npm install
node bin/zagent --help
```

Node `^22.15.0 || >=23.5.0` is required.

## Pull requests

1. Fork / branch from `master`.
2. Make a minimal, focused change; keep diffs small.
3. Add or update tests for any behavior change.
4. Run the full suite: `npm test`.
5. Open a PR describing what changed and how it was verified (commands + output).

## Reporting issues

Open a GitHub issue with your OS, Node version, zagent version
(`zagent --version`), and the exact command plus output that misbehaved.
