// D5 Telegram bot driver — IM-driven agent turns (GUI parity: ZCode's IM bots).
//
// Transport = Bot API long-polling (getUpdates offset cursor) + sendMessage; every HTTP
// call goes through the injected `fetchImpl` so tests drive the full loop with a fake.
// No SDK dependency, no background threads: runBot() is an async loop the caller owns
// (and can stop via the returned handle). Token comes from env — never logged.

export const TELEGRAM_API = 'https://api.telegram.org';

function apiBase(token, api = TELEGRAM_API) { return `${api}/bot${token}`; }

export async function sendMessage(fetchImpl, token, chatId, text, { api } = {}) {
  const r = await fetchImpl(`${apiBase(token, api)}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096) }), // TG hard cap
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok !== true) throw new Error(`telegram sendMessage failed: http ${r.status} ${JSON.stringify(body).slice(0, 120)}`);
  return body.result;
}

// One long-poll batch. Returns {updates, nextOffset} — offset advances past confirmed
// update_ids (TG semantics: offset = last update_id + 1 acks everything before it).
export async function getUpdates(fetchImpl, token, offset, { timeout = 0, api } = {}) {
  const url = `${apiBase(token, api)}/getUpdates?timeout=${timeout}&offset=${offset}`; // offset=0 = no cursor: first poll
  const r = await fetchImpl(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok !== true) throw new Error(`telegram getUpdates failed: http ${r.status}`);
  const updates = body.result ?? [];
  return { updates, nextOffset: updates.length ? updates[updates.length - 1].update_id + 1 : offset };
}

// Text extraction: private chat message text; non-text/caption-only/channel posts pass
// through as null (caller decides policy). /cmd extraction for routing.
export function messageText(update) {
  const m = update?.message ?? update?.edited_message;
  if (!m) return null;
  const text = typeof m.text === 'string' && m.text.length ? m.text
    : typeof m.caption === 'string' && m.caption.length ? m.caption : ''; // r16 #1: captions are real text; media-only = empty text
  const hasMedia = !!(m.photo?.length || m.document || m.video || m.voice || m.audio);
  if (!text && !hasMedia) return null;
  return { chatId: m.chat?.id, text, isCommand: text.startsWith('/') };
}

// The bot loop: poll → for each text update → handler(chatId, text) → reply with its
// return string. Errors are reported to the chat (not thrown) so one bad turn cannot
// kill the bot; poll failures back off exponentially (cap 60s) per TG best practice.
export async function runBot({ token, handler, fetchImpl = fetch, pollTimeout = 25, api, onEvent = () => {}, allowedChatIds }) {
  if (!token) throw new Error('runBot: token required (set ZAGENT_TELEGRAM_TOKEN)');
  if (typeof handler !== 'function') throw new Error('runBot: handler(chatId, text) required');
  // Authorization (review r2 #1): when an allowlist is set, updates from other chats are
  // dropped BEFORE the handler — an open bot would let ANY sender drive the operator's
  // account. Empty allowlist = driver-level allow-all (the CLI layer must default-deny).
  const allowed = allowedChatIds == null ? null : new Set(allowedChatIds);
  let offset = 0, stopped = false, failures = 0;
  const stop = () => { stopped = true; };
  const sleep = async ms => { for (const end = Date.now() + ms; Date.now() < end && !stopped;) await new Promise(r => setTimeout(r, Math.min(200, end - Date.now()))); };
  const loop = (async () => {
    onEvent('start');
    while (!stopped) {
      try {
        const { updates, nextOffset } = await getUpdates(fetchImpl, token, offset, { timeout: pollTimeout, api });
        offset = nextOffset; failures = 0;
        for (const u of updates) {
          if (stopped) break; // r2 #4: a released batch must not start handlers after stop
          const m = messageText(u);
          if (!m || m.chatId == null) { onEvent('skipped', u.update_id); continue; }
          // r16 #1: attachment-only messages (empty text) still reach the handler for disclosure
          if (allowed && !allowed.has(m.chatId)) { onEvent('unauthorized', m.chatId); continue; }
          onEvent('message', m);
          try { const reply = await handler(m.chatId, m.text, u.message ?? u.edited_message); if (reply) await sendMessage(fetchImpl, token, m.chatId, String(reply), { api }); }
          catch (e) { onEvent('handler_error', String(e?.message ?? e)); await sendMessage(fetchImpl, token, m.chatId, `error: ${String(e?.message ?? e).slice(0, 200)}`, { api }).catch(() => {}); }
        }
      } catch (e) {
        failures++; onEvent('poll_error', String(e?.message ?? e));
        await sleep(Math.min(1000 * 2 ** (failures - 1), 60000)); // r2 #4: abortable backoff
      }
    }
    onEvent('stop');
  })();
  return { stop, done: loop };
}
