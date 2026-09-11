// zcode-driver — minimal ZCode Protocol v1 (NDJSON over stdio) client for the ZCode agent runtime.
// Verified against runtime 0.16.5 (GUI 3.10.2) on 2026-09-03: session/list works with no
// handshake preamble; session/create requires workspace:{workspaceKey,workspacePath};
// errors are JSON-RPC-style codes (-32601 method, -32602 invalid params with Zod detail).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { findRuntime } from './runtime.mjs';
export { DEFAULT_RUNTIME } from './runtime.mjs';

// Server->client requests the runtime expects answered. session/requestRuntimePreferences is
// sent during session/create; empty result = "use your defaults" (verified 2026-09-03).
// interaction/requestUserInput covers BOTH elicitation and plan approval — the kernel sends
// params.schema.interaction === 'plan_approval' on the same method, and its result schema is
// {action:'accept'|'decline'|'cancel', content?, reason?}. Headless default = decline: the
// kernel maps it to a clean deny ("AskUserQuestion was declined" / plan denied), so CLI
// callers get a structured answer instead of a -32601 protocol error — and a plan is never
// auto-approved. Callers wanting a real prompt or auto-answer override via requestHandlers.
// interaction/requestPermission is NOT defaulted here: a missing handler replies -32601,
// which the runtime treats as "deny" and silently disables tools — callers that want
// auto-allow (bench) or a UI prompt pass their own via the requestHandlers option.
const DEFAULT_REQUEST_HANDLERS = {
  'session/requestRuntimePreferences': () => ({
    // Mirror of GUI setting.json defaults (desktop 3.10.2); fields verified via Zod feedback 2026-09-03.
    nativeSearchEnhancementsEnabled: true, memoryEnabled: true,
  }),
  'interaction/requestUserInput': () => ({ action: 'decline', reason: 'no interactive user available' }),
};

export class ZCodeProtocolClient {
  constructor({ runtime, cwd = process.cwd(), nodeBin = process.execPath, onNotify, requestHandlers } = {}) {
    runtime ??= findRuntime({ cwd })?.entry;
    if (!runtime) throw new Error('ZCode runtime not found; set ZCODE_RUNTIME or install zcode-app-cli / ZCode desktop');
    this.child = spawn(nodeBin, [runtime, 'app-server', '--stdio'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    this.buf = ''; this.decoder = new StringDecoder('utf8'); this.pending = new Map(); this.nextId = 1; this.onNotify = onNotify ?? (() => {});
    this.requestHandlers = { ...DEFAULT_REQUEST_HANDLERS, ...(requestHandlers ?? {}) };
    // stdin can EPIPE/write-after-end during the exit race; without a sink that is an
    // unhandled 'error' event that crashes the host process.
    this.child.stdin.on('error', () => {});
    // Readiness = first stdout bytes OR first successful call. The real runtime is SILENT
    // on boot (it emits nothing until it answers a request), so ready must PROBE: a cheap
    // read-only session/list is sent immediately; its reply is both the boot proof and the
    // first stdout data. Callers `await client.ready` instead of sleeping a magic constant.
    let readySettled = false;
    const settleReady = (fn, arg) => { if (readySettled) return; readySettled = true; fn(arg); };
    this.ready = new Promise((res, rej) => {
      this._readyOk = () => settleReady(res);
      this._readyErr = e => settleReady(rej, e);
      this.child.stdout.once('data', this._readyOk);
      const bootFail = msg => this._readyErr(Object.assign(new Error(msg), { code: 'E_RUNTIME_EXITED' }));
      this.child.on('exit', () => bootFail('runtime exited before ready'));
      this.child.on('error', () => bootFail('runtime failed to start (spawn error)'));
    });
    this.call('session/list', undefined, 30000)
      .then(this._readyOk, e => { if (!this.dead) this._readyErr(Object.assign(new Error(`runtime not ready: ${e?.message ?? e}`), { code: 'E_RUNTIME_NOT_READY' })); });
    this.exited = new Promise(res => {
      this.child.on('exit', (c, s) => { this._gone(); res({ code: c, signal: s }); });
      // Spawn failures emit error without exit; settle both exit and pending RPCs.
      this.child.on('error', error => { this._gone(); res({ code: null, signal: null, error }); });
    });
    this.child.stdout.on('data', d => this._feed(d));
  }
  _gone() {
    this.dead = true;
    // Fail in-flight calls instead of leaving each to hit its own timeout.
    for (const r of this.pending.values()) r.reject(Object.assign(new Error('runtime exited'), { code: 'E_RUNTIME_EXITED' }));
    this.pending.clear();
  }
  _feed(d) {
    this.buf += typeof d === 'string' ? d : (this.decoder ??= new StringDecoder('utf8')).write(d);
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, ''); this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue;
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const r = this.pending.get(String(msg.id));
        if (r) { this.pending.delete(String(msg.id)); msg.error ? r.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data })) : r.resolve(msg.result); }
      } else if (msg.method) {
        if (msg.id !== undefined) { // server->client request: answer via handler map
          const h = this.requestHandlers[msg.method];
          if (h) {
            Promise.resolve().then(() => h(msg.params)).then(result =>
              this.child.stdin.write(JSON.stringify({ id: msg.id, result }) + '\n')).catch(e =>
              this.child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: String(e?.message ?? e) } }) + '\n'));
          } else {
            this.child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: `client: ${msg.method} not implemented` } }) + '\n');
          }
        }
        this.onNotify(msg);
      }
    }
  }
  call(method, params, timeoutMs = 20000) {
    if (this.dead) return Promise.reject(new Error('runtime exited'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(String(id)); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
      this.pending.set(String(id), { resolve: v => { clearTimeout(t); this._readyOk?.(); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      this.child.stdin.write(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }) + '\n');
    });
  }
  listSessions() { return this.call('session/list'); }
  createSession(workspacePath) {
    const key = path.normalize(workspacePath);
    return this.call('session/create', { workspace: { workspaceKey: key, workspacePath: key } });
  }
  readSession(sessionId) { return this.call('session/read', { sessionId }); }
  close() { try { this.child.stdin.end(); } catch {} return this.child.kill('SIGTERM'); }
}

// session/create result shape varies by runtime (0.16.5 wraps it as {session:{sessionId}});
// callers should not re-implement the unwrap — take it from the seam.
export function sessionSid(created) { return created?.session?.sessionId ?? created?.sessionId; }

// --- A2: prompt sending + streaming events ---
export async function runTurn(client, sessionId, prompt, { timeoutMs = 120000, onEvent } = {}) {
  if (client._turnInFlight) throw new Error('runTurn: another turn is already active on this client');
  if (client.dead) throw Object.assign(new Error('runtime exited'), { code: 'E_RUNTIME_EXITED' });
  client._turnInFlight = true;
  const prevNotify = client.onNotify;
  const events = [], lifecycle = [];
  let timer, detachExit = () => {}, sendResult, acknowledged = false, active = true;
  let turnId = null, sawRunning = false;
  let settle;
  const done = new Promise(resolve => { settle = resolve; });
  const accept = (kind, params) => {
    if (!active) return;
    if (params.sessionId != null && params.sessionId !== sessionId) return;
    if (turnId != null && params.turnId != null && params.turnId !== turnId) return;
    events.push({ kind, params });
    try { onEvent?.(kind, params); } catch {}
    if (kind === 'state.updated' && params.scope === 'session' && params.patch?.status === 'running') sawRunning = true;
    if (kind !== 'computer-use/operation-event') return;
    if (params.kind === 'turn-started') {
      turnId ??= params.turnId ?? null;
      sawRunning = true;
    }
    if (sawRunning && (params.kind === 'turn-completed' || params.kind === 'turn-failed') &&
        (turnId == null || params.turnId === turnId)) {
      settle({ ended: params.kind, turnId: params.turnId });
    }
  };
  try {
    client.onNotify = msg => {
      try { prevNotify?.(msg); } catch {}
      if (!msg.method) return;
      const params = msg.params ?? {};
      // Events can precede the send acknowledgement. Defer consumers as well as
      // lifecycle tracking until its turn ID can exclude stale output and usage.
      if (acknowledged) accept(msg.method, params);
      else lifecycle.push([msg.method, params]);
    };
    const gone = new Promise((resolve, reject) => {
      const fail = () => reject(Object.assign(new Error('runtime exited during turn'), { code: 'E_RUNTIME_EXITED' }));
      if (client.child?.once) {
        client.child.once('exit', fail);
        client.child.once('error', fail);
        detachExit = () => { client.child.off('exit', fail); client.child.off('error', fail); };
      } else if (client.exited) {
        // Injectable clients need only expose the public exit promise.
        let active = true;
        client.exited.then(() => { if (active) fail(); }, () => { if (active) fail(); });
        detachExit = () => { active = false; };
      }
      if (client.dead) fail();
    });
    const expired = new Promise(resolve => { timer = setTimeout(() => resolve({ ended: 'timeout' }), timeoutMs); });
    const running = (async () => {
      const response = await client.call('session/send', { sessionId, content: prompt });
      if (!active) return;
      sendResult = response;
      turnId = sendResult?.turnId ?? lifecycle.find(([kind, params]) =>
        kind === 'computer-use/operation-event' && params.kind === 'turn-started' &&
        (params.sessionId == null || params.sessionId === sessionId) && params.turnId != null)?.[1].turnId ?? null;
      acknowledged = true;
      for (const [kind, params] of lifecycle) accept(kind, params);
      lifecycle.length = 0;
      return done;
    })();
    const end = await Promise.race([running, gone, expired]);
    return { sendResult, events, end };
  } finally {
    active = false;
    lifecycle.length = 0;
    clearTimeout(timer);
    detachExit();
    client.onNotify = prevNotify;
    client._turnInFlight = false;
  }
}

// --- I5: robustness trio (from official 3.10.1 changelog) ---
// 1) Auto-retry when a model response is blank or cut off mid-stream.
// 2) NEVER retry on provider quota errors (1302/429 without retry-after).
// 3) Surface MCP protocol-version mismatches with a clear diagnostic.

const QUOTA_ERROR_CODES = new Set([1302, 1113]); // z.ai insufficient-balance / rate-limit

export function isQuotaError(err) {
  return QUOTA_ERROR_CODES.has(err?.code) || err?.code === 'PROVIDER_BUSINESS_ERROR';
}

// Wrap a model-call attempt with the retry policy. `attempt` receives no args and
// returns the result; a blank/empty result triggers up to `maxRetries` retries with
// exponential backoff; quota errors propagate immediately (no retry loops vs 429s).
export async function withModelRetry(attempt, { maxRetries = 3, baseDelayMs = 2000, isBlank = r => r == null || r === '' } = {}) {
  for (let i = 0; ; i++) {
    try {
      const result = await attempt();
      if (!isBlank(result) || i >= maxRetries) return result;
      // blank/cutoff — retry
    } catch (e) {
      if (isQuotaError(e) || i >= maxRetries) throw e;
    }
    await new Promise(r => setTimeout(r, baseDelayMs * 2 ** i));
  }
}

// MCP protocol-version diagnostic (from 3.10.1: negotiation failure should guide, not cryptic-fail)
export function mcpVersionDiagnostic(serverName, requested, negotiated) {
  if (requested && negotiated && requested !== negotiated) {
    return `MCP ${serverName}: server negotiated protocol ${negotiated}, you pinned ${requested}. ` +
      `Update the pin in your MCP config to ${negotiated} or upgrade the server.`;
  }
  return null;
}

// --- Warm-path session cache: reuse sessions across calls in the same process ---
// The 15s system-prompt send is the dominant cold-start cost. Reusing a session for
// multiple turns (same workspace) eliminates it — the cache is keyed by workspace path.
const sessionCache = new Map(); // workspacePath -> { client, sessionId, lastUsed }

export async function warmTurn(workspacePath, prompt, opts = {}) {
  const cached = sessionCache.get(workspacePath);
  if (cached && Date.now() - cached.lastUsed < 5 * 60_000) { // 5min TTL
    try {
      cached.lastUsed = Date.now();
      return await runTurn(cached.client, cached.sessionId, prompt, opts);
    } catch { // stale session — fall through to fresh create
      sessionCache.delete(workspacePath);
    }
  }
  const client = new ZCodeProtocolClient({ cwd: workspacePath });
  await client.ready;
  const created = await client.createSession(workspacePath);
  const sessionId = created.session?.sessionId ?? created.sessionId;
  sessionCache.set(workspacePath, { client, sessionId, lastUsed: Date.now() });
  return await runTurn(client, sessionId, prompt, opts);
}

export function cachedSessionCount() { return sessionCache.size; }
export function clearSessionCache() {
  for (const { client } of sessionCache.values()) try { client.close(); } catch {}
  sessionCache.clear();
}

// --- E7: context/token usage extraction (GUI 用量/成本/缓存 parity) ---
// Usage rides v4/telemetry/event {kind:'usage.delta'} (live-verified 2026-09-05, glm-5.3):
// inputTokens/outputTokens/totalTokens/reasoningTokens/cacheReadTokens/cacheWriteTokens + modelId.
export function extractUsage(events) {
  const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0,
                   cacheReadTokens: 0, cacheWriteTokens: 0, deltas: 0 };
  const byModel = {};
  for (const e of events ?? []) {
    if (e?.kind !== 'v4/telemetry/event') continue;
    const p = e.params ?? {};
    if (p.kind !== 'usage.delta') continue;
    totals.deltas++;
    const model = p.modelId ?? 'unknown';
    const m = byModel[model] ??= { inputTokens: 0, outputTokens: 0, totalTokens: 0,
      reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, deltas: 0 };
    for (const k of ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      const v = p[k];
      if (typeof v === 'number' && Number.isFinite(v)) { totals[k] += v; m[k] += v; }
    }
    m.deltas++;
  }
  return { totals, byModel };
}

// One-line human summary for TUI/CLI statuslines: "18.3k in · 3 out · 12.3k cache-read · glm-5.3"
export function usageLine(usage) {
  const t = usage?.totals;
  if (!t || t.deltas === 0) return 'no usage';
  const f = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const models = Object.keys(usage?.byModel ?? {}).join('+');
  return `${f(t.inputTokens)} in · ${f(t.outputTokens)} out · ${f(t.cacheReadTokens)} cache-read${t.cacheWriteTokens ? ` · ${f(t.cacheWriteTokens)} cache-write` : ''} · ${models}`;
}

// Assistant text created by this turn; the pre-send snapshot prevents historical
// replies from being repeated when a session is reused.
export function currentAnswer(before, after) {
  const ids = new Set(before.map(m => m?.info?.id).filter(Boolean));
  return after.filter((m, i) => m?.info?.id ? !ids.has(m.info.id) : i >= before.length)
    .filter(m => m?.info?.role === 'assistant')
    .flatMap(m => m.parts ?? []).filter(p => p?.type === 'text' && p.text)
    .map(p => p.text).join('\n');
}

export async function turnAnswer(client, sessionId, { beforeMessages } = {}) {
  const read = await client.call('session/read', { sessionId }, 30000);
  const messages = read.messages ?? [];
  if (beforeMessages !== undefined) return currentAnswer(beforeMessages, messages);
  // Legacy callers without a snapshot get only messages after the latest user input.
  const lastUser = messages.findLastIndex(m => m?.info?.role === 'user');
  const boundary = lastUser >= 0 ? lastUser + 1 : Math.max(0, messages.findLastIndex(m => m?.info?.role === 'assistant'));
  return currentAnswer(messages.slice(0, boundary), messages);
}

// --- E1 substrate: tool-call summary from a turn's events ---
// Events: computer-use/operation-event {kind: tool-scheduled|tool-started|…} plus
// tool-call records in v4 telemetry. We surface what's actually observable: per-tool
// call counts and ordering — no invention of fields the runtime doesn't send.
export function toolCallSummary(events, sessionId = null) {
  const calls = [];
  for (const e of events ?? []) {
    if (e?.kind !== 'computer-use/operation-event') continue;
    const p = e.params ?? {};
    if (sessionId && p.sessionId && p.sessionId !== sessionId) continue; // r8: subagent mirrors carry their own sessionId — don't double-count
    if (p.kind === 'tool-started') calls.push({ tool: p.toolName ?? p.tool ?? 'unknown', at: p.sequenceNumber ?? calls.length });
  }
  return { count: calls.length, tools: calls.map(c => c.tool), line: calls.length ? calls.map(c => c.tool).join(' → ') : 'no tools' };
}

// GUI tool-grouping (E1): changes / explore / terminal / other — the TUI's grouping lens.
export const TOOL_GROUPS = {
  changes: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  explore: ['Read', 'Grep', 'Glob', 'LS', 'Search', 'WebFetch', 'WebSearch'],
  terminal: ['Bash', 'Shell'],
};
export function groupTools(tools) {
  const out = { changes: 0, explore: 0, terminal: 0, other: 0 };
  for (const t of tools ?? []) {
    const g = Object.entries(TOOL_GROUPS).find(([, names]) => names.includes(t))?.[0] ?? 'other';
    out[g]++;
  }
  return out;
}

// I6: per-turn execution summary — one human line: outcome · duration · tools · tokens.
export function turnSummary({ end, events, turnMs, usage }, toolLens = null) {
  const outcome = { 'turn-completed': '✓', 'turn-failed': '✗', timeout: '⏱' }[end?.ended] ?? (end?.ended ?? '?');
  const dur = Number.isFinite(turnMs) && turnMs >= 0 ? ` ${(turnMs / 1000).toFixed(1)}s` : ''; // r11: no 'NaNs'
  const tools = Array.isArray(toolLens?.tools) ? toolLens.tools : (toolLens ?? toolCallSummary(events ?? [])).tools ?? [];
  const count = tools.length; // r11: derive from tools — never trust a mismatched lens count
  const g = groupTools(tools);
  const toolsText = count ? `${count} tool${count > 1 ? 's' : ''}` + (g.changes || g.explore || g.terminal ? ` (${[g.changes && `${g.changes} change${g.changes > 1 ? 's' : ''}`, g.explore && `${g.explore} explore`, g.terminal && `${g.terminal} terminal`].filter(Boolean).join(', ')})` : '') : 'no tools';
  const tt = usage?.totals;
  const tokens = (Number.isFinite(tt?.inputTokens) && Number.isFinite(tt?.outputTokens) && (tt.deltas === undefined || tt.deltas > 0))
    ? ` · ${tt.inputTokens} in / ${tt.outputTokens} out` : ''; // r11: partial or zero-delta usage omitted
  return `${outcome}${dur} · ${toolsText}${tokens}`;
}
