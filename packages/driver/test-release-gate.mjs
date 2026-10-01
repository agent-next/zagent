// The release gate's own gate.
//
// scripts/verify-public-package.mjs is the outsider check: it packs, installs and
// exercises what consumers get. It is the EXPORTED package's `npm test`, so the
// repo suite never runs it — and it rotted twice without anything noticing:
//
//   * its allowlist did not know about packages/tui, so the gate went red the
//     moment the TUI landed. `npm test` on the published package would have
//     failed for every user.
//   * its forbidden list named zagent-telegram / zagentd while the files were
//     still zmax-* — an earlier product rename's find/replace had applied to
//     INTERNAL filenames before they were renamed. The patterns matched
//     nothing on disk, so the block was dead until the zmax->zagent rename
//     made them real.
//
// Running the full gate here would mean an npm pack plus a global install on
// every test run. These assertions are the cheap invariant instead: the two
// allowlists must agree, and the forbidden patterns must match real files.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const gate = readFileSync(path.join(root, 'scripts', 'verify-public-package.mjs'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// The REAL predicates, imported. This test used to scrape them out of the gate's
// source with a regex, which broke on Windows the moment the checkout used CRLF —
// a test that parses source text is testing the formatting, not the rule.
// Importing is side-effect free; only running the gate as main packs and installs.
const { allowed, forbidden, installationPaths } = await import(
  new URL('../../scripts/verify-public-package.mjs', import.meta.url).href);

// 0. Every file listed in files[] must EXIST. npm pack silently omits a listed
//    file that is missing, so a module deleted or renamed out of the tree while
//    still listed drops out of the tarball and BOTH gates stay green — the
//    consumer then gets ERR_MODULE_NOT_FOUND from the headline command. Verified:
//    removing packages/tui/pickers.mjs left every check passing and shipped 48
//    files instead of 49.
for (const file of pkg.files) {
  assert(existsSync(path.join(root, file)),
    `package.json ships ${file}, which does not exist — npm pack would drop it silently`);
}
console.log(`ok - all ${pkg.files.length} shipped files exist on disk`);

// 1. Everything the package ships must pass the gate's allowlist.
for (const file of pkg.files) {
  assert(allowed(file), `package.json ships ${file}, which the release gate would reject`);
  assert(!forbidden.test(file), `package.json ships ${file}, which the release gate forbids`);
}
console.log(`ok - all ${pkg.files.length} shipped files pass the release gate allowlist`);

// 2. The forbidden patterns must match files that actually exist. A pattern that
//    matches nothing is not protection, it is decoration.
const experimental = ['zagent-telegram.mjs', 'zagent-feishu.mjs', 'zagent-wechat.mjs',
  'zagent-compact.mjs', 'zagentd.mjs', 'zagentd-compact.mjs'];
const cliDir = path.join(root, 'packages', 'cli');
const onDisk = new Set(readdirSync(cliDir));
for (const name of experimental) {
  assert(onDisk.has(name), `${name} no longer exists — update this list and the gate together`);
  assert(forbidden.test(`packages/cli/${name}`),
    `the release gate does NOT block packages/cli/${name}; its pattern names a file that does not exist`);
}
console.log(`ok - all ${experimental.length} experimental modules are really blocked, by name`);

// 3. Every source module that exists under the shipped trees is either shipped or
//    deliberately excluded — so a new module cannot be silently left out.
for (const tree of ['packages/tui', 'packages/driver', 'packages/cli']) {
  for (const name of readdirSync(path.join(root, tree))) {
    if (!name.endsWith('.mjs') || name.startsWith('test')) continue;
    const rel = `${tree}/${name}`;
    if (pkg.files.includes(rel)) continue;
    assert(forbidden.test(rel) || !allowed(rel),
      `${rel} exists, is not shipped, and is not excluded by the gate — is it missing from files[]?`);
  }
}
console.log('ok - no source module is unshipped without the gate excluding it');

// 4. The published identity, asserted where a rename would break it.
assert.equal(pkg.bin?.zagent, 'bin/zagent', 'the zagent command must map to the internal entry');
assert.equal(pkg.bin?.za, 'bin/zagent', 'the za alias must map to the internal entry');
assert.equal(installationPaths('/prefix', pkg, 'linux').bins.zagent, '/prefix/bin/zagent',
  'the gate must exercise the zagent command a consumer actually installs');
console.log('ok - the gate exercises the commands the package installs');

// 5. The gate must permit ITSELF. The exported package's `npm test` runs this
//    script, so the exporter ships it — and the gate then rejected its own file
//    ("unexpected npm payload: scripts/verify-public-package.mjs"), which no
//    amount of testing the PRIVATE package.json would reveal, because the entry
//    is added during export.
const exportedTestScript = 'scripts/verify-public-package.mjs';
assert(allowed(exportedTestScript) && !forbidden.test(exportedTestScript),
  'the gate must allow the test script it ships and runs');
const exporter = readFileSync(path.join(root, 'scripts', 'export-public-source.mjs'), 'utf8');
assert(exporter.includes(exportedTestScript),
  'the exporter must ship the script the exported package tests with');
assert(/pkg\.files\s*=/.test(exporter),
  'the exporter must add it to files[], or npm pack drops it from the tarball');
console.log('ok - the gate ships, permits and can run itself');

console.log('\nALL PASS');
