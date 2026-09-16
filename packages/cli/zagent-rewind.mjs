#!/usr/bin/env node
// zagent rewind — the kernel's /rewind surface: inspect workspace checkpoints
// (session_entry rows in the kernel store) or restore one by forking the
// session at it (session/fork target union, 3.12.1). Forking creates a NEW
// session and restores the snapshotted files — the GUI's undo-a-turn.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { conversationFileChanges, conversationFileRewindPreview, conversationSnapshot, conversationTopic, defaultSessionForRewind, forkSession, isRowActionUnavailable, isStaleConversationBase, isV4SurfaceUnavailable, listSessionCheckpoints, noCheckpointYet, pickConversationRow, resumeSession, subscribeConversation, unsubscribeConversation } from '../driver/rewind.mjs';
import { recentSession } from './zagent-goal.mjs';
import { NOT_RUNNING, isNotRunning } from './session-errors.mjs';

export const USAGE = 'usage: zagent rewind [list|latest|<checkpointId>|changes|preview [<checkpointId>]] [--message <id>] [--session <id>] [--json]';
const CHECKPOINT_ID = /^checkpoint_[A-Za-z0-9-]+$/;

const agoWords = (ms) => {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

export function parseRewindArgs(argv) {
  let json = false;
  let session;
  let message;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { json = true; continue; }
    if (a === '--session' || a === '--message') {
      const v = argv[++i];
      if (typeof v !== 'string' || !v.trim() || v.startsWith('-')) return { error: USAGE };
      if (a === '--session') session = v.trim(); else message = v.trim();
      continue;
    }
    if (a.startsWith('--session=') || a.startsWith('--message=')) {
      const v = a.slice(a.indexOf('=') + 1).trim();
      if (!v) return { error: USAGE };
      if (a.startsWith('--session=')) session = v; else message = v;
      continue;
    }
    if (a.startsWith('-')) return { error: USAGE };
    positional.push(a);
  }
  if (positional.length > 2) return { error: USAGE };
  const target = positional[0];
  const base = { checkpointId: undefined, messageId: undefined, json, session };
  if (message !== undefined) {
    if (target !== undefined) return { error: USAGE };
    return { ...base, action: 'message', messageId: message };
  }
  // `changes`/`preview` ride the v4 conversation surface — the row query, not
  // session/fork. `preview <checkpointId>` targets the turn owning it.
  if (target === 'changes' || target === 'preview') {
    const second = positional[1];
    if (second === undefined) return { ...base, action: target };
    if (target === 'changes' || !CHECKPOINT_ID.test(second)) return { error: USAGE };
    return { ...base, action: 'preview', checkpointId: second };
  }
  if (positional.length > 1) return { error: USAGE };
  if (target === undefined || target === 'list') {
    return { ...base, action: 'list' };
  }
  if (target === 'latest') return { ...base, action: 'latest' };
  if (!CHECKPOINT_ID.test(target)) return { error: USAGE };
  return { ...base, action: 'checkpoint', checkpointId: target };
}

async function defaultCreateClient() {
  const { ZCodeProtocolClient } = await import('../driver/zcode-protocol.mjs');
  const client = new ZCodeProtocolClient({ cwd: process.cwd() });
  try {
    await client.ready;
    return client;
  } catch (e) {
    try { client.close(); } catch {}
    throw e;
  }
}

export async function runRewind(argv, opts = {}) {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const parsed = parseRewindArgs(argv);
  if (parsed.error) {
    stderr.write(`${parsed.error}\n`);
    return 2;
  }

  // list reads the kernel's checkpoint ledger (session_entry rows), the same
  // store session/fork resolves targets against — not the GUI's git refs.
  if (parsed.action === 'list') {
    const cwd = opts.cwd ?? process.cwd();
    let checkpoints;
    try {
      checkpoints = listSessionCheckpoints(
        parsed.session ? { home: opts.home, sessionId: parsed.session } : { home: opts.home, cwd });
    } catch (e) {
      stderr.write(`rewind: could not read the session store: ${e?.message ?? e}\n`);
      return 1;
    }
    if (parsed.json) {
      stdout.write(`${JSON.stringify({ ...(parsed.session ? { sessionId: parsed.session } : { cwd }), checkpoints }, null, 2)}\n`);
    } else if (checkpoints.length === 0) {
      stdout.write('no workspace checkpoints (checkpoints appear after a file-editing turn)\n');
    } else {
      for (const c of checkpoints) {
        const files = c.fileCount === null ? '' : `  ${c.fileCount} file${c.fileCount === 1 ? '' : 's'}`;
        const when = c.createdAt === null ? '' : `  ${agoWords(c.createdAt)}`;
        stdout.write(`${c.checkpointId}  ${c.sessionId}${files}${when}\n`);
      }
    }
    return 0;
  }

  let sessionId = parsed.session;
  if (!sessionId) {
    // The kernel session store first: scoped to THIS workspace — rewinding a
    // foreign-cwd session would restore files in another project. It also sees
    // headless -p sessions, which never write tasks-index rows (verified
    // 2026-09-16). For --message there is no message→session index; the
    // newest-checkpoint owner is the heuristic. Caller resolver, then
    // tasks-index recency, are the last fallbacks.
    const resolved = defaultSessionForRewind({ home: opts.home, cwd: opts.cwd ?? process.cwd(), checkpointId: parsed.checkpointId })
      ?? (opts.resolveSession ? await opts.resolveSession() : null)
      ?? recentSession({ home: opts.home });
    const id = typeof resolved === 'string' ? resolved : resolved?.id;
    const startedAt = typeof resolved === 'object' && resolved ? resolved.startedAt : null;
    if (typeof id === 'string' && id.trim()) {
      sessionId = id.trim();
      stderr.write(`using latest CLI session ${sessionId}${startedAt ? `, started ${agoWords(startedAt)}` : ''}\n`);
    }
  }
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    stderr.write('rewind: no session (pass --session <id> or run a task first)\n');
    return 2;
  }

  let client = opts.client;
  let owned = false;
  if (!client) {
    try {
      client = await (opts.createClient ?? defaultCreateClient)();
      owned = true;
    } catch (e) {
      stderr.write(`rewind: ${e?.message ?? e}\n`);
      return 1;
    }
  }

  try {
    if (parsed.action === 'changes' || parsed.action === 'preview') {
      return await runConversationQuery(client, sessionId, parsed, stdout, stderr);
    }
    // session/fork only reaches sessions ACTIVE in this app-server; a finished
    // -p session must be resumed from the store first (idempotent when active).
    // Old runtimes without session/resume (-32601) skip straight to fork —
    // that preserves the pre-3.12 contract for live sessions.
    try { await resumeSession(client, sessionId); }
    catch (e) { if (e?.code !== -32601) throw e; }
    const r = await forkSession(client, sessionId, parsed);
    if (parsed.json) {
      stdout.write(`${JSON.stringify({ sessionId, action: parsed.action, ...r }, null, 2)}\n`);
    } else {
      stdout.write(`from session: ${sessionId}\n`);
      stdout.write(`forked session: ${r.forkedSessionId ?? '(none)'}\n`);
      if (r.targetCheckpointId) stdout.write(`checkpoint: ${r.targetCheckpointId}\n`);
      if (r.summary) stdout.write(`${r.summary}\n`);
    }
    return 0;
  } catch (e) {
    if (noCheckpointYet(e)) {
      if (parsed.json) {
        stdout.write(`${JSON.stringify({ sessionId, checkpoint: null }, null, 2)}\n`);
      }
      stderr.write('rewind: no workspace checkpoint is available yet (checkpoints appear after a file-editing turn)\n');
      return 1;
    }
    if (isNotRunning(e)) {
      if (parsed.json) {
        stderr.write(`${NOT_RUNNING}\n`);
        stdout.write(`${JSON.stringify({ sessionId, running: false }, null, 2)}\n`);
      } else {
        stdout.write(`${NOT_RUNNING}\n`);
      }
      return 0;
    }
    stderr.write(`rewind: ${e?.message ?? e}\n`);
    return 1;
  } finally {
    if (owned) try { client.close?.(); } catch {}
  }
}

// `changes`/`preview`: the v4 conversation row queries. Subscribe → snapshot
// (frame notification) → resolve the turnHeader row → fileChanges /
// fileRewindPreview → unsubscribe. Errors map to the honest contracts:
// surface missing, session not running, stale snapshot, row not rewindable.
async function runConversationQuery(client, sessionId, parsed, stdout, stderr) {
  let sub;
  try {
    // The v4 projection only emits frames for a session loaded in this
    // app-server — a finished -p session must be resumed first (idempotent
    // when already active; -32601 skips on runtimes without session/resume).
    try { await resumeSession(client, sessionId); }
    catch (e) { if (e?.code !== -32601) throw e; }
    sub = await subscribeConversation(client, sessionId);
  } catch (e) {
    if (isV4SurfaceUnavailable(e)) {
      if (parsed.json) stdout.write(`${JSON.stringify({ sessionId, result: null }, null, 2)}\n`);
      stderr.write('rewind: the v4 conversation surface is not available on this runtime\n');
      return 1;
    }
    throw e;
  }
  try {
    const snapshot = conversationSnapshot(sub?.wire);
    if (!snapshot || snapshot.revision === null || !snapshot.logEpoch) {
      if (parsed.json) stdout.write(`${JSON.stringify({ sessionId, result: null }, null, 2)}\n`);
      stderr.write('rewind: no conversation snapshot arrived for this session\n');
      return 1;
    }
    const row = pickConversationRow(snapshot.rows, { checkpointId: parsed.checkpointId });
    if (!row) {
      if (parsed.json) stdout.write(`${JSON.stringify({ sessionId, result: null }, null, 2)}\n`);
      stderr.write(parsed.checkpointId
        ? `rewind: no turn row owns ${parsed.checkpointId}\n`
        : 'rewind: no turn has file changes yet (rows appear after a file-editing turn)\n');
      return 1;
    }
    const result = parsed.action === 'changes'
      ? await conversationFileChanges(client, sessionId, row, snapshot)
      : await conversationFileRewindPreview(client, sessionId, row, snapshot);
    if (parsed.json) {
      stdout.write(`${JSON.stringify({ sessionId, rowId: row.rowId, turnId: row.turnId ?? null, result }, null, 2)}\n`);
    } else if (parsed.action === 'changes') {
      printChanges(stdout, result);
    } else {
      printPreview(stdout, result);
    }
    return 0;
  } catch (e) {
    if (isStaleConversationBase(e) || isRowActionUnavailable(e) || isV4SurfaceUnavailable(e)) {
      if (parsed.json) stdout.write(`${JSON.stringify({ sessionId, result: null }, null, 2)}\n`);
      stderr.write(isStaleConversationBase(e)
        ? `rewind: ${e?.message ?? e} — retry the command\n`
        : isRowActionUnavailable(e)
          ? 'rewind: that turn is not rewindable\n'
          : 'rewind: the v4 conversation surface is not available on this runtime\n');
      return 1;
    }
    throw e;
  } finally {
    if (sub?.ack) {
      try {
        await unsubscribeConversation(client, {
          topic: conversationTopic(sessionId),
          subscriptionId: sub.ack.subscriptionId,
          connectionId: sub.connectionId,
        });
      } catch {}
    }
  }
}

function printChanges(stdout, r) {
  const items = Array.isArray(r?.items) ? r.items : [];
  const files = Number.isInteger(r?.files) ? r.files : items.length;
  const adds = Number.isInteger(r?.additions) ? `  +${r.additions}` : '';
  const dels = Number.isInteger(r?.deletions) ? ` -${r.deletions}` : '';
  const state = typeof r?.state === 'string' && r.state ? ` (${r.state})` : '';
  stdout.write(`${files} file${files === 1 ? '' : 's'} changed${adds}${dels}${state}\n`);
  for (const it of items) {
    stdout.write(`  ${it.path}  +${it.additions ?? 0} -${it.deletions ?? 0}\n`);
  }
}

function printPreview(stdout, r) {
  const group = (label, files) => {
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return;
    stdout.write(`${label} (${list.length}):\n`);
    for (const f of list) {
      const p = typeof f === 'string' ? f : (f?.path ?? f?.file ?? '?');
      const why = typeof f === 'object' && f?.reason ? `  (${f.reason})` : '';
      stdout.write(`  ${p}${why}\n`);
    }
  };
  stdout.write(`${r?.canApply === true ? 'rewind applies cleanly' : 'rewind cannot apply cleanly'}\n`);
  group('safe', r?.safeFiles);
  group('unsafe', r?.unsafeFiles);
  group('ignored', r?.ignoredFiles);
}

const isMain = (() => {
  try { return import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href; }
  catch { return false; }
})();
if (isMain) {
  runRewind(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => { console.error(`rewind: ${err?.message ?? err}`); process.exit(1); },
  );
}
