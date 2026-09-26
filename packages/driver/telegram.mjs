// D5 Telegram bot driver — IM-driven agent turns (GUI parity: ZCode's IM bots).
//
// Transport = Bot API long-polling (getUpdates offset cursor) + sendMessage; every HTTP
// call goes through the injected `fetchImpl` so tests drive the full loop with a fake.
// No SDK dependency, no background threads: runBot() is an async loop the caller owns
// (and can stop via the returned handle). Token comes from env — never logged.

import { readFileSync } from 'node:fs';
import { writePrivateFileSync } from './credentials.mjs';

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

// Restart checkpoint: {offset, pending:{update_id:{chatId,reply,attempts}}}.
// Corrupt/missing state reads as a fresh start — worst case a redelivered
// update re-runs once, which is the pre-checkpoint behaviour, not a new risk.
function readBotState(file) {
  try {
    const st = JSON.parse(readFileSync(file, 'utf8'));
    return st && typeof st === 'object' && !Array.isArray(st) ? st : null;
  } catch { return null; }
}

// The bot loop: poll → for each text update → handler(chatId, text) → reply with its
// return string. Errors are reported to the chat (not thrown) so one bad turn cannot
// kill the bot; poll failures back off exponentially (cap 60s) per TG best practice.
//
// Acknowledgement: the offset only advances past an update once that update is
// SETTLED — replied, skipped, unauthorized, or dropped after maxDeliveryAttempts
// failed sends. Advancing the whole batch before handling meant a failed
// sendMessage acknowledged an update whose answer never arrived. A completed
// handler result is cached in `pending` so a redelivery resends the same reply
// instead of re-running the turn's side effects.
//
// Restart safety: an in-memory `pending` is not enough — a process that dies
// between a finished turn and a failed sendMessage gets the same update
// redelivered on next boot and would run it again. With `stateFile` set, the
// answered-but-undelivered replies and the acked offset are persisted (private
// write) before the cursor advances, and a fresh runBot resends the pending
// answers on startup instead of re-executing the handler.
export async function runBot({ token, handler, fetchImpl = fetch, pollTimeout = 25, api, onEvent = () => {}, allowedChatIds, maxDeliveryAttempts = 4, stateFile } = {}) {
  if (!token) throw new Error('runBot: token required (set ZAGENT_TELEGRAM_TOKEN)');
  if (typeof handler !== 'function') throw new Error('runBot: handler(chatId, text) required');
  // Authorization (review r2 #1): when an allowlist is set, updates from other chats are
  // dropped BEFORE the handler — an open bot would let ANY sender drive the operator's
  // account. Empty allowlist = driver-level allow-all (the CLI layer must default-deny).
  const allowed = allowedChatIds == null ? null : new Set(allowedChatIds);
  const persisted = stateFile ? readBotState(stateFile) : null; // {offset, pending:{id:{chatId,reply,attempts}}}
  const pending = new Map(); // update_id -> {chatId, reply, attempts}: settled turn, unsettled send
  for (const [k, v] of Object.entries(persisted?.pending ?? {})) {
    const id = Number(k);
    if (Number.isInteger(id) && v && typeof v.reply === 'string' && v.chatId != null)
      pending.set(id, { chatId: v.chatId, reply: v.reply, attempts: Number(v.attempts) || 0 });
  }
  let offset = Number.isInteger(persisted?.offset) ? persisted.offset : 0;
  const persist = () => {
    if (stateFile)
      writePrivateFileSync(stateFile, JSON.stringify({ offset, pending: Object.fromEntries(pending) }, null, 1));
  };
  const remember = (id, entry) => {
    pending.set(id, entry);
    if (pending.size > 500) pending.delete(pending.keys().next().value);
    persist();
  };
  const settle = id => { if (Number.isInteger(id)) { offset = Math.max(offset, id + 1); persist(); } };
  let stopped = false, failures = 0;
  const stop = () => { stopped = true; };
  const sleep = async ms => { for (const end = Date.now() + ms; Date.now() < end && !stopped;) await new Promise(r => setTimeout(r, Math.min(200, end - Date.now()))); };
  const loop = (async () => {
    onEvent('start');
    // Crash recovery: answers that outlived the previous process are re-sent
    // from the state file — the turn is never re-run.
    for (const [id, held] of pending) {
      if (stopped) break;
      try { await sendMessage(fetchImpl, token, held.chatId, held.reply, { api }); pending.delete(id); settle(id); }
      catch (e) { onEvent('delivery_error', String(e?.message ?? e)); remember(id, { ...held, attempts: held.attempts + 1 }); }
    }
    while (!stopped) {
      let resendWait = 0;
      try {
        const { updates } = await getUpdates(fetchImpl, token, offset, { timeout: pollTimeout, api });
        failures = 0;
        for (const u of updates) {
          if (stopped) break; // r2 #4: a released batch must not start handlers after stop
          const id = u.update_id;
          const m = messageText(u);
          if (!m || m.chatId == null) { onEvent('skipped', id); settle(id); continue; }
          // r16 #1: attachment-only messages (empty text) still reach the handler for disclosure
          if (allowed && !allowed.has(m.chatId)) { onEvent('unauthorized', m.chatId); settle(id); continue; }
          const held = Number.isInteger(id) ? pending.get(id) : null;
          let reply;
          if (held) reply = held.reply;
          else {
            onEvent('message', m);
            try { reply = await handler(m.chatId, m.text, u.message ?? u.edited_message); if (reply != null) reply = String(reply); }
            catch (e) { onEvent('handler_error', String(e?.message ?? e)); reply = `error: ${String(e?.message ?? e).slice(0, 200)}`; }
            // Persist the finished answer BEFORE the first send attempt: if the
            // process dies between a completed turn and the failed send, the
            // restart resends this reply — it must never re-run the handler.
            if (reply && Number.isInteger(id)) remember(id, { chatId: m.chatId, reply, attempts: 0 });
          }
          if (reply) {
            try { await sendMessage(fetchImpl, token, m.chatId, reply, { api }); pending.delete(id); persist(); }
            catch (e) {
              onEvent('delivery_error', String(e?.message ?? e));
              const entry = held ?? { chatId: m.chatId, reply, attempts: 0 };
              entry.attempts += 1;
              if (entry.attempts >= maxDeliveryAttempts) {
                pending.delete(id); persist(); onEvent('dropped', id); // bounded: a dead chat cannot block the queue forever
              } else {
                remember(id, entry);
                resendWait = Math.min(1000 * 2 ** (entry.attempts - 1), 60000);
                break; // leave the cursor behind: the next poll redelivers this update
              }
            }
          }
          settle(id);
        }
      } catch (e) {
        failures++; onEvent('poll_error', String(e?.message ?? e));
        await sleep(Math.min(1000 * 2 ** (failures - 1), 60000)); // r2 #4: abortable backoff
      }
      if (resendWait && !stopped) await sleep(resendWait);
    }
    onEvent('stop');
  })();
  return { stop, done: loop };
}
