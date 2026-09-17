#!/usr/bin/env node
// zagent goal — session/goal show|set|pause|resume|clear on the most recent
// tasks-index row, or --session; `list` enumerates those sessions offline.
// Protocol key is `objective` (not `goal`).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { goalShow, goalSet, goalControl, projectionOf } from '../driver/session-control.mjs';
import { openTasksDb, openTasksDbIfPresent, listTasks } from '../driver/tasks-index.mjs';
import { NOT_RUNNING, isNotRunning } from './session-errors.mjs';

export const USAGE = 'usage: zagent goal list [--all] [--json] | show|set <text>|pause|resume|clear [--session <id>] [--json]';
const ACTIONS = new Set(['list', 'show', 'set', 'pause', 'resume', 'clear']);

export function parseGoalArgs(argv) {
  let json = false;
  let all = false;
  let session;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { json = true; continue; }
    if (a === '--all') { all = true; continue; }
    if (a === '--session') {
      const v = argv[++i];
      if (typeof v !== 'string' || !v.trim() || v.startsWith('-')) return { error: USAGE };
      session = v.trim();
      continue;
    }
    if (a.startsWith('--session=')) {
      const v = a.slice('--session='.length).trim();
      if (!v) return { error: USAGE };
      session = v;
      continue;
    }
    if (a.startsWith('-')) return { error: USAGE };
    positional.push(a);
  }
  const action = positional[0] ?? 'show';
  if (!ACTIONS.has(action)) return { error: USAGE };
  if (all && action !== 'list') return { error: USAGE };
  if (action === 'list') {
    if (session !== undefined || positional.length > 1) return { error: USAGE };
    return { action, json, all };
  }
  if (action === 'set') {
    const objective = positional.slice(1).join(' ').trim();
    if (!objective) return { error: USAGE };
    return { action, objective, json, session };
  }
  if (positional.length > 1) return { error: USAGE };
  return { action, json, session };
}

export function recentSession({ home } = {}) {
  try {
    const db = openTasksDb({ home, readOnly: true });
    try {
      const row = db.prepare('SELECT task_id, created_at, updated_at FROM tasks WHERE deleted = 0 AND archived = 0 ORDER BY updated_at DESC LIMIT 1').get();
      return typeof row?.task_id === 'string' && row.task_id.trim()
        ? { id: row.task_id, startedAt: Number.isFinite(row.created_at) ? row.created_at : null }
        : null;
    } finally { db.close(); }
  } catch { return null; }
}

export function recentSessionId({ home } = {}) {
  return recentSession({ home })?.id ?? null;
}

const agoWords = (ms) => {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

// A tasks-index row proves a session existed, not that it still runs: sessions
// live inside the process that owns them, so a stale id answers "not found".

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

function goalPayload(reply, { sessionId, action, objective }) {
  const payload = {
    sessionId,
    action,
    response: typeof reply?.response === 'string' ? reply.response : null,
  };
  if (objective) payload.objective = objective;
  const projection = projectionOf(reply);
  if (projection) payload.projection = projection;
  return payload;
}

export async function runGoal(argv, opts = {}) {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const parsed = parseGoalArgs(argv);
  if (parsed.error) {
    stderr.write(`${parsed.error}\n`);
    return 2;
  }
  // `goal list` answers from the task index alone — goals live inside a
  // session's kernel process, so the honest list is the sessions `goal show
  // --session <id>` can act on, not the goals themselves. No client needed.
  if (parsed.action === 'list') {
    const db = openTasksDbIfPresent({ home: opts.home, readOnly: true });
    let rows = [];
    try { rows = db ? listTasks(db, { includeArchived: parsed.all }) : []; }
    catch { rows = []; } // a mismatched/corrupt store is zero sessions, like openTasksDbIfPresent
    try { db?.close(); } catch {}
    if (parsed.json) {
      stdout.write(`${JSON.stringify({ count: rows.length, sessions: rows.map(r => ({
        sessionId: r.task_id, title: r.title, status: r.task_status ?? null,
        pinned: !!r.pinned, archived: !!r.archived,
      })) }, null, 2)}\n`);
    } else {
      if (!rows.length) stdout.write('no sessions (run a task first)\n');
      for (const r of rows) {
        stdout.write(`${r.pinned ? '📌' : ' '} ${r.archived ? '[archived] ' : ''}${r.task_id}  ${r.title}  (${r.task_status ?? '?'})\n`);
      }
      if (rows.length) stderr.write("inspect a session's goal: zagent goal show --session <id>\n");
    }
    return 0;
  }
  let sessionId = parsed.session;
  if (!sessionId) {
    const resolved = opts.resolveSession ? await opts.resolveSession() : recentSession({ home: opts.home });
    const id = typeof resolved === 'string' ? resolved : resolved?.id;
    const startedAt = typeof resolved === 'object' && resolved ? resolved.startedAt : null;
    if (typeof id === 'string' && id.trim()) {
      sessionId = id;
      stderr.write(`using latest CLI session ${sessionId}${startedAt ? `, started ${agoWords(startedAt)}` : ''}\n`);
    }
  }
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    stderr.write('goal: no session (pass --session <id> or run a task first)\n');
    return 2;
  }

  let client = opts.client;
  let owned = false;
  if (!client) {
    try {
      client = await (opts.createClient ?? defaultCreateClient)();
      owned = true;
    } catch (e) {
      stderr.write(`goal: ${e?.message ?? e}\n`);
      return 1;
    }
  }

  try {
    let reply;
    if (parsed.action === 'show') reply = await goalShow(client, sessionId);
    else if (parsed.action === 'set') reply = await goalSet(client, sessionId, parsed.objective);
    else reply = await goalControl(client, sessionId, parsed.action);
    if (parsed.json) {
      stdout.write(`${JSON.stringify(goalPayload(reply, {
        sessionId, action: parsed.action, objective: parsed.objective,
      }), null, 2)}\n`);
    } else {
      const text = typeof reply?.response === 'string' && reply.response.trim()
        ? reply.response.trim()
        : `goal ${parsed.action} ok`;
      stdout.write(`session: ${sessionId}\n${text}\n`);
    }
    return 0;
  } catch (e) {
    if (isNotRunning(e)) {
      if (parsed.json) {
        stderr.write(`${NOT_RUNNING}\n`);
        stdout.write(`${JSON.stringify({ sessionId, running: false }, null, 2)}\n`);
      } else {
        stdout.write(`${NOT_RUNNING}\n`);
      }
      return 0;
    }
    stderr.write(`goal: ${e?.message ?? e}\n`);
    return 1;
  } finally {
    if (owned) try { client.close?.(); } catch {}
  }
}

const isMain = (() => {
  try { return import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href; }
  catch { return false; }
})();
if (isMain) {
  runGoal(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => { console.error(`goal: ${err?.message ?? err}`); process.exit(1); },
  );
}
