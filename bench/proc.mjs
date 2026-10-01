import { StringDecoder } from 'node:string_decoder';

// Kill a detached child and its process group. Windows has no process groups:
// negative pids throw there, so fall back to killing the child itself.
export function killChild(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

// POSIX single-quote escaping for a value interpolated into a `sh -c` string
// (the `script -qfec <cmd>` PTY drivers): spaces, quotes, `$` and `;` stay literal.
export const shQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

/**
 * Stateful first-frame matcher: feed raw PTY chunks, true once the client has
 * painted its bordered input box. A StringDecoder keeps a multi-byte character
 * split across two chunks from decoding to U+FFFD.
 */
export function createFrameDetector() {
  const decoder = new StringDecoder('utf8');
  return (chunk) => /[╭┌]/u.test(decoder.write(chunk));
}
