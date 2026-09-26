import path from 'node:path';
import { currentAnswer } from '../driver/zcode-protocol.mjs';
export { currentAnswer } from '../driver/zcode-protocol.mjs';

export const DAEMON_TURN_TIMEOUT_MS = 120_000;
// Cold start: readiness (30s), create/pre-read/post-read/usage (20s each),
// plus transport margin (10s). session/send is already inside the turn budget.
export const DAEMON_RESPONSE_TIMEOUT_MS = DAEMON_TURN_TIMEOUT_MS + 30_000 + 4 * 20_000 + 10_000;

// One NDJSON request per connection. Bound memory before parsing untrusted input.
export function acceptRequest(sock, handle, { maxBytes = 1024 * 1024 } = {}) {
  let buf = '', claimed = false;
  sock.setEncoding('utf8');
  sock.on('error', () => {});
  const reply = value => { if (!sock.destroyed) sock.end(JSON.stringify(value) + '\n'); };
  sock.on('data', async chunk => {
    if (claimed) return;
    buf += chunk;
    if (Buffer.byteLength(buf) > maxBytes) {
      claimed = true;
      reply({ error: 'request too large' });
      return;
    }
    const idx = buf.indexOf('\n');
    if (idx < 0) return;
    claimed = true;
    try {
      const req = JSON.parse(buf.slice(0, idx));
      if (!req || Array.isArray(req) || typeof req !== 'object' ||
          typeof req.cwd !== 'string' || !path.isAbsolute(req.cwd) || req.cwd.includes('\0') ||
          (req.op !== undefined && req.op !== 'compact') ||
          (req.op !== 'compact' && (typeof req.prompt !== 'string' || !req.prompt.trim()))) {
        throw new Error('invalid request: absolute cwd and nonempty prompt (or op: compact) required');
      }
      req.cwd = path.resolve(req.cwd);
      reply(await handle(req));
    } catch (e) { reply({ error: String(e.message).slice(0, 200) }); }
    finally { buf = ''; }
  });
}

export function serializeWorkspaces(handle) {
  const busy = new Set();
  return async req => {
    if (busy.has(req.cwd)) throw new Error('workspace busy; retry after the active request completes');
    busy.add(req.cwd);
    try { return await handle(req); }
    finally { busy.delete(req.cwd); }
  };
}

export async function isolatedTurn(cached, prompt, runTurn) {
  try {
    const before = await cached.client.readSession(cached.sessionId);
    const turn = await runTurn(cached.client, cached.sessionId, prompt, { timeoutMs: DAEMON_TURN_TIMEOUT_MS });
    if (turn.end.ended === 'timeout') throw new Error('turn timed out; session discarded');
    const after = await cached.client.readSession(cached.sessionId);
    return { ...turn, answer: currentAnswer(before.messages ?? [], after.messages ?? []) };
  } catch (e) {
    try { cached.client.close(); } catch {}
    throw e;
  }
}
