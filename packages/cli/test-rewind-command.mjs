#!/usr/bin/env node
// Rewind CLI tests — offline. The kernel's 3.12.1 session/fork schema is the
// strict discriminated union verified against the kernel:
//   {sessionId, target:{kind:"message",messageId}|{kind:"checkpoint",checkpointId}
//     |{kind:"latestCheckpoint"} (default), expectedRevision?:int>=0}
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { conversationSnapshot, forkSession, listCheckpoints, listSessionCheckpoints, pickConversationRow, rewindTarget } from '../driver/rewind.mjs';
import { parseRewindArgs, runRewind, USAGE } from './zagent-rewind.mjs';

// Ambient ZCODE_DATA_BASE_DIR must not redirect fixture stores — the env-root
// test below sets it explicitly and restores.
delete process.env.ZCODE_DATA_BASE_DIR;

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
const LIVE = { forkedSessionId: 'sess_f', parentSessionId: 'sess_p',
  targetCheckpointId: 'checkpoint_1', response: 'copied 2 messages and restored 1 file',
  snapshot: { rev: 3 } };

// --- arg parsing ---
const bare = { checkpointId: undefined, messageId: undefined };
assert.deepEqual(parseRewindArgs([]), { action: 'list', ...bare, json: false, session: undefined });
assert.deepEqual(parseRewindArgs(['list']), { action: 'list', ...bare, json: false, session: undefined });
assert.deepEqual(parseRewindArgs(['latest']), { action: 'latest', ...bare, json: false, session: undefined });
assert.deepEqual(parseRewindArgs(['checkpoint_abc-1']), { action: 'checkpoint', checkpointId: 'checkpoint_abc-1', messageId: undefined, json: false, session: undefined });
assert.equal(parseRewindArgs(['bogus']).error, USAGE);           // not a checkpoint_* id
assert.deepEqual(parseRewindArgs(['--message', 'msg_9']), { action: 'message', ...bare, messageId: 'msg_9', json: false, session: undefined });
assert.equal(parseRewindArgs(['--message']).error, USAGE);
assert.deepEqual(parseRewindArgs(['--session', 'sess_1', 'latest']), { action: 'latest', ...bare, json: false, session: 'sess_1' });
assert.deepEqual(parseRewindArgs(['--session=sess_1', 'latest', '--json']), { action: 'latest', ...bare, json: true, session: 'sess_1' });
assert.deepEqual(parseRewindArgs(['list', '--session', 'sess_1']), { action: 'list', ...bare, json: false, session: 'sess_1' }); // list accepts --session (scopes to it)
assert.equal(parseRewindArgs(['--bogus']).error, USAGE);
assert.equal(parseRewindArgs(['latest', 'checkpoint_x']).error, USAGE); // two positionals
assert.equal(parseRewindArgs(['list', '--message', 'm']).error, USAGE); // list takes no target

// --- target union shapes (the strict zod contract) ---
assert.deepEqual(rewindTarget('latest'), { kind: 'latestCheckpoint' });
assert.deepEqual(rewindTarget('checkpoint', 'checkpoint_7'), { kind: 'checkpoint', checkpointId: 'checkpoint_7' });
assert.deepEqual(rewindTarget('message', 'msg_7'), { kind: 'message', messageId: 'msg_7' });
assert.deepEqual(rewindTarget('message', '  msg_7  '), { kind: 'message', messageId: 'msg_7' }); // trimmed on the wire
assert.throws(() => rewindTarget('checkpoint', 'junk'));

// --- forkSession sends the union params ---
{
  const f = fake(LIVE);
  const r = await forkSession(f, 'sess_1', { action: 'checkpoint', checkpointId: 'checkpoint_7' });
  assert.equal(f.calls[0].m, 'session/fork');
  assert.deepEqual(f.calls[0].p, { sessionId: 'sess_1', target: { kind: 'checkpoint', checkpointId: 'checkpoint_7' } });
  assert.equal(r.forkedSessionId, 'sess_f');
  assert.equal(r.summary, LIVE.response);
  assert.deepEqual(r.snapshot, { rev: 3 });

  const f2 = fake(LIVE);
  await forkSession(f2, 'sess_1', { action: 'latest', expectedRevision: 4 });
  assert.deepEqual(f2.calls[0].p, { sessionId: 'sess_1', target: { kind: 'latestCheckpoint' }, expectedRevision: 4 });
  await assert.rejects(() => forkSession(f2, 'sess_1', { action: 'latest', expectedRevision: -1 }), /expectedRevision/);
  await assert.rejects(() => forkSession(f2, 'sess_1', { action: 'latest', expectedRevision: 1.5 }), /expectedRevision/);

  const f3 = fake(LIVE);
  await forkSession(f3, 'sess_1', { action: 'message', messageId: 'msg_9' });
  assert.deepEqual(f3.calls[0].p, { sessionId: 'sess_1', target: { kind: 'message', messageId: 'msg_9' } });
}

// --- runRewind: list needs no session/client ---
{
  const dir = mkdtempSync(path.join(tmpdir(), 'zagent-rewind-'));
  try {
    const t = io();
    const code = await runRewind(['list', '--json'], { ...t, cwd: dir });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(t.out), { cwd: dir, checkpoints: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- runRewind: fork paths over a fake client ---
{
  const f = fake(LIVE);
  const t = io();
  const code = await runRewind(['latest', '--session', 'sess_1', '--json'], { ...t, client: f });
  assert.equal(code, 0);
  const forkCall = f.calls.find(c => c.m === 'session/fork');
  assert.deepEqual(forkCall.p, { sessionId: 'sess_1', target: { kind: 'latestCheckpoint' } });
  assert.deepEqual(f.calls[0].m, 'session/resume'); // finished sessions need resume first
  const payload = JSON.parse(t.out);
  assert.equal(payload.forkedSessionId, 'sess_f');
  assert.equal(payload.sessionId, 'sess_1');
}

// checkpoint + message actions reach the wire; owned client is closed
{
  const f = fake(LIVE);
  const t = io();
  const code = await runRewind(['checkpoint_abc-1', '--session', 'sess_1'], { ...t, createClient: async () => f });
  assert.equal(code, 0);
  assert.deepEqual(f.calls.find(c => c.m === 'session/fork').p, { sessionId: 'sess_1', target: { kind: 'checkpoint', checkpointId: 'checkpoint_abc-1' } });
  assert.match(t.out, /from session: sess_1/);
  assert.equal(f.closed, true);

  const f2 = fake(LIVE);
  const t2 = io();
  await runRewind(['--message', 'msg_9', '--session', 'sess_1'], { ...t2, client: f2 });
  assert.deepEqual(f2.calls.find(c => c.m === 'session/fork').p, { sessionId: 'sess_1', target: { kind: 'message', messageId: 'msg_9' } });
}

// no-checkpoint discrimination -> clean message, exit 1; --json still emits a payload
{
  const f = fake(null, { code: -32603, message: 'No workspace checkpoint is available yet.' });
  const t = io();
  const code = await runRewind(['latest', '--session', 'sess_1'], { ...t, client: f });
  assert.equal(code, 1);
  assert.match(t.err, /no workspace checkpoint/i);

  const t2 = io();
  const code2 = await runRewind(['latest', '--session', 'sess_1', '--json'], { ...t2, client: fake(null, { code: -32603, message: 'No workspace checkpoint is available yet.' }) });
  assert.equal(code2, 1);
  assert.equal(JSON.parse(t2.out).checkpoint, null);
}

// stale session -> rewind-specific refusal (NOT the goal/usage NOT_RUNNING
// hint). A finished -p session is not active in a fresh app-server, so
// rewind RESUMES it first — a -32004 from session/resume means the session
// is truly absent: a bogus id is a refusal, exit 1, on-topic copy.
{
  const f = fake(null, { code: -32004, message: 'Session not found: sess_old' });
  const t = io();
  const code = await runRewind(['latest', '--session', 'sess_old', '--json'], { ...t, client: f });
  assert.equal(code, 1);
  assert.equal(JSON.parse(t.out).running, false);
  assert.match(t.err, /rewind: session not found or no longer active: sess_old/);
  assert.match(t.err, /zagent sessions/);
  assert.doesNotMatch(t.err, /\/goal|\/usage|\/agents/); // never the live-session hint
  assert.deepEqual(f.calls.map(c => c.m), ['session/resume']); // fork never reached
}

// `preview --session <bogus>` took the same off-topic branch —
// resume -32004 on the v4-query path gets the identical refusal contract.
{
  const f = fake(null, { code: -32004, message: 'Session not found: sess_bogus_123' });
  const t = io();
  const code = await runRewind(['preview', '--session', 'sess_bogus_123'], { ...t, client: f });
  assert.equal(code, 1);
  assert.match(t.err, /rewind: session not found or no longer active: sess_bogus_123/);
  assert.doesNotMatch(t.out + t.err, /Live sessions are process-local/);
  assert.deepEqual(f.calls.map(c => c.m), ['session/resume']); // subscribe never reached
}

// r1: a -32004 carrying a NON-session message is ambiguous — generic rewind
// copy, never a session-named refusal or a running:false claim about a
// session the error was not about.
{
  const f = fake(null, { code: -32004, message: 'checkpoint row inactive' });
  const t = io();
  const code = await runRewind(['latest', '--session', 'sess_1', '--json'], { ...t, client: f });
  assert.equal(code, 1);
  assert.equal(t.out, ''); // no running:false payload for a non-session error
  assert.match(t.err, /^rewind: checkpoint row inactive\n$/);
  assert.doesNotMatch(t.err, /not found or no longer active|zagent sessions/);
}

// resume precedes fork: a persisted-but-inactive session becomes forkable
{
  const order = [];
  const f = {
    calls: order,
    call: async (m, p) => {
      order.push(m);
      if (m === 'session/resume') { assert.deepEqual(p, { sessionId: 'sess_dead' }); return {}; }
      if (m === 'session/fork') return LIVE;
      throw new Error(`unexpected ${m}`);
    },
    close() { this.closed = true; },
  };
  const t = io();
  const code = await runRewind(['latest', '--session', 'sess_dead', '--json'], { ...t, client: f });
  assert.equal(code, 0);
  assert.deepEqual(order.slice(0, 2), ['session/resume', 'session/fork']);
  const payload = JSON.parse(t.out);
  assert.equal(payload.forkedSessionId, 'sess_f');
}

// resume failure that is NOT -32004 surfaces honestly (not as NOT_RUNNING)
{
  const f = fake(null, { code: -32603, message: 'workspace gone' });
  const t = io();
  const code = await runRewind(['latest', '--session', 'sess_x'], { ...t, client: f });
  assert.equal(code, 1);
  assert.match(t.err, /workspace gone/);
}

// no resolvable session -> usage error exit 2 (empty home: no store fallback)
{
  const t = io();
  const home = mkdtempSync(path.join(tmpdir(), 'zagent-rewind-nosess-'));
  try {
    const code = await runRewind(['latest'], { ...t, resolveSession: async () => null, client: fake(LIVE), home });
    assert.equal(code, 2);
    assert.match(t.err, /no session/i);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// fork-side errors AFTER a successful resume keep their contracts
{
  const noCp = { call: async (m) => m === 'session/fork'
    ? Promise.reject(Object.assign(new Error('No workspace checkpoint is available yet.'), { code: -32603 })) : {} };
  const t = io();
  const code = await runRewind(['latest', '--session', 'sess_1'], { ...t, client: noCp });
  assert.equal(code, 1);
  assert.match(t.err, /no workspace checkpoint/i);

  const gone = { call: async (m) => m === 'session/fork'
    ? Promise.reject(Object.assign(new Error('Session is not active'), { code: -32004 })) : {} };
  const t2 = io();
  const code2 = await runRewind(['latest', '--session', 'sess_1', '--json'], { ...t2, client: gone });
  assert.equal(code2, 1); // raced inactive after a successful resume = same refusal
  assert.equal(JSON.parse(t2.out).running, false);
  assert.match(t2.err, /no longer active: sess_1/);
}

// runtimes without session/resume (-32601): skip to fork, old contract intact
{
  const f = {
    calls: [],
    call: async (m, p) => {
      f.calls.push(m);
      if (m === 'session/resume') throw Object.assign(new Error('method not found'), { code: -32601 });
      return LIVE;
    },
    close() {},
  };
  const t = io();
  const code = await runRewind(['latest', '--session', 'sess_1'], { ...t, client: f });
  assert.equal(code, 0);
  assert.deepEqual(f.calls, ['session/resume', 'session/fork']);
}

// kernel-store session resolution: a finished -p session (no tasks-index row)
// is still auto-targeted by `rewind` in its workspace
{
  const home = mkdtempSync(path.join(tmpdir(), 'zagent-rewind-res-'));
  try {
    mkdirSync(`${home}/.zcode/cli/db`, { recursive: true });
    const db = new DatabaseSync(`${home}/.zcode/cli/db/db.sqlite`);
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT, time_updated INTEGER);');
    db.prepare('INSERT INTO session (id, directory, path, time_updated) VALUES (?,?,?,?)')
      .run('sess_print', '/w/proj', '/w/proj', 5000);
    db.close();
    const f = fake(LIVE);
    const t = io();
    const code = await runRewind(['latest', '--json'], { ...t, client: f, home, cwd: '/w/proj' });
    assert.equal(code, 0);
    assert.equal(JSON.parse(t.out).sessionId, 'sess_print');
    assert.equal(f.calls.find(c => c.m === 'session/resume').p.sessionId, 'sess_print');
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// ZCODE_DATA_BASE_DIR relocates the kernel store root (same rule as the
// kernel and inspect --storage): env wins over the home default
{
  const root = mkdtempSync(path.join(tmpdir(), 'zagent-rewind-env-'));
  const prev = process.env.ZCODE_DATA_BASE_DIR;
  process.env.ZCODE_DATA_BASE_DIR = root;
  try {
    mkdirSync(`${root}/.zcode/cli/db`, { recursive: true });
    const db = new DatabaseSync(`${root}/.zcode/cli/db/db.sqlite`);
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT);'
      + ' CREATE TABLE session_entry (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);');
    db.prepare('INSERT INTO session (id, directory, path) VALUES (?,?,?)').run('sess_env', '/w/env', '/w/env');
    db.prepare('INSERT INTO session_entry (id, session_id, type, time_created, data) VALUES (?,?,?,?,?)')
      .run('e1', 'sess_env', 'runtime/workspace_checkpoint', 1,
        JSON.stringify({ payload: { checkpointId: 'checkpoint_env-1', messageId: 'm1', fileCount: 1 } }));
    db.close();
    const rows = listSessionCheckpoints({ home: '/nonexistent-home' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].checkpointId, 'checkpoint_env-1');
  } finally {
    if (prev === undefined) delete process.env.ZCODE_DATA_BASE_DIR; else process.env.ZCODE_DATA_BASE_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
}

// --- listCheckpoints over a real git repo (offline) ---
{
  const dir = mkdtempSync(path.join(tmpdir(), 'zagent-rewind-git-'));
  try {
    const git = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
    git(['commit', '-qm', 'x', '--allow-empty']);
    git(['update-ref', 'refs/zcode/checkpoints/wshash1/checkpoint_aaa', 'HEAD']);
    git(['update-ref', 'refs/zcode/checkpoints/wshash1/checkpoint_bbb', 'HEAD']);
    git(['update-ref', 'refs/zcode/checkpoints/wshash2/checkpoint_ccc', 'HEAD']);
    const cps = listCheckpoints(dir);
    assert.equal(cps.length, 3);
    assert.ok(cps.every(c => c.checkpointId.startsWith('checkpoint_')));
    assert.deepEqual(cps.map(c => c.checkpointId).sort(), ['checkpoint_aaa', 'checkpoint_bbb', 'checkpoint_ccc']);
    assert.ok(cps.find(c => c.checkpointId === 'checkpoint_ccc').workspace === 'wshash2');
    // non-repo is empty, not an error
    const empty = mkdtempSync(path.join(tmpdir(), 'zagent-rewind-nogit-'));
    try { assert.deepEqual(listCheckpoints(empty), []); }
    finally { rmSync(empty, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- listSessionCheckpoints over a REAL sqlite session store (file state, not
// param mocks): the kernel persists CheckpointCreated as session_entry rows of
// type runtime/workspace_checkpoint in ~/.zcode/cli/db/db.sqlite. Live-verified
// 2026-09-16 on 3.12.1: a headless -p Write turn wrote workspace-checkpoint:<id>
// with data.payload.checkpointId, and session/resume+session/fork restored it.
{
  const home = mkdtempSync(path.join(tmpdir(), 'zagent-rewind-home-'));
  try {
    mkdirSync(`${home}/.zcode/cli/db`, { recursive: true });
    const db = new DatabaseSync(`${home}/.zcode/cli/db/db.sqlite`);
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT);' +
      'CREATE TABLE session_entry (id TEXT PRIMARY KEY, session_id TEXT, type TEXT,' +
      ' time_created INTEGER, time_updated INTEGER, data TEXT);');
    const ins = db.prepare('INSERT INTO session_entry (id, session_id, type, time_created, time_updated, data) VALUES (?,?,?,?,?,?)');
    db.prepare('INSERT INTO session (id, directory, path) VALUES (?,?,?)').run('sess_a', '/w/a', '/w/a');
    db.prepare('INSERT INTO session (id, directory, path) VALUES (?,?,?)').run('sess_b', '/w/b', '/w/b');
    const cp = (id, sid, ts, checkpointId, fileCount) =>
      ins.run(`workspace-checkpoint:${id}`, sid, 'runtime/workspace_checkpoint', ts, ts,
        JSON.stringify({ eventId: id, payload: { checkpointId, messageId: `msg_${id}`, scope: 'workspace', snapshotRef: 'artifact://x', fileCount } }));
    cp('e1', 'sess_a', 1000, 'checkpoint_k1', 2);
    cp('e2', 'sess_a', 2000, 'checkpoint_k2', 1);
    cp('e3', 'sess_b', 1500, 'checkpoint_k3', 1);
    ins.run('sess_a:runtime-model-selection', 'sess_a', 'runtime/model_selection', 900, 900, '{}'); // other types ignored
    ins.run('workspace-checkpoint:bad', 'sess_a', 'runtime/workspace_checkpoint', 3000, 3000, 'not-json'); // corrupt rows skipped
    db.close();

    const all = listSessionCheckpoints({ home });
    assert.deepEqual(all.map(c => c.checkpointId), ['checkpoint_k1', 'checkpoint_k3', 'checkpoint_k2']); // ts order
    assert.equal(all[0].sessionId, 'sess_a');
    assert.equal(all[0].messageId, 'msg_e1');
    assert.equal(all[0].fileCount, 2);
    assert.equal(all[0].createdAt, 1000);
    assert.equal(all[0].workspace, path.normalize('/w/a')); // stored value is normalized on read (win32 -> \w\a)
    assert.deepEqual(listSessionCheckpoints({ home, sessionId: 'sess_a' }).map(c => c.checkpointId), ['checkpoint_k1', 'checkpoint_k2']);
    assert.deepEqual(listSessionCheckpoints({ home, cwd: '/w/b' }).map(c => c.checkpointId), ['checkpoint_k3']);
    assert.deepEqual(listSessionCheckpoints({ home, cwd: '/w/none' }), []);
    assert.deepEqual(listSessionCheckpoints({ home: path.join(home, 'missing') }), []); // absent db -> []

    // runRewind list reads the real store: cwd scope by default, --session pins
    const t = io();
    const code = await runRewind(['list', '--json'], { ...t, home, cwd: '/w/a' });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(t.out).checkpoints.map(c => c.checkpointId), ['checkpoint_k1', 'checkpoint_k2']);

    const t2 = io();
    const code2 = await runRewind(['list', '--session', 'sess_b', '--json'], { ...t2, home, cwd: '/w/a' });
    assert.equal(code2, 0);
    assert.deepEqual(JSON.parse(t2.out).checkpoints.map(c => c.checkpointId), ['checkpoint_k3']);

    const t3 = io();
    const code3 = await runRewind(['list'], { ...t3, home, cwd: '/w/none' });
    assert.equal(code3, 0);
    assert.match(t3.out, /no workspace checkpoints/i);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// --- v4 conversation surface: changes/preview arg parsing ---
assert.deepEqual(parseRewindArgs(['changes']), { action: 'changes', ...bare, json: false, session: undefined });
assert.deepEqual(parseRewindArgs(['preview']), { action: 'preview', ...bare, json: false, session: undefined });
assert.deepEqual(parseRewindArgs(['preview', 'checkpoint_k9']), { action: 'preview', checkpointId: 'checkpoint_k9', messageId: undefined, json: false, session: undefined });
assert.equal(parseRewindArgs(['changes', 'checkpoint_k9']).error, USAGE); // changes takes no target
assert.equal(parseRewindArgs(['preview', 'bogus']).error, USAGE);        // not a checkpoint_* id
assert.equal(parseRewindArgs(['preview', 'checkpoint_a', 'extra']).error, USAGE);
assert.deepEqual(parseRewindArgs(['preview', '--session', 'sess_1', '--json']),
  { action: 'preview', ...bare, json: true, session: 'sess_1' });
assert.equal(parseRewindArgs(['changes', '--message', 'm']).error, USAGE); // --message is fork-only

// --- snapshot extraction: the real kernel wire
// {topic,...,frame:{...,payload:{kind:'snapshot',snapshot}}} (verified live
// on 3.12.1) and the flattened variants all resolve; junk yields null ---
{
  const snap = { logEpoch: 'le1', revision: 7, rows: { window: [{ kind: 'turnHeader', rowId: 3, entityId: 'e3' }] } };
  assert.deepEqual(conversationSnapshot({ topic: 'conversation/sess_1', frame: { payload: { kind: 'snapshot', snapshot: snap } } }),
    { logEpoch: 'le1', revision: 7, rows: snap.rows.window });
  assert.deepEqual(conversationSnapshot({ topic: 'conversation/sess_1', frame: { kind: 'snapshot', snapshot: snap } }),
    { logEpoch: 'le1', revision: 7, rows: snap.rows.window });
  assert.deepEqual(conversationSnapshot({ topic: 'conversation/sess_1', snapshot: snap }),
    { logEpoch: 'le1', revision: 7, rows: snap.rows.window });
  assert.equal(conversationSnapshot(null), null);
  assert.equal(conversationSnapshot({ frame: 'junk' }), null);
}

// --- pickConversationRow: turnHeader-only, entityId required, checkpoint
// ownership via turnCheckpoints base/result file checkpoint ids, newest-first ---
{
  const rows = [
    { kind: 'userMessage', rowId: 0, entityId: 'u0' },                                            // not a turnHeader
    { kind: 'turnHeader', rowId: 1, entityId: 'e1', turnId: 't1', fileChanges: [{ path: 'a.js' }],
      turnCheckpoints: [{ turnIndex: 0, baseFileCheckpointId: 'checkpoint_k1', resultFileCheckpointId: 'checkpoint_k1r' }] },
    { kind: 'turnHeader', rowId: 2, turnId: 't2' },                                               // no entityId -> skipped
    { kind: 'turnHeader', rowId: 3, entityId: 'e3', turnId: 't3', actions: { canRewindFiles: true },
      turnCheckpoints: [{ turnIndex: 1, baseFileCheckpointId: 'checkpoint_k3' }] },
  ];
  assert.equal(pickConversationRow(rows)?.rowId, 3);                          // newest rewindable/changed
  assert.equal(pickConversationRow(rows, { checkpointId: 'checkpoint_k1' })?.rowId, 1);
  assert.equal(pickConversationRow(rows, { checkpointId: 'checkpoint_k1r' })?.rowId, 1); // result id also owns
  assert.equal(pickConversationRow(rows, { checkpointId: 'checkpoint_k3' })?.rowId, 3);
  assert.equal(pickConversationRow(rows, { checkpointId: 'checkpoint_none' }), null);
  assert.equal(pickConversationRow([]), null);
  assert.equal(pickConversationRow('junk'), null);
}

// rewindable rows outrank a NEWER non-rewindable change row (kernel only sets
// canRewindFiles while fileChanges.state === 'active'); without the marker the
// newest-by-rowId change row wins regardless of window order
{
  const rows = [
    { kind: 'turnHeader', rowId: 1, entityId: 'e1', actions: { canRewindFiles: true } },
    { kind: 'turnHeader', rowId: 5, entityId: 'e5', fileChanges: [{ path: 'b.js' }] },
  ];
  assert.equal(pickConversationRow(rows)?.rowId, 1);
  assert.equal(pickConversationRow([...rows].reverse())?.rowId, 1); // order-independent
  assert.equal(pickConversationRow(rows.map(r => ({ ...r, actions: undefined })))?.rowId, 5);
}

// --- v4 query flow over a fake client: subscribe → frame notify → row query
// → unsubscribe. The fake fires the frame inside its call handler, matching
// the kernel's post-response outbox ordering.
const v4Client = (reply) => {
  const calls = [];
  const client = {
    calls,
    onNotify: null,
    call: async (m, p) => {
      calls.push({ m, p });
      if (m === 'session/resume') return {};
      if (m === 'v4/conversation/subscribe') {
        const out = { ack: { subscriptionId: 'sub1', mode: 'snapshot', logEpoch: 'le1' } };
        // wrong-topic and non-snapshot frames must not resolve the wait
        client.onNotify?.({ method: 'v4/conversation/frame', params: {
          topic: 'conversation/other', frame: { payload: { kind: 'snapshot', snapshot: { logEpoch: 'x', revision: 1, rows: { window: [] } } } },
        } });
        client.onNotify?.({ method: 'v4/conversation/frame', params: {
          topic: p.topic, frame: { payload: { kind: 'delta', delta: {} } },
        } });
        client.onNotify?.({ method: 'v4/conversation/frame', params: {
          wireVersion: 3, kind: 'complete', deliveryKind: 'initial',
          topic: p.topic, subscriptionId: 'sub1',
          frame: { topic: p.topic, subscriptionId: 'sub1', sentAt: 1, fromSeq: 0, toSeq: 1,
            payload: { kind: 'snapshot', snapshot: {
              logEpoch: 'le1', revision: 7,
              rows: { window: [
                { kind: 'turnHeader', rowId: 3, entityId: 'e3', turnId: 't1',
                  fileChanges: [{ path: 'a.js' }], actions: { canRewindFiles: true },
                  turnCheckpoints: [{ turnIndex: 0, baseFileCheckpointId: 'checkpoint_k1' }] },
              ] },
            } } },
        } });
        return out;
      }
      if (m === 'v4/conversation/fileChanges' || m === 'v4/conversation/fileRewindPreview') {
        return typeof reply === 'function' ? reply(m, p) : reply;
      }
      if (m === 'v4/conversation/unsubscribe') return {};
      throw Object.assign(new Error(`unexpected ${m}`), { code: -32601 });
    },
    close() { this.closed = true; },
  };
  return client;
};
const CHANGES = { files: 2, additions: 10, deletions: 3, state: 'active',
  items: [{ path: 'a.js', additions: 7, deletions: 1, writeCount: 1, toolNames: ['Edit'] },
          { path: 'b.js', additions: 3, deletions: 2, writeCount: 1, toolNames: ['Write'] }] };

{
  const f = v4Client(CHANGES);
  const t = io();
  const code = await runRewind(['changes', '--session', 'sess_1', '--json'], { ...t, client: f });
  assert.equal(code, 0);
  const q = f.calls.find(c => c.m === 'v4/conversation/fileChanges');
  assert.deepEqual(q.p, { sessionId: 'sess_1', target: { rowId: 3, entityId: 'e3' }, baseRevision: 7, baseLogEpoch: 'le1' });
  // session/resume precedes subscribe — the projection only frames loaded sessions
  const order = f.calls.map(c => c.m);
  assert.ok(order.indexOf('session/resume') < order.indexOf('v4/conversation/subscribe'));
  const un = f.calls.find(c => c.m === 'v4/conversation/unsubscribe');
  assert.equal(un.p.topic, 'conversation/sess_1');
  assert.equal(un.p.subscriptionId, 'sub1');
  assert.ok(un.p.connectionId); // per-call uuid
  const payload = JSON.parse(t.out);
  assert.equal(payload.result.files, 2);
  assert.equal(payload.rowId, 3);
}

// preview resolves the row by checkpoint ownership + prints the groups
{
  const f = v4Client({ canApply: false, safeFiles: [{ path: 'a.js' }],
    unsafeFiles: [{ path: 'b.js', reason: 'external_modified' }], ignoredFiles: [] });
  const t = io();
  const code = await runRewind(['preview', 'checkpoint_k1', '--session', 'sess_1'], { ...t, client: f });
  assert.equal(code, 0);
  const q = f.calls.find(c => c.m === 'v4/conversation/fileRewindPreview');
  assert.deepEqual(q.p.target, { rowId: 3, entityId: 'e3' });
  assert.match(t.out, /cannot apply cleanly/);
  assert.match(t.out, /unsafe \(1\)/);
  assert.match(t.out, /external_modified/);
}

// checkpoint with no owning row -> honest miss
{
  const f = v4Client(CHANGES);
  const t = io();
  const code = await runRewind(['preview', 'checkpoint_none', '--session', 'sess_1'], { ...t, client: f });
  assert.equal(code, 1);
  assert.match(t.err, /no turn row owns checkpoint_none/);
}

// surface missing (-32601) and gateway-down (-32603) -> the same honest contract
{
  const dead = { call: async () => { throw Object.assign(new Error('Method not found'), { code: -32601 }); }, close() {} };
  const t = io();
  assert.equal(await runRewind(['changes', '--session', 'sess_1'], { ...t, client: dead }), 1);
  assert.match(t.err, /v4 conversation surface is not available/);

  const gw = { call: async () => { throw Object.assign(new Error('v4 gateway is not initialized'), { code: -32603 }); }, close() {} };
  const t2 = io();
  assert.equal(await runRewind(['preview', '--session', 'sess_1'], { ...t2, client: gw }), 1);
  assert.match(t2.err, /v4 conversation surface is not available/);
}

// stale snapshot pair and non-rewindable rows map to their own messages
{
  const stale = v4Client(() => { throw new Error('proto.staleRevision'); });
  const t = io();
  assert.equal(await runRewind(['changes', '--session', 'sess_1'], { ...t, client: stale }), 1);
  assert.match(t.err, /retry the command/);

  const guard = v4Client(() => { throw new Error('guard.actionUnavailable'); });
  const t2 = io();
  assert.equal(await runRewind(['preview', '--session', 'sess_1'], { ...t2, client: guard }), 1);
  assert.match(t2.err, /not rewindable/);
}

// the same classifiers fire when the kernel carries the reason in `code`
{
  const staleCode = v4Client(() => { throw Object.assign(new Error('stale'), { code: 'proto.staleLogEpoch' }); });
  const t = io();
  assert.equal(await runRewind(['changes', '--session', 'sess_1'], { ...t, client: staleCode }), 1);
  assert.match(t.err, /retry the command/);
}

// a fault.*.unsupported from the row query (host registered the method
// without the capability) maps to the same surface-unavailable contract
{
  const fault = v4Client(() => { throw Object.assign(new Error('fault.fileRewindPreview.unsupported'), { code: -32603 }); });
  const t = io();
  assert.equal(await runRewind(['preview', '--session', 'sess_1', '--json'], { ...t, client: fault }), 1);
  assert.match(t.err, /v4 conversation surface is not available/);
}

// human output for `changes`: header + per-file lines
{
  const f = v4Client(CHANGES);
  const t = io();
  const code = await runRewind(['changes', '--session', 'sess_1'], { ...t, client: f });
  assert.equal(code, 0);
  assert.match(t.out, /2 files changed  \+10 -3 \(active\)/);
  assert.match(t.out, /  a\.js  \+7 -1/);
}

// --json expected-failure paths still emit a parseable payload
{
  const f = v4Client(CHANGES);
  const t = io();
  assert.equal(await runRewind(['preview', 'checkpoint_none', '--session', 'sess_1', '--json'], { ...t, client: f }), 1);
  assert.equal(JSON.parse(t.out).result, null);
}

console.log('PASS test-rewind-command');
