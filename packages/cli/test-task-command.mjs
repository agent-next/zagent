#!/usr/bin/env node
// `zagent task` — flag parsing and `list --json`. The command previously
// ignored unknown flags silently (`task list --json` printed the human
// table); now list honors --json/--all and unknown flags are usage errors.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = path.join(root, 'packages', 'cli', 'zagent-task.mjs');
const home = mkdtempSync(path.join(tmpdir(), 'zagent-task-cli-'));

mkdirSync(path.join(home, '.zcode/v2'), { recursive: true });
const db = new DatabaseSync(path.join(home, '.zcode/v2/tasks-index.sqlite'));
db.exec(`CREATE TABLE tasks (
  workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
  task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT, provider TEXT,
  mode TEXT NOT NULL DEFAULT 'build', model TEXT, migration_source TEXT, forked_from_task_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, unread_at INTEGER,
  last_unread_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
  title_overridden INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}',
  searchable_text TEXT NOT NULL DEFAULT '', cron_automation_id TEXT, off_peak_task_id TEXT,
  PRIMARY KEY (workspace_key, task_id))`);
const ins = db.prepare(`INSERT INTO tasks (workspace_key, workspace_path, task_id, title,
  task_status, created_at, updated_at, pinned, archived, deleted) VALUES (?,?,?,?,?,?,?,?,?,?)`);
ins.run('/w', '/w', 'task_aaaa1111', 'active task', 'completed', 1, 100, 0, 0, 0);
ins.run('/w', '/w', 'task_bbbb2222', 'archived task', 'completed', 2, 200, 0, 1, 0);
ins.run('/w', '/w', 'task_cccc3333', 'deleted task', 'completed', 3, 300, 0, 0, 1);
db.close();

const env = { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home };
const run = (...args) =>
  spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', entry, ...args],
    { encoding: 'utf8', timeout: 30000, env });

try {
  // --- human table: archived hidden, deleted hidden ---------------------------
  let r = run('list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /task_aaaa1111/);
  assert.ok(!r.stdout.includes('task_bbbb2222'), 'archived hidden without --all');
  assert.ok(!r.stdout.includes('task_cccc3333'), 'deleted always hidden');

  // --- list --json: object envelope like sibling commands, same visibility ------
  r = run('list', '--json');
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.count, 1);
  assert.deepEqual(payload.tasks.map(x => x.task_id), ['task_aaaa1111']);
  assert.equal(payload.tasks[0].title, 'active task');

  // --- list --all --json: archived included, deleted still hidden -------------
  r = run('list', '--all', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).tasks.map(x => x.task_id).sort(),
    ['task_aaaa1111', 'task_bbbb2222']);

  // --- unknown flags are usage errors, not silently ignored --------------------
  r = run('list', '--bogus');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: zagent task/);
  r = run('list', '--yaml');
  assert.equal(r.status, 2);

  // --- flags and stray positionals on non-list verbs are usage errors -----------
  r = run('list', 'bogus');
  assert.equal(r.status, 2, 'list takes no positionals');
  r = run('pin', 'aaaa1111', '--json');
  assert.equal(r.status, 2, 'mutations do not take --json');
  r = run('archive', 'aaaa1111', 'extra');
  assert.equal(r.status, 2, 'mutations take exactly one id');
  r = run('rename', 'aaaa1111', 'one', 'two');
  assert.equal(r.status, 2, 'rename takes exactly id + title');

  // --- positional parsing survives the flag split -------------------------------
  r = run('rename', 'aaaa1111', 'renamed task');
  assert.equal(r.status, 0, r.stderr);
  const check = new DatabaseSync(path.join(home, '.zcode/v2/tasks-index.sqlite'), { readOnly: true });
  assert.equal(check.prepare('SELECT title FROM tasks WHERE task_id = ?').get('task_aaaa1111').title,
    'renamed task');
  check.close();

  r = run('pin', 'aaaa1111');
  assert.equal(r.status, 0, r.stderr);
  r = run('list', '--json');
  assert.equal(JSON.parse(r.stdout).tasks[0].pinned, 1);

  // --- mutations still require an id --------------------------------------------
  r = run('archive');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: zagent task/);

  // --- fresh machine: no store at all -> empty state, not a stack trace ---------
  // `task list` on an empty HOME died on 'unable to open database
  // file' / 'no such table: tasks' with a Node stack. sessions/cron already
  // print empty states; task must too — and a read must not create the file.
  {
    const bare = mkdtempSync(path.join(tmpdir(), 'zagent-task-fresh-'));
    const freshEnv = { ...process.env, HOME: bare, USERPROFILE: bare, ZAGENT_TEST_SANDBOX: bare };
    const runFresh = (...args) =>
      spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', entry, ...args],
        { encoding: 'utf8', timeout: 30000, env: freshEnv });
    const noStack = (x) => {
      assert.doesNotMatch(`${x.stdout}${x.stderr}`, /no such table|unable to open database|node:sqlite|\.mjs:\d/);
    };
    let fr = runFresh('list');
    assert.equal(fr.status, 0, fr.stderr);
    assert.match(fr.stdout, /no tasks/);
    noStack(fr);
    fr = runFresh('list', '--json');
    assert.equal(fr.status, 0, fr.stderr);
    assert.deepEqual(JSON.parse(fr.stdout), { count: 0, tasks: [] });
    fr = runFresh('pin', 'task_deadbeef');
    assert.equal(fr.status, 1);
    assert.match(fr.stderr, /no task 'task_deadbeef'/);
    noStack(fr);
    assert.ok(!existsSync(path.join(bare, '.zcode')), 'a read must not create the store');

    // store file exists but has no tasks table -> same empty state
    mkdirSync(path.join(bare, '.zcode/v2'), { recursive: true });
    new DatabaseSync(path.join(bare, '.zcode/v2/tasks-index.sqlite')).close();
    fr = runFresh('list');
    assert.equal(fr.status, 0, fr.stderr);
    assert.match(fr.stdout, /no tasks/);
    noStack(fr);
    fr = runFresh('pin', 'x');
    assert.equal(fr.status, 1);
    assert.match(fr.stderr, /no task 'x'/);
    noStack(fr);

    // store file exists but is not a database -> still the empty state
    writeFileSync(path.join(bare, '.zcode/v2/tasks-index.sqlite'), 'not sqlite');
    fr = runFresh('list');
    assert.equal(fr.status, 0, fr.stderr);
    assert.match(fr.stdout, /no tasks/);
    noStack(fr);
    rmSync(bare, { recursive: true, force: true });
  }

  console.log('ALL PASS');
} finally {
  rmSync(home, { recursive: true, force: true });
}
