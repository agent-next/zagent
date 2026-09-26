// Bot transports share one workspace/runtime, but each authorized chat gets its
// own conversation. Serialize the entire read/send/read operation across chats.
import { runTurn, sessionSid, turnAnswer } from './zcode-protocol.mjs';

export function createChatTurnRunner({ createClient, workspace, timeoutMs = 120000 } = {}) {
  const sessions = new Map();
  let client = null, queued = Promise.resolve(), closed = false;
  const discard = () => {
    try { client?.close(); } catch {}
    client = null;
    sessions.clear();
  };
  return {
    run(chatId, prompt) {
      const next = queued.then(async () => {
        if (closed) throw new Error('bot is stopping');
        let submitted = false;
        try {
          if (!client) {
            client = createClient();
            await client.ready;
          }
          const key = String(chatId);
          let sid = sessions.get(key);
          if (!sid) {
            sid = sessionSid(await client.createSession(workspace));
            if (!sid) throw new Error('runtime did not create a session');
            sessions.set(key, sid);
          }
          const before = await client.readSession(sid);
          submitted = true;
          const { end } = await runTurn(client, sid, prompt, { timeoutMs });
          if (end.ended !== 'turn-completed') throw new Error(`turn ${end.ended}; session discarded`);
          return await turnAnswer(client, sid, { beforeMessages: before.messages ?? [] });
        } catch (e) {
          discard();
          // After send begins, even an error/timeout may follow tool side effects.
          // Transports may retry only failures known to precede submission.
          throw Object.assign(new Error(String(e?.message ?? e), { cause: e }), { code: e?.code, retryable: !submitted });
        }
      });
      queued = next.catch(() => {});
      return next;
    },
    close() { closed = true; discard(); },
  };
}
