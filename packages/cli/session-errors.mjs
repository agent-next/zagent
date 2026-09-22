// Shared classification of "this session is not live" answers from the kernel.
// Live sessions are process-local: a stale id answers -32004 (not found) or
// "Session is not active: <id>". Anything else — "session/goal method not found",
// "session database: file not found" — is a real error and must stay one.
export const NOT_RUNNING = 'This session is not running. Live sessions are process-local: use /goal, /usage, /agents inside the TUI.';

const PATTERNS = [/^session is not active\b/i, /^session not found\b/i, /^unknown session\b/i, /^no such session\b/i];

export const isNotRunning = (e) =>
  e?.code === -32004 || PATTERNS.some((re) => re.test(String(e?.message ?? e).trim()));

// Stricter form for callers that name the session in their refusal copy:
// -32004 is the documented "session is not active" code, so a session-scoped
// message — or a bare code with no message — is the stale-id answer; a -32004
// carrying an unrelated message is ambiguous and must not be attributed to
// the session.
export const isSessionScopedNotRunning = (e) => {
  const msg = String(e?.message ?? (typeof e === 'object' ? '' : e) ?? '').trim();
  return PATTERNS.some((re) => re.test(msg)) || (e?.code === -32004 && !msg);
};
