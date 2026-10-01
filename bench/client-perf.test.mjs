#!/usr/bin/env node
// The harness is only useful if it measures the clients that are actually here.
// Its first version hardcoded a worktree path that was later deleted, so it would
// have failed on a path lookup rather than measured anything — and a "SKIP" that
// is not printed is indistinguishable from a client that scored nothing.
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, 'client-perf.mjs'), 'utf8');
const tests = [];
const test = (n, f) => tests.push([n, f]);

test('no client is located by an absolute checkout path', () => {
  const bad = src.match(/'\/home\/[^']*'/g) ?? [];
  assert.deepEqual(bad, [], `hardcoded paths rot: ${bad.join(', ')}`);
});

test('our client resolves relative to the repo, and exists', () => {
  assert.match(src, /path\.resolve\(path\.dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.'\)/);
  const ours = path.join(here, '..', 'packages/cli/zagent.mjs');
  assert.ok(existsSync(ours), `zagent.mjs should exist at ${ours}`);
});

test('a missing client is skipped loudly, never measured as zero', () => {
  assert.match(src, /if \(!existsSync\(cmd\[1\]\)\)/);
  assert.match(src, /SKIP \$\{label\}/);
});

test('the comparison client is found under the real home, not the pinned one', () => {
  // The flash pin overrides HOME; a harness that resolves an installed binary
  // through it measures nothing. Same defect as bench/run-multi.mjs had.
  assert.match(src, /process\.env\.BENCH_REAL_HOME \|\| homedir\(\)/);
});

let pass = 0, fail = 0;
for (const [n, f] of tests) {
  try { f(); pass++; } catch (e) { fail++; console.error(`FAIL ${n}\n  ${e.message}`); }
}
console.log(`${pass}/${tests.length} client-perf tests passed`);
process.exit(fail ? 1 : 0);
