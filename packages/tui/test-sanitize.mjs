// Sanitisation tests. Everything rendered is untrusted — model output, tool
// results (the agent reads attacker-controllable files), pasted input.
//
// Control bytes are built with fromCharCode rather than written literally, so
// this file stays safe to cat, grep and paste.
import { sanitizeText, hasControlBytes } from './sanitize.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const ch = (code) => String.fromCharCode(code);
const ESC = ch(0x1b);
const BEL = ch(0x07);
const NUL = ch(0x00);
const BS = ch(0x08);
const CSI1 = ch(0x9b);          // C1 CSI: a one-byte "ESC["
const ZWSP = ch(0x200b);        // zero-width space: NOT a control byte

ok(sanitizeText('plain text') === 'plain text', 'plain text is untouched');
ok(sanitizeText('a\nb') === 'a\nb', 'newlines survive by default');
ok(sanitizeText('a\nb', { keepNewlines: false }) === 'a b', 'newlines collapse when a single line is required');

// The attack that motivated this module: a poisoned file the agent reads.
const evil = `benign${ESC}[2J${ESC}[H CLEARED ${ESC}]0;pwned${BEL} end`;
const clean = sanitizeText(evil);
ok(!clean.includes(ESC), 'ESC bytes are removed');
ok(!clean.includes(BEL), 'BEL is removed');
ok(clean.includes('benign') && clean.includes('end'), 'surrounding text is preserved');
ok(clean.includes('[2J'), 'the ESC is stripped but its literal text stays visible, so nothing is hidden');

ok(sanitizeText('a\rb') === 'a\nb', 'a lone CR becomes a newline, never a column reset');
ok(sanitizeText('a\r\nb') === 'a\nb', 'CRLF normalises to one newline');
ok(sanitizeText('a\tb') === 'a  b', 'tabs expand so column arithmetic stays correct');
ok(sanitizeText(`a${NUL}b`) === 'ab', 'NUL is removed');
ok(sanitizeText(`a${CSI1}b`) === 'ab', 'C1 CSI is removed — it is a one-byte ESC[');
ok(sanitizeText(`a${BEL}b`) === 'ab', 'BEL is removed');
ok(sanitizeText(`a${BS}b`) === 'ab', 'backspace is removed (it would overwrite drawn text)');

// Must NOT damage legitimate content.
ok(sanitizeText('café — naïve 中文 🙂') === 'café — naïve 中文 🙂', 'unicode text is untouched');
ok(sanitizeText('┌─┐│└┘⏺⎿') === '┌─┐│└┘⏺⎿', 'box-drawing and glyphs are untouched');
ok(sanitizeText(`a${ZWSP}b`) === `a${ZWSP}b`, 'zero-width space is not a control byte and is left alone');

// Trojan Source (CVE-2021-42574): the bidi overrides reverse the VISUAL order of
// a line while leaving the bytes untouched, and they measure zero cells so no clip
// or wrap removes them. A tool result reading an attacker-controlled file could
// make the command a user reads differ from the command that runs — including in
// the permission prompt they approve.
const RLO = ch(0x202e), LRO = ch(0x202d), PDF = ch(0x202c), RLI = ch(0x2067), LS = ch(0x2028);
ok(!sanitizeText(`rm -rf /${RLO}gnitset`).includes(RLO), 'U+202E right-to-left override is removed');
ok(!sanitizeText(`a${LRO}b`).includes(LRO), 'U+202D left-to-right override is removed');
ok(!sanitizeText(`a${PDF}b`).includes(PDF), 'U+202C pop-directional-formatting is removed');
ok(!sanitizeText(`a${RLI}b`).includes(RLI), 'U+2067 right-to-left isolate is removed');
ok(!sanitizeText(`a${LS}b`).includes(LS), 'U+2028 line separator is removed');
ok(sanitizeText(`rm -rf /${RLO}gnitset`) === 'rm -rf /gnitset',
   'the surrounding command text stays exactly as written');

// Directional MARKS reorder too, and invisible format characters measured one
// cell while rendering as zero — the width-desync class width.mjs prevents.
for (const [c, name] of [[0x200e, 'LRM'], [0x200f, 'RLM'], [0x061c, 'ALM'], [0x2060, 'word joiner'],
  [0x206a, 'deprecated format'], [0xfeff, 'BOM'], [0xfff9, 'interlinear annotation'],
  [0xe0041, 'tag character'], [0x1d173, 'musical format']]) {
  ok(!sanitizeText(`a${String.fromCodePoint(c)}b`).includes(String.fromCodePoint(c)),
     `U+${c.toString(16).toUpperCase()} ${name} is removed`);
}
ok([...Array(128).keys()].every(i => sanitizeText(String.fromCodePoint(0xE0000 + i)) === ''),
   'all 128 tag characters are removed, not just the first');

// Kept ON PURPOSE — stripping these corrupts legitimate text.
for (const [c, name, why] of [[0x200d, 'ZWJ', 'joins emoji sequences'],
  [0x200c, 'ZWNJ', 'required in Persian and Indic orthography'],
  [0x200b, 'ZWSP', 'a real line-break opportunity']]) {
  ok(sanitizeText(`a${String.fromCodePoint(c)}b`).includes(String.fromCodePoint(c)),
     `U+${c.toString(16).toUpperCase()} ${name} is KEPT — it ${why}`);
}
ok(sanitizeText('👨‍👩‍👧') === '👨‍👩‍👧', 'a ZWJ emoji family survives intact');

ok(sanitizeText(null) === '' && sanitizeText(undefined) === '', 'null/undefined become empty');
ok(sanitizeText(42) === '42', 'non-strings are coerced');
ok(sanitizeText({}) === '[object Object]', 'objects are coerced, not thrown on');

ok(hasControlBytes(`a${ESC}b`) === true, 'hasControlBytes detects ESC');
ok(hasControlBytes('a\tb') === true, 'hasControlBytes detects tab');
ok(hasControlBytes('plain') === false, 'hasControlBytes is false for clean text');
ok(hasControlBytes('a\nb') === false, 'a newline alone is not flagged');
ok(hasControlBytes(`a${ESC}b`) === true && hasControlBytes(`a${ESC}b`) === true,
   'hasControlBytes is not affected by regex lastIndex state across calls');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
