// What counts as a gated test file, in one place.
//
// There were two answers. scripts/test-all.mjs decides what RUNS;
// packages/driver/test-xplat-coverage.mjs decides what must carry
// cross-platform evidence, and its whole invariant is that no test file lands
// unclassified. They were separate copies, and the moment one learned a second
// filename spelling (`*.test.mjs`) the other stopped seeing those files — a test
// gated by one ledger and invisible to the other, which is how a file ends up
// looking covered while nothing checks it.
//
// Deliberately named so it is not itself discovered as a test.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Shared assert helpers and hand-driven harnesses: real files, not gated tests.
// test-registry.mjs (research/spikes/cloud-registry) drives a real localhost
// HTTP server over fetch; the hermetic gate is offline-by-design and blocks
// fetch, so like test-user-flow.mjs it runs on demand, ungated.
export const HELPERS = new Set(['test-util.mjs', 'test-all.mjs', 'test-user-flow.mjs', 'test-registry.mjs']);

// Directories that never hold gated tests. Pruned by name at every depth.
export const PRUNE = new Set(['node_modules', '.git', '.worktrees', 'artifacts', 'usertest', '.cache']);

// Both spellings are in use — scripts and packages chose the first, bench the
// second — and a rule honouring one would silently skip half of them.
export const isTestFile = (name) =>
  (/^test.*\.mjs$/.test(name) || /\.test\.mjs$/.test(name)) && !HELPERS.has(name);

/**
 * Walk `dir` for gated test files. Walking beats a hand-listed set of
 * directories, which missed packages/cli, then scripts/, then scripts/loop/ —
 * each time leaving a test that never ran once. It also flips the direction of
 * failure: a forgotten exclusion fails loudly, a forgotten inclusion fails
 * silently, and only the loud one gets fixed.
 */
export function discoverTests(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    // A dirent reports a symlink as neither file nor directory, so resolve those
    // before deciding. A symlinked DIRECTORY is not followed, which is also what
    // stops a cycle from hanging the walk.
    const stats = entry.isSymbolicLink() ? statSync(full, { throwIfNoEntry: false }) : entry;
    if (!stats) continue;
    if (stats.isDirectory()) {
      if (!entry.isSymbolicLink() && !PRUNE.has(entry.name)) discoverTests(full, found);
    } else if (stats.isFile() && isTestFile(entry.name)) {
      found.push(full);
    }
  }
  return found;
}
