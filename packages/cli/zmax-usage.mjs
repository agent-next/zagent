#!/usr/bin/env node
// zagent usage — session/usage on the most recent tasks-index row, or --session.
// Reports the runtime's own token totals plus inputBaselineBySource (the GUI's
// context-breakdown source).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sessionUsage } from '../driver/session-control.mjs';
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

export const USAGE = 'usage: zagent usage [--session <id>] [--json]';

export function parseUsageArgs(argv) {
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

function formatBaseline(bySource) {
  const entries = Object.entries(bySource ?? {});
  return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(', ') : '(none)';
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

export async function runUsage(argv, opts = {}) {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const parsed = parseUsageArgs(argv);
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
    stderr.write('usage: no session (pass --session <id> or run a task first)\n');
    return 2;
  }

  let client = opts.client;
  let owned = false;
  if (!client) {
    try {
      client = await (opts.createClient ?? defaultCreateClient)();
      owned = true;
    } catch (e) {
      stderr.write(`usage: ${e?.message ?? e}\n`);
      return 1;
    }
  }

  try {
    const usage = await sessionUsage(client, sessionId);
    if (parsed.json) {
      stdout.write(`${JSON.stringify({ sessionId, ...usage }, null, 2)}\n`);
    } else {
      stdout.write(`session: ${sessionId}\n`);
      stdout.write(`totalTokens: ${usage.totalTokens}\n`);
      stdout.write(`inputTokens: ${usage.inputTokens}\n`);
      stdout.write(`outputTokens: ${usage.outputTokens}\n`);
      stdout.write(`reasoningTokens: ${usage.reasoningTokens}\n`);
      stdout.write(`cacheReadTokens: ${usage.cacheReadTokens}\n`);
      stdout.write(`cacheCreationTokens: ${usage.cacheCreationTokens}\n`);
      stdout.write(`modelRequestCount: ${usage.modelRequestCount}\n`);
      stdout.write(`modelErrorCount: ${usage.modelErrorCount}\n`);
      stdout.write(`inputBaselineBySource: ${formatBaseline(usage.baselineBySource)}\n`);
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
    stderr.write(`usage: ${e?.message ?? e}\n`);
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
  runUsage(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => { console.error(`usage: ${err?.message ?? err}`); process.exit(1); },
  );
}
