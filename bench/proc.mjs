// Kill a detached child and its process group. Windows has no process groups:
// negative pids throw there, so fall back to killing the child itself.
export function killChild(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

// POSIX single-quote escaping for a value interpolated into a `sh -c` string
// (the `script -qfec <cmd>` PTY drivers): spaces, quotes, `$` and `;` stay literal.
export const shQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
