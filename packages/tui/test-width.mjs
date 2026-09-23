// Terminal-cell width tests.
//
// This module exists because counting code points instead of cells let the input
// box and status line overflow and wrap, which desynced the screen writer's erase
// height and deleted committed scrollback. Typing Chinese was enough to trigger
// it, so the CJK cases here are the regression, not an edge case.
import { charWidth, stringWidth, clipToWidth, padToWidth } from './width.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

// --- charWidth ----------------------------------------------------------------
ok(charWidth(0x41) === 1, 'ascii is one cell');
ok(charWidth(0x4e2d) === 2, 'CJK ideograph is two cells');
ok(charWidth(0xac00) === 2, 'Hangul syllable is two cells');
ok(charWidth(0x3042) === 2, 'Hiragana is two cells');
ok(charWidth(0xff21) === 2, 'fullwidth Latin is two cells');
ok(charWidth(0x1f600) === 2, 'emoji is two cells');
ok(charWidth(0x26a1) === 2, 'U+26A1 zap is two cells — it looked narrow and was not');
ok(charWidth(0x0301) === 0, 'a combining acute is zero cells');
ok(charWidth(0x200b) === 0, 'zero-width space is zero cells');
ok(charWidth(0xfe0f) === 0, 'a variation selector is zero cells');
ok(charWidth(0x1b) === 0, 'ESC is zero cells');
ok(charWidth(0x2500) === 1, 'box-drawing is one cell');
ok(charWidth(0xb7) === 1, 'middle dot is one cell');
// Wide code points missing from the table (Unicode 15.1 EAW W/F) — each measured
// one cell while terminals give it two: the same overflow class as CJK.
ok(charWidth(0x231a) === 2, 'U+231A watch is two cells');
ok(charWidth(0x231b) === 2, 'U+231B hourglass is two cells');
ok(charWidth(0x1f6d5) === 2, 'U+1F6D5 hindu temple is two cells (emoji 13)');
ok(charWidth(0x1f6dd) === 2, 'U+1F6DD playground slide is two cells (emoji 14)');
ok(charWidth(0x1f7f0) === 2, 'U+1F7F0 heavy equals sign is two cells (emoji 14)');
ok(charWidth(0x1aff0) === 2, 'U+1AFF0 Kana Extended-B is two cells');
ok(charWidth(0x1aff4) === 1, 'U+1AFF4 is not wide (unassigned hole inside the block)');
ok(charWidth(0x1b170) === 2, 'U+1B170 Nushu is two cells');
ok(charWidth(0x1b2fb) === 2, 'U+1B2FB Nushu end is two cells');
ok(charWidth(0x16ff0) === 2, 'U+16FF0 Vietnamese reading mark is two cells');

// --- stringWidth --------------------------------------------------------------
ok(stringWidth('abc') === 3, 'ascii string');
ok(stringWidth('中文') === 4, 'two CJK chars are four cells');
ok(stringWidth('a中b') === 4, 'mixed width');
ok(stringWidth('é') === 1, 'a base plus combining mark is one cell');
ok(stringWidth('') === 0 && stringWidth(null) === 0, 'empty and null are zero');
ok(stringWidth('你'.repeat(34)) === 68, '34 CJK chars are 68 cells — the reported failing case');

// --- clipToWidth --------------------------------------------------------------
ok(clipToWidth('abcdef', 10) === 'abcdef', 'short text is untouched');
ok(stringWidth(clipToWidth('abcdef', 4)) <= 4, 'clipped ascii fits the budget');
ok(clipToWidth('abcdef', 4).endsWith('…'), 'clipping marks the cut');
ok(stringWidth(clipToWidth('中文中文中文', 5)) <= 5,
   'clipping never splits a wide char across the budget boundary');
ok(stringWidth(clipToWidth('中文中文中文', 6)) <= 6, 'even budget with wide chars fits');
ok(clipToWidth('abc', 0) === '', 'zero budget yields empty');
ok(clipToWidth(null, 5) === '', 'null clips to empty');
ok(stringWidth(clipToWidth('🙂🙂🙂🙂', 5)) <= 5, 'emoji clip fits');

// --- padToWidth ---------------------------------------------------------------
ok(stringWidth(padToWidth('中文', 10)) === 10, 'padding accounts for wide chars');
ok(stringWidth(padToWidth('abc', 10)) === 10, 'padding ascii');
ok(padToWidth('abcdef', 3) === 'abcdef', 'padding never truncates');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
