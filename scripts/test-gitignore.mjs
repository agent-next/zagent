#!/usr/bin/env node
// Gate for .gitignore: the harnesses that write run output inside the tree
// (usertest results, verify receipts) must never be committable by accident.
// A missing entry is invisible until someone runs `git add -A` after a live
// run and pushes captured screens and logs — the public-hygiene gate skips
// usertest/ by design, so nothing else catches it.
//
// check-ignore -q only answers yes/no, and it evaluates EVERY exclusion
// source — a rule that moved to .git/info/exclude or the runner's global
// excludes file kept this gate green after the repository rule was deleted.
// So the oracle is check-ignore -v: the matching rule's SOURCE must be the
// committed .gitignore. core.excludesFile is pinned to /dev/null so the
// runner's global config cannot mask or satisfy anything either way.
// (info/exclude cannot be neutralized per-invocation; if it ever matches here
// the source assertion below fails loudly and the culprit is inspectable.)
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// -v also reports a matching negated (!) rule, which means NOT ignored, so
// exclusion itself is judged by -q; -v only names the rule's source.
const check = (rel, mode = '-q') => spawnSync('git',
  ['-c', 'core.excludesFile=/dev/null', 'check-ignore', mode, '--', rel],
  { cwd: root, encoding: 'utf8', timeout: 15_000 });

const mustIgnore = [
  // emulator.mjs/random-user.mjs run logs and PTY fail screens
  'usertest/results/run-s32.jsonl',
  'usertest/results/s32-fail-screen.ansi',
  // soak/flock receipts (artifacts/ predates this gate; keep it pinned too)
  'artifacts/verify/soak-local.md',
];
for (const rel of mustIgnore) {
  const r = check(rel);
  assert.equal(r.status, 0, `${rel} must be gitignored (exit ${r.status}${r.stderr ? `: ${r.stderr.trim()}` : ''})`);
  // Verbose line: <source>:<lineno>:<pattern>\t<path>. The source must be the
  // repository's own .gitignore — .git/info/exclude or a global excludes file
  // matching instead means the committed rule is gone and this gate is being
  // masked by local state.
  const line = check(rel, '-v').stdout.trim().split('\n')[0];
  const source = line.split('\t')[0].split(':')[0];
  assert.equal(source, '.gitignore', `${rel} must be ignored by the repository .gitignore, not ${source}`);
}

// Negative controls. check-ignore reports tracked files as unignored no
// matter what matches, so a tracked control proves nothing — these paths are
// untracked by construction (they do not exist) and must stay unignored.
// The sibling of usertest/results/ also catches overbroad rules: .gitignore
// swallowing `usertest/` or `usertest/*` would hide the swarm's checked-in
// sources the same way it hides the run output.
for (const notIgnored of ['usertest/results-note.md', 'packages/driver/results-note.md']) {
  assert.equal(check(notIgnored).status, 1, `${notIgnored} must NOT be gitignored`);
}

console.log('PASS gitignore: run-output directories are committable only on purpose');
