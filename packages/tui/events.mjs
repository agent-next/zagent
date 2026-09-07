// Reducer: official-runtime event stream -> renderable transcript model.
//
// The 13 event types below were enumerated by execution against the unmodified
// official kernel by execution, not from documentation — there is none. Every
// payload read is therefore defensive:
// a field we never saw, or saw once, must not be able to kill the UI mid-turn.

import { sanitizeText } from './sanitize.mjs';

/** Envelope every runtime event shares: {id, sessionId, turnId, type, timestamp, traceId, sequenceNumber, payload}. */

export function createTranscript() {
  return {
    title: '',
    entries: [],
    turn: null,
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
 * Keep a bounded head plus the count of what was dropped, so both memory and the
 * per-frame re-split are bounded.
 */
const RESULT_HEAD_LINES = 64;
/** Also a byte cap: one 50 KB minified line is zero "extra lines" and still 50 KB. */
const RESULT_HEAD_BYTES = 8 * 1024;

function boundResult(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let dropped = 0;
  if (lines.length > RESULT_HEAD_LINES) {
    dropped = lines.length - RESULT_HEAD_LINES;
    lines.length = RESULT_HEAD_LINES;
  }
  let head = lines.join('\n');
  if (head.length > RESULT_HEAD_BYTES) {
    const cut = head.slice(0, RESULT_HEAD_BYTES);
    // Count the lines the byte cut removed as well, so the tally stays honest.
    dropped += head.slice(RESULT_HEAD_BYTES).split('\n').length - 1;
    head = cut;
  }
  return { text: head, dropped };
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

function streamEntry(state, id, channel) {
  const found = findEntry(state, channel, id);
  if (found) return found;
  const entry = { kind: channel, id, text: '', done: false };
  state.entries.push(entry);
  return entry;
}

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
  state.entries.push({ kind: 'user', text: sanitizeText(text) });
  return state;
}

export function applyEvent(state, event) {
  const type = str(event?.type, '(untyped)');
  const p = event?.payload ?? {};
  switch (type) {
    case 'turn_started':
      state.turn = {
        turnId: str(event?.turnId), active: true, startedAt: Date.now(),
        usage: null, retries: 0, toolCalls: 0, errors: 0,
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
      if (!isMainTurn(state.messageSource.get(id))) break;
      // 'start'/'finish' bracket the whole message and carry no channel of their
      // own; 'finish' is what settles every open entry for this message.
      if (kind === 'finish' || p.done === true) {
        for (const e of state.entries) {
          if ((e.kind === 'assistant' || e.kind === 'thinking') && e.id === id) e.done = true;
        }
        break;
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
      streamEntry(state, id, channel).text += delta;
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
        entry = { kind: 'assistant', id: id ?? str(p.assistantMessageId, 'complete'), text: '', done: false };
        state.entries.push(entry);
      }
      if (!entry) break;
      // Authoritative text for the message; streaming deltas can be lossy on reconnect.
      if (content && content.length >= entry.text.length) entry.text = content;
      entry.done = true;
      entry.stopReason = str(p.stopReason) || undefined;
      const thought = (id == null ? undefined : findEntry(state, 'thinking', id)) ?? lastOpen(state, 'thinking');
      if (thought) thought.done = true;
      state.currentMessageId = null;
      break;
    }

    case 'model_network_status': {
      // maxAttempts is the ceiling, not a failure; only a real retry is worth a line.
      const attempt = num(p.attempt, 0);
      if (attempt > 1 && state.turn) {
        state.turn.retries = attempt - 1;
        state.entries.push({ kind: 'notice', level: 'warning',
          text: `network retry ${attempt - 1}/${Math.max(0, num(p.maxAttempts, 0) - 1)}` });
      }
      break;
    }

    case 'tool_call_scheduled':
      state.entries.push({
        kind: 'tool', id: str(p.toolCallId), name: str(p.toolName, 'tool'),
        input: sanitizeInput(p.input), display: p.display ?? null,
        status: 'scheduled', resultText: '', resultDropped: 0, durationMs: null, truncated: false,
      });
      if (state.turn) state.turn.toolCalls += 1;
      break;

    case 'tool_call_started': {
      const tool = findTool(state, str(p.toolCallId));
      if (tool) { tool.status = 'running'; if (p.display) tool.display = p.display; }
      break;
    }

    case 'tool_call_result': {
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
      if (state.turn) {
        state.turn.active = false;
        state.turn.usage = p.usage ?? null;
        state.turn.durationMs = num(p.duration, Date.now() - state.turn.startedAt);
      }
      break;

    // Latches which query the next stream belongs to; nothing is drawn.
    case 'model_request':
      state.querySource = str(p.querySource, 'main_turn');
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

export function addNotice(state, text, level = 'muted') {
  state.entries.push({ kind: 'notice', level, text: sanitizeText(text) });
  return state;
}

/** Slash-command output is runtime text, and equally untrusted. */
export function addCommandEntry(state, text) {
  state.entries.push({ kind: 'command', text: sanitizeText(text), done: true });
  return state;
}
