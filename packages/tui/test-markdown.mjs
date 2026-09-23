import { renderMarkdown, renderInline, commitSafeLen } from './markdown.mjs';
import { createTheme } from './theme.mjs';
import { stringWidth } from './width.mjs';

// createTheme honors NO_COLOR; clear it so enabled:true stays deterministic.
delete process.env.NO_COLOR;

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const plain = createTheme({ enabled: false });
const md = (t, w = 60) => renderMarkdown(t, plain, w);

// --- inline -------------------------------------------------------------------
ok(renderInline('plain', plain) === 'plain', 'plain text passes through');
ok(renderInline('a `code` b', plain) === 'a code b', 'code span unwrapped when color is off');
ok(renderInline('**bold**', plain) === 'bold', 'strong emphasis');
ok(renderInline('*em*', plain) === 'em', 'single-asterisk emphasis');
ok(renderInline('2 * 3 * 4', plain) === '2 * 3 * 4', 'bare asterisks with spaces stay literal (arithmetic)');
ok(renderInline('snake_case_name', plain) === 'snake_case_name', 'underscores inside a word are not emphasis');
ok(renderInline('[docs](https://x.dev)', plain) === 'docs https://x.dev', 'link shows label then url');
ok(renderInline('[](https://x.dev)', plain) === 'https://x.dev', 'an empty link label shows just the url');
ok(renderInline('`**not bold**`', plain) === '**not bold**', 'code spans are literal, emphasis is not applied inside');
ok(renderInline(null, plain) === '', 'null inline text is safe');

const colored = createTheme({ enabled: true });
ok(renderInline('`x`', colored).includes('\x1b['), 'inline styling emits ANSI when color is on');

// --- blocks -------------------------------------------------------------------
ok(md('# Title')[0] === 'Title', 'heading text is kept, hashes dropped');
ok(md('###### h6')[0] === 'h6', 'all six heading levels parse');
ok(md('- one\n- two').join('|') === '• one|• two', 'bullets are normalised');
ok(md('* star\n+ plus').join('|') === '• star|• plus', 'all three bullet markers work');
ok(md('1. first\n2. second').join('|') === '1. first|2. second', 'ordered lists keep their numbers');
ok(md('  - nested')[0] === '  • nested', 'list indentation is preserved');
ok(md('> quoted')[0] === '│ quoted', 'blockquotes get a rule prefix');
ok(md('---')[0].startsWith('─'), 'a thematic break renders as a rule');
ok(md('a\n\nb').join('|') === 'a||b', 'blank lines are preserved between paragraphs');

// --- fences -------------------------------------------------------------------
const fenced = md('text\n```js\nconst a = 1;\n# not a heading\n```\nafter');
ok(fenced.includes('js'), 'the fence language is shown');
ok(fenced.some(l => l.includes('const a = 1;')), 'code content is kept verbatim');
ok(fenced.some(l => l.includes('# not a heading')), 'a hash inside a fence is NOT styled as a heading');
ok(!fenced.some(l => l === '```'), 'fence markers themselves are not printed');
ok(fenced.at(-1) === 'after', 'content after the fence resumes normal rendering');
ok(md('```\n- not a bullet\n```').some(l => l.includes('- not a bullet')),
   'a dash inside a fence is not turned into a bullet');
ok(md('~~~\nx\n~~~').some(l => l.includes('x')), 'tilde fences work');
ok(md('```js\nunterminated').some(l => l.includes('unterminated')),
   'an unterminated fence still renders its content (the model was cut off)');

// --- wrapping -----------------------------------------------------------------
const wrapped = md('aaa bbb ccc ddd eee fff', 12);
ok(wrapped.length > 1 && wrapped.every(l => l.length <= 12), 'prose wraps to the width');
const wrappedBullet = md('- aaa bbb ccc ddd eee', 14);
ok(wrappedBullet[0].startsWith('• ') && wrappedBullet[1].startsWith('  '),
   'a wrapped bullet indents its continuation under the text, not the marker');
const longCode = md('```\n' + 'x'.repeat(200) + '\n```', 30);
ok(longCode.some(l => l.includes('…')) && longCode.every(l => l.length <= 30),
   'code lines are truncated, never wrapped (broken indentation is worse)');

// --- tables -------------------------------------------------------------------
// Small fixture: two columns, left + right alignment, uneven rows.
const tbl = md('| Name | Age |\n| :--- | --: |\n| Ada | 36 |\n| Bo | 7 |', 40);
ok(tbl[0] === 'Name │ Age', 'table header renders with pipe separators');
ok(tbl[1] === '─────┼────', 'a divider row separates the header from the body');
ok(tbl[2] === 'Ada  │  36', 'cells pad to column width and honor right alignment');
ok(tbl[3] === 'Bo   │   7', 'short cells still align');
ok(tbl.every(l => stringWidth(l) <= 40), 'every table line fits the width');

const centered = md('| a | b |\n| :-: | - |\n| x | y |', 40);
ok(centered[2] === ' x  │ y  ', 'a center column pads both sides');

const tight = md('| Col | A very long description cell |\n| --- | --- |\n| x | short |', 20);
ok(tight.every(l => stringWidth(l) <= 20), 'columns shrink to fit a narrow width');
ok(tight.filter(l => l.includes('│')).length >= 4,
   'long cell text wraps to extra lines instead of clipping');
ok(tight.join('\n').includes('description') && tight.join('\n').includes('cell'),
   'wrapped cells lose no characters');

const tiny = md('| abcdefghij | b |\n| --- | --- |', 12);
ok(tiny.every(l => stringWidth(l) <= 12), 'sub-8 columns hard-split instead of overflowing');
ok(tiny.join('\n').includes('ghij'), 'hard-split loses no characters');

const wide = md('| k | v |\n| - | - |\n| 名字 | 值 |', 40);
ok(wide.every(l => stringWidth(l) <= 40), 'CJK cells are sized in cells, not code points');
ok(wide[2] === '名字 │ 值 ', 'wide chars pad to the same column width');

// --- table edge cases -----------------------------------------------------------
ok(md('a | b\n---')[0] === 'a | b', 'delimiter/header cell-count mismatch is not a table');
ok(md('a | b\n---')[1].startsWith('─'), 'a lone dashed line still parses as a rule');
ok(md('| a \\| b | c |\n| --- | --- |')[0] === 'a | b │ c  ',
   'an escaped pipe stays inside its cell');
ok(md('| h | t |\n| - | - |\n| 1 | 2 | dropped |').every(l => !l.includes('dropped')),
   'cells beyond the header count are dropped');
ok(md('| h |\n| - |\n| 1 |\n\nnot a row | here').at(-1) === 'not a row | here',
   'a blank line ends the table');
ok(md('| h |\n| - |\n| 1 |\n# next | heading')[3] === 'next | heading',
   'another block start ends the table and parses normally');
ok(md('```\n| a | b |\n| - | - |\n```').some(l => l.includes('| a | b |')),
   'pipes inside a fence stay code, not a table');
ok(md('before\n| a |\n| - |\n| 1 |\nafter').at(-1) === 'after',
   'content after a table resumes normal rendering');

const headerOnly = md('| a | b |\n| - | - |');
ok(headerOnly.length === 2 && headerOnly[0] === 'a   │ b  ' && headerOnly[1] === '────┼────',
   'a header-only table emits exactly header + divider, no phantom body row');

const oneCol = md('| h |\n| - |\n| 1 |');
ok(oneCol.join('\n') === 'h  \n───\n1  ',
   'a one-column table emits no separators, just padded cells');

const emptyCells = md('| | |\n| - | - |\n| | |');
ok(emptyCells[0] === '    │    ' && emptyCells[2] === '    │    ',
   'empty cells still hold their column and the grid stays aligned');

ok(md('| a | b | c |\n| - | - | - |\n| 1 |')[2] === '1   │     │    ',
   'a row short of the header count pads missing cells as empty');

ok(md('| - | - |')[0] === '| - | - |',
   'a delimiter row alone is a paragraph, not a table');

const overWide = md('| a | b | c | d |\n| - | - | - | - |\n| 1 | 2 | 3 | 4 |', 8);
ok(overWide.every(l => stringWidth(l) <= 8) && overWide.every(l => l.endsWith('…')),
   'a table wider than the terminal clips whole rows instead of overflowing');

const coloredTbl = renderMarkdown('| h |\n| - |\n| c |', colored, 40);
ok(coloredTbl[0].includes('\x1b['), 'header cells are emphasized when color is on');
ok(coloredTbl[1].includes('\x1b['), 'the divider is styled when color is on');

ok(md('').length >= 0 && md(null).length >= 0, 'empty and null sources are safe');

// --- commitSafeLen: how much of an unsettled stream may be committed -----------
// Newline gate: the unterminated tail line stays mutable — its render can still
// change as it grows, so only source up to the last '\n' is commit-safe.
ok(commitSafeLen('partial') === 0, 'no newline commits nothing');
ok(commitSafeLen('done\npartial') === 4, 'the unterminated tail line is held back');
ok(commitSafeLen('done\n') === 4, 'a trailing newline leaves only the empty tail live');
ok(commitSafeLen('a\nb\nc') === 3, 'every terminated line is commit-safe');
// Table holdback: a pipe line can still become a header while the growing tail
// may supply its delimiter, and an open table re-widths with every new row —
// both stay live until a terminated non-table line closes them.
ok(commitSafeLen('| a | b |\n') === 0, 'a trailing pipe line is pinned as a possible header');
ok(commitSafeLen('| a |\n|-') === 0, 'a delimiter-shaped tail pins the would-be header');
ok(commitSafeLen('| a |\nxyz') === 5, 'a tail that can never be a delimiter frees the pipe line');
ok(commitSafeLen('x = 1\n\n| a |\n| - |\n| 1 |') === 6, 'an open table pins from its header');
ok(commitSafeLen('| a |\n| - |\n| 1 |\nprose') === 0, 'a row-capable tail keeps the table open');
ok(commitSafeLen('| a |\n| - |\n| 1 |\nprose\n') === 23, 'a terminated non-table line closes the table');
ok(commitSafeLen('| a | b |\n| - |\n| 1 | 2 |') === 15, 'a column-count mismatch is not a table');
// A consumed delimiter row must not false-pair with a following rule line —
// '| - |' is table 1's delimiter, not a header for '---'; the open table is
// the later one (r2 MAJOR: a local-pair scan pinned the wrong line).
ok(commitSafeLen('| a |\n| - |\n---\n| x | y |\n| - | - |\n| 1 | 2 |\n') === 15,
   'a closed table before the open one does not confuse the pin');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
