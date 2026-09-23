// Cell-model oracles. The load-bearing properties: the grid must match what a
// real terminal would show for the same byte stream (deferred wrap, wide-char
// continuation, SGR carried across the line joins), and the row diff must only
// ever report rows whose painted content actually differs.

import { gridFromLines, rowsEqual, changedRows, serializeRow } from './cells.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const texts = (row) => row.map((c) => c.t);
const sgrs = (row) => row.map((c) => c.s);

// --- basic layout -------------------------------------------------------------
let g = gridFromLines(['abc'], 5);
ok(g.length === 1 && texts(g[0]).join('') === 'abc', 'plain line fills one row');
ok(g[0][3].t === '' && g[0][4].t === '', 'tail cells are blanks');

g = gridFromLines(['abcdef'], 5);
ok(g.length === 2 && g[1][0].t === 'f', 'overflow wraps to the next row');

g = gridFromLines(['abcde', 'x'], 5);
ok(g.length === 2 && g[1][0].t === 'x', 'a line that fills the last column does not earn a blank row (deferred wrap)');

g = gridFromLines(['', 'x'], 5);
ok(g.length === 2 && texts(g[0]).join('') === '' && g[1][0].t === 'x', 'empty line still occupies its row');

// --- wide chars ---------------------------------------------------------------
g = gridFromLines(['你好'], 4);
ok(g.length === 1 && g[0][0].t === '你' && g[0][1].cont === true && g[0][2].t === '好' && g[0][3].cont === true, 'wide char owns a continuation cell');

g = gridFromLines(['abc你'], 4);
ok(g.length === 2 && g[1][0].t === '你' && g[1][1].cont === true, 'a wide char that cannot fit the last column wraps whole');

// --- SGR ----------------------------------------------------------------------
g = gridFromLines(['\x1b[31mab\x1b[0m'], 5);
ok(g[0][0].s === '31' && g[0][1].s === '31' && g[0][2].s === '', 'SGR applies to its span only');

g = gridFromLines(['\x1b[31ma', 'b'], 5);
ok(g[1][0].s === '31', 'SGR state carries across the line join like the real stream');

g = gridFromLines(['\x1b[1m\x1b[31mx'], 5);
ok(g[0][0].s === '1;31', 'separate sequences serialize canonically');
g = gridFromLines(['\x1b[1;31mx'], 5);
ok(g[0][0].s === '1;31', 'combined params serialize identically');

g = gridFromLines(['\x1b[31m\x1b[1ma\x1b[22mb'], 5);
ok(g[0][0].s === '1;31', 'order is canonical (b before fg)');
ok(g[0][1].s === '31', '22 clears bold but keeps fg');

g = gridFromLines(['\x1b[38;5;196mx'], 5);
ok(g[0][0].s === '38;5;196', '256-color fg consumes its index');
g = gridFromLines(['\x1b[48;2;1;2;3mx'], 5);
ok(g[0][0].s === '48;2;1;2;3', 'truecolor bg consumes r;g;b');

g = gridFromLines(['\x1b[31ma\x1b[39mb'], 5);
ok(g[0][1].s === '', '39 resets fg to default');

// colon subparams belong to their leading param
ok(rowsEqual(gridFromLines(['\x1b[4:1mx'], 5)[0], gridFromLines(['\x1b[4mx'], 5)[0]), '4:1 is plain underline');
ok(!rowsEqual(gridFromLines(['\x1b[4:3mx'], 5)[0], gridFromLines(['\x1b[4mx'], 5)[0]), '4:3 curly underline differs from 4');
g = gridFromLines(['\x1b[38:2::1:2:3mx'], 5);
ok(g[0][0].s === '38:2::1:2:3' && !g[0][0].s.includes('NaN'), 'colon truecolor keeps its raw subparams, no NaN leak');

// empty params are code 0; truncated color specs swallow their numeric tail
ok(rowsEqual(gridFromLines(['\x1b[1m\x1b[;31mx'], 5)[0], gridFromLines(['\x1b[0;31mx'], 5)[0]), 'empty param resets like 0');
g = gridFromLines(['\x1b[38;5mx'], 5);
ok(g[0][0].s === '38', 'truncated 38;5 swallows the 5 instead of reparsing it as blink');
g = gridFromLines(['\x1b[38;2;1;2mx'], 5);
ok(g[0][0].s === '38', 'truncated 38;2;r;g swallows the numeric tail');

// --- tab / control ------------------------------------------------------------
g = gridFromLines(['a\tb'], 16);
ok(g[0][1].t === '' && g[0][8].t === 'b', 'tab advances to the next 8-stop');
g = gridFromLines(['a\tb'], 9);
ok(g.length === 1 && g[0][8].t === 'b', 'a tab that reaches the margin leaves the last cell to the next char');
g = gridFromLines(['a\x07b'], 5);
ok(g[0][1].t === 'b', 'non-tab C0 carries no cell and does not resolve a wrap');
g = gridFromLines(['abcde\x07f'], 5);
ok(g.length === 2 && g[1][0].t === 'f', 'a C0 byte at the wrap boundary paints no cell');

// --- cluster widths -----------------------------------------------------------
g = gridFromLines(['🇫🇷x'], 4);
ok(g.length === 1 && g[0][0].t === '🇫🇷' && g[0][1].cont === true && g[0][2].t === 'x', 'an RI flag pair occupies two cells');
g = gridFromLines(['1️⃣x'], 4);
ok(g.length === 1 && g[0][0].t === '1️⃣' && g[0][1].cont === true, 'a keycap sequence occupies two cells');
g = gridFromLines(['́a'], 5);
ok(g[0][0].t === 'a', 'a cluster of only zero-width points advances no cell');
g = gridFromLines(['áb'], 5);
ok(g[0][0].t === 'á' && g[0][1].t === 'b', 'a combining mark folds into its base cell');

// --- row diff -----------------------------------------------------------------
const g1 = gridFromLines(['aaa', 'bbb'], 5);
ok(changedRows(g1, gridFromLines(['aaa', 'bbb'], 5)).length === 0, 'identical frames diff empty');
ok(JSON.stringify(changedRows(g1, gridFromLines(['aaa', 'bbc'], 5))) === '[1]', 'one changed row reports only that row');
ok(JSON.stringify(changedRows(g1, gridFromLines(['aaa', 'bbb', 'ccc'], 5))) === '[2]', 'a grown frame reports the new row');
ok(JSON.stringify(changedRows(gridFromLines(['aaa', 'bbb', 'ccc'], 5), g1)) === '[2]', 'a shrunk frame reports the dropped row');
ok(changedRows(gridFromLines(['\x1b[31ma'], 5), gridFromLines(['a'], 5)).length === 1, 'SGR-only change is a real diff');
ok(changedRows(gridFromLines(['\x1b[1;31ma'], 5), gridFromLines(['\x1b[31;1ma'], 5)).length === 0, 'order-shuffled identical state is not a diff');

// --- serialize ----------------------------------------------------------------
let row = gridFromLines(['\x1b[31mab', 'cd'], 5)[1];
ok(serializeRow(row) === '\x1b[0;31mcd\x1b[0m', 'serialize emits the carried state and a trailing reset');

row = gridFromLines(['ab\x1b[0m'], 5)[0];
ok(serializeRow(row) === 'ab', 'default-state row serializes to bare text (EL covers the tail)');

row = gridFromLines(['\x1b[41mab  \x1b[0m'], 8)[0];
ok(serializeRow(row) === '\x1b[0;41mab  \x1b[0m', 'styled trailing blanks are kept as painted spaces');

row = gridFromLines(['ab'], 8)[0];
ok(serializeRow(row, { trim: false }) === 'ab      ', 'untrimmed serializes every cell');
ok(serializeRow(row) === 'ab', 'trimmed drops default tail blanks');

// attribute-dropping transitions must rebuild from reset, not append
row = gridFromLines(['\x1b[1;31ma\x1b[22mb'], 5)[0];
ok(serializeRow(row) === '\x1b[0;1;31ma\x1b[0;31mb\x1b[0m', 'a dropped attribute re-emits from reset');

// a serialized row re-grids to itself (round-trip on the trimmed prefix)
const src = gridFromLines(['\x1b[31ma你\x1b[0mb'], 10)[0];
const rt = gridFromLines([serializeRow(src)], 10)[0];
ok(rowsEqual(src, rt), 'a serialized row re-grids to itself');

if (fails > 0) { console.error(`${fails} FAIL`); process.exit(1); }
console.log('ALL PASS');
