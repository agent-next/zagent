import assert from 'node:assert/strict';
import { createKeyDecoder, decodeKeys, applyKey } from './keys.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const names = (chunk) => decodeKeys(chunk).map(e => e.name ?? `text:${e.text}`);

ok(names('a').join() === 'text:a', 'printable char');
ok(names('abc').join() === 'text:a,text:b,text:c', 'multiple chars in one chunk');
ok(names('\r')[0] === 'enter' && names('\n')[0] === 'enter', 'enter both encodings');
ok(names('\x7f')[0] === 'backspace' && names('\x03')[0] === 'ctrl-c', 'backspace and ctrl-c');
ok(names('\x1b[A')[0] === 'up' && names('\x1bOB')[0] === 'down', 'arrows in both CSI and SS3 form');
ok(names('\x05')[0] === 'ctrl-e', 'ctrl+e is a named key (a thinking toggle in other harnesses), not end-of-line');
ok(names('\x1b[F')[0] === 'end', 'the End key is still end-of-line');
ok(names('\x1b[1;2A')[0] === 'shift-up' && names('\x1b[1;2B')[0] === 'shift-down',
   'shift+up/down are named keys for user-turn jumps');
ok(names('\x1b[Z')[0] === 'shift-tab', 'shift+tab is a named key');
ok(names('\x1b')[0] === 'escape', 'bare escape');
ok(names('\x1b[3~')[0] === 'delete', 'delete key');
ok(names('\x1b[5~')[0] === 'pageup' && names('\x1b[6~')[0] === 'pagedown', 'page keys are named (they page the palette)');
ok(names('\t')[0] === 'tab', 'tab is a named key, not typed text');
ok(decodeKeys('\x1b[<35;40;12M').length === 0, 'unknown CSI (mouse report) is swallowed, not typed');
ok(decodeKeys('\x00\x1e').length === 0, 'unnamed control bytes are dropped, not inserted');
ok(names('é').join() === 'text:é', 'non-ascii char passes through');
ok(names('🙂').join() === 'text:🙂', 'astral codepoint is not split into surrogates');
ok(decodeKeys('').length === 0 && decodeKeys(null).length === 0, 'empty/null chunk is safe');

const pasted = decodeKeys('\x1b[200~ls -la\r\nmore\x1b[201~');
ok(pasted.length === 1 && pasted[0].text === 'ls -la\nmore',
   'bracketed paste arrives as ONE verbatim insert, with CRLF normalised');
const mixed = decodeKeys('a\x1b[200~X\x1b[201~\r');
ok(mixed.map(e => e.name ?? e.text).join() === 'a,X,enter', 'text around a paste is still decoded');

// Exercise every split, including inside both delimiters. Pasted Enter and
// Ctrl-C must remain data even when terminal reads divide a large paste.
const pasteSource = '\x1b[200~line one\r\nline two\n\x03\x1b[201~';
for (let split = 1; split < pasteSource.length; split++) {
  const decoder = createKeyDecoder();
  assert.deepEqual(decoder.push(pasteSource.slice(0, split)), []);
  assert.deepEqual(decoder.push(pasteSource.slice(split)), [{ text: 'line one\nline two\n\x03' }]);
  assert.deepEqual(decoder.push('\r'), [{ name: 'enter', raw: '\r' }]);
}
ok(true, 'all bracketed-paste split boundaries preserve text without keystrokes');
for (const sequence of ['\x1b[A', '\x1bOB', '\x1b[3~', '\x1b\r', '\x1b[<35;40;12M', '\x1b[1;2A', '\x1b[Z']) {
  const decoder = createKeyDecoder();
  const events = [...sequence].flatMap(ch => decoder.push(ch));
  assert.deepEqual(events, decodeKeys(sequence));
}
{
  const decoder = createKeyDecoder();
  assert.deepEqual(decoder.push('\x1b'), []);
  assert.equal(decoder.waitingForEscape, true);
  assert.deepEqual(decoder.flushEscape(), [{ name: 'escape' }]);
  assert.deepEqual(decoder.flushEscape(), []);
  decoder.push('\x1b[');
  assert.deepEqual(decoder.flushEscape(), []);
  assert.deepEqual(decoder.push('A'), [{ name: 'up' }]);
}
ok(true, 'fragmented escape sequences decode once and bare Escape flushes separately');

// --- meta chords ---------------------------------------------------------------
// ESC + a printable key in the SAME read is alt+key, not the Escape key — a real
// Escape arrives alone and resolves through flushEscape(). Decoding the chord as
// escape+text made alt+x abort the turn and then type 'x' (orphan finding).
{
  const d = createKeyDecoder();
  assert.deepEqual(d.push('\x1bx'), [{ name: 'meta', key: 'x' }]);
  assert.deepEqual(d.push('\x1b中'), [{ name: 'meta', key: '中' }]);
  // A split chord still decodes once the second byte lands.
  assert.deepEqual(d.push('\x1b'), []);
  assert.deepEqual(d.push('b'), [{ name: 'meta', key: 'b' }]);
  // Double-escape stays two escapes: the second byte is a control, not a chord.
  assert.deepEqual(d.push('\x1b\x1b'), [{ name: 'escape' }]);
  assert.equal(d.waitingForEscape, true);
  assert.deepEqual(d.flushEscape(), [{ name: 'escape' }]);
  // A split surrogate pair after ESC is not mangled into a lone-surrogate meta.
  const pair = '🙂';
  assert.deepEqual(d.push('\x1b' + pair[0]), []);
  assert.deepEqual(d.push(pair[1]), [{ name: 'meta', key: pair }]);
}
assert.deepEqual(decodeKeys('\x1b\x7f'), [{ name: 'meta', key: '\x7f' }],
  'alt+backspace is a meta chord (DEL is printable-side, not C1)');
assert.deepEqual(decodeKeys('\x1b\x9b'), [{ name: 'escape' }],
  'ESC + a C1 control stays on the escape path and the C1 byte is not typed');
{
  const before = { value: 'ab', cursor: 2 };
  ok(applyKey(before, { name: 'meta', key: 'x' }) === before,
     'a meta chord is a no-op (same object, no redraw, no edit)');
}

// --- editing -----------------------------------------------------------------
let s = { value: '', cursor: 0 };
for (const e of decodeKeys('hello')) s = applyKey(s, e);
ok(s.value === 'hello' && s.cursor === 5, 'typing appends and advances the cursor');
s = applyKey(s, { name: 'left' }); s = applyKey(s, { name: 'left' });
s = applyKey(s, { text: 'X' });
ok(s.value === 'helXlo' && s.cursor === 4, 'insert at cursor');
s = applyKey(s, { name: 'backspace' });
ok(s.value === 'hello' && s.cursor === 3, 'backspace deletes before the cursor');
s = applyKey(s, { name: 'delete' });
ok(s.value === 'helo', 'delete removes at the cursor');
s = applyKey(s, { name: 'home' });
ok(s.cursor === 0 && applyKey(s, { name: 'backspace' }).value === 'helo', 'backspace at column 0 is a no-op');
s = applyKey(s, { name: 'end' });
ok(s.cursor === 4 && applyKey(s, { name: 'right' }).cursor === 4, 'cursor cannot pass the end');
ok(applyKey({ value: 'a b c', cursor: 5 }, { name: 'ctrl-w' }).value === 'a b ', 'ctrl-w kills the previous word');
ok(applyKey({ value: 'a b c', cursor: 5 }, { name: 'ctrl-u' }).value === '', 'ctrl-u kills to line start');
ok(applyKey({ value: 'x', cursor: 1 }, { name: 'f13' }).value === 'x', 'unknown key name is a no-op');

// index.mjs redraws when the input object's identity changes, so a no-op key that
// returns a NEW object forces a full frame. At 3000 entries that was 6 ms wasted
// on an arrow key that could not move.
for (const [state, key] of [[{ value: 'x', cursor: 0 }, 'left'], [{ value: 'x', cursor: 1 }, 'right'],
                            [{ value: 'x', cursor: 0 }, 'home'], [{ value: 'x', cursor: 1 }, 'end'],
                            [{ value: 'x', cursor: 0 }, 'ctrl-u'], [{ value: 'x', cursor: 0 }, 'backspace'],
                            [{ value: 'x', cursor: 1 }, 'delete']]) {
  ok(applyKey(state, { name: key }) === state, `a no-op ${key} returns the SAME object, so no redraw is forced`);
}
ok(applyKey({ value: 'ab', cursor: 0 }, { name: 'right' }) !== null, 'a key that DOES move still returns a new state');

for (const grapheme of ['🙂', 'e\u0301', '👩‍💻', '🇨🇳']) {
  const value = `a${grapheme}b`;
  const end = 1 + grapheme.length;
  assert.deepEqual(applyKey({ value, cursor: end }, { name: 'left' }), { value, cursor: 1 });
  assert.deepEqual(applyKey({ value, cursor: 1 }, { name: 'right' }), { value, cursor: end });
  assert.deepEqual(applyKey({ value, cursor: end }, { name: 'backspace' }), { value: 'ab', cursor: 1 });
  assert.deepEqual(applyKey({ value, cursor: 1 }, { name: 'delete' }), { value: 'ab', cursor: 1 });
}
ok(true, 'editing respects emoji, combining marks, ZWJ sequences, and flag graphemes');
assert.equal(applyKey({ value: '\nx', cursor: 0 }, { name: 'home' }).cursor, 0);

// --- kitty keyboard protocol (CSI u, the disambiguate flag) -------------------
// With `CSI >1u` pushed at startup a kitty-protocol terminal disambiguates the
// ambiguous bytes: shift+enter arrives as CSI 13;2u (a newline, no submit),
// ctrl+i/m/h stop colliding with the tab/enter/backspace bytes, and
// the Escape key can arrive as CSI 27u. Terminals that ignored the push never
// emit these — the legacy byte forms above keep decoding either way.
ok(names('\x1b[13;2u')[0] === 'newline', 'kitty shift+enter inserts a newline, not a submit');
ok(names('\x1b[13;3u')[0] === 'newline' && names('\x1b[13;4u')[0] === 'newline',
   'kitty alt+enter / shift+alt+enter stay newline (alt+enter was ESC+CR)');
ok(names('\x1b[13u')[0] === 'enter' && names('\x1b[13;1u')[0] === 'enter', 'kitty plain enter still submits');
ok(names('\x1b[13;5u')[0] === 'enter', 'kitty ctrl+enter submits');
ok(names('\x1b[27u')[0] === 'escape' && names('\x1b[27;1u')[0] === 'escape', 'kitty escape key');
ok(names('\x1b[9;2u')[0] === 'shift-tab' && names('\x1b[9u')[0] === 'tab', 'kitty tab and shift+tab');
ok(names('\x1b[127u')[0] === 'backspace' && names('\x1b[127;1u')[0] === 'backspace', 'kitty backspace');
// ctrl+letter keeps its C0 binding under disambiguation — ctrl+i/m/h were the
// tab/return/backspace bytes, ctrl+a was \x01 which this decoder names 'home'.
ok(names('\x1b[99;5u')[0] === 'ctrl-c', 'kitty ctrl+c still aborts');
ok(names('\x1b[100;5u')[0] === 'ctrl-d' && names('\x1b[108;5u')[0] === 'ctrl-l', 'kitty ctrl+d / ctrl+l');
ok(names('\x1b[117;5u')[0] === 'ctrl-u' && names('\x1b[119;5u')[0] === 'ctrl-w', 'kitty ctrl+u / ctrl+w');
ok(names('\x1b[118;5u')[0] === 'ctrl-v' && names('\x1b[121;5u')[0] === 'ctrl-y' && names('\x1b[111;5u')[0] === 'ctrl-o',
   'kitty ctrl+v / ctrl+y / ctrl+o');
ok(names('\x1b[105;5u')[0] === 'tab' && names('\x1b[109;5u')[0] === 'enter' && names('\x1b[104;5u')[0] === 'backspace',
   'kitty ctrl+i/m/h decode to their C0-equivalent names');
ok(names('\x1b[97;5u')[0] === 'home' && names('\x1b[101;5u')[0] === 'ctrl-e', 'kitty ctrl+a/e match the C0 map');
ok(names('\x1b[106;5u')[0] === 'enter', 'kitty ctrl+j keeps its C0 enter binding');
// Lock keys ride in the modifier field (caps 64, num 128) — masking them is
// load-bearing: unmasked, Caps Lock swallows Esc/Backspace/ctrl+c.
ok(names('\x1b[27;65u')[0] === 'escape', 'kitty escape survives caps lock (27;65u)');
ok(names('\x1b[127;65u')[0] === 'backspace' && names('\x1b[9;66u')[0] === 'shift-tab',
   'kitty backspace/shift+tab survive lock modifiers');
ok(names('\x1b[99;133u')[0] === 'ctrl-c' && names('\x1b[99;69u')[0] === 'ctrl-c',
   'kitty ctrl+c survives num lock and caps lock');
ok(names('\x1b[13;66u')[0] === 'newline', 'kitty shift+enter survives caps lock');
// ctrl+shift+letter still resolves the binding — legacy sent the same C0 byte.
ok(names('\x1b[117;6u')[0] === 'ctrl-u', 'kitty ctrl+shift+u keeps the ctrl+u binding');
// alt+key stays a meta chord (it was the ESC prefix); the shifted letter rides along.
assert.deepEqual(decodeKeys('\x1b[120;3u'), [{ name: 'meta', key: 'x' }], 'kitty alt+x is a meta chord');
assert.deepEqual(decodeKeys('\x1b[120;4u'), [{ name: 'meta', key: 'X' }], 'kitty shift+alt+x keeps the shift');
// Keys with no binding are ignored, never typed — same as unknown CSI today.
ok(decodeKeys('\x1b[57399u').length === 0, 'an unbound kitty key is swallowed');
ok(decodeKeys('\x1b[120;5u').length === 0, 'an unbound ctrl+letter is swallowed');
ok(decodeKeys('\x1b[27;5u').length === 0, 'a modified escape is swallowed, not an abort');
// A sequence split across reads still decodes once, like every other CSI.
{
  const d = createKeyDecoder();
  assert.deepEqual(d.push('\x1b[13;'), []);
  assert.deepEqual(d.push('2u'), [{ name: 'newline' }]);
}
// Event-type sub-fields (CSI key;mod:type u) are not requested but parse anyway.
ok(names('\x1b[13;2:1u')[0] === 'newline', 'a kitty event-type sub-field is tolerated');
ok(decodeKeys('\x1b[13;2:3u').length === 0, 'a kitty key-release event is not a second newline');
ok(decodeKeys('\x1b[20000000;3u').length === 0, 'an out-of-range kitty code cannot throw');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
