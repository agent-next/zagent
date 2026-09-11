#!/usr/bin/env node
// zagent goal — session/goal show|set|pause|resume|clear on the most recent
// tasks-index row, or --session. Protocol key is `objective` (not `goal`).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { goalShow, goalSet, goalControl, projectionOf } from '../driver/session-control.mjs';
import { openTasksDb, listTasks } from '../driver/tasks-index.mjs';

export const USAGE = 'usage: zagent goal [show|set <text>|pause|resume|clear] [--session <id>] [--json]';
const ACTIONS = new Set(['show', 'set', 'pause', 'resume', 'clear']);

export function parseGoalArgs(argv) {
  let json = false;
  let session;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { json = true; continue; }
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
  if (action === 'set') {
    const objective = positional.slice(1).join(' ').trim();
    if (!objective) return { error: USAGE };
    return { action, objective, json, session };
  }
  if (positional.length > 1) return { error: USAGE };
  return { action, json, session };
}

export function recentSessionId({ home } = {}) {
  try {
    const db = openTasksDb({ home, readOnly: true });
    try {
      const id = listTasks(db)[0]?.task_id;
      return typeof id === 'string' && id.trim() ? id : null;
    } finally { db.close(); }
  } catch { return null; }
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
  const sessionId = parsed.session
    ?? (opts.resolveSession ? await opts.resolveSession() : recentSessionId({ home: opts.home }));
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
