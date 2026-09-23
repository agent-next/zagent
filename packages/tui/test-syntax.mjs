import { createHighlighter } from './syntax.mjs';
import { renderMarkdown } from './markdown.mjs';
import { createTheme } from './theme.mjs';
import { clipToWidth, stringWidth } from './width.mjs';

delete process.env.NO_COLOR;

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

// Marker painters make every scope's output exact-matchable; C<> is the
// default code color ordinary tokens keep.
const T = {
  code: s => `C<${s}>`, synKeyword: s => `K<${s}>`, synString: s => `S<${s}>`,
  synComment: s => `M<${s}>`, synNumber: s => `N<${s}>`, synFunc: s => `F<${s}>`,
  synType: s => `T<${s}>`, synConstant: s => `O<${s}>`, synProperty: s => `P<${s}>`,
  success: s => `A<${s}>`, error: s => `D<${s}>`, faint: s => `f<${s}>`,
};
const hi = (lang) => createHighlighter(lang, T);

// --- language resolution --------------------------------------------------------
ok(hi('brainfuck') === null, 'unknown language resolves to no highlighter');
ok(hi(undefined) === null && hi('') === null, 'a missing language resolves to no highlighter');
ok(hi('JavaScript') !== null && hi('TS') !== null && hi('golang') !== null,
   'aliases and case-folded names resolve to a family');
ok(hi('c++') !== null && hi('c#') !== null, 'symbol-heavy aliases resolve');

// --- c-like ---------------------------------------------------------------------
const js = hi('js');
ok(js('const x = "s"; // tail') === 'K<const>C< x = >S<"s">C<; >M<// tail>',
   'js: keyword, string and line comment are scoped');
ok(js('let n = 0x1f + 2.5;') === 'K<let>C< n = >N<0x1f>C< + >N<2.5>C<;>', 'js: hex and float numbers');
ok(js('foo(bar)') === 'F<foo>C<(bar)>', 'js: a call name is a function, its argument is plain');
ok(js('a.b = 1') === 'C<a.>P<b>C< = >N<1>', 'js: a dotted member is a property');
ok(js('new Foo;') === 'K<new>C< >T<Foo>C<;>', 'js: a capitalized identifier reads as a type');
ok(js('const MAX_SIZE = 1') === 'K<const>C< >O<MAX_SIZE>C< = >N<1>', 'js: ALL_CAPS reads as a constant');
ok(js('if (ok) return null;') === 'K<if>C< (ok) >K<return>C< >O<null>C<;>', 'js: null is a constant not a call');
ok(js('constable = construction') === 'C<constable = construction>',
   'js: identifiers starting with a keyword stay plain (word boundary)');
ok(js('x = "a\\"b"') === 'C<x = >S<"a\\"b">', 'js: an escaped quote does not close a string');
ok(js('s = "unterminated') === 'C<s = >S<"unterminated>',
   'js: an unterminated string colors to end of line and does not hang');

// block comments are stateful across lines.
ok(js('a /* one') === 'C<a >M</* one>', 'js: block comment opens mid-line');
ok(js('still */ b') === 'M<still */>C< b>', 'js: block comment closes on a later line');
ok(js('plain again') === 'C<plain again>', 'js: state is clear after the comment closes');

// ' is char-literal only in clike: digit separators and Rust lifetimes must not
// swallow the rest of the line into a string.
ok(js("c = 'x'") === 'C<c = >S<\'x\'>', "js: a real 'x' literal still highlights");
ok(js("s = 'hello world'") === 'C<s = >S<\'hello world\'>', 'js: a longer single-quoted string highlights');
ok(hi('cpp')("1'000'000") === 'N<1>C<\'>N<000>C<\'>N<000>', 'cpp: digit separators stay numbers');
ok(hi('rust')("fn f<'a>(x: &'a str) {}") === 'K<fn>C< >F<f>C<<\'a>(x: &\'a str) {}>',
   'rust: lifetimes are not strings');
ok(js('function (x) {}') === 'K<function>C< (x) {}>', 'js: anonymous function params stay code');

// --- script (python/ruby) --------------------------------------------------------
const py = hi('python');
ok(py('def f(x): # note') === 'K<def>C< >F<f>C<(x): >M<# note>', 'py: def keyword, call name, comment');
ok(py('return self.x is None') === 'K<return>C< >O<self>C<.>P<x>C< >K<is>C< >O<None>',
   'py: self/None constants, member property');
ok(py('@deco') === 'F<@deco>', 'py: a decorator is a function scope');
const py3 = hi('python');
ok(py3('s = """doc') === 'C<s = >S<"""doc>', 'py: a triple-quoted string opens');
ok(py3('more text') === 'S<more text>', 'py: a triple-quoted string continues on the next line');
ok(py3('end""" + 1') === 'S<end""">C< + >N<1>', 'py: a triple-quoted string closes');
ok(hi('ruby')('def f; end') === 'K<def>C< >F<f>C<; >K<end>', 'ruby shares the script family');
ok(hi('ruby')('@x = 1') === 'P<@x>C< = >N<1>', 'ruby: an @ivar assignment is a property not a decorator');

// --- shell -----------------------------------------------------------------------
const sh = hi('bash');
ok(sh('echo $HOME # c') === 'F<echo>C< >P<$HOME>C< >M<# c>', 'sh: command position, $var, comment');
ok(sh('if [ -f x ]; then echo y; fi') === 'K<if>C< [ -f x ]; >K<then>C< >F<echo>C< y; >K<fi>',
   'sh: keywords and a command after then');
ok(sh('a=1; b=2') === 'C<a=>N<1>C<; b=>N<2>', 'sh: assignments keep their name plain');
ok(sh('echo ${X}y') === 'F<echo>C< >P<${X}>C<y>', 'sh: braced variable expands as one token');
ok(sh('x;# note c') === 'F<x>C<;>M<# note c>', 'sh: # right after ; still opens a comment');

// --- json / yaml ------------------------------------------------------------------
const jq = hi('json');
ok(jq('{"a": 1, "b": "x"}') === 'C<{>P<"a">C<: >N<1>C<, >P<"b">C<: >S<"x">C<}>',
   'json: keys are properties, string values are strings');
ok(jq('[true, null]') === 'C<[>O<true>C<, >O<null>C<]>', 'json: literals are constants');
ok(jq('// trailing comment ok') === 'M<// trailing comment ok>', 'json: jsonc comments tolerated');
ok(hi('yaml')('- name: x # c') === 'C<- >P<name>C<: x >M<# c>', 'yaml: a mapping key is a property');
ok(hi('yaml')('url: a#b') === 'P<url>C<: a#b>', 'yaml: # without a preceding space is not a comment');
ok(hi('yaml')('x: ~') === 'P<x>C<: >O<~>', 'yaml: ~ is a null constant');
ok(hi('yaml')('-'.repeat(1000) + ':') === 'C<' + '-'.repeat(1000) + ':>',
   'yaml: a pathological dash line cannot stall the key scan');

// --- diff --------------------------------------------------------------------------
const df = hi('diff');
ok(df('+added') === 'A<+added>', 'diff: added lines are success-colored');
ok(df('-removed') === 'D<-removed>', 'diff: removed lines are error-colored');
ok(df('@@ -1,2 +1,2 @@') === 'F<@@ -1,2 +1,2 @@>', 'diff: hunk headers are function-colored');
ok(df('--- a/f') === 'M<--- a/f>' && df('+++ b/f') === 'M<+++ b/f>',
   'diff: file headers are muted, not add/del colored');

// --- sql (case-insensitive keywords) ------------------------------------------------
const sq = hi('sql');
ok(sq('SELECT id FROM t;') === 'K<SELECT>C< id >K<FROM>C< t;>', 'sql: uppercase keywords');
ok(sq('select id from t;') === 'K<select>C< id >K<from>C< t;>', 'sql: lowercase keywords too');

// --- clipping -----------------------------------------------------------------------
const off = createTheme({ enabled: false });
const plainHi = createHighlighter('js', off);
const long = 'const identifier = "a much longer string value";';
ok(plainHi(long, 20) === clipToWidth(long, 20),
   'a disabled theme clips exactly like clipToWidth');
const on = createTheme({ enabled: true });
const onHi = createHighlighter('js', on);
ok(stringWidth(onHi(long, 20).replace(/\x1b\[[0-9;]*m/g, '')) <= 20,
   'a colored line clips to the cell budget (ANSI does not count)');

// state advances on the FULL line even when the open marker is clipped away.
const clip = hi('js');
clip('aaaa /* hidden', 4);
ok(clip('b */ c') === 'M<b */>C< c>',
   'a block comment clipped out of view still scopes the next line');

// --- renderMarkdown integration -------------------------------------------------------
const md = (t, w = 60, th = on) => renderMarkdown(t, th, w);
const fenced = md('```js\nconst a = 1;\n```');
ok(fenced[1].includes('\x1b[38;5;176m'), 'a fenced js block paints keywords in the syntax color');
ok(fenced[1].includes('\x1b[38;5;215m'), 'the same line paints numbers in their own color');
const noLang = md('```\nconst a = 1;\n```');
ok(noLang[0].includes('\x1b[38;5;109m') && !noLang[0].includes('38;5;176'),
   'a language-less fence keeps the uniform code color');
const unknown = md('```xyz\nconst a = 1;\n```');
ok(unknown[1].includes('\x1b[38;5;109m') && !unknown[1].includes('38;5;176'),
   'an unknown fence language keeps the uniform code color');
// disabled theme stays byte-identical to the pre-syntax output.
const mdOff = (t, w = 60) => renderMarkdown(t, off, w);
ok(mdOff('```js\nconst a = 1;\n```')[1] === '  const a = 1;',
   'color-off fenced code is unchanged');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
