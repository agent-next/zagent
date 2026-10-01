#!/usr/bin/env node
// The outsider gate is the answer to a whole class of defect, so it needs its own
// gate: a smoke script that silently checks nothing is worse than none, because it
// reports PASS.
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { COMMANDS, verbOf } from '../packages/cli/commands.mjs';

const src = readFileSync(new URL('./outsider-smoke.mjs', import.meta.url), 'utf8');
const tests = [];
const test = (n, f) => tests.push([n, f]);

test('it drives the INSTALLED binary, never the source tree', () => {
  assert.match(src, /const bin = path\.join\(prefix, 'bin', 'zagent'\)/);
  assert.match(src, /spawnSync\(bin, args/);
  assert.ok(!/spawnSync\('node', \['bin\/zagent'/.test(src),
    'running the source tree would defeat the entire point');
});

test('it installs with the command the README documents', () => {
  assert.match(src, /'install', '-g'/, 'must use the documented global install');
});

test('it checks every user-typed command, derived from the table', () => {
  // Hardcoding the list would let a new command ship unchecked.
  assert.match(src, /for \(const \[sig\] of COMMANDS\)/);
  assert.match(src, /verbOf\(sig\)/);
  const verbs = COMMANDS.map(([s]) => verbOf(s)).filter(v => !v.startsWith('-') && v !== '(default)');
  assert.ok(verbs.length >= 10, `expected the full command set, got ${verbs.length}`);
});

test('a command that prints nothing is a failure, not a pass', () => {
  // The original defect: exit 0 with empty output looked like success.
  assert.match(src, /if \(!out\.trim\(\)\) throw new Error\('printed nothing'\)/);
});

test('it fails the process when any check fails', () => {
  assert.match(src, /if \(fails\.length\)/);
  assert.match(src, /process\.exitCode = 1/);
});

test('failed installed checks remove the smoke work directory without claiming success', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'zagent-outsider-cleanup-test-'));
  try {
    // Keep the real finally/exit behavior, but replace filesystem observations
    // and subprocesses so no package installation or runtime use can occur.
    const mock = `import cp from 'node:child_process'; import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      cp.execFileSync = () => '';
      cp.spawnSync = () => ({ status: 1, stdout: '', stderr: 'synthetic failure' });
      fs.existsSync = () => true;
      fs.readdirSync = () => ['synthetic.tgz'];
      syncBuiltinESMExports();`;
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(mock)}`,
      fileURLToPath(new URL('./outsider-smoke.mjs', import.meta.url))], {
      encoding: 'utf8', env: { ...process.env, TMPDIR: fixture, TMP: fixture, TEMP: fixture }, timeout: 5000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /OUTSIDER SMOKE FAILED/);
    assert(!result.stdout.includes('outsider smoke PASSED'));
    assert.deepEqual(readdirSync(fixture), [], 'failed smoke must remove its fixture');
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('it verifies the shipped package passes its own tests', () => {
  assert.match(src, /'npm', \['test'\]/);
  assert.match(src, /"status":\\s\*"PASS"/);
});

let pass = 0, fail = 0;
for (const [n, f] of tests) {
  try { f(); pass++; } catch (e) { fail++; console.error(`FAIL ${n}\n  ${e.message}`); }
}
console.log(`${pass}/${tests.length} outsider-gate tests passed`);
process.exit(fail ? 1 : 0);
