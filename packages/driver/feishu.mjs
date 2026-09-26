// D4 Feishu bot driver — docs-verified against open.feishu.cn (2026-09-06):
//  - Send message (im-v1/message/create, updated 2026-04-10): POST /open-apis/im/v1/messages
//    ?receive_id_type=chat_id|open_id|…, Authorization: Bearer <tenant_access_token>,
//    Content-Type: application/json; charset=utf-8, body {receive_id, msg_type:'text',
//    content:'{"text":"…"}'} — content is a JSON-SERIALIZED string. Response {code,msg,data};
//    code !== 0 is a failure. Text cap 150KB; 5 QPS per user/chat.
//  - Receive message event (im.message.receive_v1, updated 2026-08-05): webhook push
//    {schema, header:{event_type,…}, event:{message:{chat_id,message_id,content},sender:{sender_type}}}.
//    Dedup by message_id (NOT event_id — repeats happen). url_verification handshake:
//    {type:'url_verification', challenge} → echo the challenge.
//  - tenant_access_token: POST /open-apis/auth/v3/tenant_access_token/internal {app_id,
//    app_secret} (endpoint referenced by the send-message doc; exact response field set
//    verified at first live use — receipt notes this).
// All HTTP via injectable fetchImpl; secrets never logged.
import { randomBytes } from 'node:crypto';

export const FEISHU_API = 'https://open.feishu.cn';

// Webhook bind + token policy. A verified event can spawn an agent turn, so the
// listener must default to LOOPBACK — binding every interface by default is
// drive-by code execution for anyone on the LAN who finds the port. Set
// ZAGENT_FEISHU_HOST (e.g. 0.0.0.0) to opt in to a wider bind. A missing
// ZAGENT_FEISHU_VERIFY_TOKEN gets a fresh per-run random token, printed once by
// the CLI so the operator can paste it into the Feishu app's Verification Token
// field — never a source-tree constant (that would be a public credential).
// Legacy ZMAX_FEISHU_* names are still read as fallbacks.
const feishuEnv = (env, key) => env[`ZAGENT_FEISHU_${key}`] ?? env[`ZMAX_FEISHU_${key}`];
export function feishuWebhookConfig(env = process.env) {
  const configured = feishuEnv(env, 'VERIFY_TOKEN');
  return {
    host: feishuEnv(env, 'HOST')?.trim() || '127.0.0.1',
    port: Number(feishuEnv(env, 'PORT') ?? 9801),
    verifyToken: configured || randomBytes(24).toString('base64url'),
    generatedToken: !configured,
  };
}

export async function getTenantToken(fetchImpl, appId, appSecret, { api = FEISHU_API } = {}) {
  const r = await fetchImpl(`${api}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const body = await r.json().catch(() => ({}));
  const tok = body?.tenant_access_token;
  if (!r.ok || body?.code !== 0 || !tok)
    throw new Error(`feishu token failed: http ${r.status} code ${body?.code} ${String(body?.msg ?? '').slice(0, 80)}`);
  return { token: tok, expireSec: Number(body?.expire) || 0 };
}

// The docs cap is 150KB of UTF-8 — String.slice counts UTF-16 units, so a CJK
// reply (3 bytes/char) would overshoot ~3x. Truncate by bytes on a code-point
// boundary: a continuation byte (0b10xxxxxx) means the cut landed mid-char, so
// back off to that char's lead byte and drop it too.
function utf8Cap(text, maxBytes) {
  const buf = Buffer.from(String(text), 'utf8');
  if (buf.length <= maxBytes) return String(text);
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

export async function sendText(fetchImpl, token, receiveIdType, receiveId, text, { api = FEISHU_API } = {}) {
  const r = await fetchImpl(`${api}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ receive_id: receiveId, msg_type: 'text',
      content: JSON.stringify({ text: utf8Cap(text, 150 * 1024) }) }), // docs cap: 150KB text
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body?.code !== 0) throw new Error(`feishu send failed: http ${r.status} code ${body?.code} ${String(body?.msg ?? '').slice(0, 100)}`);
  return body.data ?? {};
}

// Webhook event ingestion. Returns:
//   {kind:'challenge', challenge}                       — url_verification handshake
//   {kind:'message', chatId, messageId, text, senderType}
//   {kind:'ignored'}                                    — other events / non-text / bot senders / malformed
//   {kind:'unauthorized'}                               — verify-token mismatch (challenge or event)
const FEISHU_ATTACHMENT_TYPES = new Set(['image', 'file', 'audio', 'media', 'sticker']);

export function receiveEvent(body, { verifyToken } = {}) {
  // Review r3 #1: events must authenticate with the app's Verification Token.
  // The url_verification handshake carries that token too (top-level `token`,
  // header.token on v2-shaped payloads) — answer it before the check, not after,
  // or the endpoint tells a stranger where the unauthenticated hole is.
  if (body?.type === 'url_verification') {
    if (verifyToken !== undefined && (body?.token ?? body?.header?.token) !== verifyToken)
      return { kind: 'unauthorized' };
    return { kind: 'challenge', challenge: body.challenge ?? '' };
  }
  if (verifyToken !== undefined && body?.header?.token !== verifyToken) return { kind: 'unauthorized' };
  if (body?.header?.event_type !== 'im.message.receive_v1') return { kind: 'ignored' };
  // A bot/app posting inside an allowed chat must not drive agent turns
  // (bot-to-bot loops, cross-app injection). Absent sender_type stays admissible:
  // real user deliveries always carry 'user'.
  const senderType = body.event?.sender?.sender_type ?? null;
  if (senderType !== null && senderType !== 'user') return { kind: 'ignored' };
  const msg = body.event?.message;
  let text = null;
  try { text = JSON.parse(msg?.content ?? '{}')?.text ?? null; } catch { text = null; }
  const isAttachment = FEISHU_ATTACHMENT_TYPES.has(msg?.message_type ?? '') || /"(image_key|file_key)"/.test(msg?.content ?? '');
  if (!msg?.chat_id) return { kind: 'ignored' };
  if (typeof text !== 'string' || text.length === 0) {
    if (!isAttachment) return { kind: 'ignored' }; // r16 #2: attachment events flow with empty text
    text = '';
  }
  return { kind: 'message', chatId: msg.chat_id, messageId: msg.message_id ?? null,
    text, senderType };
}

// Token cache with expiry (default 90% of reported expire, floor 60s) — one refresh
// lifetime per bot, not per message.
export function tokenCache({ fetchImpl, appId, appSecret, api } = {}) {
  let cached = null; // {token, expiresAt}
  return async () => {
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    const { token, expireSec } = await getTenantToken(fetchImpl, appId, appSecret, { api });
    cached = { token, expiresAt: Date.now() + Math.max(60, expireSec * 0.9) * 1000 };
    return token;
  };
}

// Message-processing core shared by any transport (webhook server, test harness):
// challenge pass-through, message_id dedup, default-deny allowlist, handler errors
// reported back to the chat instead of killing the process.
export function makeInbox({ handler, sendReply, allowedChatIds = null, onEvent = () => {}, maxDedup = 500, verifyToken } = {}) {
  const seen = new Set(), inFlight = new Map(), pendingReplies = new Map();
  const allowed = allowedChatIds == null ? null : new Set(allowedChatIds);
  let queued = Promise.resolve();
  const rememberCompleted = id => {
    if (!id) return;
    seen.add(id);
    if (seen.size > maxDedup) seen.delete(seen.values().next().value);
  };
  const boundedSet = (map, key, value) => {
    map.set(key, value);
    if (map.size > maxDedup) map.delete(map.keys().next().value);
  };
  return async function ingest(rawBody) {
    const ev = receiveEvent(rawBody, { verifyToken });
    if (ev.kind === 'challenge') return { status: 200, body: { challenge: ev.challenge } };
    if (ev.kind === 'unauthorized') { onEvent('unauthorized', 'bad verify token'); return { status: 401, body: {} }; }
    if (ev.kind === 'ignored') return { status: 200, body: {} };
    if (allowed && !allowed.has(ev.chatId)) { onEvent('unauthorized', ev.chatId); return { status: 200, body: {} }; }
    if (typeof ev.messageId !== 'string' || !ev.messageId) return { status: 400, body: {} }; // cannot safely deduplicate/retry without an ID
    if (seen.has(ev.messageId)) { onEvent('duplicate', ev.messageId); return { status: 200, body: {} }; }
    if (inFlight.has(ev.messageId)) return inFlight.get(ev.messageId);
    if (inFlight.size >= maxDedup) return { status: 503, body: {} };
    const key = ev.messageId;
    const work = queued.then(async () => {
      onEvent('message', { chatId: ev.chatId, senderType: ev.senderType });
      let reply;
      try {
        // Keep a successful model response until delivery succeeds. A webhook retry
        // after sendReply failure must not run the agent's side effects again.
        if (pendingReplies.has(key)) reply = pendingReplies.get(key);
        else {
          reply = await handler(ev.chatId, ev.text, rawBody);
          reply = reply ? String(reply) : '';
          boundedSet(pendingReplies, key, reply);
        }
      } catch (e) {
        onEvent('handler_error', String(e?.message ?? e));
        reply = `error: ${String(e?.message ?? e).slice(0, 200)}`;
        if (e?.retryable === true) {
          await sendReply(ev.chatId, reply).catch(() => {});
          return { status: 503, body: {} };
        }
        // Unknown/started failures may already have changed the workspace. Deliver
        // their error once, then deduplicate; retries can resend only this reply.
        boundedSet(pendingReplies, key, reply);
      }
      try { if (reply) await sendReply(ev.chatId, reply); }
      catch (e) {
        onEvent('delivery_error', String(e?.message ?? e));
        return { status: 503, body: {} };
      }
      pendingReplies.delete(key);
      rememberCompleted(ev.messageId);
      return { status: 200, body: {} };
    });
    inFlight.set(key, work);
    queued = work.catch(() => {});
    try { return await work; }
    finally { inFlight.delete(key); }
  };
}
