#!/usr/bin/env node
// `zagent permissions` — view/revoke the persisted always-allow/deny grants
// (F14a/F14d). Fresh machine = honest empty state, never a created file;
// revoke matches the remembered pattern, `all`/`reset` clears the store.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = path.join(root, 'packages', 'cli', 'zagent-permissions.mjs');
const home = mkdtempSync(path.join(tmpdir(), 'zagent-perms-cli-'));
const storePath = path.join(home, '.zcode', 'cli', 'grants.json');

const seed = (grants) => {
  mkdirSync(path.dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify({ version: 1, grants }), { mode: 0o600 });
};
const seedSample = () => seed({
  ['a'.repeat(64)]: { toolName: 'Bash', optionId: 'allow_always',
    pattern: 'npm install: *', response: { decision: 'allow' } },
  ['b'.repeat(64)]: { toolName: 'Edit', optionId: 'deny-always',
    pattern: '{"file_path":"/x/a.py"}', response: { decision: 'deny' } },
  // A pre-F14a record carries no pattern — it must still list and revoke.
  ['c'.repeat(64)]: { toolName: 'Write', optionId: 'allow_always',
    response: { decision: 'allow' } },
});

const env = { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home };
delete env.ZCODE_DATA_BASE_DIR;
const run = (args, e = env) =>
  spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 30000, env: e });

try {
  // --- empty state: bare, list, --json — honest, exit 0, nothing created ---
  for (const args of [[], ['list'], ['--json'], ['list', '--json']]) {
    const r = run(args);
    assert.equal(r.status, 0, `${args}: ${r.stderr}`);
  }
  let r = run([]);
  assert.match(r.stdout, /no persisted permission grants/);
  assert.ok(!existsSync(storePath), 'list never creates the store');
  r = run(['--json']);
  assert.deepEqual(JSON.parse(r.stdout), { count: 0, grants: [] });

  // --- list shows WHAT was granted, not a bare tool name -------------------
  seedSample();
  r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Bash\(npm install: \*\) — allow_always/, 'pattern renders beside the tool');
  assert.match(r.stdout, /Edit\(.*a\.py.*\) — deny-always/);
  assert.match(r.stdout, /Write — allow_always/, 'pre-pattern grant still lists');
  assert.ok(!/a{64}/.test(r.stdout), 'the opaque hash never renders');

  r = run(['list', '--json']);
  let d = JSON.parse(r.stdout);
  assert.equal(d.count, 3);
  assert.equal(d.grants.find(g => g.toolName === 'Bash').pattern, 'npm install: *');
  assert.equal(d.grants.find(g => g.toolName === 'Bash').decision, 'allow');
  assert.equal(d.grants.find(g => g.toolName === 'Write').pattern, null);
  assert.equal(d.grants.find(g => g.toolName === 'Write').decision, 'allow');

  // --- revoke by pattern substring -----------------------------------------
  r = run(['revoke', 'npm install']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /revoked 1 grant/);
  assert.match(r.stdout, /Bash\(npm install: \*\)/);
  let saved = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.equal(Object.keys(saved.grants).length, 2);
  assert.ok(!saved.grants['a'.repeat(64)], 'the matching grant is gone');

  // no match: honest stderr + exit 1, store untouched
  r = run(['revoke', 'rm -rf']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no grant matching 'rm -rf'/);
  assert.equal(Object.keys(JSON.parse(readFileSync(storePath, 'utf8')).grants).length, 2);

  // tool name revokes too (a pre-pattern grant is still reachable)
  r = run(['revoke', 'write']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /revoked 1 grant/);
  assert.equal(Object.keys(JSON.parse(readFileSync(storePath, 'utf8')).grants).length, 1);

  // --- revoke all / --reset: honest counts on both full and empty stores ---
  r = run(['revoke', 'all', '--json']);
  d = JSON.parse(r.stdout);
  assert.equal(d.revoked, 1);
  assert.equal(d.revokedGrants[0].toolName, 'Edit');
  r = run(['revoke', 'all']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no persisted permission grants/);

  seedSample();
  r = run(['--reset']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /revoked 3 grants/);
  assert.equal(Object.keys(JSON.parse(readFileSync(storePath, 'utf8')).grants).length, 0);
  r = run(['--reset']);
  assert.match(r.stdout, /no persisted permission grants/);

  // --- usage errors ---------------------------------------------------------
  for (const args of [['bogus'], ['revoke'], ['list', 'extra'], ['--bogus'],
                      ['list', '--reset'], ['revoke', '--reset']]) {
    r = run(args);
    assert.equal(r.status, 2, `${args}`);
    assert.match(r.stderr, /usage: zagent permissions/);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log('PASS permissions-command');
