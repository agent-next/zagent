#!/usr/bin/env node
// zagent subagents — session/subagents on the most recent tasks-index row, or --session.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listSubagents } from '../driver/session-control.mjs';
import { openTasksDb, listTasks } from '../driver/tasks-index.mjs';

export function recentSessionId({ home } = {}) {
  try {
    const db = openTasksDb({ home, readOnly: true });
    try {
      const id = listTasks(db)[0]?.task_id;
      return typeof id === 'string' && id.trim() ? id : null;
    } finally { db.close(); }
  } catch { return null; }
}

export const USAGE = 'usage: zagent subagents [--session <id>] [--json]';

export function parseSubagentsArgs(argv) {
  let json = false;
  let session;
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
    return { error: USAGE };
  }
  return { json, session };
}

function childId(item) {
  if (typeof item === 'string' && item.trim()) return item;
  if (!item || typeof item !== 'object') return null;
  for (const key of ['sid', 'sessionId', 'childSessionId', 'id']) {
    if (typeof item[key] === 'string' && item[key].trim()) return item[key];
  }
  return null;
}

function formatIds(items) {
  const ids = (items ?? []).map(childId).filter(Boolean);
  return ids.length ? ids.join(', ') : '(none)';
}

function formatEnded(ended, endedCount) {
  const ids = (ended ?? []).map(childId).filter(Boolean);
  if (ids.length) {
    return endedCount > ids.length ? `${ids.join(', ')} (total ${endedCount})` : ids.join(', ');
  }
  return endedCount > 0 ? String(endedCount) : '(none)';
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

export async function runSubagents(argv, opts = {}) {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const parsed = parseSubagentsArgs(argv);
  if (parsed.error) {
    stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const sessionId = parsed.session
    ?? (opts.resolveSession ? await opts.resolveSession() : recentSessionId({ home: opts.home }));
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    stderr.write('subagents: no session (pass --session <id> or run a task first)\n');
    return 2;
  }

  let client = opts.client;
  let owned = false;
  if (!client) {
    try {
      client = await (opts.createClient ?? defaultCreateClient)();
      owned = true;
    } catch (e) {
      stderr.write(`subagents: ${e?.message ?? e}\n`);
      return 1;
    }
  }

  try {
    const listed = await listSubagents(client, sessionId);
    const payload = { sessionId, ...listed };
    if (parsed.json) {
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      stdout.write(`session: ${sessionId}\n`);
      stdout.write(`childSessionIds: ${formatIds(listed.childSessionIds)}\n`);
      stdout.write(`running: ${formatIds(listed.running)}\n`);
      stdout.write(`ended: ${formatEnded(listed.ended, listed.endedCount)}\n`);
    }
    return 0;
  } catch (e) {
    stderr.write(`subagents: ${e?.message ?? e}\n`);
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
  runSubagents(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => { console.error(`subagents: ${err?.message ?? err}`); process.exit(1); },
  );
}
