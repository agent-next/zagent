// Transcript reducer tests. Fixtures are VERBATIM payload shapes captured from the
// unmodified official runtime (a verified capture),
// so a runtime change that alters the contract fails here rather than in a user's terminal.
import { createTranscript, applyEvent, addUserEntry, addNotice, endTurn, getSubagentCount,
         quotaExhaustedNotice } from './events.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const ev = (type, payload, extra = {}) => ({
  id: 'e', sessionId: 'sess_1', turnId: 'turn_1', type,
  timestamp: '2026-09-07T14:38:12.423Z', traceId: 't', sequenceNumber: 1, payload, ...extra,
});

// --- streaming accretion -----------------------------------------------------
let s = createTranscript();
addUserEntry(s, 'reply with exactly: PONG');
applyEvent(s, ev('turn_started', { turnNumber: 0, input: 'reply with exactly: PONG', messageId: 'msg_1' }));
ok(s.turn?.active === true && s.turn.turnId === 'turn_1', 'turn_started opens a turn');

applyEvent(s, ev('model_streaming', { assistantMessageId: 'msg_a', delta: '', done: false, kind: 'start' }));
applyEvent(s, ev('model_streaming', { assistantMessageId: 'msg_a', delta: 'PO', done: false }));
applyEvent(s, ev('model_streaming', { assistantMessageId: 'msg_a', delta: 'NG', done: false }));
const assistant = s.entries.find(e => e.kind === 'assistant');
ok(assistant?.text === 'PONG', 'deltas accrete into one entry keyed by assistantMessageId');
ok(s.entries.filter(e => e.kind === 'assistant').length === 1, 'no duplicate assistant entries');

applyEvent(s, ev('model_complete', { content: 'PONG', stopReason: 'stop',
  usage: { inputTokens: 15810, outputTokens: 36 } }));
ok(assistant.done === true && assistant.stopReason === 'stop', 'model_complete finalizes the entry');

// model_complete is authoritative but must never TRUNCATE a longer streamed body
// (observed: reconnect replays a short content while deltas already delivered more).
const s2 = createTranscript();
applyEvent(s2, ev('model_streaming', { assistantMessageId: 'm', delta: 'abcdef' }));
applyEvent(s2, ev('model_complete', { content: 'abc' }));
ok(s2.entries[0].text === 'abcdef', 'short model_complete does not truncate longer streamed text');

applyEvent(s, ev('turn_complete', { response: 'PONG', tokenCount: 15846,
  usage: { inputTokens: 15810, outputTokens: 36, totalTokens: 15846 }, toolCallCount: 0, duration: 380 }));
ok(s.turn.active === false, 'turn_complete closes the turn');
ok(s.turn.usage?.totalTokens === 15846 && s.turn.durationMs === 380, 'turn_complete records usage + duration');

// --- reasoning vs answer -----------------------------------------------------
// Regression: reasoning and answer text stream under the SAME assistantMessageId,
// discriminated only by payload.kind. Keying by id alone produced, live:
//   "The user wants me to reply with exactly "PONG". Simple.PONG"
const r2 = createTranscript();
applyEvent(r2, ev('turn_started', {}));
for (const [kind, delta] of [['start', ''], ['reasoning_start', ''], ['reasoning_delta', 'The user wants '],
  ['reasoning_delta', 'PONG. Simple.'], ['reasoning_end', ''], ['text_start', ''],
  ['text_delta', 'PONG'], ['text_end', '']]) {
  applyEvent(r2, ev('model_streaming', { assistantMessageId: 'msg_x', delta, done: false, kind }));
}
const answer = r2.entries.find(e => e.kind === 'assistant');
const thought = r2.entries.find(e => e.kind === 'thinking');
ok(answer?.text === 'PONG', `the answer holds ONLY the answer (got ${JSON.stringify(answer?.text)})`);
ok(thought?.text === 'The user wants PONG. Simple.', 'reasoning is captured in its own entry');
ok(r2.entries.filter(e => e.kind === 'assistant' || e.kind === 'thinking').length === 2,
   'exactly two stream entries: one reasoning, one answer');
ok(thought.done === false && answer.done === false, 'neither settles before the message finishes');

applyEvent(r2, ev('model_streaming', { assistantMessageId: 'msg_x', delta: '', done: true, kind: 'finish' }));
ok(thought.done === true && answer.done === true, 'finish settles BOTH channels of the message');

// model_complete must settle reasoning too, even when finish never arrives
const r3 = createTranscript();
applyEvent(r3, ev('model_streaming', { assistantMessageId: 'm', delta: 'why', kind: 'reasoning_delta' }));
applyEvent(r3, ev('model_complete', { content: 'answer' }));
ok(r3.entries.find(e => e.kind === 'thinking').done === true, 'model_complete settles an open reasoning entry');
ok(r3.entries.find(e => e.kind === 'assistant').text === 'answer', 'model_complete fills the answer channel');

// a stream with no kind at all (older/other builds) must still render as an answer
const r4 = createTranscript();
applyEvent(r4, ev('model_streaming', { assistantMessageId: 'm', delta: 'plain' }));
ok(r4.entries[0].kind === 'assistant' && r4.entries[0].text === 'plain',
   'a kind-less delta defaults to the answer channel');

// --- model_complete has no message id ----------------------------------------
// Regression: the payload carries no assistantMessageId, so keying it by a
// synthetic id opened a SECOND entry with the same text and every message
// printed twice on screen.
const mc = createTranscript();
applyEvent(mc, ev('model_streaming', { assistantMessageId: 'm1', delta: '', kind: 'start' }));
applyEvent(mc, ev('model_streaming', { assistantMessageId: 'm1', delta: 'I will list them.', kind: 'text_delta' }));
// finish settles the entry BEFORE model_complete arrives — the exact ordering
// that made "newest open entry" find nothing and append a duplicate.
applyEvent(mc, ev('model_streaming', { assistantMessageId: 'm1', delta: '', done: true, kind: 'finish' }));
applyEvent(mc, ev('model_complete', { content: 'I will list them.', stopReason: 'tool_use',
  querySource: 'main_turn', usage: {} }));
ok(mc.entries.filter(e => e.kind === 'assistant').length === 1,
   `model_complete settles the open entry instead of opening a second (got ${mc.entries.filter(e => e.kind === 'assistant').length})`);
ok(mc.entries[0].done === true && mc.entries[0].text === 'I will list them.', 'the settled entry keeps its text once');

// a second message in the same turn is still its own entry
applyEvent(mc, ev('model_streaming', { assistantMessageId: 'm2', delta: '', kind: 'start' }));
applyEvent(mc, ev('model_streaming', { assistantMessageId: 'm2', delta: 'DONE', kind: 'text_delta' }));
applyEvent(mc, ev('model_streaming', { assistantMessageId: 'm2', delta: '', done: true, kind: 'finish' }));
applyEvent(mc, ev('model_complete', { content: 'DONE', querySource: 'main_turn' }));
ok(mc.entries.filter(e => e.kind === 'assistant').length === 2, 'a later message opens its own entry');
ok(mc.entries.map(e => e.text).join('|') === 'I will list them.|DONE', 'the two messages stay distinct');

// a model_complete with no open entry and real content still shows the answer
const orphanC = createTranscript();
applyEvent(orphanC, ev('model_complete', { content: 'answer', querySource: 'main_turn' }));
ok(orphanC.entries.length === 1 && orphanC.entries[0].text === 'answer',
   'a model_complete with no open entry still renders its content');
const emptyC = createTranscript();
applyEvent(emptyC, ev('model_complete', { content: '', querySource: 'main_turn' }));
ok(emptyC.entries.length === 0, 'an empty model_complete does not create a blank entry');

// reasoning left open by a missing finish is settled by model_complete
const rc = createTranscript();
applyEvent(rc, ev('model_streaming', { assistantMessageId: 'm', delta: '', kind: 'start' }));
applyEvent(rc, ev('model_streaming', { assistantMessageId: 'm', delta: 'why', kind: 'reasoning_delta' }));
applyEvent(rc, ev('model_complete', { content: 'ok', querySource: 'main_turn' }));
ok(rc.entries.find(e => e.kind === 'thinking').done === true, 'model_complete settles open reasoning without an id');

// --- reasoning phase duration ------------------------------------------------
// The header's elapsed figure must measure the reasoning window, so
// reasoning_end stamps it even though the entry stays open for late deltas.
const rd = createTranscript();
applyEvent(rd, ev('model_streaming', { assistantMessageId: 'm', delta: 'thinking', kind: 'reasoning_delta' },
  { timestamp: '2026-09-07T14:38:12.000Z' }));
applyEvent(rd, ev('model_streaming', { assistantMessageId: 'm', delta: '', kind: 'reasoning_end' },
  { timestamp: '2026-09-07T14:38:14.500Z' }));
const rdThought = rd.entries.find(e => e.kind === 'thinking');
ok(rdThought?.durationMs === 2500, 'reasoning_end stamps the phase duration');
ok(rdThought?.done !== true, 'reasoning_end leaves the entry open for late deltas');
applyEvent(rd, ev('model_streaming', { assistantMessageId: 'm', delta: ' more', kind: 'reasoning_delta' }));
ok(rdThought.text === 'thinking more', 'a late reasoning delta still lands after reasoning_end');
ok(rdThought.durationMs === 2500, 'the reasoning_end stamp survives the late delta');

// no reasoning_end (older runtime): the first answer delta bounds the window —
// settling at finish would bill the answer's own stream time as thinking
const rf = createTranscript();
applyEvent(rf, ev('model_streaming', { assistantMessageId: 'm', delta: 'why', kind: 'reasoning_delta' },
  { timestamp: '2026-09-07T14:38:12.000Z' }));
applyEvent(rf, ev('model_streaming', { assistantMessageId: 'm', delta: 'ans', kind: 'text_delta' },
  { timestamp: '2026-09-07T14:38:14.000Z' }));
applyEvent(rf, ev('model_streaming', { assistantMessageId: 'm', delta: '', kind: 'finish' },
  { timestamp: '2026-09-07T14:38:21.000Z' }));
const rfThought = rf.entries.find(e => e.kind === 'thinking');
ok(rfThought?.done === true && rfThought?.durationMs === 2000,
  'the first answer delta bounds the duration when reasoning_end was absent');

// a reasoning_end for a DIFFERENT message must not stamp this message's entry
const rm = createTranscript();
applyEvent(rm, ev('model_streaming', { assistantMessageId: 'm1', delta: 'why', kind: 'reasoning_delta' },
  { timestamp: '2026-09-07T14:38:12.000Z' }));
applyEvent(rm, ev('model_streaming', { assistantMessageId: 'm2', delta: '', kind: 'reasoning_end' },
  { timestamp: '2026-09-07T14:38:14.000Z' }));
ok(rm.entries.find(e => e.kind === 'thinking').durationMs === undefined,
  'an unmatched reasoning_end stamps no duration');

// an unparseable or backwards span is worse than none — no duration at all
const rg = createTranscript();
applyEvent(rg, ev('model_streaming', { assistantMessageId: 'm', delta: 'why', kind: 'reasoning_delta' },
  { timestamp: '2026-09-07T14:38:16.000Z' }));
applyEvent(rg, ev('model_streaming', { assistantMessageId: 'm', delta: '', kind: 'finish' },
  { timestamp: '2026-09-07T14:38:12.000Z' }));
ok(rg.entries.find(e => e.kind === 'thinking').durationMs === undefined,
  'a backwards finish stamp records no duration');

// a model_complete whose streamed text was LONGER keeps the streamed text and
// must still not append a second copy
const keep = createTranscript();
applyEvent(keep, ev('model_streaming', { assistantMessageId: 'k', delta: '', kind: 'start' }));
applyEvent(keep, ev('model_streaming', { assistantMessageId: 'k', delta: 'a long streamed answer', kind: 'text_delta' }));
applyEvent(keep, ev('model_streaming', { assistantMessageId: 'k', delta: '', done: true, kind: 'finish' }));
applyEvent(keep, ev('model_complete', { content: 'short', querySource: 'main_turn' }));
ok(keep.entries.filter(e => e.kind === 'assistant').length === 1, 'a shorter model_complete does not append a duplicate');
ok(keep.entries[0].text === 'a long streamed answer', 'the longer streamed text is kept');

// --- side-queries must never reach the transcript ----------------------------
// Regression: the runtime generates the session title as a FULL model call on the
// lite model, multiplexed onto the same event stream with its own message id and
// deltas. Rendering it printed the raw JSON as the first assistant turn, live:
//   ⏺ {"title":"List files in directory"}
const q = createTranscript();
applyEvent(q, ev('model_request', { querySource: 'session_title', modelRef: { role: 'lite' } }));
applyEvent(q, ev('model_streaming', { assistantMessageId: 'title', delta: '', kind: 'start' }));
applyEvent(q, ev('model_streaming', { assistantMessageId: 'title', delta: '{"title":"x"}', kind: 'text_delta' }));
applyEvent(q, ev('model_complete', { assistantMessageId: 'title', content: '{"title":"x"}', querySource: 'session_title' }));
ok(q.entries.length === 0, `the session-title side-query renders nothing (got ${q.entries.length} entries)`);

applyEvent(q, ev('model_request', { querySource: 'main_turn' }));
applyEvent(q, ev('model_streaming', { assistantMessageId: 'main', delta: '', kind: 'start' }));
applyEvent(q, ev('model_streaming', { assistantMessageId: 'main', delta: 'Hello.', kind: 'text_delta' }));
ok(q.entries.length === 1 && q.entries[0].text === 'Hello.', 'the main turn still renders after a side-query');

// A stream whose message id was never opened by a 'start' defaults to renderable,
// so an unseen runtime path cannot silently blank the transcript.
const orphan = createTranscript();
applyEvent(orphan, ev('model_streaming', { assistantMessageId: 'never-started', delta: 'hi', kind: 'text_delta' }));
ok(orphan.entries.length === 1, 'a stream with no preceding start is rendered, not dropped');

// --- unknown stream kinds may never become prose ------------------------------
// The deny-list of tool_input_* kinds was a patch on a fall-through default that
// made the ANSWER the destination for every kind the map did not know. The kind
// list was already wrong once (enumerated on a prompt with no tools), so the next
// non-prose kind the runtime ships would reproduce the bug silently.
const uk = createTranscript();
applyEvent(uk, ev('model_streaming', { assistantMessageId: 'm', delta: '', kind: 'start' }));
applyEvent(uk, ev('model_streaming', { assistantMessageId: 'm', delta: 'real answer', kind: 'text_delta' }));
applyEvent(uk, ev('model_streaming', { assistantMessageId: 'm', delta: '{"citation":1}', kind: 'citation_delta' }));
applyEvent(uk, ev('model_streaming', { assistantMessageId: 'm', delta: 'x', kind: 'some_future_kind' }));
ok(uk.entries.find(e => e.kind === 'assistant').text === 'real answer',
   'an unknown stream kind never lands in the answer');
ok(uk.unhandled.get('kind:citation_delta') === 1 && uk.unhandled.get('kind:some_future_kind') === 1,
   'unknown kinds are counted, like unknown event types');

// Absent kind is a DIFFERENT case: every live event carries one, so a kind-less
// delta means an older/different runtime and prose is the graceful reading.
const nk = createTranscript();
applyEvent(nk, ev('model_streaming', { assistantMessageId: 'm', delta: 'plain' }));
ok(nk.entries[0]?.kind === 'assistant' && nk.entries[0].text === 'plain',
   'a delta with NO kind still renders as the answer');

// --- a per-message fact must not latch for the session ------------------------
// Left latched, a completed session-title query kept querySource as
// 'session_title' and the next main turn rendered nothing while streaming.
const qs = createTranscript();
applyEvent(qs, ev('model_request', { querySource: 'session_title' }));
applyEvent(qs, ev('model_streaming', { assistantMessageId: 'title', delta: '', kind: 'start' }));
applyEvent(qs, ev('model_complete', { content: '{"title":"x"}', querySource: 'session_title' }));
ok(qs.querySource === 'main_turn', 'querySource is consumed when the stream it describes opens');
applyEvent(qs, ev('model_streaming', { assistantMessageId: 'main', delta: '', kind: 'start' }));
applyEvent(qs, ev('model_streaming', { assistantMessageId: 'main', delta: 'Hello', kind: 'text_delta' }));
ok(qs.entries.length === 1 && qs.entries[0].text === 'Hello',
   'a main turn after a side-query streams normally instead of rendering nothing');

// --- tool argument JSON is not prose -----------------------------------------
// Regression: tool arguments stream as raw JSON on the SAME message as the answer.
// Live, the blob was appended to the sentence:
//   I'll list the files in the current directory.{"command":"ls -la ...
const ti = createTranscript();
applyEvent(ti, ev('model_streaming', { assistantMessageId: 'm', delta: '', kind: 'start' }));
applyEvent(ti, ev('model_streaming', { assistantMessageId: 'm', delta: "I'll list them.", kind: 'text_delta' }));
for (const kind of ['tool_input_start', 'tool_input_delta', 'tool_input_end', 'tool_call']) {
  applyEvent(ti, ev('model_streaming', { assistantMessageId: 'm', delta: '{"command":"ls -la"}', kind,
    toolCallId: 'call_1', toolName: 'Bash' }));
}
ok(ti.entries.find(e => e.kind === 'assistant').text === "I'll list them.",
   'tool argument JSON never lands in the answer text');
ok(!ti.entries.some(e => e.kind === 'thinking'), 'tool argument JSON does not become reasoning either');

// --- tool lifecycle ----------------------------------------------------------
let t = createTranscript();
applyEvent(t, ev('turn_started', { turnNumber: 0 }));
applyEvent(t, ev('tool_call_scheduled', { toolCallId: 'call_1', assistantMessageId: 'msg_b',
  toolName: 'Bash', input: { command: 'ls -la', description: 'List files in current directory' },
  dependencies: [], parallelGroupIndex: 0, canRunParallel: false }));
let tool = t.entries.find(e => e.kind === 'tool');
ok(tool?.name === 'Bash' && tool.status === 'scheduled', 'tool_call_scheduled creates a scheduled tool entry');
ok(tool.input.command === 'ls -la', 'tool input preserved');

applyEvent(t, ev('tool_call_started', { toolCallId: 'call_1', toolName: 'Bash', startedAt: '2026-09-07T14:41:41.350Z' }));
ok(tool.status === 'running', 'tool_call_started -> running');

applyEvent(t, ev('tool_call_result', { toolCallId: 'call_1', duration: 36,
  result: { success: true, content: 'total 8\nalpha.txt\nbeta.md', truncated: false,
    perf: { totalMs: 39 }, originalBytes: 202, returnedBytes: 202 } }));
ok(tool.status === 'ok' && tool.durationMs === 36, 'tool_call_result -> ok with duration');
ok(tool.resultText.includes('alpha.txt'), 'tool result content captured');
ok(t.turn.toolCalls === 1 && t.turn.errors === 0, 'turn counts one tool call, no errors');

applyEvent(t, ev('tool_batch_complete', { toolCallIds: ['call_1'], successCount: 1, errorCount: 0 }));
ok(t.turn.errors === 0, 'tool_batch_complete does not invent errors');

// a failing tool must be counted exactly once, by the per-call event
const f = createTranscript();
applyEvent(f, ev('turn_started', {}));
applyEvent(f, ev('tool_call_scheduled', { toolCallId: 'c', toolName: 'Bash', input: {} }));
applyEvent(f, ev('tool_call_result', { toolCallId: 'c', result: { success: false, content: 'boom' } }));
applyEvent(f, ev('tool_batch_complete', { toolCallIds: ['c'], successCount: 0, errorCount: 1 }));
ok(f.entries.find(e => e.kind === 'tool').status === 'error', 'failed tool marked error');
ok(f.turn.errors === 1, 'a failed tool is counted exactly once, not double-counted by the batch event');

// --- explore tagging ----------------------------------------------------------
// Read/list/search calls join an "Explored" cell;
// the reducer tags them at schedule time so the renderer can group a run.
{
  const g = createTranscript();
  applyEvent(g, ev('tool_call_scheduled', { toolCallId: 'e1', toolName: 'Read', input: { file_path: 'a.txt' } }));
  applyEvent(g, ev('tool_call_scheduled', { toolCallId: 'e2', toolName: 'Bash', input: { command: 'ls' } }));
  applyEvent(g, ev('tool_call_scheduled', { toolCallId: 'e3', toolName: 'Grep', input: { pattern: 'needle' } }));
  applyEvent(g, ev('tool_call_scheduled', { toolCallId: 'e4', toolName: 'LS', input: { path: 'src' } }));
  const flags = g.entries.map(e => [e.name, e.explore === true]);
  ok(flags[0][1] === true && flags[1][1] === false && flags[2][1] === true && flags[3][1] === true,
     `read/search/list calls tag as explore members, Bash does not (got ${JSON.stringify(flags)})`);
  // The tag must not hide the member from the lifecycle: started/result still
  // find it by id and update it in place.
  applyEvent(g, ev('tool_call_started', { toolCallId: 'e1' }));
  applyEvent(g, ev('tool_call_result', { toolCallId: 'e1', duration: 3, result: { success: true, content: 'body' } }));
  ok(g.entries[0].status === 'ok' && g.entries[0].durationMs === 3,
     'an explore member still resolves started/result by id');
}

// --- tool output is bounded at ingestion --------------------------------------
// It was stored in full and kept forever to display six lines: 500 results of
// 50 KB retained 24 MB. The byte cap matters as much as the line cap — one
// minified 50 KB line is zero "extra lines" and still 50 KB.
{
  const many = createTranscript();
  applyEvent(many, ev('tool_call_scheduled', { toolCallId: 'c', toolName: 'B', input: {} }));
  applyEvent(many, ev('tool_call_result', { toolCallId: 'c', result: { success: true, content: 'line\n'.repeat(2000) } }));
  const tool = many.entries[0];
  ok(tool.resultText.split('\n').length <= 64, 'a long result keeps a bounded window');
  ok(tool.resultDropped === 1936, `the dropped-line count is exact (got ${tool.resultDropped})`);

  // Head+tail keep: the rendered tail must be the output's TRUE end — a
  // head-only keep retains lines 0-63 and the "tail" would be a lie.
  const ends = createTranscript();
  applyEvent(ends, ev('tool_call_scheduled', { toolCallId: 'c', toolName: 'B', input: {} }));
  applyEvent(ends, ev('tool_call_result', { toolCallId: 'c',
    result: { success: true, content: Array.from({ length: 2000 }, (_, i) => `row${i}`).join('\n') } }));
  const e2 = ends.entries[0];
  ok(e2.resultText.split('\n').at(-1) === 'row1999', 'the true last line of a long result is retained');
  ok(e2.resultText.startsWith('row0\n') && !e2.resultText.includes('row1000'),
     'the keep is head + tail, the middle is what drops');

  const wide = createTranscript();
  applyEvent(wide, ev('tool_call_scheduled', { toolCallId: 'c', toolName: 'B', input: {} }));
  applyEvent(wide, ev('tool_call_result', { toolCallId: 'c', result: { success: true, content: 'x'.repeat(50 * 1024) } }));
  ok(wide.entries[0].resultText.length <= 8 * 1024,
     `a single huge line is capped by BYTES too (got ${wide.entries[0].resultText.length})`);

  const small = createTranscript();
  applyEvent(small, ev('tool_call_scheduled', { toolCallId: 'c', toolName: 'B', input: {} }));
  applyEvent(small, ev('tool_call_result', { toolCallId: 'c', result: { success: true, content: 'a\nb\nc' } }));
  ok(small.entries[0].resultText === 'a\nb\nc' && small.entries[0].resultDropped === 0,
     'a small result is stored untouched');
}

// --- retries -----------------------------------------------------------------
const r = createTranscript();
applyEvent(r, ev('turn_started', {}));
applyEvent(r, ev('model_network_status', { baseURL: 'https://api.z.ai/api/anthropic', maxAttempts: 11 }));
ok(r.entries.length === 0 && r.turn.retries === 0, 'first attempt is not a retry (maxAttempts is a ceiling)');
applyEvent(r, ev('model_network_status', { maxAttempts: 11, attempt: 3 }));
ok(r.turn.retries === 2, 'attempt 3 records 2 retries');
ok(r.entries.some(e => e.kind === 'notice' && /retry 2\/10/.test(e.text)), 'retry surfaces a notice');

// The kernel re-emits the same attempt several times (observed 3x live on the
// 0.0.222 release candidate): consecutive repeats refresh one row, they must
// not stack identical copies.
const d = createTranscript();
applyEvent(d, ev('turn_started', {}));
const retryEmit = { maxAttempts: 11, attempt: 2 };
applyEvent(d, ev('model_network_status', retryEmit));
applyEvent(d, ev('model_network_status', retryEmit));
applyEvent(d, ev('model_network_status', retryEmit));
ok(d.entries.filter(e => e.kind === 'notice').length === 1,
   'repeated emits of the same attempt collapse to one row');
ok(d.turn.retries === 1, 'deduped emits still record the retry depth');
applyEvent(d, ev('model_network_status', { maxAttempts: 11, attempt: 3 }));
applyEvent(d, ev('model_network_status', { maxAttempts: 11, attempt: 3 }));
ok(d.entries.filter(e => e.kind === 'notice').length === 2 && d.turn.retries === 2,
   'the next attempt adds exactly one row');
// A repeated emit that now carries the real error upgrades the row in place.
applyEvent(d, ev('model_network_status', { maxAttempts: 11, attempt: 3, statusCode: 429 }));
const retryRows = d.entries.filter(e => e.kind === 'notice');
ok(retryRows.length === 2 && /rate limited/.test(retryRows[1].text),
   'a repeated emit updates its row with the classified error');
// A later retry cycle restarting at a lower attempt is a new event, not a dup.
applyEvent(d, ev('model_network_status', { maxAttempts: 11, attempt: 2 }));
ok(d.entries.filter(e => e.kind === 'notice').length === 3 && d.turn.retries === 2,
   'a new retry cycle appends a row without rewinding the counter');
// Re-emits across a turn boundary never collapse into the previous turn's row.
applyEvent(d, ev('turn_complete', {}));
applyEvent(d, ev('turn_started', {}));
applyEvent(d, ev('model_network_status', { maxAttempts: 11, attempt: 2 }));
ok(d.entries.filter(e => e.kind === 'notice').length === 4 && d.turn.retries === 1,
   'the next turn retries against its own dedup state');
// /clear empties entries mid-turn: the dedup pointer must detect the detached
// row and push a fresh one rather than updating an entry nobody can see.
d.entries.length = 0;
applyEvent(d, ev('model_network_status', { maxAttempts: 11, attempt: 2 }));
ok(d.entries.length === 1 && /retry 1\/10/.test(d.entries[0].text),
   'a cleared transcript detaches the dedup pointer — the next emit pushes a new row');
// Fractional attempts (undocumented runtime) render as their integer attempt,
// never "retry 1.7/10".
applyEvent(d, ev('model_network_status', { maxAttempts: 11, attempt: 2.7 }));
ok(/retry 1\/10/.test(d.entries[0].text) && !/1\.7/.test(d.entries[0].text),
   'a non-integer attempt is normalized before display and dedup');

// --- robustness: the runtime is undocumented, so nothing may throw ------------
const bad = createTranscript();
const hostile = [
  ev('model_streaming', {}), ev('model_streaming', { delta: 42 }),
  ev('tool_call_result', { toolCallId: 'missing', result: {} }),
  ev('tool_call_started', {}), ev('turn_complete', {}),
  ev('model_complete', { content: null }), ev('model_network_status', { attempt: 'x' }),
  { type: 'brand_new_event_from_a_future_runtime', payload: { a: 1 } },
  { type: 'brand_new_event_from_a_future_runtime' },
  {}, null, undefined,
];
let threw = null;
try { for (const e of hostile) applyEvent(bad, e); } catch (e) { threw = e; }
ok(threw === null, `no event shape throws (${threw?.message ?? 'clean'})`);
ok(bad.unhandled.get('brand_new_event_from_a_future_runtime') === 2, 'unknown types are counted, not dropped');
ok(bad.unhandled.get('(untyped)') >= 1, 'untyped events are counted too');

// --- running subagent count (Agent tool lifecycle) ----------------------------
// Kernel evidence: child sessions are spawned by a tool_use named "Agent" (the
// foreground-subagents mock emits name:"Agent" blocks; child session ids are
// sess_subagent_*) and their model calls carry querySource 'subagent'. Running
// children = Agent tool calls still in flight.
{
  const a = createTranscript();
  ok(getSubagentCount(a) === 0, 'no children before any Agent call');
  applyEvent(a, ev('tool_call_scheduled', { toolCallId: 'a1', toolName: 'Agent', input: { prompt: 'x' } }));
  applyEvent(a, ev('tool_call_scheduled', { toolCallId: 'b1', toolName: 'Bash', input: {} }));
  applyEvent(a, ev('tool_call_scheduled', { toolCallId: 'a2', toolName: 'Agent', input: { prompt: 'y' } }));
  ok(getSubagentCount(a) === 2, 'two Agent calls -> two running children');
  applyEvent(a, ev('tool_call_started', { toolCallId: 'a1' }));
  ok(getSubagentCount(a) === 2, 'a started Agent call is still running');
  applyEvent(a, ev('tool_call_result', { toolCallId: 'a1', result: { success: true, content: 'done' } }));
  ok(getSubagentCount(a) === 1, 'a finished Agent call stops counting');
  applyEvent(a, ev('tool_call_result', { toolCallId: 'a2', result: { success: false, content: 'boom' } }));
  ok(getSubagentCount(a) === 0, 'a failed Agent call stops counting too');
  applyEvent(a, ev('tool_call_result', { toolCallId: 'ghost', result: { success: true, content: '' } }));
  ok(getSubagentCount(a) === 0, 'a result for an unknown id cannot underflow');
}

// a re-scheduled call id is still ONE child, and an id-less call is untrackable
{
  const d = createTranscript();
  applyEvent(d, ev('tool_call_scheduled', { toolCallId: 'a1', toolName: 'Agent', input: {} }));
  applyEvent(d, ev('tool_call_scheduled', { toolCallId: 'a1', toolName: 'Agent', input: {} }));
  applyEvent(d, ev('tool_call_scheduled', { toolName: 'Agent', input: {} }));
  ok(getSubagentCount(d) === 1, 'duplicate ids count once; a missing id counts never');
}

// a turn that dies mid-Agent-call must not leave a phantom running child
{
  const e = createTranscript();
  applyEvent(e, ev('turn_started', {}));
  applyEvent(e, ev('tool_call_scheduled', { toolCallId: 'a1', toolName: 'Agent', input: {} }));
  endTurn(e, { reason: 'error' });
  ok(getSubagentCount(e) === 0, 'an aborted turn retires its open Agent calls');
}

// subagent model calls stay out of the transcript like other side-queries
{
  const sub = createTranscript();
  applyEvent(sub, ev('model_request', { querySource: 'subagent' }));
  applyEvent(sub, ev('model_streaming', { assistantMessageId: 'child', delta: '', kind: 'start' }));
  applyEvent(sub, ev('model_streaming', { assistantMessageId: 'child', delta: 'child text', kind: 'text_delta' }));
  applyEvent(sub, ev('model_complete', { content: 'child text', querySource: 'subagent' }));
  ok(sub.entries.length === 0, 'subagent streams render nothing in the parent transcript');
  ok(sub.querySource === 'main_turn', 'the subagent querySource latch is consumed, not sticky');
}

// --- retry notices distinguish provider limits --------------------------------
// "network retry n/m" told the user nothing: 1302 clears in seconds, 1308 means
// the plan window is gone until it resets. When the payload carries the provider
// error the notice must say which.
{
  const { retryNotice } = await import('./events.mjs');
  const noticeAt = (st) => st.entries.filter(e => e.kind === 'notice').at(-1)?.text;

  const rate = createTranscript();
  applyEvent(rate, ev('turn_started', {}));
  applyEvent(rate, ev('model_network_status', { attempt: 2, maxAttempts: 11,
    error: 'ProviderBusinessError: [1302][Rate limit reached for requests][req-1]' }));
  ok(/rate limited · retry 1\/10/.test(noticeAt(rate)), 'code 1302 -> rate limited · retry n/m');

  const http = createTranscript();
  applyEvent(http, ev('turn_started', {}));
  applyEvent(http, ev('model_network_status', { attempt: 2, maxAttempts: 11, message: 'HTTP 429 too many requests' }));
  ok(/rate limited · retry 1\/10/.test(noticeAt(http)), 'HTTP 429 text -> rate limited');
  const httpCode = createTranscript();
  applyEvent(httpCode, ev('turn_started', {}));
  applyEvent(httpCode, ev('model_network_status', { attempt: 2, maxAttempts: 11, statusCode: 429 }));
  ok(/rate limited/.test(noticeAt(httpCode)), 'a numeric 429 statusCode -> rate limited');

  const exhausted = createTranscript();
  applyEvent(exhausted, ev('turn_started', {}));
  // resolveReset only accepts a stamp inside the window, so make one two hours out.
  const future = new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
  applyEvent(exhausted, ev('model_network_status', { attempt: 2, maxAttempts: 11,
    error: `ProviderBusinessError: [1308][Usage limit reached for 5 hour. Your limit will reset at ${future}][req-2]` }));
  ok(/5-hour window used up/.test(noticeAt(exhausted)), 'code 1308 -> 5-hour window used up');
  ok(/resets \d{2}:\d{2}/.test(noticeAt(exhausted)), 'the reset time rides the notice when known');
  const bare = createTranscript();
  applyEvent(bare, ev('turn_started', {}));
  applyEvent(bare, ev('model_network_status', { attempt: 2, maxAttempts: 11, code: 1308 }));
  ok(/5-hour window used up/.test(noticeAt(bare)) && !/resets/.test(noticeAt(bare)),
     '1308 with no reset time still names the window');
  // Live measurements (2026-09-07) show the rolling window is independent
  // of off-peak routing — pointing at /model or `zagent offpeak` sends the user
  // back into the same 1308. The honest remedy is provider-errors': wait.
  ok(/nothing will succeed until the reset/.test(noticeAt(exhausted))
      && /nothing will succeed until the reset/.test(noticeAt(bare)),
     'the exhausted notice says wait for the reset');
  ok(!/offpeak/.test(noticeAt(exhausted)) && !/\/model/.test(noticeAt(exhausted)),
     'no offpeak/model suggestion — 1308s land inside open off-peak windows too');

  // The monitor's pool.nextResetAt is authoritative: a cached quota report on
  // the state beats the offset-guessed stamp parsed out of the error text.
  const monitored = createTranscript();
  applyEvent(monitored, ev('turn_started', {}));
  // +26.5h, not +26h: a whole-day offset renders the SAME HH:MM as the +2h
  // error stamp, which would let the assertion pass even if the report were
  // ignored.
  const poolReset = new Date(Date.now() + 26.5 * 3600e3);
  monitored.quotaReport = { pools: [{ type: 'TOKENS_LIMIT', nextResetAt: poolReset.toISOString() }] };
  applyEvent(monitored, ev('model_network_status', { attempt: 2, maxAttempts: 11,
    error: `ProviderBusinessError: [1308][Usage limit reached for 5 hour. Your limit will reset at ${future}][req-9]` }));
  const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  ok(noticeAt(monitored).includes(`resets ${hhmm(poolReset)}`),
     'the monitor pool reset wins over the error-text stamp');
  ok(retryNotice({ attempt: 2, maxAttempts: 11, code: 1308 }, 2,
    { pools: [{ type: 'TOKENS_LIMIT', nextResetAt: poolReset.toISOString() }] })
      .includes(`resets ${hhmm(poolReset)}`),
     'retryNotice takes the report directly too');

  // A stale report loses: a reset that already passed must fall back to the
  // error-text stamp, not print "resets <a time in the past>".
  const stale = createTranscript();
  applyEvent(stale, ev('turn_started', {}));
  const pastReset = new Date(Date.now() - 3600e3);
  stale.quotaReport = { pools: [{ type: 'TOKENS_LIMIT', nextResetAt: pastReset.toISOString() }] };
  applyEvent(stale, ev('model_network_status', { attempt: 2, maxAttempts: 11,
    error: `ProviderBusinessError: [1308][Usage limit reached for 5 hour. Your limit will reset at ${future}][req-10]` }));
  ok(/resets \d{2}:\d{2}/.test(noticeAt(stale)),
     'the error-text stamp still rides the notice');
  ok(!noticeAt(stale).includes(`resets ${hhmm(pastReset)}`),
     'a past monitor reset is never printed');

  const plain = createTranscript();
  applyEvent(plain, ev('turn_started', {}));
  applyEvent(plain, ev('model_network_status', { attempt: 3, maxAttempts: 11, error: 'socket hang up' }));
  ok(/network retry 2\/10/.test(noticeAt(plain)), 'unrecognised errors keep network retry n/m');

  // A bare "429" substring is not a rate limit — a refused connect carries the
  // port. Only a carried status/code or an explicit phrase may classify.
  const refused = createTranscript();
  applyEvent(refused, ev('turn_started', {}));
  applyEvent(refused, ev('model_network_status', { attempt: 2, maxAttempts: 11,
    error: 'connect ECONNREFUSED 127.0.0.1:429' }));
  ok(/network retry 1\/10/.test(noticeAt(refused)), 'a :429 port in a connect error is not a rate limit');

  // 1113 is insufficient balance, not the 5-hour window — only 1308 names it.
  const balance = createTranscript();
  applyEvent(balance, ev('turn_started', {}));
  applyEvent(balance, ev('model_network_status', { attempt: 2, maxAttempts: 11,
    error: 'ProviderBusinessError: [1113][Insufficient balance][req-3]' }));
  ok(/network retry 1\/10/.test(noticeAt(balance)) && !/5-hour/.test(noticeAt(balance)),
     'code 1113 is not painted as the 5-hour window');

  // retryNotice is pure and junk-safe for direct assertions.
  ok(retryNotice({ attempt: 2, maxAttempts: 11 }, 2) === 'network retry 1/10', 'no error text -> generic notice');
  ok(retryNotice({}, 2) === 'network retry 1/0', 'missing fields are safe');
  ok(retryNotice({ attempt: 2, maxAttempts: 11, error: 'connect ECONNREFUSED 127.0.0.1:429' }, 2)
     === 'network retry 1/10', 'ECONNREFUSED :429 -> generic notice');
  ok(retryNotice({ attempt: 2, maxAttempts: 11, error: 'Rate limit hit, backing off' }, 2)
     === 'rate limited · retry 1/10', 'an explicit "Rate limit" message -> rate limited');
}

// --- session telemetry the commands read ---------------------------------------
{
  const t = createTranscript();
  ok(t.sessionId === null && t.startedAt > 0, 'a fresh transcript carries startedAt and no session id');
  applyEvent(t, ev('turn_started', {}));
  ok(t.sessionId === 'sess_1', 'the envelope sessionId is latched');
  applyEvent(t, ev('turn_complete', { duration: 5,
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 } }));
  ok(t.totals.inputTokens === 100 && t.totals.outputTokens === 10 && t.totals.cacheReadTokens === 50,
     'turn usage accumulates into the session totals');
  applyEvent(t, ev('turn_complete', { duration: 5, usage: { inputTokens: 5, outputTokens: 1 } }));
  ok(t.totals.inputTokens === 105, 'later turns add to the totals');
  applyEvent(t, ev('model_complete', { content: 'x', querySource: 'main_turn',
    contextUsageBreakdown: { system: 100 } }));
  ok(t.contextBreakdown?.system === 100, 'the context baseline breakdown is latched');
}

// --- session id follows the active session -------------------------------------
{
  const t = createTranscript();
  applyEvent(t, ev('turn_started', {}));
  ok(t.sessionId === 'sess_1', 'the first envelope latches the session id');
  applyEvent(t, ev('model_request', { querySource: 'main_turn' }, { sessionId: 'sess_2' }));
  ok(t.sessionId === 'sess_2', 'a main-turn model_request refreshes the session id after a switch');
  applyEvent(t, ev('model_request', { querySource: 'subagent' }, { sessionId: 'sess_subagent_9' }));
  ok(t.sessionId === 'sess_2', 'a subagent model_request never overwrites the session id');
  applyEvent(t, ev('model_request', { querySource: 'session_title' }, { sessionId: 'sess_9' }));
  ok(t.sessionId === 'sess_2', 'a side-query model_request never overwrites the session id');
  applyEvent(t, ev('model_request', { querySource: 'main_turn' }, { sessionId: undefined }));
  ok(t.sessionId === 'sess_2', 'an id-less main-turn request keeps the latched id');
}

// --- assistant_message: the login authorize-URL channel -------------------------
// The kernel's in-band /login (host.login / host.loginBigmodel) announces the
// OAuth authorize URL as a COMPLETE assistant_message event — not a
// model_streaming delta. Payload captured from the vendored kernel's
// emitLoginAuthorizeMessage: {content: <string>} on sessionId 'local-login'.
// Before this case existed the URL was counted unhandled and never painted, so
// /login zai-coding-plan sat on a spinner the user could not complete.
{
  const t = createTranscript();
  applyEvent(t, ev('assistant_message',
    { content: 'Open this URL to sign in with Z.AI:\n\nhttps://chat.z.ai/oauth\n\nAfter authorization, return here and I will finish the login automatically.' },
    { id: 'local-login-authorize-1', sessionId: 'local-login', traceId: 'local-login' }));
  const msg = t.entries.find(e => e.kind === 'assistant');
  ok(msg?.text.includes('https://chat.z.ai/oauth'), 'assistant_message renders its content (the authorize URL is visible)');
  ok(msg?.done === true, 'assistant_message arrives complete — settled immediately');
  applyEvent(t, ev('assistant_message', { content: 'same url, retried emit' },
    { id: 'local-login-authorize-1', sessionId: 'local-login', traceId: 'local-login' }));
  ok(t.entries.filter(e => e.kind === 'assistant').length === 1, 'a repeated emit updates in place, never duplicates');
  ok(t.entries.find(e => e.kind === 'assistant').text === 'same url, retried emit', 're-emit carries the latest content');
  // 'local-login' is the kernel's pseudo session for the login flow — latching
  // it would aim /rename & friends at a session that does not exist.
  ok(t.sessionId === null, 'the local-login pseudo session never becomes the session id');
  applyEvent(t, ev('assistant_message', {}));
  ok(t.entries.filter(e => e.kind === 'assistant').length === 1, 'an empty assistant_message adds nothing');
  ok(t.entries.find(e => e.kind === 'assistant').text === 'same url, retried emit', 'empty content does not blank a rendered message');
  ok(t.sessionId === 'sess_1', 'a real envelope session id still latches');
}

// --- turn phase + received bytes ----------------------------------------------
// The status line names the phase a possibly-stuck turn is in: 'waiting' until
// the first observable model output, 'responding' after — plus a count of the
// bytes received so far (the ⇣ counter convention other harnesses use).
// Both ride on state.turn and are fed by main-turn events only.
{
  const t = createTranscript();
  applyEvent(t, ev('turn_started', {}));
  ok(t.turn.responded === false && t.turn.streamBytes === 0,
     'a fresh turn starts in the waiting phase with zero received bytes');
  applyEvent(t, ev('model_streaming', { assistantMessageId: 'm', delta: '', kind: 'start' }));
  ok(t.turn.responded === false, 'a stream start marker alone is not a response');
  applyEvent(t, ev('model_streaming', { assistantMessageId: 'm', delta: 'abc', kind: 'text_delta' }));
  ok(t.turn.responded === true && t.turn.streamBytes === 3,
     'the first delta flips the phase and counts its bytes');
  applyEvent(t, ev('model_streaming', { assistantMessageId: 'm', delta: '你好', kind: 'text_delta' }));
  ok(t.turn.streamBytes === 9, 'the counter is UTF-8 bytes, not code units');
  applyEvent(t, ev('model_streaming', { assistantMessageId: 'm', delta: 'thinking', kind: 'reasoning_delta' }));
  ok(t.turn.streamBytes === 17, 'reasoning deltas count too — the wire carried them');

  // A turn that goes straight to tool calls still answers "is it stuck?".
  const t2 = createTranscript();
  applyEvent(t2, ev('turn_started', {}));
  applyEvent(t2, ev('tool_call_scheduled', { toolCallId: 'tc1', toolName: 'Read', input: {} }));
  ok(t2.turn.responded === true && t2.turn.streamBytes === 0,
     'a scheduled tool call ends the waiting phase without inventing bytes');

  // An unsynced (non-streamed) answer still counts what arrived, and an
  // authoritative complete longer than the deltas only bills the difference.
  const t3 = createTranscript();
  applyEvent(t3, ev('turn_started', {}));
  applyEvent(t3, ev('model_complete', { content: 'whole answer', querySource: 'main_turn' }));
  ok(t3.turn.responded === true && t3.turn.streamBytes === 12,
     'model_complete counts an answer that arrived without deltas');
  const t5 = createTranscript();
  applyEvent(t5, ev('turn_started', {}));
  applyEvent(t5, ev('model_streaming', { assistantMessageId: 'm', delta: 'abc', kind: 'text_delta' }));
  applyEvent(t5, ev('model_complete', { content: 'abcdef', querySource: 'main_turn' }));
  ok(t5.turn.streamBytes === 6, 'a longer authoritative complete bills only the missing tail');
  const t6 = createTranscript();
  applyEvent(t6, ev('turn_started', {}));
  applyEvent(t6, ev('model_streaming', { assistantMessageId: 'm', delta: 'abc', kind: 'text_delta' }));
  applyEvent(t6, ev('model_complete', { content: 'abc', querySource: 'main_turn' }));
  ok(t6.turn.streamBytes === 3, 'a complete matching the deltas never double-counts');

  // Side-query traffic (session_title generation) never moves the counter.
  const t4 = createTranscript();
  applyEvent(t4, ev('turn_started', {}));
  applyEvent(t4, ev('model_request', { querySource: 'session_title' }));
  applyEvent(t4, ev('model_streaming', { assistantMessageId: 'sq', delta: '', kind: 'start' }));
  applyEvent(t4, ev('model_streaming', { assistantMessageId: 'sq', delta: 'title', kind: 'text_delta' }));
  ok(t4.turn.responded === false && t4.turn.streamBytes === 0,
     'a side-query stream never flips the phase or the counter');

  // The counter is wire bytes, not rendered text: kinds with no renderer
  // (tool_input_*) still prove the turn is producing, and control bytes the
  // sanitizer strips were still received.
  const t7 = createTranscript();
  applyEvent(t7, ev('turn_started', {}));
  applyEvent(t7, ev('model_streaming', { assistantMessageId: 'm', delta: '', kind: 'start' }));
  applyEvent(t7, ev('model_streaming', { assistantMessageId: 'm', delta: '{"a":', kind: 'tool_input_delta' }));
  ok(t7.turn.responded === true && t7.turn.streamBytes === 5,
     'an unrendered tool-input delta still flips the phase and counts its bytes');
  applyEvent(t7, ev('model_streaming', { assistantMessageId: 'm', delta: 'a\u0007b', kind: 'text_delta' }));
  ok(t7.turn.streamBytes === 8, 'the counter bills raw wire bytes, not the sanitized text');

  // The in-band login notice is not turn traffic even while a turn is active.
  const t8 = createTranscript();
  applyEvent(t8, ev('turn_started', {}));
  applyEvent(t8, ev('assistant_message', { content: 'open the authorize url' }, { sessionId: 'local-login' }));
  ok(t8.turn.responded === false && t8.turn.streamBytes === 0,
     'a local-login message mid-turn never flips the phase or the counter');
}

// --- block timestamp stamps ---------------------------------------------------
// The envelope's own timestamp wins; numeric stamps are epoch millis, an
// unusable non-empty stamp is kept raw, an absent one falls back to receipt time.
{
  const t9 = createTranscript();
  applyEvent(t9, ev('model_streaming', { assistantMessageId: 'ms', delta: 'x' }, { timestamp: 1758069600000 }));
  ok(t9.entries[0]?.at === new Date(1758069600000).toISOString(),
     'a numeric envelope timestamp reads as epoch millis');
  const t10 = createTranscript();
  applyEvent(t10, ev('model_streaming', { assistantMessageId: 'ms', delta: 'x' }, { timestamp: '1758069600000' }));
  ok(t10.entries[0]?.at === new Date(1758069600000).toISOString(),
     'a digit-string timestamp reads as epoch millis');
  const t11 = createTranscript();
  applyEvent(t11, ev('model_streaming', { assistantMessageId: 'ms', delta: 'x' }, { timestamp: 'not-a-date' }));
  ok(t11.entries[0]?.at === 'not-a-date', 'an unusable stamp is kept raw (renderers fail safe)');
  const t12 = createTranscript();
  applyEvent(t12, ev('model_streaming', { assistantMessageId: 'ms', delta: 'x' }, { timestamp: undefined }));
  ok(Number.isFinite(new Date(t12.entries[0]?.at).getTime()),
     'an absent stamp falls back to receipt time');

  // Numeric-looking stamps outside the plausible epoch-ms window (epoch
  // seconds, year-like strings, 0/negative/overflow) fail to receipt time —
  // a wrong-looking stamp is worse than none.
  for (const [label, stamp] of [['epoch seconds', '1758069600'], ['year-like', '2026'],
    ['zero', 0], ['overflow digits', '1758069600000000000']]) {
    const ts = createTranscript();
    applyEvent(ts, ev('model_streaming', { assistantMessageId: 'ms', delta: 'x' }, { timestamp: stamp }));
    const at = ts.entries[0]?.at;
    ok(at !== String(stamp) && Number.isFinite(new Date(at).getTime()) && new Date(at).getTime() > 1e12,
       `${label} stamp fails to receipt time, not a bogus pre-2001 date`);
  }
}

// --- notices -----------------------------------------------------------------
const n = createTranscript();
addNotice(n, 'hello', 'warning');
ok(n.entries[0].kind === 'notice' && n.entries[0].level === 'warning', 'addNotice appends a levelled notice');

// --- quotaExhaustedNotice -----------------------------------------------------
// The turn-failure path names the reset only when the monitor proves the
// TOKENS_LIMIT pool is spent — a guess would blame quota for an unrelated bug.
{
  const spent = { pools: [{ type: 'TOKENS_LIMIT', usedPercent: 100, nextResetAt: '2099-01-01T06:05:00Z' }] };
  const line = quotaExhaustedNotice(spent);
  ok(/5-hour window used up/.test(line ?? ''), 'a spent TOKENS_LIMIT pool yields the used-up notice');
  ok(/resets \d{2}:\d{2}/.test(line ?? ''), 'a future reset is named HH:MM');
  ok(/nothing will succeed until the reset/.test(line ?? ''), 'the notice is honest about the wait');

  const partial = { pools: [{ type: 'TOKENS_LIMIT', usedPercent: 42, nextResetAt: '2099-01-01T06:05:00Z' }] };
  ok(quotaExhaustedNotice(partial) === null, 'a partly-used pool claims nothing — the failure is something else');
  ok(quotaExhaustedNotice({ pools: [] }) === null, 'a pool-less report claims nothing');
  ok(quotaExhaustedNotice(null) === null, 'a missing report claims nothing');
  ok(quotaExhaustedNotice({ pools: [{ type: 'TIME_LIMIT', usedPercent: 100 }] }) === null,
     'a spent monthly pool is not the 5-hour window');

  const zeroed = { pools: [{ type: 'TOKENS_LIMIT', usedPercent: null, remaining: 0, nextResetAt: '2099-01-01T06:05:00Z' }] };
  ok(/window used up/.test(quotaExhaustedNotice(zeroed) ?? ''), 'remaining 0 proves exhaustion without a percent');

  const past = { pools: [{ type: 'TOKENS_LIMIT', usedPercent: 100, nextResetAt: '2001-01-01T00:00:00Z' }] };
  const pastLine = quotaExhaustedNotice(past);
  ok(/window used up/.test(pastLine ?? '') && !/resets \d{2}:\d{2}/.test(pastLine ?? '') && /reset pending/.test(pastLine ?? ''),
     'a reset already past is named pending, not upcoming');

  // The window pool is the same predicate bin/zagent-quota uses —
  // TOKENS_LIMIT/CREDIT_LIMIT, unit 3, number 5 — with a type-only fallback
  // only for reports that carry no unit/number at all.
  const credit = { pools: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, usedPercent: 100, nextResetAt: '2099-01-01T06:05:00Z' }] };
  ok(/window used up/.test(quotaExhaustedNotice(credit) ?? ''), 'a spent CREDIT_LIMIT window pool is the 5-hour window too');

  const otherWindow = { pools: [{ type: 'TOKENS_LIMIT', unit: 3, number: 1, usedPercent: 100, nextResetAt: '2099-01-01T06:05:00Z' }] };
  ok(quotaExhaustedNotice(otherWindow) === null, 'a spent pool on a different window claims nothing');

  const qualifiedWins = { pools: [
    { type: 'TOKENS_LIMIT', unit: 3, number: 1, usedPercent: 100 },
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, usedPercent: 42, nextResetAt: '2099-01-01T06:05:00Z' }] };
  ok(quotaExhaustedNotice(qualifiedWins) === null, 'the qualified 5-hour pool wins over a spent different-window pool');
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
