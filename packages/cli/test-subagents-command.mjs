#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseSubagentsArgs, recentSessionId, runSubagents, USAGE } from './zagent-subagents.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const home = mkdtempSync(path.join(tmpdir(), 'zagent-subagents-cli-'));
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
      return reply;
    },
    close() { this.closed = true; },
  };
};

try {
  assert.deepEqual(parseSubagentsArgs([]), { json: false, session: undefined });
  assert.equal(parseSubagentsArgs(['--json']).json, true);
  assert.equal(parseSubagentsArgs(['--session', 's1']).session, 's1');
  assert.equal(parseSubagentsArgs(['--session=s2', '--json']).session, 's2');
  for (const args of [['list'], ['--bogus'], ['--session'], ['--session='], ['s1']]) {
    assert.equal(parseSubagentsArgs(args).error, USAGE, JSON.stringify(args));
  }
  assert.equal(parseSubagentsArgs(['--session', '  ']).error, USAGE, 'whitespace-only --session');
  assert.equal(parseSubagentsArgs(['--session', '--json']).error, USAGE, '--session must not eat a flag');
  assert.equal(parseSubagentsArgs(['--json', 'extra']).error, USAGE, 'positional args are rejected');
  assert.deepEqual(parseSubagentsArgs(['--json', '--json']), { json: true, session: undefined },
    'repeated --json is fine');

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
    created_at, updated_at) VALUES (?,?,?,?,?,?,?)`).run('/w', '/w', 'sess_parent', 'P', 'running', 1, 5);
  db.close();
  assert.equal(recentSessionId({ home }), 'sess_parent');

  const deadHome = mkdtempSync(path.join(tmpdir(), 'zagent-subagents-dead-'));
  try {
    mkdirSync(path.join(deadHome, '.zcode/v2'), { recursive: true });
    const deadDb = new DatabaseSync(path.join(deadHome, '.zcode/v2/tasks-index.sqlite'));
    deadDb.exec(`CREATE TABLE tasks (
      workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, task_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', task_status TEXT, pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_key, task_id))`);
    const deadIns = deadDb.prepare(`INSERT INTO tasks (workspace_key, workspace_path, task_id,
      archived, deleted, updated_at) VALUES (?,?,?,?,?,?)`);
    deadIns.run('/w', '/w', 'sess_arch', 1, 0, 99);
    deadIns.run('/w', '/w', 'sess_del', 0, 1, 100);
    deadDb.close();
    assert.equal(recentSessionId({ home: deadHome }), null,
      'archived/deleted tasks are not sessions');
    writeFileSync(path.join(deadHome, '.zcode/v2/tasks-index.sqlite'), 'not sqlite');
    assert.equal(recentSessionId({ home: deadHome }), null, 'corrupt tasks db yields no session');
  } finally { rmSync(deadHome, { recursive: true, force: true }); }

  const listed = {
    revision: 2,
    childSessionIds: ['a', 'b'],
    running: [{ sid: 'r1' }],
    ended: { total: 3, items: [{ sessionId: 'e1' }, {}] },
  };
  const client = fake(listed);
  const cap = io();
  assert.equal(await runSubagents([], { client, home, stdout: cap.stdout, stderr: cap.stderr }), 0);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].m, 'session/subagents');
  assert.deepEqual(client.calls[0].p, { sessionId: 'sess_parent' });
  assert.match(cap.out, /session: sess_parent/);
  assert.match(cap.err, /using latest CLI session sess_parent, started .* ago/);
  assert.match(cap.out, /childSessionIds: a, b/);
  assert.match(cap.out, /running: r1/);
  assert.match(cap.out, /ended: e1 \(total 3\)/);

  const jsonIo = io();
  const jsonClient = fake(listed);
  assert.equal(await runSubagents(['--json', '--session', 's-explicit'], {
    client: jsonClient, home, stdout: jsonIo.stdout, stderr: jsonIo.stderr,
  }), 0);
  assert.deepEqual(jsonClient.calls[0].p, { sessionId: 's-explicit' });
  const parsed = JSON.parse(jsonIo.out);
  assert.equal(parsed.sessionId, 's-explicit');
  assert.deepEqual(parsed.childSessionIds, ['a', 'b']);
  assert.equal(parsed.endedCount, 3);
  assert.equal(parsed.revision, 2);
  assert.equal(parsed.running.length, 1);

  const emptyJson = io();
  assert.equal(await runSubagents(['--json', '--session', 's1'], {
    client: fake({}), stdout: emptyJson.stdout, stderr: emptyJson.stderr,
  }), 0);
  assert.deepEqual(JSON.parse(emptyJson.out), {
    sessionId: 's1', revision: 0, childSessionIds: [], running: [], endedCount: 0, ended: [],
  }, 'empty reply normalizes to a stable --json shape');

  const altIds = io();
  assert.equal(await runSubagents(['--session', 's1'], {
    client: fake({
      running: [{ childSessionId: 'c1' }, { id: 'i1' }, 'str1'],
      ended: { total: 2, items: [{ sessionId: 'e1' }, { sid: 'e2' }] },
    }),
    stdout: altIds.stdout, stderr: altIds.stderr,
  }), 0);
  assert.match(altIds.out, /running: c1, i1, str1/, 'alternate id keys and bare strings are picked up');
  assert.match(altIds.out, /ended: e1, e2\n/, 'ended ids print without a total when they cover the count');
  assert.ok(!/\(total /.test(altIds.out));

  const countOnly = io();
  assert.equal(await runSubagents(['--session', 's1'], {
    client: fake({ ended: { total: 5, items: [{}, {}] } }),
    stdout: countOnly.stdout, stderr: countOnly.stderr,
  }), 0);
  assert.match(countOnly.out, /ended: 5\n/, 'unidentifiable ended items fall back to the count');

  const empty = io();
  const emptyClient = fake({});
  assert.equal(await runSubagents(['--session', 's1'], {
    client: emptyClient, stdout: empty.stdout, stderr: empty.stderr,
  }), 0);
  assert.match(empty.out, /childSessionIds: \(none\)/);
  assert.match(empty.out, /running: \(none\)/);
  assert.match(empty.out, /ended: \(none\)/);

  const none = io();
  assert.equal(await runSubagents([], {
    resolveSession: () => null, client: fake({}), stdout: none.stdout, stderr: none.stderr,
  }), 2);
  assert.match(none.err, /subagents: no session/);
  assert.equal(none.out, '');

  const noneJson = io();
  assert.equal(await runSubagents(['--json'], {
    resolveSession: () => null, client: fake({}), stdout: noneJson.stdout, stderr: noneJson.stderr,
  }), 2);
  assert.match(noneJson.err, /subagents: no session/);
  assert.equal(noneJson.out, '', 'no-session failure emits no partial JSON');

  const boom = io();
  assert.equal(await runSubagents(['--session', 's1'], {
    client: fake(null, Object.assign(new Error('session not found'), { code: -32004 })),
    stdout: boom.stdout, stderr: boom.stderr,
  }), 0);
  assert.match(boom.out, /This session is not running\. Live sessions are process-local/);

  const boomJson = io();
  assert.equal(await runSubagents(['--json', '--session', 's1'], {
    client: fake(null, Object.assign(new Error('gone'), { code: -32004 })),
    stdout: boomJson.stdout, stderr: boomJson.stderr,
  }), 0);
  assert.equal(JSON.parse(boomJson.out).running, false, 'not-running --json emits a parseable verdict');
  assert.match(boomJson.err, /not running/);

  const usage = io();
  assert.equal(await runSubagents(['nope'], {
    client: fake({}), stdout: usage.stdout, stderr: usage.stderr,
  }), 2);
  assert.equal(usage.err, `${USAGE}\n`);

  const usageJson = io();
  assert.equal(await runSubagents(['--json', 'nope'], {
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

  const emptyHome = mkdtempSync(path.join(tmpdir(), 'zagent-subagents-empty-'));
  try {
    const missing = spawnSync(process.execPath, [
      '--experimental-sqlite', '--no-warnings',
      path.join(root, 'packages/cli/zagent-subagents.mjs'),
    ], {
      encoding: 'utf8', timeout: 15000,
      env: { ...env, HOME: emptyHome, USERPROFILE: emptyHome, ZAGENT_TEST_SANDBOX: emptyHome },
    });
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stderr, /subagents: no session/);

    const missingJson = spawnSync(process.execPath, [
      '--experimental-sqlite', '--no-warnings',
      path.join(root, 'packages/cli/zagent-subagents.mjs'), '--json',
    ], {
      encoding: 'utf8', timeout: 15000,
      env: { ...env, HOME: emptyHome, USERPROFILE: emptyHome, ZAGENT_TEST_SANDBOX: emptyHome },
    });
    assert.equal(missingJson.status, 2, missingJson.stderr);
    assert.match(missingJson.stderr, /subagents: no session/);
    assert.equal(missingJson.stdout, '', 'no-session --json keeps stdout empty');

    const routedNone = spawnSync(process.execPath, [path.join(root, 'bin/zagent'), 'subagents'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...env, HOME: emptyHome, USERPROFILE: emptyHome, ZAGENT_TEST_SANDBOX: emptyHome },
    });
    assert.equal(routedNone.status, 2, 'routed subagents with no session exits 2');
    assert.match(routedNone.stderr, /subagents: no session/);
  } finally { rmSync(emptyHome, { recursive: true, force: true }); }

  const help = spawnSync(process.execPath, [path.join(root, 'bin/zagent'), 'subagents', '--help'], {
    encoding: 'utf8', timeout: 15000, env,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /zagent subagents/);

  const routed = spawnSync(process.execPath, [path.join(root, 'bin/zagent'), 'subagents', 'list'], {
    encoding: 'utf8', timeout: 15000, env,
  });
  assert.equal(routed.status, 2, routed.stderr);
  assert.match(routed.stderr, /usage: zagent subagents/);

  console.log('ok - subagents CLI running/ended childSessionIds, --json, --session, no-session, json-error-paths');
} finally {
  rmSync(home, { recursive: true, force: true });
}
