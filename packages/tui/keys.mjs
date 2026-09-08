// Minimal key decoder. A full terminfo parser is not warranted: we need the keys
// a prompt actually uses, and everything else must degrade to "ignore" rather
// than land as garbage in the input buffer.

const NAMED = new Map([
  ['\r', 'enter'], ['\n', 'enter'], ['\t', 'tab'],
  ['\x1b\r', 'newline'], ['\x1b\n', 'newline'],   // alt+enter: insert, do not submit
  ['\x7f', 'backspace'], ['\b', 'backspace'],
  ['\x03', 'ctrl-c'], ['\x04', 'ctrl-d'], ['\x0c', 'ctrl-l'], ['\x15', 'ctrl-u'],
  ['\x01', 'home'], ['\x05', 'end'], ['\x17', 'ctrl-w'],
  ['\x16', 'ctrl-v'], ['\x19', 'ctrl-y'], ['\x0f', 'ctrl-o'],
  ['\x1b', 'escape'],
  ['\x1b[A', 'up'], ['\x1b[B', 'down'], ['\x1b[C', 'right'], ['\x1b[D', 'left'],
  ['\x1bOA', 'up'], ['\x1bOB', 'down'], ['\x1bOC', 'right'], ['\x1bOD', 'left'],
  ['\x1b[H', 'home'], ['\x1b[F', 'end'], ['\x1b[1~', 'home'], ['\x1b[4~', 'end'],
  ['\x1b[3~', 'delete'],
]);

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** A terminal stream may split a paste or escape sequence at any byte. */
export function createKeyDecoder() {
  let pending = '';
  let pasting = false;
  return {
    push(chunk) {
      pending += String(chunk ?? '');
      const events = [];
      while (pending !== '') {
        if (pasting) {
          const end = pending.indexOf(PASTE_END);
          if (end === -1) break;
          events.push({ text: pending.slice(0, end).replace(/\r\n?/g, '\n') });
          pending = pending.slice(end + PASTE_END.length);
          pasting = false;
          continue;
        }
        if (pending.startsWith(PASTE_START)) {
          pending = pending.slice(PASTE_START.length);
          pasting = true;
          continue;
        }
        const ch = pending[0];
        if (ch === '\x1b') {
          if (pending.length === 1) break; // distinguish Escape from a split sequence
          if (pending[1] === '[' || pending[1] === 'O') {
            const end = pending.slice(2).search(/[@-~]/);
            if (end === -1) break;
            const sequence = pending.slice(0, end + 3);
            if (NAMED.has(sequence)) events.push({ name: NAMED.get(sequence) });
            pending = pending.slice(sequence.length); // unknown CSI/SS3 is ignored
            continue;
          }
          const alt = pending.slice(0, 2);
          if (NAMED.has(alt)) { events.push({ name: NAMED.get(alt) }); pending = pending.slice(2); }
          else { events.push({ name: 'escape' }); pending = pending.slice(1); }
          continue;
        }
        const code = pending.codePointAt(0);
        // setEncoding('utf8') already preserves code points; also support callers
        // feeding string fragments that end in a high surrogate.
        if (pending.length === 1 && code >= 0xD800 && code <= 0xDBFF) break;
        const point = String.fromCodePoint(code);
        if (NAMED.has(ch)) events.push({ name: NAMED.get(ch) });
        else if (code >= 0x20) events.push({ text: point });
        pending = pending.slice(point.length);
      }
      return events;
    },
    get waitingForEscape() { return !pasting && pending === '\x1b'; },
    flushEscape() {
      if (pasting || pending !== '\x1b') return [];
      pending = '';
      return [{ name: 'escape' }];
    },
  };
}

/** Decode a complete key string; stream consumers must retain createKeyDecoder(). */
export function decodeKeys(chunk) {
  const decoder = createKeyDecoder();
  return [...decoder.push(chunk), ...decoder.flushEscape()];
}

/**
 * Editable buffer with a cursor. The value may contain newlines: a prompt longer
 * than the terminal was previously CLIPPED, so you stopped seeing what you were
 * typing. Pure — every method returns a new state, and returns the SAME object
 * when nothing moved so no redraw is forced.
 */
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function adjacentBoundary(value, cursor, direction) {
  const part = segments.segment(value).containing(direction < 0 ? cursor - 1 : cursor);
  return direction < 0 ? part.index : part.index + part.segment.length;
}
const lineBounds = (value, cursor) => {
  const start = cursor === 0 ? 0 : value.lastIndexOf('\n', cursor - 1) + 1;
  const end = value.indexOf('\n', cursor);
  return { start, end: end === -1 ? value.length : end };
};
export function applyKey(state, event) {
  const { value, cursor } = state;
  if (event.text != null) {
    return { value: value.slice(0, cursor) + event.text + value.slice(cursor), cursor: cursor + event.text.length };
  }
  switch (event.name) {
    case 'backspace': {
      if (cursor === 0) return state;
      const previous = adjacentBoundary(value, cursor, -1);
      return { value: value.slice(0, previous) + value.slice(cursor), cursor: previous };
    }
    case 'delete':
      return cursor >= value.length ? state : { value: value.slice(0, cursor) + value.slice(adjacentBoundary(value, cursor, 1)), cursor };
    // Return the SAME object when nothing moved: index.mjs redraws on identity
    // change, so a new object for a no-op arrow key forced a full frame.
    case 'left': return cursor === 0 ? state : { value, cursor: adjacentBoundary(value, cursor, -1) };
    case 'right': return cursor === value.length ? state : { value, cursor: adjacentBoundary(value, cursor, 1) };
    // home/end act on the CURRENT line, which is what they mean in a multi-line box.
    case 'home': {
      const { start } = lineBounds(value, cursor);
      return cursor === start ? state : { value, cursor: start };
    }
    case 'end': {
      const { end } = lineBounds(value, cursor);
      return cursor === end ? state : { value, cursor: end };
    }
    case 'newline':
      return { value: value.slice(0, cursor) + '\n' + value.slice(cursor), cursor: cursor + 1 };
    case 'ctrl-u': {
      const { start } = lineBounds(value, cursor);
      return cursor === start ? state : { value: value.slice(0, start) + value.slice(cursor), cursor: start };
    }
    case 'ctrl-w': {
      const head = value.slice(0, cursor).replace(/\S+\s*$/u, '');
      return { value: head + value.slice(cursor), cursor: head.length };
    }
    default: return state;
  }
}
