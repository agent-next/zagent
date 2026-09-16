// Reducer: official-runtime event stream -> renderable transcript model.
//
// The 13 event types below were enumerated by execution against the unmodified
// official kernel by execution, not from documentation — there is none. Every
// payload read is therefore defensive:
// a field we never saw, or saw once, must not be able to kill the UI mid-turn.

import { sanitizeText } from './sanitize.mjs';
import { explainProviderError, EXHAUSTED, RETRYABLE } from '../driver/provider-errors.mjs';
import { TOOL_GROUPS } from '../driver/zcode-protocol.mjs';

/** Envelope every runtime event shares: {id, sessionId, turnId, type, timestamp, traceId, sequenceNumber, payload}. */

export function createTranscript() {
  return {
    title: '',
    entries: [],
    turn: null,
    /** When this TUI session opened — /status elapsed time. */
    startedAt: Date.now(),
    /** Latched from the event envelope; /status, /diff, /export need it. */
    sessionId: null,
    /** Sum of turn_complete usage payloads; /usage and /status read it. */
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheCreationTokens: 0 },
    /** Last model_complete contextUsageBreakdown; /context prints it. */
    contextBreakdown: null,
    /** Event types seen that we have no renderer for — surfaced by /debug, never silently dropped. */
    unhandled: new Map(),
    /**
     * The runtime multiplexes side-queries onto the SAME event stream: generating
     * the session title is a full model call on the lite model, with its own
     * message id, streaming deltas and model_complete. Only model_request and
     * model_complete carry querySource, so the source is latched at request time
     * and attached to the message id when its stream opens.
     */
    querySource: 'main_turn',
    messageSource: new Map(),
    /** Message id of the stream currently open; model_complete carries none of its own. */
    currentMessageId: null,
    /**
     * toolCallIds of in-flight Agent tool calls — the kernel spawns child
     * sessions through a tool_use named "Agent" (foreground-subagents mock;
     * child sessions are sess_subagent_*) and child model calls carry
     * querySource 'subagent'. Running children = Agent calls not yet resulted.
     */
    subagents: new Set(),
  };
}

// Every payload string that reaches the transcript goes through here, so this is
// the one place terminal control bytes are stripped. Model output and tool
// results are untrusted: a poisoned file the agent reads could otherwise clear
// the screen, forge a permission prompt, or corrupt the screen writer's line
// arithmetic and delete committed scrollback. See sanitize.mjs.
const str = (v, fallback = '') => (typeof v === 'string' ? sanitizeText(v) : fallback);

/**
 * Tool output is stored to display a handful of lines, but arrived in full and
 * was kept forever: 500 results of 50 KB retained 24 MB to show 6 lines each.
 * Keep a bounded head+tail plus the count of what was dropped, so both memory
 * and the per-frame re-split are bounded. The tail matters: the end of a long
 * output is where the error or final result lives — a head-only keep drops
 * exactly the lines a human scrolls for.
 */
const RESULT_KEEP_LINES = 64;
const RESULT_TAIL_LINES = 16;
/** Also a byte cap: one 50 KB minified line is zero "extra lines" and still 50 KB. */
const RESULT_KEEP_BYTES = 8 * 1024;

function boundResult(text) {
  let lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let dropped = 0;
  if (lines.length > RESULT_KEEP_LINES) {
    dropped = lines.length - RESULT_KEEP_LINES;
    lines = lines.slice(0, RESULT_KEEP_LINES - RESULT_TAIL_LINES)
      .concat(lines.slice(-RESULT_TAIL_LINES));
  }
  let kept = lines.join('\n');
  if (kept.length > RESULT_KEEP_BYTES) {
    const cut = kept.slice(0, RESULT_KEEP_BYTES);
    // Count the lines the byte cut removed as well, so the tally stays honest.
    dropped += kept.slice(RESULT_KEEP_BYTES).split('\n').length - 1;
    kept = cut;
  }
  return { text: kept, dropped };
}
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Tool arguments are rendered in the header; their string values are untrusted too. */
function sanitizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === 'string' ? sanitizeText(v, { keepNewlines: false }) : v;
  }
  return out;
}

// str() yields '' for a missing id, and a bare lookup would then match a tool
// entry whose id is also '' — so the guard stays.
const findTool = (state, toolCallId) => (toolCallId ? findEntry(state, 'tool', toolCallId) : undefined);

/**
 * Reasoning and answer text stream under the SAME assistantMessageId, discriminated
 * only by payload.kind (reasoning_* vs text_*). Keying entries by id alone
 * concatenated the model's private reasoning onto its answer — observed live
 * before this split: "The user wants me to reply with exactly "PONG". Simple.PONG".
 */
const STREAM_CHANNEL = new Map([
  ['reasoning_start', 'thinking'], ['reasoning_delta', 'thinking'], ['reasoning_end', 'thinking'],
  ['text_start', 'assistant'], ['text_delta', 'assistant'], ['text_end', 'assistant'],
]);

/** Side-queries (session_title, and anything else the runtime adds) never reach the transcript. */
const isMainTurn = (source) => source === undefined || source === 'main_turn';

function streamEntry(state, id, channel, event) {
  const found = findEntry(state, channel, id);
  if (found) return found;
  const entry = { kind: channel, id, text: '', done: false, at: stampOf(event) };
  state.entries.push(entry);
  return entry;
}

/** The entry's block timestamp: the envelope's own stamp when it carries one.
 * A numeric stamp (or a digit-only string) inside the plausible epoch-millis
 * window reads as epoch millis; numeric-looking stamps outside it (epoch
 * seconds, year-like strings, 0/negative/overflow) fall back to receipt time —
 * a wrong-looking stamp is worse than none. Other unusable stamps are kept raw
 * (hhmm fails safe to no stamp) and an absent one falls back to receipt time. */
const EPOCH_MS_FLOOR = 1e12;   // 2001-09-09 — no kernel predates this
const stampOf = (event) => {
  const t = event?.timestamp;
  const s = str(t);
  const n = typeof t === 'number' ? t : /^\d+$/.test(s) ? Number(s) : NaN;
  const d = new Date(n);
  if (Number.isFinite(d.getTime()) && n >= EPOCH_MS_FLOOR && n <= 8.64e15) return d.toISOString();
  if (Number.isFinite(n) || s === '') return new Date().toISOString();
  return s;
};

/** The newest entry of a channel that has not settled yet. */
function lastOpen(state, kind) {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const e = state.entries[i];
    if (e.kind === kind && !e.done) return e;
  }
  return undefined;
}

/** The newest entry of a channel with this message id, settled or not. */
function findEntry(state, kind, id) {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const e = state.entries[i];
    if (e.kind === kind && e.id === id) return e;
  }
  return undefined;
}

export function addUserEntry(state, text) {
  state.entries.push({ kind: 'user', text: sanitizeText(text), at: new Date().toISOString() });
  return state;
}

export function applyEvent(state, event) {
  const type = str(event?.type, '(untyped)');
  const p = event?.payload ?? {};
  // The session id rides on the envelope; latch the first non-empty one. The
  // kernel's login flow emits its authorize assistant_message on the pseudo
  // session 'local-login' — latching it would aim /rename & friends at a
  // session that does not exist until the first real model turn.
  const sid = str(event?.sessionId);
  if (!state.sessionId && sid && sid !== 'local-login') state.sessionId = sid;
  switch (type) {
    case 'turn_started':
      state.turn = {
        turnId: str(event?.turnId), active: true, startedAt: Date.now(),
        entryStart: state.entries.length,
        usage: null, retries: 0, toolCalls: 0, errors: 0,
        // W5 turn-status phases: 'waiting' until the first observable model
        // output, 'responding' after; streamBytes is the ⇣ received counter.
        responded: false, streamBytes: 0,
      };
      break;

    case 'session_title_updated':
      state.title = str(p.title, state.title);
      break;

    case 'model_streaming': {
      const id = str(p.assistantMessageId, 'stream');
      const kind = str(p.kind);
      if (kind === 'start') {
        state.messageSource.set(id, state.querySource);
        if (isMainTurn(state.querySource)) state.currentMessageId = id;
        // Consumed here: the fact belongs to ONE message. Left latched, a
        // completed session-title query kept the source as 'session_title', and
        // the next main turn rendered nothing at all while streaming.
        state.querySource = 'main_turn';
        break;
      }
      const source = state.messageSource.get(id);
      // 'start'/'finish' bracket the whole message and carry no channel of their
      // own; 'finish' is what settles every open entry for this message.
      if (kind === 'finish' || p.done === true) {
        if (isMainTurn(source)) {
          for (const e of state.entries) {
            if ((e.kind === 'assistant' || e.kind === 'thinking') && e.id === id) e.done = true;
          }
        }
        state.messageSource.delete(id);
        break;
      }
      if (!isMainTurn(source)) break;
      // Bill received wire bytes and flip the phase for ANY main-turn delta —
      // including kinds with no renderer (tool_input_*): the wire carried
      // them, so the turn is producing even when nothing paints yet. Raw
      // bytes, not the sanitized text that reaches the transcript.
      const rawDelta = typeof p.delta === 'string' ? p.delta : '';
      if (state.turn && rawDelta !== '') {
        state.turn.responded = true;
        state.turn.streamBytes += Buffer.byteLength(rawDelta, 'utf8');
      }
      // Absent kind and UNKNOWN kind are different cases and must not share a rule.
      //   * absent — every live event carries a kind, so this is an older or
      //     different runtime; prose is the graceful reading and such a stream
      //     cannot be carrying tool JSON (that always arrives as tool_input_*).
      //   * present but unknown — something new the runtime ships. Defaulting
      //     THAT to prose is how tool_input_* printed a JSON blob into the answer,
      //     and the kind list has already been wrong once (enumerated on a prompt
      //     with no tools). Counted like an unknown event type, never rendered.
      const channel = kind === '' ? 'assistant' : STREAM_CHANNEL.get(kind);
      if (!channel) { state.unhandled.set(`kind:${kind}`, (state.unhandled.get(`kind:${kind}`) ?? 0) + 1); break; }
      const delta = str(p.delta);
      if (delta === '') break;                 // *_start / *_end markers
      // Late deltas cannot reopen a settled message, even after its routing map
      // was retired. model_complete retains its separate authoritative path.
      const prior = findEntry(state, 'assistant', id) ?? findEntry(state, 'thinking', id);
      if (prior?.done) break;
      streamEntry(state, id, channel, event).text += delta;
      break;
    }

    case 'model_complete': {
      if (!isMainTurn(p.querySource)) break;   // e.g. the session-title side-query
      // model_complete carries NO assistantMessageId (payload verified live:
      // cacheHit, content, contextUsageBreakdown, contextWindow, querySource,
      // stopReason, toolCallCount, usage). Keying it by a synthetic id opened a
      // SECOND entry holding the same text, so every message printed twice.
      // It therefore settles the newest still-open entry instead.
      const content = str(p.content);
      if (state.turn) state.turn.responded = true;
      // Locate by the id latched when this message's stream opened. Using "the
      // newest OPEN entry" was not enough: kind='finish' settles the entry first,
      // so model_complete found nothing open and appended a duplicate of the whole
      // message. Observed live as every assistant turn printing twice.
      // Prefer the latched id; fall back to the newest open entry so a stream that
      // lost its 'start' (reconnect, or a runtime path we have not seen) still
      // settles in place instead of duplicating.
      const id = state.currentMessageId;
      let entry = (id == null ? undefined : findEntry(state, 'assistant', id)) ?? lastOpen(state, 'assistant');
      if (!entry && content !== '') {
        entry = { kind: 'assistant', id: id ?? str(p.assistantMessageId, 'complete'), text: '', done: false, at: stampOf(event) };
        state.entries.push(entry);
      }
      if (!entry) break;
      // Authoritative text for the message; streaming deltas can be lossy on reconnect.
      if (content && content.length >= entry.text.length) {
        // Bill only what the deltas had not already delivered — an unsynced
        // answer counts in full, a replayed complete never double-counts.
        if (state.turn) state.turn.streamBytes += Buffer.byteLength(content.slice(entry.text.length), 'utf8');
        entry.text = content;
      }
      entry.done = true;
      entry.stopReason = str(p.stopReason) || undefined;
      const thought = (id == null ? undefined : findEntry(state, 'thinking', id)) ?? lastOpen(state, 'thinking');
      if (thought) thought.done = true;
      if (p.contextUsageBreakdown && typeof p.contextUsageBreakdown === 'object') {
        state.contextBreakdown = p.contextUsageBreakdown;
      }
      state.currentMessageId = null;
      break;
    }

    // A complete, non-streamed assistant text. The kernel's in-band /login
    // (host.login / host.loginBigmodel) announces the OAuth authorize URL this
    // way — payload {content} on sessionId 'local-login', id
    // 'local-login-authorize-<ts>' — so dropping it left the login sitting on a
    // spinner with no URL to open. Keyed by the envelope id so a repeated emit
    // updates in place instead of duplicating.
    case 'assistant_message': {
      const content = str(p.content);
      if (content === '') break;
      const id = str(event?.id) || 'assistant_message';
      let entry = findEntry(state, 'assistant', id);
      if (!entry) {
        entry = { kind: 'assistant', id, text: '', done: true, at: stampOf(event) };
        state.entries.push(entry);
      }
      if (state.turn && sid !== 'local-login') {
        state.turn.responded = true;
        // A repeated emit updates in place — bill only what grew, never twice
        // (a same-length rewrite bills 0 but still replaces the text).
        state.turn.streamBytes += Buffer.byteLength(content.slice(entry.text.length), 'utf8');
      }
      entry.text = content;
      entry.done = true;
      break;
    }

    case 'model_network_status': {
      // maxAttempts is the ceiling, not a failure; only a real retry is worth a line.
      const attempt = num(p.attempt, 0);
      if (attempt > 1 && state.turn) {
        state.turn.retries = attempt - 1;
        state.entries.push({ kind: 'notice', level: 'warning', text: retryNotice(p, attempt, state.quotaReport), at: stampOf(event) });
      }
      break;
    }

    case 'tool_call_scheduled': {
      const tool = {
        kind: 'tool', id: str(p.toolCallId), name: str(p.toolName, 'tool'),
        input: sanitizeInput(p.input), display: p.display ?? null,
        status: 'scheduled', resultText: '', resultDropped: 0, durationMs: null, truncated: false,
        at: stampOf(event),
      };
      // The GUI's grouping lens (TOOL_GROUPS.explore): read/list/search calls
      // collapse under one `Explored` cell — the member set the screen writer
      // renders compact, the same classification turn summaries already use.
      if (TOOL_GROUPS.explore.includes(tool.name)) tool.explore = true;
      state.entries.push(tool);
      // A call with no id can never be matched to its result — untrackable.
      if (tool.name === 'Agent' && tool.id) state.subagents.add(tool.id);
      if (state.turn) { state.turn.toolCalls += 1; state.turn.responded = true; }
      break;
    }

    case 'tool_call_started': {
      const tool = findTool(state, str(p.toolCallId));
      if (tool) { tool.status = 'running'; if (p.display) tool.display = p.display; }
      break;
    }

    case 'tool_call_result': {
      state.subagents.delete(str(p.toolCallId));
      const tool = findTool(state, str(p.toolCallId));
      const result = p.result ?? {};
      if (tool) {
        tool.status = result.success === false ? 'error' : 'ok';
        const bounded = boundResult(str(result.content));
        tool.resultText = bounded.text;
        tool.resultDropped = bounded.dropped;
        tool.truncated = result.truncated === true;
        tool.durationMs = num(p.duration, num(result?.perf?.totalMs, 0));
        if (tool.status === 'error' && state.turn) state.turn.errors += 1;
      }
      break;
    }

    // Informational only: tool_call_result already counted each outcome, and adding
    // errorCount here double-counts every failure (caught by test-events.mjs).
    case 'tool_batch_complete':
      break;

    case 'turn_complete':
      endTurn(state, { reason: 'complete' });
      if (state.turn) {
        state.turn.usage = p.usage ?? null;
        state.turn.durationMs = num(p.duration, Date.now() - state.turn.startedAt);
        state.turn.active = false;
        state.turn.endedBy = 'complete';
      }
      if (p.usage && typeof p.usage === 'object') {
        for (const k of Object.keys(state.totals)) {
          const v = p.usage[k];
          if (Number.isFinite(v)) state.totals[k] += v;
        }
      }
      break;

    // Latches which query the next stream belongs to; nothing is drawn.
    case 'model_request':
      state.querySource = str(p.querySource, 'main_turn');
      // The envelope sessionId is the ACTIVE session's, and the kernel's /new,
      // /resume and /fork all change it — a first-set latch keeps pointing
      // /rename & friends at the session the user left. Only a main-turn
      // request may refresh it: subagent calls multiplex onto this stream
      // carrying their own sess_subagent_* envelopes.
      if (isMainTurn(state.querySource) && str(event?.sessionId)) {
        state.sessionId = str(event.sessionId);
      }
      break;

    // Seen live but carrying nothing the transcript renders. Counted, not drawn.
    case 'streaming_tool_ledger_updated':
    case 'stream_recovery_anchor_created':
      break;

    default:
      state.unhandled.set(type, (state.unhandled.get(type) ?? 0) + 1);
      break;
  }
  return state;
}

/**
 * End the turn in the reducer, whatever happened to it.
 *
 * `turn_complete` was the only thing that cleared `turn.active`, and the status
 * line renders the spinner from exactly that flag. So a turn that THREW — a
 * provider limit, an aborted stream — left the UI showing "working 3.2s" forever,
 * with a frozen frame, because index.mjs's finally block only stopped the
 * animation interval and set its own ui.busy. Two owners of one piece of state.
 */
export function endTurn(state, { reason = 'ended' } = {}) {
  let changed = state.currentMessageId !== null || state.querySource !== 'main_turn';
  // An exception or abort may omit every stream/tool completion marker. Retire
  // those entries too, or their old tails keep repainting beneath later turns.
  for (const entry of state.entries.slice(state.turn?.entryStart ?? 0)) {
    if ((entry.kind === 'assistant' || entry.kind === 'thinking') && !entry.done) {
      entry.done = true;
      changed = true;
    } else if (entry.kind === 'tool' && (entry.status === 'scheduled' || entry.status === 'running')) {
      entry.status = 'error';
      entry.resultText ||= 'Tool ended without a result.';
      if (state.turn) state.turn.errors += 1;
      changed = true;
    }
  }
  if (state.turn && state.turn.active !== false) {
    state.turn.active = false;
    state.turn.endedBy = reason;
    state.turn.durationMs ??= Date.now() - state.turn.startedAt;
    changed = true;
  }
  // Reset per-turn latches, but preserve side-query routing until that stream
  // finishes: session-title generation can outlive the main turn.
  if (state.currentMessageId !== null && isMainTurn(state.messageSource.get(state.currentMessageId))) {
    state.messageSource.delete(state.currentMessageId);
  }
  // Unfinished Agent calls were force-retired above; from the parent's view
  // those children are over — a thrown turn must not leave a phantom count.
  if (state.subagents?.size) { state.subagents.clear(); changed = true; }
  state.currentMessageId = null;
  state.querySource = 'main_turn';
  return changed;
}

/** In-flight Agent tool calls — the running child-session count. */
export function getSubagentCount(state) {
  return state?.subagents?.size ?? 0;
}

export function addNotice(state, text, level = 'muted') {
  state.entries.push({ kind: 'notice', level, text: sanitizeText(text), at: new Date().toISOString() });
  return state;
}

/** HH:MM in 24-hour local time — the same stamp /status, /quota, G4 and the
 * config-gated block timestamps print (render.mjs shares it). */
export const hhmm = (at) => {
  const d = new Date(at);
  return Number.isFinite(d.getTime())
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : null;
};

/** The authoritative window reset: a cached quota monitor report's TOKENS_LIMIT pool. */
const windowResetAt = (report) =>
  (report?.pools ?? []).find(x => x?.type === 'TOKENS_LIMIT')?.nextResetAt ?? null;

/**
 * The retry notice text for a model_network_status payload. Every retry says
 * "retry n/m"; where the payload carries the provider error, a rate limit
 * (HTTP 429 / code 1302) and the Coding Plan window (code 1308) are named, so
 * the reader knows whether waiting seconds or waiting for the reset will help.
 * Classification needs a carried status/code or an explicit "[code]" /
 * "Rate limit" phrase — a bare "429" substring also matches an ECONNREFUSED
 * port, and code 1113 (insufficient balance) is not the 5-hour window.
 * Unknown payloads keep the generic wording.
 */
export function retryNotice(p, attempt, report) {
  const n = attempt - 1;
  const m = Math.max(0, num(p?.maxAttempts, 0) - 1);
  const errText = [p?.error?.message ?? p?.error, p?.message, p?.reason, p?.lastError, p?.detail]
    .filter(v => typeof v === 'string').join(' ');
  const code = num(p?.code ?? p?.statusCode ?? p?.error?.code, 0);
  const explained = explainProviderError(errText);
  const kind = code === 1308 || explained?.code === 1308 ? EXHAUSTED
    : code === 1302 || code === 429 || explained?.kind === RETRYABLE
      || /\bhttp\s+429\b|\[1302\]|rate limit/i.test(errText) ? RETRYABLE
    : null;
  if (kind === EXHAUSTED) {
    // Prefer the monitor's pool.nextResetAt over the stamp resolveReset guesses
    // out of the provider error text through a list of tz offsets — but only
    // while it is still in the future: a report cached since startup can name
    // a reset that has already passed, and resolveReset's candidate is always
    // future-facing.
    const monitored = Date.parse(windowResetAt(report) ?? '');
    const stamp = hhmm(Number.isFinite(monitored) && monitored > Date.now()
      ? monitored : explained?.reset?.at);
    // G7: measured receipts (2026-09-07) show the rolling window is independent
    // of off-peak routing — 1308s land inside an open off-peak window — so the
    // honest remedy is provider-errors': wait for the reset.
    return `5-hour window used up${stamp ? ` · resets ${stamp}` : ''} · nothing will succeed until the reset`;
  }
  if (kind === RETRYABLE) return `rate limited · retry ${n}/${m}`;
  return `network retry ${n}/${m}`;
}

/** Slash-command output is runtime text, and equally untrusted. */
export function addCommandEntry(state, text) {
  state.entries.push({ kind: 'command', text: sanitizeText(text), done: true, at: new Date().toISOString() });
  return state;
}

// Fold state for thinking and tool entries. Kept here rather than a new module
// so the public package files[] list does not have to grow.
// Collapse cannot un-print committed scrollback; expanding appends the body.

export const COLLAPSED = 'collapsed';
export const EXPANDED = 'expanded';

export function createFold() {
  return { thinkingAll: COLLAPSED, override: new Map() };
}

export function identityKey(entry, index) {
  return `${index}:${entry?.kind ?? ''}:${entry?.id ?? ''}`;
}

export function foldStateFor(fold, entry, index) {
  const key = identityKey(entry, index);
  if (fold?.override?.has(key)) return fold.override.get(key);
  if (entry?.kind === 'thinking') return fold?.thinkingAll ?? COLLAPSED;
  return EXPANDED;
}

export function setFold(fold, entry, index, state) {
  fold.override.set(identityKey(entry, index), state);
  return state;
}

export function collapse(fold, entry, index) {
  return setFold(fold, entry, index, COLLAPSED);
}

export function expand(fold, entry, index) {
  return setFold(fold, entry, index, EXPANDED);
}

export function toggleAllThinking(fold) {
  fold.thinkingAll = fold.thinkingAll === COLLAPSED ? EXPANDED : COLLAPSED;
  for (const key of [...fold.override.keys()]) {
    if (key.includes(':thinking:')) fold.override.delete(key);
  }
  return fold.thinkingAll;
}

export function userIndices(entries) {
  const out = [];
  (entries ?? []).forEach((entry, i) => { if (entry.kind === 'user') out.push(i); });
  return out;
}

export function foldableEntries(entries) {
  const out = [];
  (entries ?? []).forEach((entry, i) => {
    if (entry.kind === 'thinking' || entry.kind === 'tool') out.push([entry, i]);
  });
  return out;
}

/** Foldables belonging to the selected user turn; last turn when index is -1. */
export function foldablesInTurn(entries, userTurn) {
  const list = entries ?? [];
  const users = userIndices(list);
  if (users.length === 0) return foldableEntries(list);
  const at = userTurn < 0 ? users.length - 1 : Math.min(Math.max(0, userTurn), users.length - 1);
  const start = users[at];
  const end = users[at + 1] ?? list.length;
  const out = [];
  for (let i = start; i < end; i++) {
    const entry = list[i];
    if (entry.kind === 'thinking' || entry.kind === 'tool') out.push([entry, i]);
  }
  return out;
}

export function stepUserTurn(entries, current, direction) {
  const users = userIndices(entries);
  if (users.length === 0) return -1;
  if (current < 0) return users.length - 1;
  return Math.min(users.length - 1, Math.max(0, current + (direction < 0 ? -1 : 1)));
}
