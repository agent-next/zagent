// A large paste must not flood the composer: codex and opencode collapse it to
// a `[Pasted ~N lines]` chip in the input box and expand it only on submit.
// The chip lives IN the buffer as a literal token plus a side table — cursor
// math, width and history recall keep working on the token, while the runtime
// always receives the full pasted text.
//
// Chips are bound to the text that carries them: enqueue moves a message's
// chips onto the queue/history entry so a later keystroke cannot prune a queued
// payload away, and among same-token chips the k-th chip belongs to the k-th
// buffer occurrence, left to right.

const CHIP_MIN_CHARS = 150;  // opencode's threshold; codex chips at 1000
const CHIP_MIN_LINES = 3;

const CHIP_RE = /\[Pasted ~\d+ (?:lines|chars)\]/g;

/** The buffer token for a pasted payload, or null when the paste is small
 * enough to show inline. Bracketed paste arrives as ONE text event, so a long
 * or multi-line event is a paste — typed text never reaches this size. */
export function pasteToken(text) {
  const lines = text.split('\n').length;
  if (text.length <= CHIP_MIN_CHARS && lines < CHIP_MIN_LINES) return null;
  return lines > 1 ? `[Pasted ~${lines} lines]` : `[Pasted ~${text.length} chars]`;
}

/** Rebuild the payload for the runtime: every chip token expands to its stored
 * text, matched left-to-right so two chips with the same token still resolve
 * in order. A token with no chip behind it (the user typed it) stays literal.
 * A typed literal next to a same-token chip can still cross-bind — the
 * left-to-right assignment cannot tell them apart — but nobody types
 * `[Pasted ~N lines]` by hand next to a live chip. */
export function expandChips(chips, value) {
  if (!chips || chips.length === 0) return value;
  const queues = new Map();
  for (const chip of chips) {
    const queue = queues.get(chip.token) ?? [];
    if (queue.length === 0) queues.set(chip.token, queue);
    queue.push(chip.text);
  }
  return value.replace(CHIP_RE, (m) => (queues.get(m)?.length ? queues.get(m).shift() : m));
}

const starts = (value, token) => {
  const out = [];
  for (let at = value.indexOf(token); at !== -1; at = value.indexOf(token, at + 1)) out.push(at);
  return out;
};

const chipIndexAt = (chips, token, ordinal) => {
  let seen = -1;
  for (let i = 0; i < chips.length; i++) {
    if (chips[i].token === token && ++seen === ordinal) return i;
  }
  return -1;
};

/** Record a chip for the token occurrence beginning at spanStart in value, so
 * its ordinal among same-token chips matches its position in the buffer. */
export function insertChip(chips, value, spanStart, token, text) {
  const ordinal = starts(value, token).filter(at => at < spanStart).length;
  const at = chipIndexAt(chips, token, ordinal);
  chips.splice(at === -1 ? chips.length : at, 0, { token, text });
}

/** The chip span strictly containing a cursor position — a mid-chip insert
 * point would split the token into a broken literal that ships verbatim. */
export function chipSpanAt(chips, value, cursor) {
  for (const token of new Set(chips.map(c => c.token))) {
    for (const [ordinal, at] of starts(value, token).entries()) {
      if (at < cursor && cursor < at + token.length) {
        const index = chipIndexAt(chips, token, ordinal);
        return { start: at, end: at + token.length, index: index === -1 ? chips.findIndex(c => c.token === token) : index };
      }
    }
  }
  return null;
}

/** The chip an edit range [start, end) touches — the whole token is removed in
 * one shot rather than edited into a broken literal that would ship verbatim. */
export function chipSpanIn(chips, value, start, end) {
  for (const token of new Set(chips.map(c => c.token))) {
    for (const [ordinal, at] of starts(value, token).entries()) {
      const occEnd = at + token.length;
      if (at < end && occEnd > start) {
        const index = chipIndexAt(chips, token, ordinal);
        return { start: at, end: occEnd, index: index === -1 ? chips.findIndex(c => c.token === token) : index };
      }
    }
  }
  return null;
}

/** Move the chips a leaving message owns out of the buffer table and return
 * them (in buffer order) for the queue/history entry to carry. */
export function takeChips(chips, value) {
  const need = new Map();
  for (const m of value.matchAll(CHIP_RE)) need.set(m[0], (need.get(m[0]) ?? 0) + 1);
  if (need.size === 0) return [];
  const taken = [];
  const keep = [];
  for (const chip of chips) {
    const n = need.get(chip.token) ?? 0;
    if (n > 0) { need.set(chip.token, n - 1); taken.push(chip); } else keep.push(chip);
  }
  chips.length = 0;
  chips.push(...keep);
  return taken;
}

/** Re-attach a recalled message's chips to a buffer holding its compact text. */
export function attachChips(chips, value, list) {
  const seen = new Map();
  for (const chip of list ?? []) {
    const k = seen.get(chip.token) ?? 0;
    seen.set(chip.token, k + 1);
    const at = starts(value, chip.token)[k];
    if (at !== undefined) insertChip(chips, value, at, chip.token, chip.text);
  }
}

/** Drop chips whose token is gone from the buffer (partial edits, ctrl+u).
 * Occurrence-counted so duplicate tokens keep the right many. */
export function pruneChips(chips, value) {
  const left = new Map();
  return chips.filter((chip) => {
    if (!left.has(chip.token)) left.set(chip.token, value.split(chip.token).length - 1);
    const n = left.get(chip.token);
    left.set(chip.token, n - 1);
    return n > 0;
  });
}
