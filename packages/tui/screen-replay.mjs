// Replay the erase-and-redraw stream into what a terminal actually shows.
//
// This is the only honest oracle for an append-only TUI: the raw byte stream
// contains lines that were later erased, so grepping it reports text no human ever
// saw — and misses text that is on screen. Three rendering defects were missed by
// reading the raw capture and found immediately by replaying it: duplicated
// messages, the session-title side query rendered as an answer, and tool-argument
// JSON appended to prose.
//
// The model is a sparse grid, not a line stack: the writer now PARKS the hardware
// cursor inside the live region (the input box), so a cursor-up no longer starts
// from the bottom of the region — pop-n-lines replay erased the wrong rows and
// reported ghost lines nobody saw. Rows and columns are tracked in cells;
// characters wider than one cell and writes past the last column wrap like a
// real terminal.
//
// Extracted from scripts/tui-smoke.mjs so the hermetic journey harness and the
// live smoke assert against the same screen.
import { charWidth, stringWidth } from './width.mjs';

// The first `cells` terminal cells of a line: overwrite positions are column
// addresses, not string indices.
const takeCells = (text, cells) => {
  let out = '', w = 0;
  for (const ch of String(text ?? '')) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > cells) break;
    out += ch;
    w += cw;
  }
  return out;
};
// Everything after the first `cells` cells — the surviving tail of a line a
// mid-line write overwrites into.
const dropCells = (text, cells) => {
  const s = String(text ?? '');
  let w = 0, i = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > cells) break;
    w += cw;
    i += ch.length;
  }
  return s.slice(i);
};

export function replayScreen(raw, columns = 120) {
  const width = Math.max(20, columns || 120);
  const lines = [''];
  let row = 0, col = 0;
  // Deferred wrap: a write that fills the last column leaves the cursor on
  // that cell with the wrap armed — the next printable wraps, and an EL0/ED0
  // erases from that cell INCLUSIVE (a payload-then-\x1b[K stream loses the
  // last glyph on a real terminal; without this flag the replay reported it
  // intact and the class shipped un-pinned).
  let wrapPending = false;
  const put = (ch) => {
    const cw = charWidth(ch.codePointAt(0));
    if (wrapPending && cw > 0) { row += 1; col = 0; wrapPending = false; }
    if (cw > 0 && col + cw > width) { row += 1; col = 0; }
    if (row >= lines.length) lines.push('');
    lines[row] = takeCells(lines[row], col) + ch + dropCells(lines[row], col + cw);
    col += cw;
    if (col >= width) { col = width; wrapPending = true; }
  };
  let i = 0;
  while (i < raw.length) {
    const move = /^\x1b\[(\d*)([A-Za-z])/.exec(raw.slice(i, i + 8));
    if (move) {
      const n = Number(move[1] || 1);
      if (move[2] === 'A') { row = Math.max(0, row - n); wrapPending = false; }
      else if (move[2] === 'B') { row += n; wrapPending = false; }
      else if (move[2] === 'C') { col += n; wrapPending = false; }
      else if (move[2] === 'D') { col = Math.max(0, col - n); wrapPending = false; }
      else if (move[2] === 'G') { col = Math.max(0, n - 1); wrapPending = false; }
      else if (move[2] === 'H') { row = 0; col = 0; wrapPending = false; }
      else if (move[2] === 'J' || move[2] === 'K') {
        // The pending-wrap cell is the cursor's inclusive erase start.
        const at = wrapPending ? col - 1 : col;
        if (row < lines.length) {
          lines[row] = takeCells(lines[row], at);
          if (move[2] === 'J') lines.length = row + 1;
        }
        col = at;   // the erased cell is writable again, wrap disarmed
        wrapPending = false;
      }
      // Non-movement finals (SGR 'm', private modes) leave the wrap armed.
      i += move[0].length;
      continue;
    }
    // Full CSI grammar: params 0x30-0x3f (the kitty push/pop use > and <),
    // intermediates 0x20-0x2f, final 0x40-0x7e — plus OSC terminated by BEL.
    const other = /^\x1b\[[0-?]*[ -/]*[@-~]|^\x1b\][^\x07]*\x07/.exec(raw.slice(i, i + 64));
    if (other) { i += other[0].length; continue; }
    const ch = raw[i];
    if (ch === '\n') { row += 1; col = 0; wrapPending = false; if (row >= lines.length) lines.push(''); }
    else if (ch === '\r') { col = 0; wrapPending = false; }
    else put(ch);
    i += 1;
  }
  return lines.join('\n').replace(/\s+$/, '');
}

// Bounded terminal model — the oracle for the DECSTBM scroll-region writer.
//
// replayScreen's unbounded line stack cannot express the pinned live-region
// scheme (docs/TUI-CORE-SPEC.md wave 5): commits are written INSIDE a DECSTBM
// scroll region where a '\n' at the region's last row scrolls only that
// region — its top line leaves into scrollback — instead of walking the
// cursor down, and the live region below is repainted by absolute CUP, never
// erased. This model runs a fixed rows×columns screen plus a scrollback
// buffer, the same way xterm/VTE/iTerm2/kitty/WT do:
//
//   - '\n' (and an auto-wrap resolving past the margin) at the region's last
//     row scrolls rows [top..bottom] up; below the region it moves the cursor
//     down to the screen edge and then does nothing — scrolling only ever
//     happens inside the margins while the cursor is in them.
//   - ESC M (reverse index) at the region's first row scrolls the region
//     DOWN: a blank enters at the top and the bottom line is dropped (it does
//     NOT reach scrollback — scrollback only ever grows from the top edge).
//   - CUU/CUD clamp at the margin they approach from inside the region.
//   - DECSTBM (CSI t;b r) validates t<b, homes the cursor to absolute 1;1
//     (DECOM stays reset — the writer emits `\x1b[?6l`), and a bare `\x1b[r`
//     restores the full screen.
//   - ED/EL erase within the margins' rules like everywhere else; `\x1b[2J`
//     clears the whole screen but leaves the margins and scrollback alone,
//     while `\x1b[3J` clears scrollback and leaves the screen.
//
// Not modeled (the pinned writer never emits them): IL/DL/ICH/DCH/ECH/REP,
// VPR/HPR, DECSC/DECRC, RIS, alt-screen `?1049`, DECOM `?6` beyond the reset
// the writer sends, and colon-subparameter DECSTBM (a leading integer is
// taken). Sparse rows carry no leading blanks — a write at column N on a
// shorter row pads with spaces.
//
// Returns { screen, scrollback, cursor } — rows are strings, untrimmed, so an
// oracle can assert exactly where a line landed; cursor is 0-based {row,col}.
export function replayTerminal(raw, { columns = 120, rows = 24 } = {}) {
  const width = Math.max(20, columns || 120);
  const height = Math.max(8, rows || 24);
  const screen = Array.from({ length: height }, () => '');
  const scrollback = [];
  let row = 0, col = 0, wrapPending = false;
  let mTop = 0, mBot = height - 1; // scroll region, inclusive row indices

  // One scroll-up inside the region: top line to scrollback, blank at bottom.
  const scrollUp = (n) => {
    for (let k = 0; k < n; k++) {
      // A real terminal only adds lines to scrollback when they leave the
      // top of the screen (mTop === 0); this model retires any region-top
      // line to scrollback so the transcript scroll history stays readable.
      scrollback.push(screen[mTop]);
      for (let r = mTop; r < mBot; r++) screen[r] = screen[r + 1];
      screen[mBot] = '';
    }
  };
  // One scroll-down inside the region: blank at top, bottom line dropped.
  const scrollDown = (n) => {
    for (let k = 0; k < n; k++) {
      for (let r = mBot; r > mTop; r--) screen[r] = screen[r - 1];
      screen[mTop] = '';
    }
  };
  // Vertical feed (NL or a resolving wrap): scrolls only at the region's own
  // bottom edge; outside the region it walks down and clamps at the screen's.
  const feed = () => {
    if (row === mBot) scrollUp(1);
    else if (row < height - 1) row += 1;
  };
  const put = (ch) => {
    const cw = charWidth(ch.codePointAt(0));
    if (cw === 0) {
      const cp = ch.codePointAt(0);
      // C0/DEL carry no cell; a zero-width mark folds into the cell it lands on.
      if (cp >= 0x20 && cp !== 0x7f)
        screen[row] = takeCells(screen[row], col) + ch + dropCells(screen[row], col);
      return;
    }
    if (wrapPending) { feed(); col = 0; wrapPending = false; }
    if (col + cw > width) { feed(); col = 0; }
    const head = takeCells(screen[row], col);
    screen[row] = head + ' '.repeat(Math.max(0, col - stringWidth(head)))
      + ch + dropCells(screen[row], col + cw);
    col += cw;
    if (col >= width) { col = width; wrapPending = true; }
  };

  let i = 0;
  while (i < raw.length) {
    // Full CSI grammar: params 0x30-0x3f (digits, ;, :, ?), intermediates
    // 0x20-0x2f, final 0x40-0x7e — then private/OSC escapes.
    const csi = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(raw.slice(i, i + 256));
    if (csi) {
      const params = csi[1].split(';').map((p) => (p === '' ? 0 : parseInt(p, 10)));
      const n = params[0] || 1;
      const f = csi[3];
      // Private param leaders (? > < =) never reach the standard handlers.
      if (csi[2] === '' && !/^[?<>=]/.test(csi[1])) {
        if (f === 'A') { row = Math.max(row >= mTop && row <= mBot ? mTop : 0, row - n); wrapPending = false; }
        else if (f === 'B') { row = Math.min(row >= mTop && row <= mBot ? mBot : height - 1, row + n); wrapPending = false; }
        else if (f === 'C') { col = Math.min(width - 1, col + n); wrapPending = false; }
        else if (f === 'D') { col = Math.max(0, col - n); wrapPending = false; }
        else if (f === 'G' || f === '`') { col = Math.max(0, Math.min(width - 1, n - 1)); wrapPending = false; }
        else if (f === 'H' || f === 'f') {
          row = Math.max(0, Math.min(height - 1, n - 1));
          col = Math.max(0, Math.min(width - 1, (params[1] || 1) - 1));
          wrapPending = false;
        } else if (f === 'd') { row = Math.max(0, Math.min(height - 1, n - 1)); wrapPending = false; }
        else if (f === 'J' || f === 'K') {
          const at = wrapPending ? col - 1 : col;
          const mode = params[0] || 0;
          if (f === 'K') {
            if (mode === 0) screen[row] = takeCells(screen[row], at);
            else if (mode === 1) screen[row] = ' '.repeat(at + 1) + dropCells(screen[row], at + 1);
            else screen[row] = '';
          } else {
            if (mode === 0) { screen[row] = takeCells(screen[row], at); for (let r = row + 1; r < height; r++) screen[r] = ''; }
            else if (mode === 1) { for (let r = 0; r < row; r++) screen[r] = ''; screen[row] = ' '.repeat(at + 1) + dropCells(screen[row], at + 1); }
            else if (mode === 3) scrollback.length = 0;
            else for (let r = 0; r < height; r++) screen[r] = '';
          }
          col = at;
          wrapPending = false;
        } else if (f === 'r') {
          // DECSTBM: margins are 1-based inclusive; a bare `\x1b[r` restores
          // the full screen and every valid set homes the cursor (DECOM off).
          // xterm clamps an overlarge bottom to the screen edge rather than
          // rejecting the sequence.
          const top = (params[0] || 1) - 1;
          const bot = Math.min((params[1] || height) - 1, height - 1);
          if (bot > top && top >= 0) {
            mTop = top; mBot = bot;
            row = 0; col = 0; wrapPending = false;
          }
        } else if (f === 'S') scrollUp(n);       // SU: region scrolls regardless of cursor
        else if (f === 'T') scrollDown(n);       // SD
        // SGR 'm' and unhandled finals leave the wrap armed.
      }
      i += csi[0].length;
      continue;
    }
    const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(raw.slice(i, i + 256));
    if (osc) { i += osc[0].length; continue; }
    const dcs = /^\x1bP(?:[^\x1b]|\x1b[^\\])*\x1b\\/.exec(raw.slice(i, i + 512));
    if (dcs) { i += dcs[0].length; continue; }
    const esc = /^\x1b([@-~])/.exec(raw.slice(i, i + 4));
    if (esc) {
      // ESC M = reverse index: at the region top scroll it down, else move up.
      if (esc[1] === 'M') { if (row === mTop) scrollDown(1); else row = Math.max(0, row - 1); wrapPending = false; }
      else if (esc[1] === 'D') { feed(); wrapPending = false; }         // IND
      else if (esc[1] === 'E') { feed(); col = 0; wrapPending = false; } // NEL
      i += esc[0].length;
      continue;
    }
    const ch = raw[i];
    if (ch === '\n') { feed(); col = 0; wrapPending = false; }
    else if (ch === '\r') { col = 0; wrapPending = false; }
    else if (ch === '\x0b' || ch === '\x0c') { feed(); wrapPending = false; }
    else if (ch === '\t') {
      if (wrapPending) { feed(); col = 0; wrapPending = false; }
      col = Math.min(width - 1, (Math.floor(col / 8) + 1) * 8);
    }
    else put(ch);
    i += 1;
  }
  return { screen, scrollback, cursor: { row, col } };
}
