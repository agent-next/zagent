#!/usr/bin/env node
// Reported live: after a turn failed, the status line kept showing "⠴ working 3.2s"
// forever, and typing /exit answered "Unknown command" with no way out.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createTranscript, applyEvent, endTurn, addUserEntry } from './events.mjs';
import { composeFrame } from './screen.mjs';
import { renderStatus } from './chrome.mjs';
import { createTheme } from './theme.mjs';

const tests = [];
const test = (n, f) => tests.push([n, f]);
const startedTurn = () => {
  const s = createTranscript();
  applyEvent(s, { type: 'turn_started', turnId: 't1' });
  return s;
};

test('a turn is active once started', () => {
  const s = startedTurn();
  assert.equal(s.turn?.active, true, 'turn_start must open a turn');
});

test('endTurn closes a turn that threw, which turn_complete never does', () => {
  const s = startedTurn();
  assert.equal(endTurn(s, { reason: 'error' }), true);
  assert.equal(s.turn.active, false);
  assert.equal(s.turn.endedBy, 'error');
});

test('endTurn is idempotent and reports that it did nothing', () => {
  const s = startedTurn();
  endTurn(s);
  assert.equal(endTurn(s), false, 'a second call must not claim to have ended it again');
});

test('endTurn on a transcript with no turn is safe', () => {
  assert.equal(endTurn(createTranscript()), false);
});

test('turn_complete still records usage and duration', () => {
  const s = startedTurn();
  applyEvent(s, { type: 'turn_complete', payload: { usage: { input: 5 }, duration: 1234 } });
  assert.equal(s.turn.active, false);
  assert.equal(s.turn.endedBy, 'complete');
  assert.deepEqual(s.turn.usage, { input: 5 });
  assert.equal(s.turn.durationMs, 1234);
});

for (const reason of ['error', 'interrupted', 'complete']) {
  test(`${reason} settles partial text, reasoning, and tools before the next turn`, () => {
    const s = startedTurn();
    const theme = createTheme({ enabled: false });
    for (const kind of ['text_delta', 'reasoning_delta']) {
      applyEvent(s, { type: 'model_streaming', payload: { assistantMessageId: 'm', kind, delta: 'partial' } });
    }
    applyEvent(s, { type: 'tool_call_scheduled', payload: { toolCallId: 'c', toolName: 'Read' } });
    applyEvent(s, { type: 'tool_call_started', payload: { toolCallId: 'c' } });
    composeFrame(s, theme, 80);
    if (reason === 'complete') applyEvent(s, { type: 'turn_complete' });
    else endTurn(s, { reason });
    assert.ok(s.entries.filter(e => e.kind !== 'tool').every(e => e.done));
    assert.equal(s.entries.find(e => e.kind === 'tool').status, 'error');
    assert.equal(s.turn.errors, 1);
    assert.equal(endTurn(s, { reason }), false);
    assert.equal(s.turn.errors, 1, 'repeated cleanup must not recount the failure');
    assert.deepEqual(composeFrame(s, theme, 80).live, []);
    addUserEntry(s, 'next');
    applyEvent(s, { type: 'turn_started', turnId: 't2' });
    assert.deepEqual(composeFrame(s, theme, 80).live, []);
  });
}

test('cleanup tolerates a host that omitted turn_started', () => {
  const s = createTranscript();
  applyEvent(s, { type: 'model_streaming', payload: { assistantMessageId: 'm', kind: 'text_delta', delta: 'partial' } });
  assert.equal(endTurn(s, { reason: 'error' }), true);
  assert.equal(s.entries[0].done, true);
});

test('a completion in the next turn cannot overwrite the failed turn answer', () => {
  const s = startedTurn();
  applyEvent(s, { type: 'model_streaming', payload: { assistantMessageId: 'm1', kind: 'start' } });
  applyEvent(s, { type: 'model_streaming', payload: { assistantMessageId: 'm1', kind: 'text_delta', delta: 'old partial' } });
  endTurn(s, { reason: 'error' });
  assert.equal(s.currentMessageId, null);
  assert.equal(s.messageSource.size, 0);
  applyEvent(s, { type: 'turn_started', turnId: 't2' });
  applyEvent(s, { type: 'model_complete', payload: { querySource: 'main_turn', content: 'new complete answer' } });
  assert.deepEqual(s.entries.map(entry => entry.text), ['old partial', 'new complete answer']);
});

test('an interrupted title request cannot hide the next turn main stream', () => {
  const s = startedTurn();
  applyEvent(s, { type: 'model_request', payload: { querySource: 'session_title' } });
  endTurn(s, { reason: 'interrupted' });
  assert.equal(s.querySource, 'main_turn');
  applyEvent(s, { type: 'turn_started', turnId: 't2' });
  applyEvent(s, { type: 'model_streaming', payload: { assistantMessageId: 'm2', kind: 'start' } });
  applyEvent(s, { type: 'model_streaming', payload: { assistantMessageId: 'm2', kind: 'text_delta', delta: 'visible answer' } });
  assert.deepEqual(s.entries.map(entry => entry.text), ['visible answer']);
});

test('a title stream that outlives the main turn stays hidden until its own finish', () => {
  const s = startedTurn();
  const stream = (assistantMessageId, kind, delta = '') => applyEvent(s,
    { type: 'model_streaming', payload: { assistantMessageId, kind, delta } });
  applyEvent(s, { type: 'model_request', payload: { querySource: 'session_title' } });
  stream('title', 'start');
  applyEvent(s, { type: 'model_request', payload: { querySource: 'main_turn' } });
  stream('main', 'start');
  stream('main', 'text_delta', 'main answer');
  stream('main', 'finish');
  assert.equal(s.messageSource.has('main'), false);
  applyEvent(s, { type: 'model_complete', payload: { querySource: 'main_turn', content: 'main answer' } });
  applyEvent(s, { type: 'turn_complete' });
  assert.equal(endTurn(s), false, 'an ongoing side stream is not another active main turn');
  assert.equal(s.messageSource.get('title'), 'session_title');
  applyEvent(s, { type: 'turn_started', turnId: 't2' });
  stream('title', 'text_delta', 'private generated title');
  stream('title', 'finish');
  applyEvent(s, { type: 'model_complete', payload: { querySource: 'session_title', content: 'private generated title' } });
  assert.equal(s.messageSource.has('title'), false);
  assert.deepEqual(s.entries.map(entry => entry.text), ['main answer']);
});

test('late deltas cannot reopen an ended message before or during the next turn', () => {
  const s = startedTurn();
  const stream = (assistantMessageId, kind, delta = '') => applyEvent(s,
    { type: 'model_streaming', payload: { assistantMessageId, kind, delta } });
  stream('m1', 'start');
  stream('m1', 'text_delta', 'partial');
  endTurn(s, { reason: 'error' });
  stream('m1', 'text_delta', ' LATE');
  assert.deepEqual(s.entries.map(entry => entry.text), ['partial']);
  assert.equal(s.entries[0].done, true);
  applyEvent(s, { type: 'turn_started', turnId: 't2' });
  stream('m1', 'text_delta', ' LATER');
  stream('m1', 'reasoning_delta', 'late reasoning');
  stream('m2', 'text_delta', 'source-less new answer');
  assert.deepEqual(s.entries.map(entry => entry.text), ['partial', 'source-less new answer']);
});

// The actual user-visible symptom: the spinner renders from turn.active, so a turn
// that only had its animation interval stopped still SHOWS as working.
test('the status line stops claiming "working" once the turn is ended', () => {
  const s = startedTurn();
  const theme = createTheme();
  // renderStatus returns an array of lines.
  const working = [renderStatus(s, theme, 80, { mode: 'build', model: 'glm-5.3' })].flat().join('\n');
  assert.match(working, /working|waiting|responding|interrupt/i, 'an active turn should show activity');
  endTurn(s, { reason: 'error' });
  const after = [renderStatus(s, theme, 80, { mode: 'build', model: 'glm-5.3' })].flat().join('\n');
  assert.ok(!/working|waiting|responding/i.test(after), `status still claims activity: ${after}`);
});

test('the error path ends the turn, not just the spinner interval', () => {
  const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  const fin = src.slice(src.indexOf('denyPendingPermission()'), src.indexOf('denyPendingPermission()') + 500);
  assert.match(fin, /endTurn\(state/, 'the finally block must end the turn in the reducer');
  assert.match(fin, /stopSpinner\(\)/, 'and still stop the animation');
});

test('a failed turn explains the provider limit instead of only "Turn execution failed"', () => {
  const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  assert.match(src, /explainProviderError/);
  assert.match(src, /formatProviderError/);
});

test('/exit, /quit, /q and /bye leave, since the runtime has no quit command', () => {
  const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  const m = src.match(/const QUIT = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'no QUIT set');
  for (const c of ['/exit', '/quit', '/q', '/bye']) assert.ok(m[1].includes(`'${c}'`), `${c} missing`);
  assert.match(src, /QUIT\.has\(t\.toLowerCase\(\)\)/, 'must be case-insensitive');
});

// The first version of this fix only checked in submit(), but enqueueOrSubmit
// queues on ui.busy BEFORE calling it — so /exit typed while a turn ran was
// queued and ignored. That is precisely the state a user is in when a turn hangs.
test('quitting is never queued behind a running turn', () => {
  const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function enqueueOrSubmit'), src.indexOf('async function submit'));
  const quitAt = fn.indexOf('isQuit(trimmed)');
  const busyAt = fn.indexOf('ui.busy');
  const queueAt = fn.indexOf('ui.queue.push');
  assert.ok(quitAt > 0, 'enqueueOrSubmit must handle quit itself');
  assert.ok(busyAt > 0 && queueAt > 0, 'expected the busy-queue guard');
  assert.ok(quitAt < queueAt, 'quit must be checked before the input is queued');
});

test('quitting resolves the run loop rather than waiting for a keypress', () => {
  // exit() only flips `exiting`; the loop resolves on the NEXT key event. Typed at
  // the prompt there may be no next key, so the process would hang.
  const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  assert.match(src, /resolveRun\?\.\(\)/);
  assert.match(src, /resolveRun = resolve;/);
});

let pass = 0, fail = 0;
for (const [n, f] of tests) {
  try { f(); pass++; } catch (e) { fail++; console.error(`FAIL ${n}\n  ${e.message}`); }
}
console.log(`${pass}/${tests.length} turn-end tests passed`);
process.exit(fail ? 1 : 0);
