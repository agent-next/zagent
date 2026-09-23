// PasteBurst collector unit tests. The TUI-facing seams are exercised
// end-to-end in test-runtui.mjs (in-process) and test-journeys.mjs (real PTY);
// this file pins the collector's timing/state contract directly.
import assert from 'node:assert/strict';
import { createPasteBurst } from './paste-burst.mjs';

const char = (text) => ({ text });
const enter = { name: 'enter' };

const clocked = (options = {}) => {
  let t = 0;
  const burst = createPasteBurst({ ...options, now: () => t });
  return { burst, tick: (ms) => { t += ms; } };
};

// Slow typing: every char passes through, burst never arms.
{
  const { burst, tick } = clocked();
  for (const c of 'hello') {
    assert.deepEqual(burst.onEvent(char(c)), { kind: 'pass' });
    tick(50);
  }
  assert.equal(burst.active, false);
}

// Rapid run of >=3 chars: first two pass, the third captures and reports the
// already-dispatched prefix so the caller can pull it back.
{
  const { burst, tick } = clocked();
  assert.deepEqual(burst.onEvent(char('l')), { kind: 'pass' });
  tick(4);
  assert.deepEqual(burst.onEvent(char('i')), { kind: 'pass' });
  tick(4);
  assert.deepEqual(burst.onEvent(char('n')), { kind: 'capture', prefix: 'li' });
  assert.equal(burst.active, true);
  // Further chars and a mid-flood Enter are swallowed into the buffer.
  tick(1);
  assert.deepEqual(burst.onEvent(char('e')), { kind: 'swallow' });
  tick(1);
  assert.deepEqual(burst.onEvent(enter), { kind: 'swallow' });
  tick(1);
  assert.deepEqual(burst.onEvent(char('2')), { kind: 'swallow' });
  const out = burst.takeFlush();
  assert.deepEqual(out, { text: 'line\n2', submit: false });
  assert.equal(burst.active, false);
}

// Trailing Enter on a single-line flood defers to the flush and submits.
{
  const { burst, tick } = clocked();
  for (const c of 'do the thing') { burst.onEvent(char(c)); tick(2); }
  burst.onEvent(enter);
  assert.deepEqual(burst.takeFlush(), { text: 'do the thing\n', submit: true });
}

// Trailing Enter on a multi-line flood never auto-submits — the paste stays
// in the composer for review.
{
  const { burst, tick } = clocked();
  for (const c of 'alpha') { burst.onEvent(char(c)); tick(2); }
  burst.onEvent(enter);
  for (const c of 'beta') { burst.onEvent(char(c)); tick(2); }
  burst.onEvent(enter);
  const out = burst.takeFlush();
  assert.equal(out.text, 'alpha\nbeta\n');
  assert.equal(out.submit, false);
}

// A hot Enter after a run shorter than 3 still captures: 'a\n' pasted must
// not let 'a' submit on its own.
{
  const { burst, tick } = clocked();
  assert.deepEqual(burst.onEvent(char('a')), { kind: 'pass' });
  tick(3);
  assert.deepEqual(burst.onEvent(char('b')), { kind: 'pass' });
  tick(3);
  assert.deepEqual(burst.onEvent(enter), { kind: 'capture', prefix: 'ab' });
  assert.deepEqual(burst.takeFlush(), { text: 'ab\n', submit: true });
}

// A pasted CRLF is ONE line break: the decoder reports '\r' and '\n' both as
// 'enter' (with the raw byte kept), and the LF trailing a swallowed CR joins
// silently. A real '\n\n' still produces two breaks.
{
  const { burst, tick } = clocked();
  for (const c of 'one') { burst.onEvent(char(c)); tick(2); }
  burst.onEvent({ name: 'enter', raw: '\r' });
  burst.onEvent({ name: 'enter', raw: '\n' });
  tick(2);
  for (const c of 'two') { burst.onEvent(char(c)); tick(2); }
  const out = burst.takeFlush();
  assert.equal(out.text, 'one\ntwo', 'CRLF collapsed to a single newline');
  assert.equal(out.submit, false);
}
{
  const { burst, tick } = clocked();
  for (const c of 'ab') { burst.onEvent(char(c)); tick(2); }
  burst.onEvent({ name: 'enter', raw: '\n' });
  burst.onEvent({ name: 'enter', raw: '\n' });
  tick(2);
  burst.onEvent(char('c'));
  assert.equal(burst.takeFlush().text, 'ab\n\nc', 'a real LF LF keeps both breaks');
}
// Windows-style 'cmd\r\n' still submits once — the collapsed LF does not eat
// the trailing-Enter intent.
{
  const { burst, tick } = clocked();
  for (const c of 'cmd') { burst.onEvent(char(c)); tick(2); }
  burst.onEvent({ name: 'enter', raw: '\r' });
  burst.onEvent({ name: 'enter', raw: '\n' });
  assert.deepEqual(burst.takeFlush(), { text: 'cmd\n', submit: true });
}

// A cold Enter (no rapid chars before it) is a normal keypress.
{
  const { burst, tick } = clocked();
  burst.onEvent(char('x'));
  tick(50);
  assert.deepEqual(burst.onEvent(enter), { kind: 'pass' });
}

// A non-text key ends the flood: the buffer is handed back and the key is
// dispatched on its own — it is not part of the paste.
{
  const { burst, tick } = clocked();
  for (const c of 'abc') { burst.onEvent(char(c)); tick(2); }
  const action = burst.onEvent({ name: 'left' });
  assert.equal(action.kind, 'flush-then');
  assert.equal(action.event.name, 'left');
  assert.equal(action.text, 'abc');
  assert.equal(burst.active, false);
}

// Tab inside a flood is a tab, not a completion request.
{
  const { burst, tick } = clocked();
  for (const c of 'abc') { burst.onEvent(char(c)); tick(2); }
  assert.deepEqual(burst.onEvent({ name: 'tab' }), { kind: 'swallow' });
  assert.deepEqual(burst.takeFlush(), { text: 'abc\t', submit: false });
}

// Bracketed paste arrives as one large text event — never mistaken for a
// burst, never splits.
{
  const { burst, tick } = clocked();
  assert.deepEqual(burst.onEvent({ text: 'a'.repeat(400) }), { kind: 'pass' });
  tick(1);
  assert.deepEqual(burst.onEvent(char('x')), { kind: 'pass' });
}

// Retro-capture verification: when the caller could not pull the prefix out
// of the input (cursor moved), dropPrefix keeps the buffer consistent.
{
  const { burst, tick } = clocked();
  for (const c of 'wxyz') { burst.onEvent(char(c)); tick(2); }
  burst.dropPrefix(2);
  assert.deepEqual(burst.takeFlush(), { text: 'yz', submit: false });
}

// takeFlush resets the hotness: ordinary typing right after a flush is not
// still "in the burst".
{
  const { burst, tick } = clocked();
  for (const c of 'abc') { burst.onEvent(char(c)); tick(2); }
  burst.takeFlush();
  tick(1);
  assert.deepEqual(burst.onEvent(char('d')), { kind: 'pass' });
  assert.equal(burst.active, false);
}

// An IME (CJK) commit lands as a burst of code points with Enter right behind.
// The flush delivers the held text BEFORE the enter is honoured, so the last
// composed char can never be read late — a known double-defer race in other
// harnesses.
{
  const { burst, tick } = clocked();
  for (const c of '你好') { burst.onEvent(char(c)); tick(1); }
  assert.deepEqual(burst.onEvent(enter), { kind: 'capture', prefix: '你好' });
  assert.deepEqual(burst.takeFlush(), { text: '你好\n', submit: true });
}
{
  const { burst, tick } = clocked();
  for (const c of '今天天气') { burst.onEvent(char(c)); tick(1); }
  assert.deepEqual(burst.onEvent(enter), { kind: 'swallow' });
  assert.deepEqual(burst.takeFlush(), { text: '今天天气\n', submit: true });
}
// A non-BMP code point is still ONE char to the collector (length <= 2).
{
  const { burst, tick } = clocked();
  for (const c of ['𠀋', '字']) { burst.onEvent(char(c)); tick(1); }
  assert.deepEqual(burst.onEvent(enter), { kind: 'capture', prefix: '𠀋字' });
}

console.log('test-paste-burst: ok');
