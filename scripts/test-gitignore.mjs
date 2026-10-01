#!/usr/bin/env node
// Gate for .gitignore: the harnesses that write run output inside the tree
// (usertest results, verify receipts) must never be committable by accident.
// A missing entry is invisible until someone runs `git add -A` after a live
// run and pushes captured screens and logs — the public-hygiene gate skips
// usertest/ by design, so nothing else catches it.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// check-ignore exits 0 for ignored paths, 1 for tracked/unignored ones.
const ignored = (rel) => spawnSync('git', ['check-ignore', '-q', rel],
  { cwd: root, encoding: 'utf8', timeout: 15_000 });

const mustIgnore = [
  // emulator.mjs/random-user.mjs run logs and PTY fail screens
  'usertest/results/run-s32.jsonl',
  'usertest/results/s32-fail-screen.ansi',
  // soak/flock receipts (artifacts/ predates this gate; keep it pinned too)
  'artifacts/verify/soak-local.md',
];
for (const rel of mustIgnore) {
  const r = ignored(rel);
  assert.equal(r.status, 0, `${rel} must be gitignored (exit ${r.status}${r.stderr ? `: ${r.stderr.trim()}` : ''})`);
}

// Negative control: the oracle must be able to say "not ignored", or the
// passes above prove nothing.
assert.equal(ignored('scripts/test-gitignore.mjs').status, 1, 'a checked-in file must not read as ignored');

console.log('PASS gitignore: run-output directories are committable only on purpose');
