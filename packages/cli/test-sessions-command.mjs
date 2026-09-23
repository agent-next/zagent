#!/usr/bin/env node
// `zagent sessions [--json]` — the session/task panel ignored argv entirely:
// `sessions --json` printed the ANSI table instead of JSON. Now --json emits a
// machine-readable payload and any other arg is a usage error. Driven against
// a fake NDJSON app-server answering session/list (the client ready probe and
// listSessions both use it).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = path.join(root, 'bin', 'zagent-sessions');
const home = mkdtempSync(path.join(tmpdir(), 'zagent-sessions-cli-'));

const runtime = path.join(home, 'fake-runtime.cjs');
writeFileSync(runtime, `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', l => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id === undefined || !m.method) return;
  const reply = o => process.stdout.write(JSON.stringify({ id: m.id, ...o }) + '\\n');
  if (m.method === 'session/list') return reply({ result: { sessions: [
    { sessionId: 'sess_aaa111', status: 'idle', title: 'older session',
      updatedAt: 1000, workspace: { workspaceKey: '/w', workspacePath: '/w' } },
    { sessionId: 'sess_bbb222', status: 'running', title: 'newer session',
      updatedAt: 2000, workspace: { workspaceKey: '/w2', workspacePath: '/w2' } },
  ] } });
  reply({ error: { code: -32601, message: 'method not found' } });
});`);

// GUI task index join: sess_aaa111 has a task row, sess_bbb222 does not.
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
db.prepare(`INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status,
  pinned, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
  .run('/w', '/w', 'sess_aaa111', 'gui title for aaa', 'completed', 1, 0, 1, 1000);
db.close();

const env = {
  ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home,
  ZCODE_RUNTIME: runtime, NO_COLOR: '1',
};
const run = (...args) =>
  spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', entry, ...args],
    { encoding: 'utf8', timeout: 60000, env });

try {
  // --- --json: parseable payload, newest first, task join present ---------------
  let r = run('--json');
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.count, 2);
  assert.equal(payload.total, 2, 'total counts pre-truncation sessions');
  assert.equal(payload.sessions[0].sessionId, 'sess_bbb222', 'newest first');
  assert.equal(payload.sessions[1].sessionId, 'sess_aaa111');
  assert.equal(payload.sessions[1].gui.title, 'gui title for aaa', 'tasks-index join survives');
  assert.equal(payload.sessions[0].gui, undefined, 'no join row -> no gui field');

  // --- human table still renders ------------------------------------------------
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 sessions \(newest first\)/);
  assert.match(r.stdout, /gui title for aaa/);

  // --- unknown args are usage errors, not silently ignored -----------------------
  r = run('--bogus');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: zagent sessions/);
  r = run('extra');
  assert.equal(r.status, 2);

  // --- fresh install: an absent tasks index is an empty join, not a warning --
  // A brand-new machine printed "(tasks-index: unable to open
  // database file)" — a first run must be quiet; real breakage still reports.
  const freshHome = mkdtempSync(path.join(tmpdir(), 'zagent-sessions-fresh-'));
  try {
    const freshEnv = { ...env, HOME: freshHome, USERPROFILE: freshHome, ZAGENT_TEST_SANDBOX: freshHome };
    r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', entry, '--json'],
      { encoding: 'utf8', timeout: 60000, env: freshEnv });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /tasks-index/, 'a missing index file must not warn');
    assert.equal(JSON.parse(r.stdout).count, 2, 'runtime sessions still list');
    // A PRESENT but unreadable index still warns — silence must not hide breakage.
    mkdirSync(path.join(freshHome, '.zcode/v2'), { recursive: true });
    writeFileSync(path.join(freshHome, '.zcode/v2/tasks-index.sqlite'), 'not sqlite');
    r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', entry],
      { encoding: 'utf8', timeout: 60000, env: freshEnv });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /tasks-index/, 'a broken index still says so');
    assert.match(r.stdout, /2 sessions/, 'the session list still renders');
  } finally { rmSync(freshHome, { recursive: true, force: true }); }

  console.log('ALL PASS');
} finally {
  rmSync(home, { recursive: true, force: true });
}
