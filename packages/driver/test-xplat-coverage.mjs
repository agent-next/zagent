// Cross-platform coverage ledger.
//
// .github/workflows/test-matrix.yml names its test files by hand. That is the
// same shape as the old `test:all` (4 of 24 named, the rest ungated) — a new
// pure-unit test is simply never run on Windows or macOS and nothing says so.
// The ubuntu lane (test.yml -> scripts/test-all.mjs) still runs everything, so
// nothing is UNGATED; what is missing is cross-platform evidence.
//
// This ledger does not guess. Every test file must be in exactly one bucket:
//   matrix     — actually run on ubuntu + windows + macos
//   EXCLUDED   — a stated, checkable reason it cannot run there
//   UNTRIAGED  — honest backlog: plausibly eligible, never verified off-Linux
// UNTRIAGED is ratcheted: it may shrink, never grow. A new test file therefore
// has to be put in the matrix or given a reason; it cannot land unclassified.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, ok, summary } from './test-util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const workflow = path.join(root, '.github', 'workflows', 'test-matrix.yml');

// What counts as a gated test file comes from the same module the runner uses.
// This ledger kept its own copy and they drifted: the runner learned a second
// filename spelling (`*.test.mjs`) and this file went on not seeing those, so a
// test could be gated by one ledger and unclassified by the other.
import { isTestFile, HELPERS } from '../../scripts/discover-tests.mjs';

// Verified blockers only. Live tests spawn the proprietary ZCode runtime, which
// is why scripts/test-all.mjs already gates them behind --live / ZAGENT_LIVE=1.
const EXCLUDED = new Map([
  ['test.mjs', 'drives a real ZCode runtime process (--live only)'],
  ['test-a2.mjs', 'drives a real ZCode runtime process (--live only)'],
  ['test-permission-live.mjs', 'drives a real ZCode runtime process (--live only)'],
  ['test-journeys.mjs', 'needs a POSIX pty via script(1); util-linux flags, absent on Windows'],
  ['test-journeys-commands.mjs', 'needs a POSIX pty via script(1); util-linux flags, absent on Windows'],
  ['test-journeys-live.mjs', 'spends real model quota through a real PTY (ZAGENT_LIVE=1 only)'],
]);

// Backlog. These spawn only process.execPath or are pure file/logic tests, so
// they are plausible matrix candidates — but that has never been demonstrated
// on Windows or macOS, and this ledger refuses to record a reason nobody checked.
const UNTRIAGED = [
  'test-core-release.mjs', 'test-d3-e2e.mjs', 'test-doctor.mjs', 'test-feishu.mjs',
  'test-goal.mjs', 'test-offpeak.mjs', 'test-packaging.mjs', 'test-permissions-rewind.mjs',
  'test-providers.mjs', 'test-public-export.mjs', 'test-public-regressions.mjs',
  'test-queue-sm.mjs', 'test-robustness.mjs', 'test-router.mjs', 'test-rpc-bridge.mjs',
  'test-rpc-frame.mjs', 'test-session-control.mjs', 'test-subagents.mjs',
  'test-telegram.mjs', 'test-tool-summary.mjs', 'test-unit.mjs', 'test-usage.mjs',
  'test-version.mjs',
];
const UNTRIAGED_BASELINE = 23; // ratchet: lower this as files move into the matrix

ok(existsSync(workflow), 'test-matrix.yml exists');
const yml = readFileSync(workflow, 'utf8');
const matrix = new Set(
  [...yml.matchAll(/packages\/(?:driver|tui)\/(test[a-z0-9.-]*\.mjs)/g)].map((m) => m[1]),
);
ok(matrix.size > 0, `matrix names ${matrix.size} test file(s)`);

// packages/tui lands here too: the ledger's whole point is that a NEW pure-unit
// test cannot be added without cross-platform evidence, and the TUI is pure logic
// (wrapping, key decoding, ANSI arithmetic) that is exactly what breaks off-Linux.
const tuiDir = path.join(root, 'packages', 'tui');
const discovered = [
  ...readdirSync(here).filter(isTestFile),
  ...(existsSync(tuiDir) ? readdirSync(tuiDir).filter(isTestFile) : []),
].sort();
ok(discovered.length > 0, `discovered ${discovered.length} driver+tui test file(s)`);

const untriaged = new Set(UNTRIAGED);

// 1. Every test file is classified exactly once.
for (const file of discovered) {
  const buckets = [
    matrix.has(file) && 'matrix',
    EXCLUDED.has(file) && 'excluded',
    untriaged.has(file) && 'untriaged',
  ].filter(Boolean);
  eq(buckets.length, 1, `${file} is in exactly one bucket (${buckets.join('+') || 'NONE'})`);
}

// 2. No stale bookkeeping: every listed file still exists.
for (const file of [...EXCLUDED.keys(), ...untriaged]) {
  ok(discovered.includes(file), `${file} listed in the ledger still exists`);
}
for (const file of matrix) {
  ok(discovered.includes(file) || HELPERS.has(file),
    `${file} named by test-matrix.yml still exists`);
}

// 3. Every exclusion states a reason.
for (const [file, reason] of EXCLUDED) {
  ok(typeof reason === 'string' && reason.trim().length > 0, `${file} exclusion states a reason`);
}

// 4. Ratchet — the backlog may shrink, never grow.
ok(untriaged.size <= UNTRIAGED_BASELINE,
  `untriaged backlog ${untriaged.size} <= baseline ${UNTRIAGED_BASELINE}`);
eq(untriaged.size, UNTRIAGED.length, 'untriaged list has no duplicates');

summary('xplat-coverage');
