// The paste-chip helpers, without a terminal: the composer collapse, the
// one-shot delete, the submit-time expansion and the message-bound bookkeeping.
import { pasteToken, expandChips, insertChip, chipSpanAt, chipSpanIn, takeChips, attachChips, pruneChips }
  from './paste-chips.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

// -- the threshold ------------------------------------------------------------
ok(pasteToken('just a sentence') === null, 'a short paste is not chipped');
ok(pasteToken('one\ntwo') === null, 'a two-line paste is not chipped');
ok(pasteToken('x'.repeat(150)) === null, '150 chars exactly is still inline');
ok(pasteToken('x'.repeat(151)) === '[Pasted ~151 chars]', 'a >150-char single line chips by length');
ok(pasteToken('a\nb\nc') === '[Pasted ~3 lines]', 'a three-line paste chips by lines');
ok(pasteToken('a\nb\nc\nd') === '[Pasted ~4 lines]', 'the token reports its line count');
ok(pasteToken(`${'x'.repeat(200)}\ny`) === '[Pasted ~2 lines]', 'multi-line chips report lines, not chars');

// -- submit-time expansion ----------------------------------------------------
const chips = [{ token: '[Pasted ~2 lines]', text: 'alpha\nbeta' }];
ok(expandChips(chips, 'see [Pasted ~2 lines] end') === 'see alpha\nbeta end',
   'the chip token expands to its stored payload');
ok(expandChips(chips, 'literal [Pasted ~9 lines] typed') === 'literal [Pasted ~9 lines] typed',
   'a token with no live chip stays literal');
ok(expandChips([], 'see [Pasted ~2 lines]') === 'see [Pasted ~2 lines]',
   'no chips means the buffer is verbatim');
{
  const dup = [
    { token: '[Pasted ~2 lines]', text: 'first\none' },
    { token: '[Pasted ~2 lines]', text: 'second\ntwo' },
  ];
  ok(expandChips(dup, '[Pasted ~2 lines] then [Pasted ~2 lines]') === 'first\none then second\ntwo',
     'identical tokens expand left-to-right in insertion order');
}

// -- insertion keeps buffer order ----------------------------------------------
{
  // Paste B lands BEFORE chip A's token in the buffer: the table must record B
  // first so left-to-right expansion maps occurrences to payloads correctly.
  const T = '[Pasted ~2 lines]';
  const table = [];
  insertChip(table, T, 0, T, 'A');
  insertChip(table, T + T, 0, T, 'B');            // B pasted before A's token
  ok(table[0].text === 'B' && table[1].text === 'A', 'a mid-buffer paste orders its chip by position');
  ok(expandChips(table, T + T) === 'BA', 'reordered chips still expand in buffer order');
}

// -- one-shot delete ------------------------------------------------------------
{
  const value = 'pre [Pasted ~3 lines] post';
  const chip = [{ token: '[Pasted ~3 lines]', text: 'a\nb\nc' }];
  const start = value.indexOf('[');
  const end = start + '[Pasted ~3 lines]'.length;
  ok(chipSpanIn(chip, value, end - 1, end)?.start === start,
     'backspace right after the chip removes it');
  ok(chipSpanIn(chip, value, start + 2, start + 3)?.start === start,
     'an edit inside the chip still removes it whole');
  ok(chipSpanIn(chip, value, start - 1, start) === null,
     'backspace before the chip edits the earlier text, not the chip');
  ok(chipSpanIn(chip, value, start, start + 1)?.start === start,
     'delete at the chip start removes it');
  ok(chipSpanIn(chip, value, end, end + 1) === null,
     'delete after the chip edits the following text');
  ok(chipSpanIn(chip, 'plain text', 1, 2) === null, 'no chip in the buffer means no span');
  // ctrl-u deletes line-start..cursor — a range overlapping the token kills it
  ok(chipSpanIn(chip, value, 0, end - 2)?.start === start, 'ctrl-u over a chip removes the chip');
  // chipSpanAt is the STRICTLY-inside probe: a mid-token cursor is an illegal
  // insert point, but the token's edges are legal (backspace after it, typing
  // before it).
  ok(chipSpanAt(chip, value, start + 2)?.start === start, 'a cursor inside the chip reports its span');
  ok(chipSpanAt(chip, value, start) === null, 'the chip left edge is a legal cursor');
  ok(chipSpanAt(chip, value, end) === null, 'the chip right edge is a legal cursor');
}
{
  // Two chips sharing one token: deleting the SECOND occurrence must kill the
  // second payload, not the first.
  const table = [
    { token: 'T', text: 'first' },
    { token: 'T', text: 'second' },
  ];
  const hit = chipSpanIn(table, 'a T b T c', 6, 7);
  ok(hit?.index === 1, 'deleting the second of two identical chips removes ITS payload');
}

// -- takeChips: the message owns its chips once it leaves the buffer ------------
{
  const table = [{ token: '[Pasted ~3 lines]', text: 'a\nb\nc' }];
  const taken = takeChips(table, 'see [Pasted ~3 lines]');
  ok(taken.length === 1 && taken[0].text === 'a\nb\nc', 'enqueue moves the chip onto the message');
  ok(table.length === 0, 'a taken chip leaves the buffer table');
  ok(takeChips([], 'see [Pasted ~3 lines]').length === 0, 'no live chip means nothing is taken');
  ok(takeChips(table, 'plain text').length === 0, 'chip-free text takes nothing');
}
{
  // The queued-payload survival case: the buffer is edited after enqueue, and
  // the drained message must still expand.
  const table = [];
  insertChip(table, '[Pasted ~3 lines]', 0, '[Pasted ~3 lines]', 'payload\nmore\nhere');
  const taken = takeChips(table, '[Pasted ~3 lines]');
  table.push({ token: 'x', text: 'unrelated' });
  ok(expandChips(taken, '[Pasted ~3 lines]') === 'payload\nmore\nhere',
     'a queued message expands from its own chips after the buffer moved on');
}

// -- attachChips: recall restores chips to the buffer ---------------------------
{
  const table = [];
  attachChips(table, 'see [Pasted ~3 lines] end', [{ token: '[Pasted ~3 lines]', text: 'a\nb\nc' }]);
  ok(table.length === 1, 'recall re-attaches the message chips');
  ok(expandChips(table, 'see [Pasted ~3 lines] end') === 'see a\nb\nc end',
     'a recalled chip expands again on resubmit');
  attachChips(table, 'no token here', [{ token: 'ZZZ', text: 'gone' }]);
  ok(table.length === 1, 'a chip whose token is absent is not attached');
}

// -- prune ----------------------------------------------------------------------
ok(pruneChips([{ token: '[Pasted ~3 lines]', text: 'x' }], 'pre [Pasted ~3 lines] post').length === 1,
   'a live token keeps its chip');
ok(pruneChips([{ token: '[Pasted ~3 lines]', text: 'x' }], 'pre  post').length === 0,
   'a wiped buffer drops its chip');
{
  const dup = [{ token: 'T', text: '1' }, { token: 'T', text: '2' }];
  ok(pruneChips(dup, 'x T y').length === 1, 'one surviving occurrence keeps exactly one chip');
  ok(pruneChips(dup, 'x T y T z').length === 2, 'two occurrences keep both chips');
}
ok(pruneChips([], 'anything').length === 0, 'empty stays empty');

if (fails) { console.error(`${fails} failed`); process.exit(1); }
console.log('paste-chip helpers all pass');
