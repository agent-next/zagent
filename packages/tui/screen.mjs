// Append-only screen writer.
//
// The transcript is written into normal scrollback exactly once and never
// rewritten; only a small live region at the bottom (the growing tail line of
// the entry still streaming, plus the footer) is erased and redrawn. That keeps
// redraw cost independent of transcript length and leaves scrollback intact.
//
// The eraser must move up exactly as many ROWS as the terminal used. Trusting the
// caller's array length made that a convention every producer had to uphold
// independently — and renderPermission already broke it: at width 40 a long tool
// name and a long option label rendered 75 and 54 cells, two rows each, while
// paint counted one. paint now measures the rows itself, so no producer can
// desync the eraser into committed scrollback.

import { renderEntry } from './render.mjs';
import { stringWidth } from './width.mjs';

/** theme.mjs only ever emits SGR, so this is the whole vocabulary to strip. */
const SGR = /\x1b\[[0-9;]*m/gu;

/** Terminal rows one logical line occupies once the terminal has wrapped it. */
export function rowsFor(line, width) {
  const plain = String(line ?? '').replace(SGR, '');
  return Math.max(1, Math.ceil(stringWidth(plain) / Math.max(1, width)));
}

/** An entry stops changing once its stream is done; tools settle at ok/error. */
export function isSettled(entry) {
  if (entry.kind === 'assistant' || entry.kind === 'thinking') return entry.done === true;
  if (entry.kind === 'tool') return entry.status === 'ok' || entry.status === 'error';
  return true;
}

/**
 * Everything that decides an entry's rendered form. An entry whose fingerprint is
 * unchanged since it was retired renders identically, so it can be skipped.
 * A re-opened assistantMessageId appends text to an already-done entry, which the
 * length terms catch — a plain "settled" flag would not.
 */
const fingerprint = (e) =>
  `${e.kind}|${e.done}|${e.status}|${(e.text ?? '').length}|${(e.resultText ?? '').length}|${e.durationMs}|${e.truncated}`;

/**
 * Split the transcript into lines to commit permanently and lines to keep live.
 * `printed` is carried on each entry so a re-entrant redraw never double-prints.
 *
 * Settled entries whose lines are all committed are RETIRED: re-rendering them
 * every frame made this O(transcript) on a path driven by every streaming token
 * and a 90 ms spinner (measured: 0.49 ms/frame at 120 entries, 6.13 ms at 3000 —
 * 7% of a core spent redrawing an idle screen).
 * @returns {{commit: string[], live: string[]}}
 */
export function composeFrame(state, theme, width, options = {}) {
  const commit = [];
  const live = [];
  // A width change re-wraps everything, so no retirement survives it.
  if (state.frameWidth !== width) {
    for (const entry of state.entries) entry.retired = undefined;
    state.frameWidth = width;
  }
  for (const [i, entry] of state.entries.entries()) {
    const fold = options.foldOf?.(entry, i);
    const fp = `${fingerprint(entry)}|${fold ?? ''}`;
    if (entry.retired !== undefined && entry.retired === fp) continue;
    const rendered = renderEntry(entry, theme, width, { ...options, fold });
    if (rendered.length === 0) continue;
    // The separator belongs to the entry APPEARING, not to its first stable line:
    // a streaming entry's opening line is live, so keying off committed lines
    // dropped the blank line entirely and glued entries together.
    if (entry.started !== true) {
      if (state.printedAny) commit.push('');
      entry.started = true;
      state.printedAny = true;
    }
    const settled = isSettled(entry);
    // The final line of an unsettled entry may still re-wrap, so it stays live.
    const stable = settled ? rendered : rendered.slice(0, -1);
    const printed = entry.printed ?? 0;
    if (stable.length > printed) {
      commit.push(...stable.slice(printed));
      entry.printed = stable.length;
    }
    if (!settled) live.push(rendered[rendered.length - 1]);
    // Collapse cannot un-print: if this render is shorter than what we already
    // committed, retire anyway so we do not re-render every frame.
    else if ((entry.printed ?? 0) >= rendered.length) entry.retired = fp;
  }
  return { commit, live };
}

export function createScreen(stdout, { columns = () => 80 } = {}) {
  let eraseHeight = 0;
  const write = (text) => { try { stdout.write(text); } catch { /* closed pipe: nothing to do */ } };

  return {
    get width() { return Math.max(20, columns() || 80); },
    /** Erase the live region, append `commit` to scrollback, redraw `live`. */
    paint(commit, live) {
      const width = Math.max(20, columns() || 80);
      let out = eraseHeight > 0 ? `\x1b[${eraseHeight}A\x1b[0J` : '';
      if (commit.length > 0) out += `${commit.join('\n')}\n`;
      out += live.length > 0 ? `${live.join('\n')}\n` : '';
      eraseHeight = live.reduce((rows, line) => rows + rowsFor(line, width), 0);
      write(out);
    },
    /** Drop the live region for good (used before exiting, so no chrome is left behind). */
    clearLive() {
      if (eraseHeight > 0) write(`\x1b[${eraseHeight}A\x1b[0J`);
      eraseHeight = 0;
    },
    writeRaw: write,
    get eraseHeight() { return eraseHeight; },
  };
}
