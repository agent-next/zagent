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

/**
 * Decode one chunk into key events. Bracketed-paste content arrives as a single
 * large chunk; it must be inserted verbatim, never interpreted as keystrokes.
 * @returns {Array<{name?: string, text?: string}>}
 */
export function decodeKeys(chunk) {
  const input = String(chunk ?? '');
  if (input === '') return [];

  // Bracketed paste: ESC[200~ ... ESC[201~
  const paste = /\x1b\[200~([\s\S]*?)\x1b\[201~/g;
  if (paste.test(input)) {
    const events = [];
    let last = 0;
    paste.lastIndex = 0;
    for (let m; (m = paste.exec(input)); ) {
      if (m.index > last) events.push(...decodeKeys(input.slice(last, m.index)));
      events.push({ text: m[1].replace(/\r\n?/g, '\n') });
      last = m.index + m[0].length;
    }
    if (last < input.length) events.push(...decodeKeys(input.slice(last)));
    return events;
  }

  const events = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\x1b') {
      // Longest-match a known sequence; otherwise swallow the whole CSI so a
      // mouse report or unknown key cannot leak escape bytes into the buffer.
      let matched = null;
      for (let len = Math.min(6, input.length - i); len >= 2; len--) {
        const candidate = input.slice(i, i + len);
        if (NAMED.has(candidate)) { matched = { name: NAMED.get(candidate), len }; break; }
      }
      if (matched) { events.push({ name: matched.name }); i += matched.len; continue; }
      if (input[i + 1] === '[' || input[i + 1] === 'O') {
        let j = i + 2;
        while (j < input.length && !/[A-Za-z~]/.test(input[j])) j++;
        i = j + 1;
        continue;
      }
      events.push({ name: 'escape' }); i += 1; continue;
    }
    if (NAMED.has(ch)) { events.push({ name: NAMED.get(ch) }); i += 1; continue; }
    // Control characters other than the ones we name are dropped, not typed.
    // Read the codepoint from the STRING, not from ch: ch is a single UTF-16 unit,
    // so an emoji would otherwise be emitted as two broken surrogate halves.
    const code = input.codePointAt(i);
    if (code < 0x20) { i += 1; continue; }
    const point = String.fromCodePoint(code);
    events.push({ text: point });
    i += point.length;
  }
  return events;
}

/**
 * Editable buffer with a cursor. The value may contain newlines: a prompt longer
 * than the terminal was previously CLIPPED, so you stopped seeing what you were
 * typing. Pure — every method returns a new state, and returns the SAME object
 * when nothing moved so no redraw is forced.
 */
const lineBounds = (value, cursor) => {
  const start = value.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
  const end = value.indexOf('\n', cursor);
  return { start, end: end === -1 ? value.length : end };
};
export function applyKey(state, event) {
  const { value, cursor } = state;
  if (event.text != null) {
    return { value: value.slice(0, cursor) + event.text + value.slice(cursor), cursor: cursor + event.text.length };
  }
  switch (event.name) {
    case 'backspace':
      return cursor === 0 ? state : { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
    case 'delete':
      return cursor >= value.length ? state : { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor };
    // Return the SAME object when nothing moved: index.mjs redraws on identity
    // change, so a new object for a no-op arrow key forced a full frame.
    case 'left': return cursor === 0 ? state : { value, cursor: cursor - 1 };
    case 'right': return cursor === value.length ? state : { value, cursor: cursor + 1 };
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
