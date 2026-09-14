// Shared classification of "this session is not live" answers from the kernel.
// Live sessions are process-local: a stale id answers -32004 (not found) or
// "Session is not active: <id>". Anything else — "session/goal method not found",
// "session database: file not found" — is a real error and must stay one.
export const NOT_RUNNING = 'This session is not running. Live sessions are process-local: use /goal, /usage, /agents inside the TUI.';

const PATTERNS = [/^session is not active\b/i, /^session not found\b/i, /^unknown session\b/i, /^no such session\b/i];

export const isNotRunning = (e) =>
  e?.code === -32004 || PATTERNS.some((re) => re.test(String(e?.message ?? e).trim()));
