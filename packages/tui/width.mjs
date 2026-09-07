// Terminal cell width.
//
// Code-point count is not column count. CJK and emoji occupy two cells, and
// combining marks occupy none. Counting them as one made the input box and the
// status line exceed the terminal width and wrap, which turns the footer into 4+
// rows while screen.mjs still erases 4 — so the eraser walked up into committed
// transcript and deleted the user's scrollback. Typing Chinese was enough to
// trigger it. (Found by an independent review, confirmed by measurement:
// 34 CJK chars in a width-40 box produced a 74-column line.)
//
// Ranges are the East Asian Wide/Fullwidth blocks plus the emoji-presentation
// symbols that are Wide in practice. Sorted, so lookup is a binary search.

const WIDE = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0],
  [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653],
  [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab],
  [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4],
  [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757],
  [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4], [0x17000, 0x18d08], [0x1b000, 0x1b16f],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c], [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

/** Combining marks and format characters that advance the cursor by nothing. */
const ZERO = [
  // Sorted: charWidth binary-searches these, so an out-of-order entry is simply
  // never found. Invisible format characters measured 1 cell while rendering as
  // 0 — the width-desync class this module exists to prevent.
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x061c, 0x061c],
  [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x0e31, 0x0e31], [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x206a, 0x206f],
  [0x20d0, 0x20f0], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff], [0xfff9, 0xfffb],
  [0x1d173, 0x1d17a], [0xe0000, 0xe007f], [0xe0100, 0xe01ef]
];

function inRanges(code, ranges) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (code < ranges[mid][0]) hi = mid - 1;
    else if (code > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Columns one code point occupies: 0, 1, or 2. */
export function charWidth(code) {
  if (code < 0x0300) return code < 0x20 || code === 0x7f ? 0 : 1;
  if (inRanges(code, ZERO)) return 0;
  return inRanges(code, WIDE) ? 2 : 1;
}

/** Columns a string occupies. ANSI is not expected here — call it on plain text. */
export function stringWidth(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0));
  return width;
}

/** Truncate to at most `columns` cells, appending `ellipsis` when it had to cut. */
export function clipToWidth(value, columns, ellipsis = '…') {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (columns <= 0) return '';
  if (stringWidth(text) <= columns) return text;
  const budget = columns - stringWidth(ellipsis);
  if (budget <= 0) return ellipsis.slice(0, columns);
  let out = '';
  let width = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0));
    if (width + w > budget) break;
    out += ch;
    width += w;
  }
  return out + ellipsis;
}

/** Right-pad to exactly `columns` cells (no-op when already wider). */
export function padToWidth(value, columns) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text + ' '.repeat(Math.max(0, columns - stringWidth(text)));
}
