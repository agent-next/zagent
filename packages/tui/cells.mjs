// Cell-grid model of the painted live region — groundwork for the spec's
// cell-diff repaint and DECSTBM rows (docs/TUI-CORE-SPEC.md, wave 5).
//
// paint() erases the whole live region and rewrites every line per frame.
// Repainting only changed rows needs to compare what each terminal ROW will
// contain, which the logical line array cannot express: the terminal wraps
// lines, a wide char straddles the wrap column (its tail cell is a
// continuation, not a blank), and SGR state carries across the '\n' joins
// between lines. This module replays the line stream the way the terminal
// would and records the result as cells: { t, s, cont } — the grapheme text
// ('' for a blank), the canonical SGR state in effect at that cell, and a
// continuation flag for a wide char's second cell.
//
// paint() consumes this: it keeps the painted live region as a grid and, on a
// commit-free same-width frame, rewrites only `changedRows` — CUU/CUD + CR +
// serializeRow + EL per row, '\n' for rows grown below the old region (so the
// screen bottom still scrolls), one `\x1b[0J` for a surplus tail.

import { charWidth } from './width.mjs';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** CSI sequence: params (digits/;/:) + a final byte. SGR ('m') is the only
 *  one rendered lines carry — theme.mjs emits nothing else — but the parser
 *  consumes the whole sequence so a stray CSI cannot corrupt the grid. */
const CSI = /\x1b\[([0-9;:]*)([@-~])/g;

/**
 * Canonical SGR state as a slot map: attribute class -> the raw params that
 * set it. Equality for the row diff is decided on the serialized map, so the
 * slots only need to be deterministic and reset-faithful — semantically
 * identical escape streams serialize identically even when written
 * differently (\x1b[1m\x1b[31m vs \x1b[1;31m).
 */
const SLOT = (code) => {
  if (code === 1) return 'b';
  if (code === 2) return 'faint';
  if (code === 3) return 'i';
  if (code === 4 || code === 21) return 'u'; // ECMA-48 21 = double underline
  if (code === 5 || code === 6) return 'blink';
  if (code === 7) return 'inv';
  if (code === 8) return 'hide';
  if (code === 9) return 'strike';
  if ((code >= 30 && code <= 37) || code === 38 || (code >= 90 && code <= 97)) return 'fg';
  if ((code >= 40 && code <= 47) || code === 48 || (code >= 100 && code <= 107)) return 'bg';
  if (code === 51 || code === 52) return 'frame';
  if (code === 53) return 'ol';
  if (code === 58) return 'ulc';
  return `x${code}`;
};
const SLOT_ORDER = ['b', 'faint', 'i', 'u', 'blink', 'inv', 'hide', 'strike', 'frame', 'ol', 'fg', 'bg', 'ulc'];

/** Apply one SGR param list to the slot map. Elements split on ';' only —
 *  colon-separated subparams (`4:3` curly underline, `38:2::r:g:b` colon
 *  truecolor) belong to their leading param, so the raw element is kept as
 *  the slot value. Empty elements are code 0 per spec (`\x1b[;31m` ≡
 *  `\x1b[0;31m`). Handles the consuming forms 38/48/58 ;5;n and ;2;r;g;b —
 *  a truncated spec swallows its numeric tail rather than reparse it as
 *  attributes — and the per-class resets (22-29, 39, 49, 54, 55, 59). */
function applySgr(state, params) {
  const els = params === '' ? [''] : params.split(';');
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const colon = el.indexOf(':');
    const code = (colon === -1 ? el : el.slice(0, colon)) === ''
      ? 0
      : parseInt(colon === -1 ? el : el.slice(0, colon), 10);
    if (Number.isNaN(code)) continue;
    if (code === 0) { state.clear(); continue; }
    if (code === 22) { state.delete('b'); state.delete('faint'); continue; }
    if (code === 23) { state.delete('i'); continue; }
    if (code === 24) { state.delete('u'); continue; }
    if (code === 25) { state.delete('blink'); continue; }
    if (code === 27) { state.delete('inv'); continue; }
    if (code === 28) { state.delete('hide'); continue; }
    if (code === 29) { state.delete('strike'); continue; }
    if (code === 39) { state.delete('fg'); continue; }
    if (code === 49) { state.delete('bg'); continue; }
    if (code === 54) { state.delete('frame'); continue; }
    if (code === 55) { state.delete('ol'); continue; }
    if (code === 59) { state.delete('ulc'); continue; }
    let value = el;
    if (code === 4 && colon !== -1) {
      const sub = el.slice(colon + 1);
      if (sub === '0') { state.delete('u'); continue; }
      value = sub === '1' ? '4' : el; // 4:1 is plain underline; the rest keep their subparam
    }
    if ((code === 38 || code === 48 || code === 58) && colon === -1) {
      const mode = els[i + 1];
      if (mode === '5' && /^\d+$/.test(els[i + 2] ?? '')) {
        value = [el, '5', els[i + 2]].join(';'); i += 2;
      } else if (mode === '2' && [1, 2, 3].every((k) => /^\d+$/.test(els[i + 1 + k] ?? ''))) {
        value = [el, '2', els[i + 2], els[i + 3], els[i + 4]].join(';'); i += 4;
      } else if (mode === '5' || mode === '2') {
        let j = i + 1;
        while (/^\d+$/.test(els[j + 1] ?? '')) j++;
        i = j; // truncated spec: the numeric tail is color args, not attributes
      }
    }
    state.set(SLOT(code), value);
  }
}

/** Canonical serialization of a slot map — '' means default rendition. */
const sgrOf = (state) => {
  const parts = [];
  for (const slot of SLOT_ORDER) if (state.has(slot)) parts.push(state.get(slot));
  const extras = [...state.keys()].filter((k) => k.startsWith('x')).sort();
  for (const k of extras) parts.push(state.get(k));
  return parts.join(';');
};

const BLANK = (s) => ({ t: '', s, cont: false });

/**
 * Replay `lines` onto a `width`-column terminal grid. Returns Cell[][] —
 * one array per terminal row, exactly `width` cells each. SGR state persists
 * across the implicit '\n' between lines, matching what the terminal does
 * with the paint stream; a char that exactly fills the last column leaves the
 * wrap deferred, so the '\n' — not the fill — starts the next row.
 */
export function gridFromLines(lines, width, lineRows) {
  const w = Math.max(1, width | 0);
  const rows = [];
  let row = [];
  let col = 0;
  let pending = false; // deferred wrap: cursor full but not yet on the next row
  const state = new Map();
  const newline = () => {
    // Cells past the written text are modeled as default blanks: on a repaint
    // they are what an EL under default rendition leaves behind.
    for (let i = col; i < w; i++) row[i] = BLANK('');
    rows.push(row);
    row = [];
    col = 0;
  };
  const put = (text, cw) => {
    if (pending || col + cw > w) { newline(); pending = false; }
    row[col] = { t: text, s: sgrOf(state), cont: false };
    for (let i = 1; i < cw; i++) row[col + i] = { t: '', s: sgrOf(state), cont: true };
    col += cw;
    if (col >= w) pending = true;
  };
  const putGrapheme = (g) => {
    if (g === '\n') { pending = false; newline(); return; }
    const cp = g.codePointAt(0);
    if (cp < 0x20 || cp === 0x7f) {
      if (g === '\t') {
        // A tab resolves a deferred wrap, then advances whole cells — but
        // clamps short of the margin and does NOT arm the wrap itself: the
        // next printable paints into the last cell, then defers.
        if (pending) { newline(); pending = false; }
        const stop = Math.min(w - 1, (Math.floor(col / 8) + 1) * 8);
        while (col < stop) { row[col] = BLANK(sgrOf(state)); col += 1; }
      }
      return; // other C0/DEL carry no cell and do not resolve the wrap
    }
    const cps = [...g].map((c) => c.codePointAt(0));
    // Cluster width = cells the terminal uses, not a code-point sum: an RI
    // pair is one flag (2 cells), a keycap sequence one glyph (2), a ZWJ
    // emoji the widest member (2). A cluster of only zero-width points
    // advances nothing — it folds into the last written cell's text.
    const isRI = (c) => c >= 0x1f1e6 && c <= 0x1f1ff;
    let cw = cps.filter(isRI).length >= 2 || cps.includes(0x20e3) ? 2
      : cps.reduce((n, c) => Math.max(n, charWidth(c)), 0);
    if (cw === 0) {
      let k = (pending ? w : col) - 1;
      while (k >= 0 && row[k].cont) k -= 1;
      if (k >= 0) row[k].t += g;
      return;
    }
    put(g, Math.min(cw, w));
  };
  for (const line of lines) {
    // Optional out-map: the grid row each logical line starts on — the diff
    // repaint's cursor park needs rows, and `live` is indexed by line.
    if (lineRows) lineRows.push(rows.length);
    const text = String(line ?? '');
    let pos = 0;
    CSI.lastIndex = 0;
    let m;
    while ((m = CSI.exec(text)) !== null) {
      for (const { segment } of graphemes.segment(text.slice(pos, m.index))) putGrapheme(segment);
      if (m[2] === 'm') applySgr(state, m[1]);
      pos = m.index + m[0].length;
    }
    for (const { segment } of graphemes.segment(text.slice(pos))) putGrapheme(segment);
    // The '\n' joining lines: CR+LF — the row ends whether or not the last
    // cell filled it (a pending wrap does not add a blank row).
    pending = false;
    newline();
  }
  return rows;
}

/** Two rows are interchangeable iff every cell matches — text, SGR, and the
 *  continuation flag (a blank differs from a wide char's tail). */
export const rowsEqual = (a, b) =>
  a.length === b.length && a.every((c, i) => c.t === b[i].t && c.s === b[i].s && c.cont === b[i].cont);

/** Indices of rows that differ between two grids (missing side = changed). */
export function changedRows(prev, next) {
  const out = [];
  const n = Math.max(prev.length, next.length);
  for (let i = 0; i < n; i++) {
    if (i >= prev.length || i >= next.length || !rowsEqual(prev[i], next[i])) out.push(i);
  }
  return out;
}

/**
 * Serialize a row for repaint-in-place: SGR changes emitted inline, blanks as
 * spaces, continuation cells skipped (their head carries the grapheme).
 * `trim` (default) stops after the last non-blank cell — the caller erases to
 * end-of-line with EL. A trailing reset is emitted when the row ends in a
 * non-default state so the repaint cannot bleed attributes past its end.
 */
export function serializeRow(cells, { trim = true } = {}) {
  let end = cells.length;
  // Trailing default blanks are the caller's EL territory; a styled blank is
  // real painted content (a bg-colored space) and is kept.
  if (trim) while (end > 0 && cells[end - 1].t === '' && cells[end - 1].s === '' && !cells[end - 1].cont) end -= 1;
  let out = '';
  let cur = '';
  for (let i = 0; i < end; i++) {
    const c = cells[i];
    if (c.s !== cur) {
      // Rebuild from reset: the new state may drop attributes the old one
      // carried, and plain `\x1b[<s>m` only ever adds.
      out += c.s === '' ? '\x1b[0m' : `\x1b[0;${c.s}m`;
      cur = c.s;
    }
    if (!c.cont) out += c.t === '' ? ' ' : c.t;
  }
  if (cur !== '') out += '\x1b[0m';
  return out;
}
