#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseGoalArgs, recentSessionId, runGoal, USAGE } from './zagent-goal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const home = mkdtempSync(path.join(tmpdir(), 'zagent-goal-cli-'));
const io = () => {
  let out = '', err = '';
  return {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    get out() { return out; },
    get err() { return err; },
  };
};
const fake = (reply, fail) => {
  const calls = [];
  return {
    calls,
    call: async (m, p) => {
      calls.push({ m, p });
      if (fail) throw fail;
      return typeof reply === 'function' ? reply(m, p) : reply;
    },
    close() { this.closed = true; },
  };
};

const seed = (rows) => {
  mkdirSync(path.join(home, '.zcode/v2'), { recursive: true });
  const db = new DatabaseSync(path.join(home, '.zcode/v2/tasks-index.sqlite'));
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
    task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT, provider TEXT,
    mode TEXT NOT NULL DEFAULT 'build', model TEXT, migration_source TEXT, forked_from_task_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, unread_at INTEGER,
    last_unread_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
    title_overridden INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}',
    searchable_text TEXT NOT NULL DEFAULT '', cron_automation_id TEXT, off_peak_task_id TEXT,
    PRIMARY KEY (workspace_key, task_id))`);
  db.exec('DELETE FROM tasks');
  const ins = db.prepare(`INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status,
    created_at, updated_at, archived, deleted) VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const r of rows) {
    ins.run('/w', '/w', r.id, r.title ?? r.id, 'completed', r.created ?? r.updated, r.updated,
      r.archived ?? 0, r.deleted ?? 0);
  }
  db.close();
};

try {
  assert.deepEqual(parseGoalArgs([]), { action: 'show', json: false, session: undefined });
  assert.equal(parseGoalArgs(['show']).action, 'show');
  assert.deepEqual(parseGoalArgs(['set', 'ship', 'it']), {
    action: 'set', objective: 'ship it', json: false, session: undefined,
  });
  assert.equal(parseGoalArgs(['set', '--json', 'ship it']).json, true);
  assert.equal(parseGoalArgs(['--session', 's1', 'pause']).session, 's1');
  assert.equal(parseGoalArgs(['--session=s2']).session, 's2');
  for (const args of [['set'], ['pause', 'x'], ['replace', 'x'], ['--bogus'], ['--session'],
    ['--session', '--json'], ['--session='], ['show', 'extra']]) {
    assert.equal(parseGoalArgs(args).error, USAGE, JSON.stringify(args));
  }
  assert.equal(parseGoalArgs(['--session', '  ']).error, USAGE, 'whitespace-only --session');
  assert.equal(parseGoalArgs(['set', '   ']).error, USAGE, 'whitespace-only objective');
  assert.deepEqual(parseGoalArgs(['set', 'a', '--session', 's9']), {
    action: 'set', objective: 'a', json: false, session: 's9',
  }, 'flags may follow the objective');
  assert.deepEqual(parseGoalArgs(['clear', '--json']), {
    action: 'clear', json: true, session: undefined,
  });

  assert.equal(recentSessionId({ home }), null, 'empty home has no session');
  seed([
    { id: 'sess_old', updated: 1 },
    { id: 'sess_new', updated: 9 },
    { id: 'sess_arch', updated: 99, archived: 1 },
    { id: 'sess_del', updated: 100, deleted: 1 },
  ]);
  assert.equal(recentSessionId({ home }), 'sess_new');

  // `goal list` is a verb — it lists the sessions a goal can be
  // shown for, like `task list`, instead of dumping usage.
  assert.deepEqual(parseGoalArgs(['list']), { action: 'list', json: false, all: false });
  assert.deepEqual(parseGoalArgs(['list', '--json']), { action: 'list', json: true, all: false });
  assert.deepEqual(parseGoalArgs(['list', '--all']), { action: 'list', json: false, all: true });
  assert.equal(parseGoalArgs(['list', 'x']).error, USAGE, 'list takes no positional');
  assert.equal(parseGoalArgs(['list', '--session', 's1']).error, USAGE, 'list takes no --session');
  assert.equal(parseGoalArgs(['show', '--all']).error, USAGE, '--all is a list flag');
  assert.equal(parseGoalArgs(['--all']).error, USAGE, 'bare --all is not show --all');

  const listIo = io();
  assert.equal(await runGoal(['list'], { home, stdout: listIo.stdout, stderr: listIo.stderr }), 0);
  assert.match(listIo.out, /sess_new/);
  assert.match(listIo.out, /sess_old/);
  assert.ok(!listIo.out.includes('sess_arch'), 'archived sessions are not listed');
  assert.ok(!listIo.out.includes('sess_del'), 'deleted sessions are not listed');
  assert.match(listIo.err, /goal show --session/, 'human list points at goal show');

  const listAllIo = io();
  assert.equal(await runGoal(['list', '--all'], { home, stdout: listAllIo.stdout, stderr: listAllIo.stderr }), 0);
  assert.match(listAllIo.out, /\[archived\] sess_arch/, '--all lists archived sessions marked');
  assert.ok(!listAllIo.out.includes('sess_del'), '--all still hides deleted');

  const listJson = io();
  assert.equal(await runGoal(['list', '--json'], { home, stdout: listJson.stdout, stderr: listJson.stderr }), 0);
  const listParsed = JSON.parse(listJson.out);
  assert.equal(listParsed.count, 2);
  assert.equal(listParsed.sessions[0].sessionId, 'sess_new');
  assert.equal(listParsed.sessions[0].title, 'sess_new');

  const emptyHome2 = mkdtempSync(path.join(tmpdir(), 'zagent-goal-list-empty-'));
  try {
    const listEmpty = io();
    assert.equal(await runGoal(['list'], {
      home: emptyHome2, stdout: listEmpty.stdout, stderr: listEmpty.stderr,
    }), 0, 'list on a fresh machine is an empty state, not an error');
    assert.match(listEmpty.out, /no sessions/);
    const listEmptyJson = io();
    assert.equal(await runGoal(['list', '--json'], {
      home: emptyHome2, stdout: listEmptyJson.stdout, stderr: listEmptyJson.stderr,
    }), 0);
    assert.deepEqual(JSON.parse(listEmptyJson.out), { count: 0, sessions: [] });
  } finally { rmSync(emptyHome2, { recursive: true, force: true }); }

  const corruptHome = mkdtempSync(path.join(tmpdir(), 'zagent-goal-corrupt-'));
  try {
    mkdirSync(path.join(corruptHome, '.zcode/v2'), { recursive: true });
    writeFileSync(path.join(corruptHome, '.zcode/v2/tasks-index.sqlite'), 'not sqlite');
    assert.equal(recentSessionId({ home: corruptHome }), null, 'corrupt tasks db yields no session');
  } finally { rmSync(corruptHome, { recursive: true, force: true }); }

  const cap = io();
  const client = fake({
    response: 'No goal is set.',
    snapshot: { projection: { contextUsed: 0, contextWindow: 1000000, mode: 'build' } },
  });
  assert.equal(await runGoal([], { client, home, stdout: cap.stdout, stderr: cap.stderr }), 0);
  assert.match(cap.out, /session: sess_new/);
  assert.match(cap.out, /No goal is set\./);
  assert.match(cap.err, /using latest CLI session sess_new, started .* ago/);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].m, 'session/goal');
  assert.deepEqual(client.calls[0].p, { sessionId: 'sess_new', action: 'show' });

  const jsonIo = io();
  assert.equal(await runGoal(['--json'], { client, home, stdout: jsonIo.stdout, stderr: jsonIo.stderr }), 0);
  const shown = JSON.parse(jsonIo.out);
  assert.equal(shown.sessionId, 'sess_new');
  assert.equal(shown.action, 'show');
  assert.equal(shown.response, 'No goal is set.');
  assert.equal(shown.projection.contextWindow, 1000000);

  const setClient = fake({ response: 'Goal active' });
  const setIo = io();
  assert.equal(await runGoal(['set', '--session', 'sess_explicit', 'ship', 'it'], {
    client: setClient, home, stdout: setIo.stdout, stderr: setIo.stderr,
  }), 0);
  assert.deepEqual(setClient.calls[0].p, {
    sessionId: 'sess_explicit', action: 'set', objective: 'ship it',
  });
  assert.match(setIo.out, /Goal active/);

  const setJson = io();
  assert.equal(await runGoal(['--json', 'set', 'v2'], {
    client: setClient, resolveSession: () => 's-res', stdout: setJson.stdout, stderr: setJson.stderr,
  }), 0);
  const setParsed = JSON.parse(setJson.out);
  assert.equal(setParsed.objective, 'v2');
  assert.equal(setParsed.sessionId, 's-res');

  const pauseJson = io();
  const pauseClient = fake({ response: 'paused' });
  assert.equal(await runGoal(['pause', '--session', 's1', '--json'], {
    client: pauseClient, stdout: pauseJson.stdout, stderr: pauseJson.stderr,
  }), 0);
  const pauseParsed = JSON.parse(pauseJson.out);
  assert.equal(pauseParsed.action, 'pause');
  assert.equal(pauseParsed.sessionId, 's1');
  assert.equal(pauseParsed.response, 'paused');
  assert.ok(!('objective' in pauseParsed), 'control actions carry no objective key');

  const bare = io();
  assert.equal(await runGoal(['--session', 's1', '--json'], {
    client: fake({}), stdout: bare.stdout, stderr: bare.stderr,
  }), 0);
  const bareParsed = JSON.parse(bare.out);
  assert.equal(bareParsed.response, null, 'missing response is null in --json');
  assert.ok(!('projection' in bareParsed), 'no projection key without a snapshot');

  const topProj = io();
  assert.equal(await runGoal(['--session', 's1', '--json'], {
    client: fake({ response: 'x', projection: { contextUsed: 3, contextWindow: 9, mode: 'plan' } }),
    stdout: topProj.stdout, stderr: topProj.stderr,
  }), 0);
  assert.equal(JSON.parse(topProj.out).projection.contextWindow, 9,
    'top-level projection is picked up, not only snapshot.projection');

  for (const action of ['pause', 'resume', 'clear']) {
    const c = fake({ response: `Goal ${action}d` });
    const aIo = io();
    assert.equal(await runGoal([action, '--session', 's1'], {
      client: c, stdout: aIo.stdout, stderr: aIo.stderr,
    }), 0);
    assert.deepEqual(c.calls[0].p, { sessionId: 's1', action });
    assert.equal(c.calls[0].m, 'session/goal');
  }

  const none = io();
  assert.equal(await runGoal(['show'], {
    resolveSession: () => null, client: fake({}), stdout: none.stdout, stderr: none.stderr,
  }), 2);
  assert.match(none.err, /goal: no session/);
  assert.equal(none.out, '');

  const noneJson = io();
  assert.equal(await runGoal(['--json'], {
    resolveSession: () => null, client: fake({}), stdout: noneJson.stdout, stderr: noneJson.stderr,
  }), 2);
  assert.match(noneJson.err, /goal: no session/);
  assert.equal(noneJson.out, '', 'no-session failure emits no partial JSON');

  const boom = io();
  assert.equal(await runGoal(['--session', 's1'], {
    client: fake(null, Object.assign(new Error('session not found'), { code: -32004 })),
    stdout: boom.stdout, stderr: boom.stderr,
  }), 0);
  assert.match(boom.out, /This session is not running\. Live sessions are process-local/);

  const boomJson = io();
  assert.equal(await runGoal(['--json', '--session', 's1'], {
    client: fake(null, Object.assign(new Error('gone'), { code: -32004 })),
    stdout: boomJson.stdout, stderr: boomJson.stderr,
  }), 0);
  assert.equal(JSON.parse(boomJson.out).running, false, 'not-running --json emits a parseable verdict');
  assert.match(boomJson.err, /not running/);

  const otherErr = io();
  assert.equal(await runGoal(['--session', 's1'], {
    client: fake(null, Object.assign(new Error('transport blew up'), { code: -32603 })),
    stdout: otherErr.stdout, stderr: otherErr.stderr,
  }), 1);
  assert.equal(otherErr.out, '');
  assert.match(otherErr.err, /goal: transport blew up/);

  let closed = false;
  const created = io();
  assert.equal(await runGoal(['--session', 's1', '--json'], {
    createClient: async () => ({
      call: async () => ({ response: 'ok' }),
      close() { closed = true; },
    }),
    stdout: created.stdout, stderr: created.stderr,
  }), 0);
  assert.equal(JSON.parse(created.out).response, 'ok');
  assert.equal(closed, true);

  const usage = io();
  assert.equal(await runGoal(['set'], { client: fake({}), stdout: usage.stdout, stderr: usage.stderr }), 2);
  assert.equal(usage.err, `${USAGE}\n`);

  const usageJson = io();
  assert.equal(await runGoal(['--json', 'frobnicate'], {
    client: fake({}), stdout: usageJson.stdout, stderr: usageJson.stderr,
  }), 2);
  assert.equal(usageJson.out, '', 'usage failure emits no partial JSON');
  assert.equal(usageJson.err, `${USAGE}\n`);

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ZAGENT_TEST_SANDBOX: home,
    TMPDIR: path.join(home, 'tmp'),
    TEMP: path.join(home, 'tmp'),
    TMP: path.join(home, 'tmp'),
    ZCODE_RUNTIME: path.join(home, 'no-runtime'),
  };
  mkdirSync(path.join(home, 'tmp'), { recursive: true });
  const run = (entry, args, extraEnv = {}) => spawnSync(process.execPath, [
    '--experimental-sqlite', '--no-warnings', entry, ...args,
  ], { encoding: 'utf8', timeout: 15000, env: { ...env, ...extraEnv } });

  const emptyHome = mkdtempSync(path.join(tmpdir(), 'zagent-goal-empty-'));
  try {
    const missing = run(path.join(root, 'packages/cli/zagent-goal.mjs'), [], {
      HOME: emptyHome, USERPROFILE: emptyHome, ZAGENT_TEST_SANDBOX: emptyHome,
    });
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stderr, /goal: no session/);
    assert.equal(missing.stdout, '');

    const missingJson = run(path.join(root, 'packages/cli/zagent-goal.mjs'), ['--json'], {
      HOME: emptyHome, USERPROFILE: emptyHome, ZAGENT_TEST_SANDBOX: emptyHome,
    });
    assert.equal(missingJson.status, 2, missingJson.stderr);
    assert.match(missingJson.stderr, /goal: no session/);
    assert.equal(missingJson.stdout, '', 'no-session --json keeps stdout empty');

    const routedNone = spawnSync(process.execPath, [path.join(root, 'bin/zagent'), 'goal'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...env, HOME: emptyHome, USERPROFILE: emptyHome, ZAGENT_TEST_SANDBOX: emptyHome },
    });
    assert.equal(routedNone.status, 2, 'routed goal with no session exits 2');
    assert.match(routedNone.stderr, /goal: no session/);
  } finally { rmSync(emptyHome, { recursive: true, force: true }); }

  const help = spawnSync(process.execPath, [path.join(root, 'bin/zagent'), 'goal', '--help'], {
    encoding: 'utf8', timeout: 15000, env,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /zagent goal/);

  const routed = spawnSync(process.execPath, [path.join(root, 'bin/zagent'), 'goal', 'set'], {
    encoding: 'utf8', timeout: 15000, env,
  });
  assert.equal(routed.status, 2, routed.stderr);
  assert.match(routed.stderr, /usage: zagent goal/);

  const routedList = spawnSync(process.execPath, [path.join(root, 'bin/zagent'), 'goal', 'list'], {
    encoding: 'utf8', timeout: 15000, env,
  });
  assert.equal(routedList.status, 0, routedList.stderr);
  assert.match(routedList.stdout, /sess_new/);

  console.log('ok - goal CLI list/show/set/pause/resume/clear, --json, --session, no-session, json-error-paths');
} finally {
  rmSync(home, { recursive: true, force: true });
}
