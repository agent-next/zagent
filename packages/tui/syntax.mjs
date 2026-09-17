// Fenced-code syntax colors: a small line tokenizer, not a grammar.
//
// Every peer TUI (codex/syntect, opencode/tree-sitter) colors fenced code; a
// uniform block is the readability gap. This is deliberately NOT a parser port:
// per-language regex specs over a ~10-class scope set mapped to theme tokens, state
// carried only for block comments and triple-quoted strings. Wrong guesses land
// on the default code color, so the failure mode is a duller line, never noise.
//
// The fence language resolves through aliases to a family; unknown languages
// get no highlighter and keep the uniform code color.

import { charWidth, stringWidth } from './width.mjs';

const PAINT = {
  keyword: 'synKeyword', string: 'synString', comment: 'synComment',
  number: 'synNumber', func: 'synFunc', type: 'synType', constant: 'synConstant',
  property: 'synProperty', add: 'success', del: 'error', code: 'code',
};

const IDENT = /[A-Za-z_][\w]*/y;
const NUMBER = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*)/y;
const ALLCAPS = /^[A-Z][A-Z0-9_]+$/;
const SHELL_VAR = /\$(?:\{[^}]*\}|[\w]+|[@#?$!*0-9])/y;
const SHELL_FLAG = /-{1,2}[A-Za-z][\w-]*/y;
// Bounds keep this linear: a pathological dash/space line can never force
// unbounded backtracking, and a key longer than 200 chars just stays code-colored.
const YAML_KEY = /^(\s*(?:-\s*){0,8})([^\s:#'"][^:#'"]{0,200}?):(?=\s|$)/;

const CLIKE_KW = new Set(('abstract as assert async await auto break case catch chan char class const continue ' +
  'debugger declare default defer delete do double dyn else enum export extends extern fallthrough final finally ' +
  'float fn for from func function go goto if impl implements import in instanceof int interface let long map ' +
  'match mod move mut new of package private protected pub public range readonly ref register return select ' +
  'signed sizeof static struct super switch synchronized this throw throws trait try typedef typeof union unsafe ' +
  'unsigned use var void volatile where while with yield').split(' '));
const CLIKE_CONST = new Set('true false null nullptr NULL nil undefined NaN Infinity'.split(' '));

const SCRIPT_KW = new Set(('and as assert async await begin break class continue def del do elif else end ensure ' +
  'except finally for from global if import in is lambda module next nonlocal not or pass private protected ' +
  'public raise redo rescue retry return then unless until while with yield require include').split(' '));
const SCRIPT_CONST = new Set('True False None nil true false self NotImplemented Ellipsis'.split(' '));

const SHELL_KW = new Set('if then else elif fi for while until do done case esac function in select time coproc'.split(' '));
// Words after which a bare identifier is again a command name.
const SHELL_CMD_KW = new Set('if then elif else while until do select time'.split(' '));
const SHELL_CMD_CHAR = new Set(';|&(`');

const SQL_KW = new Set(('select insert update delete from where join inner left right outer full cross on group ' +
  'by order having limit offset as distinct union all into values set create alter drop table view index primary ' +
  'key foreign references not null default unique check constraint cascade and or like in is between exists ' +
  'case when then else end begin commit rollback transaction grant revoke with recursive returning').split(' '));

// Shared scanner spec: line comment, optional block comment, string quotes,
// optional triple quotes, identifier sets, and small per-family hooks.
const FAMILIES = {
  clike: {
    line: '//', block: ['/*', '*/'], strings: '"\'`',
    keywords: CLIKE_KW, constants: CLIKE_CONST, defKw: new Set(['function', 'fn', 'func']),
    charLit: true, // ' is char-literal only: 'a' is a string, &'a a lifetime, 1'000 a number
  },
  script: {
    line: '#', strings: '"\'', triples: ['"""', "'''"],
    keywords: SCRIPT_KW, constants: SCRIPT_CONST, decorators: true,
    defKw: new Set(['def', 'function']),
  },
  shell: {
    line: '#', strings: '"\'', keywords: SHELL_KW, constants: new Set(),
    boundComment: /[\s;|&(]/, vars: true, cmdTrack: true,
  },
  json: {
    line: '//', block: ['/*', '*/'], strings: '"',
    keywords: new Set(), constants: new Set(['true', 'false', 'null']), jsonKeys: true,
  },
  yaml: {
    line: '#', strings: '"\'', keywords: new Set(), boundComment: /\s/,
    constants: new Set(['true', 'false', 'null']), yamlKeys: true,
  },
  sql: {
    line: '--', block: ['/*', '*/'], strings: '\'"`',
    keywords: SQL_KW, constants: new Set(['null']), ci: true,
  },
  diff: { lineMode: true },
};

const ALIASES = new Map(Object.entries({
  clike: 'js javascript mjs cjs node jsx ts typescript tsx java c h cpp c++ cc cxx hpp cs csharp c# go golang rs rust kt kts kotlin swift php dart scala',
  script: 'py python pyw ruby rb perl pl',
  shell: 'sh bash zsh shell console',
  json: 'json jsonc json5 jsonl',
  yaml: 'yaml yml',
  sql: 'sql mysql pgsql postgres sqlite',
  diff: 'diff patch',
}).flatMap(([fam, names]) => names.split(' ').map(n => [n, fam])));

/** A diff is classified whole-line; there is nothing to tokenize inside it. */
function scanDiff(line) {
  if (line.startsWith('@@')) return [['func', line]];
  if (/^(diff |index |Binary |--- |\+\+\+ )/.test(line)) return [['comment', line]];
  if (line.startsWith('+')) return [['add', line]];
  if (line.startsWith('-')) return [['del', line]];
  return [['code', line]];
}

/**
 * One line -> [scope, text] spans. `st` carries an unterminated block
 * comment / triple string's closing delimiter and scope between lines.
 */
function scan(spec, line, st) {
  if (spec.lineMode) return scanDiff(line);
  const spans = [];
  let plain = '';
  const push = (scope, text) => {
    if (!text) return;
    if (scope === 'code') { plain += text; return; }
    if (plain) { spans.push(['code', plain]); plain = ''; }
    spans.push([scope, text]);
  };
  const flush = () => { if (plain) { spans.push(['code', plain]); plain = ''; } };

  let i = 0;
  let expectCmd = spec.cmdTrack === true;
  let defNext = false;

  if (spec.yamlKeys) {
    const m = YAML_KEY.exec(line);
    if (m) {
      push('code', m[1]);
      push('property', m[2]);
      push('code', ':');
      i = m[0].length;
    }
  }

  while (i < line.length) {
    const rest = line.slice(i);

    // Resume an unterminated block comment / triple string from the last line.
    if (st.close) {
      const end = rest.indexOf(st.close);
      push(st.scope, end < 0 ? rest : rest.slice(0, end + st.close.length));
      if (end < 0) i = line.length; else { i += end + st.close.length; st.close = null; st.scope = null; }
      continue;
    }

    if (spec.line && rest.startsWith(spec.line)
        && !(spec.boundComment && i > 0 && !spec.boundComment.test(line[i - 1]))) {
      push('comment', rest);
      break;
    }
    if (spec.block && rest.startsWith(spec.block[0])) {
      const end = rest.indexOf(spec.block[1], spec.block[0].length);
      if (end < 0) { push('comment', rest); st.close = spec.block[1]; st.scope = 'comment'; i = line.length; }
      else { push('comment', rest.slice(0, end + spec.block[1].length)); i += end + spec.block[1].length; }
      continue;
    }
    const triple = spec.triples?.find(t => rest.startsWith(t));
    if (triple) {
      const end = rest.indexOf(triple, triple.length);
      if (end < 0) { push('string', rest); st.close = triple; st.scope = 'string'; i = line.length; }
      else { push('string', rest.slice(0, end + triple.length)); i += end + triple.length; }
      continue;
    }
    const ch = rest[0];
    if (defNext && !/[\sA-Za-z_]/.test(ch)) defNext = false;
    if (spec.strings.includes(ch)) {
      let j = 1;
      while (j < rest.length && rest[j] !== ch) j += rest[j] === '\\' ? 2 : 1;
      const text = rest.slice(0, Math.min(j + 1, rest.length));
      if (spec.charLit && ch === "'") {
        // ' opens a char literal, not a string: a digit separator (1'000) or a
        // Rust lifetime (&'a, <'a>) must not paint the tail as a string. Gate:
        // never after a word char, a close within reach, and an interior that
        // a char literal could plausibly hold (no brackets/operators).
        const prev = line[i - 1];
        const closed = j < rest.length;
        const interior = closed ? rest.slice(1, j) : null;
        if ((prev && /\w/.test(prev)) || !closed || interior.length > 12
            || /[<>&()\[\]{};]/.test(interior)) {
          push('code', ch);
          i += 1;
          continue;
        }
      }
      // A JSON string is a key when a colon follows its close.
      const scope = spec.jsonKeys && /^\s*:/.test(rest.slice(text.length)) ? 'property' : 'string';
      push(scope, text);
      i += text.length;
      continue;
    }
    if (spec.vars) {
      SHELL_VAR.lastIndex = i;
      const v = SHELL_VAR.exec(line);
      if (v) { push('property', v[0]); i += v[0].length; expectCmd = false; continue; }
    }
    if (spec.decorators && ch === '@' && /[A-Za-z_]/.test(rest[1] ?? '')) {
      IDENT.lastIndex = i + 1;
      const m = IDENT.exec(line);
      const name = '@' + (m?.[0] ?? '');
      // A decorator is a line-leading statement (@deco); an @ivar elsewhere —
      // and a leading @x = assignment — is a variable, painted as a property.
      const atLineStart = /^\s*$/.test(line.slice(0, i));
      push(atLineStart && !/^\s*=/.test(line.slice(i + name.length)) ? 'func' : 'property', name);
      i += name.length;
      continue;
    }
    if (spec.cmdTrack) {
      SHELL_FLAG.lastIndex = i;
      const flag = ch === '-' && SHELL_FLAG.exec(line);
      if (flag) { push('code', flag[0]); i += flag[0].length; expectCmd = false; continue; }
      if (SHELL_CMD_CHAR.has(ch)) { push('code', ch); i += 1; expectCmd = true; continue; }
    }
    NUMBER.lastIndex = i;
    const num = /[\d.]/.test(ch) && NUMBER.exec(line);
    if (num) { push('number', num[0]); i += num[0].length; expectCmd = false; continue; }

    IDENT.lastIndex = i;
    const id = /[A-Za-z_]/.test(ch) && IDENT.exec(line);
    if (id) {
      const word = id[0];
      const norm = spec.ci ? word.toLowerCase() : word;
      const after = line.slice(i + word.length);
      if (spec.keywords.has(norm)) {
        push('keyword', word);
        if (spec.defKw?.has(norm)) defNext = true;
        if (spec.cmdTrack) expectCmd = SHELL_CMD_KW.has(norm);
      } else if (spec.constants.has(norm)) { push('constant', word); if (spec.cmdTrack) expectCmd = false; }
      else if (ALLCAPS.test(word)) { push('constant', word); if (spec.cmdTrack) expectCmd = false; }
      else if (line[i - 1] === '.') { push('property', word); if (spec.cmdTrack) expectCmd = false; }
      else if (defNext) { push('func', word); defNext = false; if (spec.cmdTrack) expectCmd = false; }
      // cmdTrack is approximate by design: case patterns (a|b) and ((x)) still
      // mis-fire the command slot — cosmetic only, never an error color.
      else if (spec.cmdTrack && expectCmd && after[0] !== '=') { push('func', word); expectCmd = false; }
      else if (/^\s*\(/.test(after)) { push('func', word); if (spec.cmdTrack) expectCmd = false; }
      else if (/^[A-Z]/.test(word)) { push('type', word); if (spec.cmdTrack) expectCmd = false; }
      else push('code', word);
      i += word.length;
      continue;
    }
    if (spec.yamlKeys && /^~(?=\s|#|$)/.test(rest)) push('constant', ch);
    else push('code', ch);
    i += 1;
  }
  flush();
  return spans;
}

/**
 * Paint spans with their theme tokens, clipped to `maxCells` exactly like
 * clipToWidth (ellipsis included, ANSI never counted). Tokenizing still runs
 * over the whole line so an off-screen `/*` keeps later lines scoped.
 */
function paintSpans(spans, theme, maxCells) {
  const paint = (scope, text) => (theme[PAINT[scope]] ?? theme.code)(text);
  if (maxCells == null) return spans.map(([s, t]) => paint(s, t)).join('');
  const total = spans.reduce((w, [, t]) => w + stringWidth(t), 0);
  if (total <= maxCells) return spans.map(([s, t]) => paint(s, t)).join('');
  const budget = maxCells - 1; // the '…' takes the last cell
  if (budget <= 0) return paint('code', '…'.slice(0, Math.max(0, maxCells)));
  let out = '', used = 0, run = '', runScope = null;
  outer:
  for (const [scope, text] of spans) {
    for (const ch of text) {
      const w = charWidth(ch.codePointAt(0));
      if (used + w > budget) break outer;
      if (scope !== runScope && run) { out += paint(runScope, run); run = ''; }
      runScope = scope;
      run += ch;
      used += w;
    }
  }
  if (run) out += paint(runScope, run);
  return out + paint('code', '…');
}

/**
 * @param {string} lang fence info string (```js)
 * @returns {null | (line: string, maxCells?: number) => string} per-line styler,
 *          or null when the language is unknown (caller keeps theme.code).
 */
export function createHighlighter(lang, theme) {
  const spec = FAMILIES[ALIASES.get(String(lang ?? '').toLowerCase())];
  if (!spec) return null;
  const st = { close: null, scope: null };
  return (line, maxCells) => paintSpans(scan(spec, line, st), theme, maxCells);
}

/**
 * Scan-only sibling of createHighlighter for callers that must separate
 * state advancement from painting: the diff renderer feeds EVERY line of a
 * file's patch through the scanner (block-comment/triple-string state must see
 * the rows the head+tail budget hides) but paints only the shown ones, and the
 * marker column is styled by diff semantics rather than the file's grammar.
 * @returns {null | (line: string) => [scope, text][]}
 */
export function createScanner(lang) {
  const spec = FAMILIES[ALIASES.get(String(lang ?? '').toLowerCase())];
  if (!spec) return null;
  const st = { close: null, scope: null };
  return (line) => scan(spec, line, st);
}

export { paintSpans };
