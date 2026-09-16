// Session control surfaces — the runtime's own admin methods, live-verified 2026-09-05
// against runtime 2.1.0 (desktop 3.11.2). All params below are the exact shapes the
// runtime's zod schemas accept (wrong shapes give -32602 with the field named).
//
//   session/usage         {sessionId} -> totals + inputBaselineBySource (context breakdown)
//   session/compact       {sessionId} -> full snapshot (E5)
//   session/setModel      {sessionId, model:{modelId, providerId}}
//   session/setThoughtLevel {sessionId, thoughtLevel}
//   session/setMode       {sessionId, mode: 'plan'|'build'|'edit'|'yolo'|'auto'}
//
// automation/* exists in the desktop bundle's strings but the app-server answers
// -32601 for automation/list — that surface is GUI-side, not protocol-side (gap note).

export const MODES = ['plan', 'build', 'edit', 'yolo', 'auto'];

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : 0;

export async function sessionUsage(client, sessionId) {
  const u = await client.call('session/usage', { sessionId }, 20000);
  return {
    totalTokens: num(u?.totalTokens), inputTokens: num(u?.inputTokens), outputTokens: num(u?.outputTokens),
    reasoningTokens: num(u?.reasoningTokens), cacheReadTokens: num(u?.cacheReadTokens),
    cacheCreationTokens: num(u?.cacheCreationTokens),
    modelRequestCount: num(u?.modelRequestCount), modelErrorCount: num(u?.modelErrorCount),
    baselineBySource: u?.inputBaselineBySource ?? {}, // e.g. {main_turn: 18474} — the GUI context-breakdown source
  };
}

// App-usage dashboard (live-verified 2026-09-16, runtime 3.12.1): usage/stats
// takes strict {range, timeZone?} — range ∈ all|7d|30d — and answers a snapshot
// {range, generatedAt, timeZone, source:'agent-db', summary, heatmap,
// dailyModelUsage, models, tools}. v4/usage/stats is the same surface under the
// v4 prefix — retry it once on -32601 for runtimes that only register that name.
export const USAGE_STATS_RANGES = ['all', '7d', '30d'];

export async function appUsageStats(client, { range = '7d', timeZone } = {}) {
  if (!USAGE_STATS_RANGES.includes(range)) {
    throw new Error(`appUsageStats: range must be one of ${USAGE_STATS_RANGES.join('|')} (got '${range}')`);
  }
  const params = { range };
  if (typeof timeZone === 'string' && timeZone) params.timeZone = timeZone;
  try {
    return await client.call('usage/stats', params, 20000);
  } catch (e) {
    if (e?.code !== -32601) throw e;
    return client.call('v4/usage/stats', params, 20000);
  }
}

export function compactSession(client, sessionId, { timeoutMs = 120000 } = {}) {
  return client.call('session/compact', { sessionId }, timeoutMs); // returns {response, snapshot}
}

export function setModel(client, sessionId, modelId, providerId = 'zai') {
  return client.call('session/setModel', { sessionId, model: { modelId, providerId } }, 20000);
}

export function setThoughtLevel(client, sessionId, thoughtLevel) {
  return client.call('session/setThoughtLevel', { sessionId, thoughtLevel }, 20000);
}

export function setMode(client, sessionId, mode) {
  if (!MODES.includes(mode)) throw new Error(`setMode: mode must be one of ${MODES.join('|')} (got '${mode}')`);
  return client.call('session/setMode', { sessionId, mode }, 20000);
}

// --- Goal loop (protocol-side, live-verified 2026-09-05) ---
// action enum: show|set|replace|pause|resume|clear; the goal text key is `objective`
// (NOT `goal` — that's the -32602 trap). Projection in every reply carries
// {contextUsed, contextWindow, mode} — the GUI's context meter.
export function goalShow(client, sessionId) {
  return client.call('session/goal', { sessionId, action: 'show' }, 20000);
}
export function goalSet(client, sessionId, objective) {
  return client.call('session/goal', { sessionId, action: 'set', objective }, 20000);
}
export function goalReplace(client, sessionId, objective) {
  return client.call('session/goal', { sessionId, action: 'replace', objective }, 20000);
}
export function goalControl(client, sessionId, action) { // pause|resume|clear
  if (!['pause', 'resume', 'clear'].includes(action)) throw new Error(`goalControl: action must be pause|resume|clear (got '${action}')`);
  return client.call('session/goal', { sessionId, action }, 20000);
}

// Context meter from any snapshot-bearing reply (goal/compact/setModel all return it):
// {contextUsed, contextWindow, mode} — normalized, junk-safe.
export function projectionOf(reply) {
  const p = reply?.snapshot?.projection ?? reply?.projection;
  if (!p) return null;
  return { contextUsed: num(p.contextUsed), contextWindow: num(p.contextWindow), mode: p.mode ?? null };
}

// Subagent monitor (live-verified 2026-09-05): requires a session that has run at
// least one turn (a fresh session answers -32004 not-found).
export async function listSubagents(client, sessionId) {
  const r = await client.call('session/subagents', { sessionId }, 20000);
  return { revision: num(r?.revision), childSessionIds: r?.childSessionIds ?? [],
    running: r?.running ?? [], endedCount: num(r?.ended?.total), ended: r?.ended?.items ?? [] };
}

// A3 v4 gateway (live-verified 2026-09-06): session/subscribe {sessionId, deliveryKind}
// with deliveryKind ∈ 'desktop-continuous' | 'web-remote-replayable' → {eventSeq, events};
// subscribed sessions then push `session/event` notifications. session/events replays.
export const DELIVERY_KINDS = ['desktop-continuous', 'web-remote-replayable'];

export function subscribeSession(client, sessionId, deliveryKind = 'desktop-continuous', { includeSnapshot } = {}) {
  if (!DELIVERY_KINDS.includes(deliveryKind)) throw new Error(`subscribeSession: deliveryKind must be ${DELIVERY_KINDS.join('|')} (case-sensitive, exact)`);
  const params = { sessionId, deliveryKind };
  if (includeSnapshot !== undefined) params.includeSnapshot = includeSnapshot;
  return client.call('session/subscribe', params, 20000);
}

export function replayEvents(client, sessionId, { afterSeq, limit } = {}) {
  const params = { sessionId };
  if (Number.isInteger(afterSeq) && afterSeq >= 0) params.afterSeq = afterSeq; // r17 #2: resume cursor — without it the FULL history replays every call
  if (Number.isInteger(limit) && limit > 0) params.limit = limit;
  return client.call('session/events', params, 20000);
}

// A3: subscribed-event catalog — 6 types live-captured 2026-09-06 on the desktop-continuous
// lane during an agentic edit turn; verified by execution
// fileChanges/fileRewindPreview do NOT ride this lane (relay/web-remote-replayable payloads).
export const SESSION_EVENT_TYPES = ['session.titleUpdated', 'turn.started', 'session.updated',
  'model.streaming', 'tool.updated', 'streamRecovery.updated'];

export function sessionEventEnvelope(p) { // normalize one session/event notify param
  // payload is RAW (may carry turn-input text) — NOT safe to log/export verbatim; use
  // sessionEventMeta() for a payload-free diagnostics projection.
  return { type: typeof p?.type === 'string' ? p.type : null,
    seq: Number.isInteger(p?.seq) ? p.seq : null,
    turnId: typeof p?.turnId === 'string' ? p.turnId : null,
    deliveryKind: typeof p?.deliveryKind === 'string' ? p.deliveryKind : null,
    payload: p?.payload ?? null };
}

export function sessionEventMeta(p) { // payload-free projection for logging/diagnostics
  const e = sessionEventEnvelope(p);
  return { type: e.type, seq: e.seq, turnId: e.turnId, deliveryKind: e.deliveryKind };
}
