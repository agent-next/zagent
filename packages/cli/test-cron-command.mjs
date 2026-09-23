// `zagent cron` argv handling: `list --json` must emit parseable JSON (it used
// to print the human "no automations" line even under --json), and the verbs
// must validate their arity instead of silently ignoring stray arguments
// (`cron remove` with no id printed `removed undefined`).
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveJobs, loadJobs } from '../driver/automation.mjs';

const home = mkdtempSync(path.join(tmpdir(), 'zcron-cmd-'));
try {
  mkdirSync(path.join(home, 'tmp'));
  const cli = fileURLToPath(new URL('./zagent-cron.mjs', import.meta.url));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home,
    TMPDIR: path.join(home, 'tmp'), TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp') };
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: home, env, encoding: 'utf8', timeout: 10000 });

  let r = run('list', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { count: 0, jobs: [] });
  console.log('ok - list --json emits a JSON envelope when the store is empty');

  saveJobs([{ id: 'a', cron: '* * * * *', prompt: 'hello', workspace: home, status: 'idle' }], { home });
  r = run('list', '--json');
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.jobs[0].id, 'a');
  console.log('ok - list --json carries the stored jobs');

  r = run('list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /a: '\* \* \* \* \*'/);
  assert.throws(() => JSON.parse(r.stdout), 'human output must stay human');
  console.log('ok - bare list keeps the human line');

  for (const [args, why] of [
    [['list', '--bogus'], 'unknown flag'],
    [['list', 'extra'], 'stray positional'],
    [['remove'], 'missing id'],
    [['remove', 'a', 'b'], 'extra id'],
    [['remove', '--json'], 'flag where the id belongs'],
    [['tick', '--json'], 'tick takes no arguments'],
    [['bogus'], 'unknown verb'],
  ]) {
    r = run(...args);
    assert.equal(r.status, 2, `${why}: ${JSON.stringify(r)}`);
    assert.match(r.stderr, /usage:/, why);
  }
  console.log('ok - malformed invocations are usage errors (exit 2)');

  r = run('remove', 'missing-id');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not found/);
  r = run('remove', 'missing-id', '--json');
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stdout), { id: 'missing-id', deleted: false });
  console.log('ok - removing a missing id reports not-found instead of claiming removal');

  r = run('remove', 'a', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { id: 'a', deleted: true });
  assert.equal(loadJobs({ home }).length, 0);
  console.log('ok - remove --json reports the deletion honestly');

  // The prompt is free text: flag-looking tokens inside it must be stored
  // literally, not parsed as cron flags.
  r = run('add', 'free', '0 9 * * *', 'deploy --json -v');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(loadJobs({ home }).find(j => j.id === 'free').prompt, 'deploy --json -v');
  r = run('add', '--json', '0 9 * * *', 'prompt');
  assert.equal(r.status, 2, 'a dash-prefixed id would be unremovable');
  r = run('add', 'empty-prompt', '0 9 * * *', '   ');
  assert.equal(r.status, 2, 'an all-whitespace prompt would fire zagent -p ""');
  console.log('ok - add keeps prompt free text literal but rejects unusable ids/empty prompts');

  // A trailing --json is the output flag — it used to be swallowed INTO the
  // prompt ("echo hi --json") with no JSON emitted at all.
  r = run('add', 'j1', '0 9 * * *', 'echo', 'hi', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { id: 'j1', added: true });
  assert.equal(loadJobs({ home }).find(j => j.id === 'j1').prompt, 'echo hi');
  // Interior --json stays prompt text — the positional prompt is free text.
  r = run('add', 'j2', '0 9 * * *', '--json', 'loudly');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(loadJobs({ home }).find(j => j.id === 'j2').prompt, '--json loudly');
  // Duplicate id under --json reports added:false, exit 2.
  r = run('add', 'j1', '0 9 * * *', 'again', '--json');
  assert.equal(r.status, 2);
  assert.deepEqual(JSON.parse(r.stdout), { id: 'j1', added: false });
  // The flag alone is not a prompt — usage error, and nothing JSON-shaped leaks.
  for (const args of [['add', 'j3', '0 9 * * *', '--json'], ['add', '--json']]) {
    r = run(...args);
    assert.equal(r.status, 2, JSON.stringify(r));
    assert.match(r.stderr, /usage:/);
    assert.throws(() => JSON.parse(r.stdout), 'no JSON envelope on a usage error');
  }
  console.log('ok - add [--json] emits an envelope; interior --json stays prompt text');

  console.log('PASS cron command (8 cases)');
} finally { rmSync(home, { recursive: true, force: true }); }
