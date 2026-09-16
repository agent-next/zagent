#!/usr/bin/env node
// zagent usage — session/usage on the most recent tasks-index row, or --session.
// Reports the runtime's own token totals plus inputBaselineBySource (the GUI's
// context-breakdown source). `usage stats` is the GUI's app-usage dashboard:
// usage/stats {range, timeZone} → summary/heatmap/models/tools (3.12.1).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appUsageStats, sessionUsage, USAGE_STATS_RANGES } from '../driver/session-control.mjs';
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

export const USAGE = 'usage: zagent usage [--session <id>] [--json] | zagent usage stats [--range all|7d|30d] [--json]';

export function parseUsageArgs(argv) {
  let json = false;
  let session;
  let range;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { json = true; continue; }
    if (a === '--session' || a === '--range') {
      const v = argv[++i];
      if (typeof v !== 'string' || !v.trim() || v.startsWith('-')) return { error: USAGE };
      if (a === '--session') session = v.trim(); else range = v.trim();
      continue;
    }
    if (a.startsWith('--session=') || a.startsWith('--range=')) {
      const v = a.slice(a.indexOf('=') + 1).trim();
      if (!v) return { error: USAGE };
      if (a.startsWith('--session=')) session = v; else range = v;
      continue;
    }
    if (a.startsWith('-')) return { error: USAGE };
    positional.push(a);
  }
  if (positional.length > 1 || (positional.length === 1 && positional[0] !== 'stats')) {
    return { error: USAGE };
  }
  if (positional[0] === 'stats') {
    if (session !== undefined) return { error: USAGE };
    const r = range ?? '7d';
    if (!USAGE_STATS_RANGES.includes(r)) return { error: USAGE };
    return { action: 'stats', json, range: r };
  }
  if (range !== undefined) return { error: USAGE };
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

const pct = (v) => (typeof v === 'number' && Number.isFinite(v)) ? `${(v * 100).toFixed(1)}%` : 'n/a';

function printStats(stdout, snap) {
  const s = snap?.summary ?? {};
  const when = typeof snap?.generatedAt === 'number' ? new Date(snap.generatedAt).toISOString() : 'unknown';
  stdout.write(`app usage (source: ${snap?.source ?? 'unknown'}, generated: ${when})\n`);
  stdout.write(`range: ${snap?.range ?? 'unknown'}\n`);
  for (const k of ['totalTokens', 'inputTokens', 'outputTokens', 'reasoningTokens',
    'cacheReadTokens', 'cacheCreationTokens', 'totalSessions', 'totalTurns',
    'toolCallCount', 'activeDays', 'currentStreakDays', 'longestStreakDays',
    'longestSessionMs', 'peakDayTokens', 'avgTimeToFirstTokenMs', 'avgTurnDurationMs']) {
    const v = s[k];
    stdout.write(`${k === 'totalSessions' ? 'sessions' : k === 'totalTurns' ? 'turns' : k === 'toolCallCount' ? 'toolCalls' : k}: ${v ?? 'n/a'}\n`);
  }
  stdout.write(`cacheHitRate: ${pct(s.cacheHitRate)}\n`);
  stdout.write(`toolErrorRate: ${pct(s.toolErrorRate)}\n`);
  stdout.write(`modelErrorRate: ${pct(s.modelErrorRate)}\n`);
  const fav = s.favoriteModel;
  stdout.write(`favoriteModel: ${fav?.modelId ?? '(none)'}${fav ? ` (${pct(fav.share)})` : ''}\n`);
  const models = Array.isArray(snap?.models) ? snap.models : [];
  if (models.length) {
    stdout.write('models:\n');
    for (const m of models) {
      stdout.write(`  ${m?.modelId ?? '(unknown)'}: ${m?.totalTokens ?? 0} tokens (${pct(m?.share)}, ${m?.requestCount ?? 0} requests)\n`);
    }
  }
  const tools = Array.isArray(snap?.tools) ? snap.tools : [];
  if (tools.length) {
    stdout.write('tools:\n');
    for (const t of tools) {
      stdout.write(`  ${t?.toolName ?? '(unknown)'}: ${t?.callCount ?? 0} calls (${pct(t?.errorRate)} errors)\n`);
    }
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
  if (parsed.action === 'stats') {
    let client = opts.client;
    let owned = false;
    if (!client) {
      try {
        client = await (opts.createClient ?? defaultCreateClient)();
        owned = true;
      } catch (e) {
        stderr.write(`usage stats: ${e?.message ?? e}\n`);
        return 1;
      }
    }
    try {
      const snap = await appUsageStats(client, {
        range: parsed.range,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (parsed.json) {
        stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
      } else {
        printStats(stdout, snap);
      }
      return 0;
    } catch (e) {
      if (e?.code === -32601) {
        stderr.write('usage stats: this runtime does not serve usage/stats (needs ZCode desktop 3.12.x or newer)\n');
      } else {
        stderr.write(`usage stats: ${e?.message ?? e}\n`);
      }
      return 1;
    } finally {
      if (owned) try { client.close?.(); } catch {}
    }
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
