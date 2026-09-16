// Paste-burst suppression: on terminals that do NOT send bracketed-paste
// markers, a paste arrives as a flood of single-char input — including CR/LF,
// which the key decoder reports as 'enter' and would submit line-by-line.
// Codex's PasteBurst heuristic (8 ms / 3 chars / 60 ms, see
// docs/TUI-CORE-SPEC.md wave 4): characters arriving <8 ms apart, three in a
// row, are a paste in progress, so they are buffered and inserted as ONE text
// event when the flood goes quiet — which is also what lets an unbracketed
// paste reach the paste-chip threshold.
//
// Enter inside a flood never submits mid-paste: it joins the buffer as a
// newline. An Enter that is the flood's LAST byte is deferred to the flush and
// then honoured — but only for a single-line payload; a multi-line paste
// always lands in the composer for review (the codex contract), never
// auto-submits. "type fast and hit Enter" and "paste 'cmd\n'" therefore still
// work, while "line1\nline2\n" can no longer fire off 'line1' on its own.

const DEFAULTS = { charMs: 8, flushMs: 60, minChars: 3 };
const isChar = (e) => typeof e.text === 'string' && e.text.length <= 2; // one code point; bracketed paste is one large event

export function createPasteBurst(options = {}) {
  const { charMs, flushMs, minChars } = { ...DEFAULTS, ...options };
  const now = options.now ?? (() => Date.now());

  let run = 0;               // consecutive single-char events <charMs apart
  let recent = [];           // this run's texts, capped at minChars (retro-capture source)
  let lastCharAt = -Infinity;
  let lastWasChar = false;   // the previous event was a single char (hot-enter test)
  let buffer = null;         // non-null while a burst is being collected
  let tailEnter = false;     // the flood's last event was Enter
  let swallowedCR = false;   // the flood's last byte was CR — a following LF is the same break

  return {
    flushMs,
    get active() { return buffer !== null; },
    /**
     * @returns {{kind:'pass'} | {kind:'capture', prefix:string} |
     *           {kind:'swallow'} | {kind:'flush-then', event:object}}
     */
    onEvent(event) {
      const t = now();
      if (buffer !== null) {
        if (typeof event.text === 'string' && isChar(event)) {
          buffer += event.text; tailEnter = false; swallowedCR = false; lastCharAt = t; return { kind: 'swallow' };
        }
        if (event.name === 'enter' || event.name === 'newline') {
          // The decoder reports '\r' and '\n' both as 'enter'; a pasted CRLF
          // is ONE line break, so an LF trailing a swallowed CR joins silently.
          if (swallowedCR && event.raw === '\n') { lastCharAt = t; return { kind: 'swallow' }; }
          swallowedCR = event.raw === '\r';
          buffer += '\n'; tailEnter = event.name === 'enter'; lastCharAt = t; return { kind: 'swallow' };
        }
        if (event.name === 'tab') {
          buffer += '\t'; tailEnter = false; swallowedCR = false; lastCharAt = t; return { kind: 'swallow' };
        }
        lastWasChar = false; swallowedCR = false;  // any other key ends the flood
        const held = buffer; buffer = null; tailEnter = false;
        return { kind: 'flush-then', event, text: held };
      }
      if (isChar(event)) {
        const hot = t - lastCharAt < charMs;
        run = hot ? run + 1 : 1;
        if (!hot) recent = [];                     // drop stale chars from an older run
        lastCharAt = t; lastWasChar = true;
        recent.push(event.text);
        if (recent.length > minChars) recent.shift();
        if (run >= minChars) {
          // The first minChars-1 chars already reached the input as ordinary
          // inserts — report them as the prefix for the caller to pull back.
          const prefix = recent.slice(0, -1).join('');
          buffer = recent.join('');
          tailEnter = false; swallowedCR = false; run = 0; recent = [];
          return { kind: 'capture', prefix };
        }
        return { kind: 'pass' };
      }
      if (event.name === 'enter' && lastWasChar && t - lastCharAt < charMs) {
        // A hot Enter after a short run (e.g. 'a\n' pasted) is flood content
        // too: pull the run back so the lines cannot submit one by one.
        const prefix = recent.join('');
        buffer = prefix + '\n';
        tailEnter = true; swallowedCR = event.raw === '\r';
        lastCharAt = t; run = 0; recent = [];
        lastWasChar = false;
        return { kind: 'capture', prefix };
      }
      lastWasChar = false; swallowedCR = false; run = 0; recent = [];
      return { kind: 'pass' };
    },
    /** The retro-capture verification failed — the prefix stayed in the input,
     * so drop it from the buffer too (identical total text, just un-chipped). */
    dropPrefix(n) { if (buffer !== null) buffer = buffer.slice(n); },
    /** Drain the collected paste. `submit` is true only when the flood's last
     * byte was Enter AND the payload is a single line — multi-line pastes are
     * always left in the composer for review. */
    takeFlush() {
      if (buffer === null) return null;
      const text = buffer;
      const submit = tailEnter && !text.trimEnd().includes('\n');
      buffer = null; tailEnter = false;
      run = 0; recent = []; lastCharAt = -Infinity; lastWasChar = false; swallowedCR = false;
      return { text, submit };
    },
    reset() { run = 0; recent = []; lastCharAt = -Infinity; lastWasChar = false; swallowedCR = false; buffer = null; tailEnter = false; },
  };
}
