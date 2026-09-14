#!/usr/bin/env node
// zagent subagents — session/subagents on the most recent tasks-index row, or --session.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listSubagents } from '../driver/session-control.mjs';
import { openTasksDb } from '../driver/tasks-index.mjs';
import { NOT_RUNNING, isNotRunning } from './session-errors.mjs';

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
    if (isNotRunning(e)) {
      if (parsed.json) {
        stderr.write(`${NOT_RUNNING}\n`);
        stdout.write(`${JSON.stringify({ sessionId, running: false }, null, 2)}\n`);
      } else {
        stdout.write(`${NOT_RUNNING}\n`);
      }
      return 0;
    }
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
