// Terminal-escape sanitisation for untrusted text.
//
// Everything the transcript renders is untrusted: model output, tool results (a
// file the agent read may be attacker-controlled), and pasted user input. Raw
// control bytes reaching the terminal are not cosmetic:
//
//   * ESC sequences can clear the screen, move the cursor, set the window title,
//     or repaint over the transcript — including forging a permission prompt.
//   * A stray CR, or a cursor move inside what the renderer counts as ONE line,
//     breaks the append-only screen arithmetic; the eraser then walks up into
//     committed scrollback and deletes it.
//
// So this runs at ingestion, before text enters the transcript, and the renderer
// applies its own styling to already-clean text.

/**
 * C0 (minus newline, handled separately), DEL, and C1 — U+009B is a one-byte CSI —
 * plus the Unicode BIDI overrides and the line/paragraph separators.
 *
 * The bidi controls are not cosmetic: U+202E reverses the visual order of the rest
 * of the line while leaving the bytes untouched and measuring zero cells, so no
 * clip or wrap removes it. A tool result reading an attacker-controlled file can
 * make the command a user READS differ from the command that RUNS — including in
 * the permission prompt they approve. That is Trojan Source, CVE-2021-42574.
 */
const CONTROL_SOURCE = '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F'
  // Bidi embeddings, overrides and isolates.
  + '\\u202A-\\u202E\\u2066-\\u2069\\u2028\\u2029'
  // Directional MARKS. Weaker than the overrides but they still reorder, and they
  // measure zero cells so no clip or wrap removes them.
  + '\\u200E\\u200F\\u061C'
  // Invisible format characters with no legitimate meaning in a terminal:
  // word joiner and the invisible math operators, the deprecated format block,
  // BOM/ZWNBSP, interlinear annotation, and the musical format controls.
  + '\\u2060-\\u2064\\u206A-\\u206F\\uFEFF\\uFFF9-\\uFFFB'
  + ']';

/**
 * Tag characters (U+E0000-E007F) are invisible and have no terminal use, but they
 * are astral so they cannot live in the class above. 128 of 128 were surviving.
 */
const ASTRAL_INVISIBLE_SOURCE = '[\\u{E0000}-\\u{E007F}\\u{1D173}-\\u{1D17A}]';

// DELIBERATELY KEPT, because stripping them would corrupt legitimate text:
//   U+200D ZWJ    — joins emoji sequences (family, profession, flag modifiers)
//   U+200C ZWNJ   — required in Persian, Arabic and Indic orthography
//   U+200B ZWSP   — a real line-break opportunity, asserted in test-sanitize.mjs

/**
 * @param {unknown} value
 * @param {{keepNewlines?: boolean}} [options] false collapses newlines to spaces,
 *   for text that must occupy exactly one line (queued input, one-line summaries).
 */
export function sanitizeText(value, options = {}) {
  const keepNewlines = options.keepNewlines !== false;
  let text = typeof value === 'string' ? value : String(value ?? '');
  // CR first: a bare CR returns the cursor to column 0 and overwrites the line
  // already drawn.
  text = text.replace(/\r\n?/gu, '\n');
  // Tabs expand: a raw tab advances by a terminal-defined amount, so every
  // column measurement downstream would be wrong.
  text = text.replace(/\t/gu, '  ');
  text = text.replace(new RegExp(CONTROL_SOURCE, 'gu'), '');
  text = text.replace(new RegExp(ASTRAL_INVISIBLE_SOURCE, 'gu'), '');
  if (!keepNewlines) text = text.replace(/\n/gu, ' ');
  return text;
}

/** True when the value carries anything that would reach the terminal as a control byte. */
export function hasControlBytes(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  // A fresh regex each call: a shared global regex carries lastIndex between
  // calls and would alternate true/false on identical input.
  return new RegExp(CONTROL_SOURCE, 'u').test(text)
    || new RegExp(ASTRAL_INVISIBLE_SOURCE, 'u').test(text)
    || /[\r\t]/u.test(text);
}
