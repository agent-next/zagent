import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const home = mkdtempSync(path.join(tmpdir(), 'zagent-memory-command-'));
const cwd = mkdtempSync(path.join(tmpdir(), 'zagent-memory-cwd-'));
const root = fileURLToPath(new URL('../../', import.meta.url));
try {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home };
  const run = (args, dir = cwd) => spawnSync(process.execPath, [path.join(root, 'bin/zagent'), ...args], {
    encoding: 'utf8', timeout: 10000, env, cwd: dir,
  });

  // Unknown verbs must not fall through to `show` — 'memory bogus' used to
  // print this workspace's memory and exit 0.
  let r = run(['memory', 'bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
  r = run(['memory', 'show', 'extra']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
  r = run(['memory', 'index', 'extra']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
  r = run(['memory', '--json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
  r = run(['memory', 'append']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
  r = run(['memory', 'append', '   ']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);

  // Real paths still work.
  r = run(['memory']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No memory|Add one with/);
  r = run(['memory', 'index']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no memories anywhere|entries\)/);
  r = run(['memory', 'append', 'pin', 'this']);
  assert.equal(r.status, 0, r.stderr);
  r = run(['memory']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pin this/);
  console.log('PASS memory verb validation');
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
