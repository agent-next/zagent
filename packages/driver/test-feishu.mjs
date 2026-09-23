// Feishu driver tests — docs-verified shapes (open.feishu.cn, 2026-09-06); fake fetch + real ingest core.
import { getTenantToken, sendText, receiveEvent, tokenCache, makeInbox } from './feishu.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const calls = [];
const fTok = async (url, init) => { calls.push({ url, init });
  if (url.includes('tenant_access_token')) return { ok: true, status: 200, json: async () => ({ code: 0, tenant_access_token: 't-abc', expire: 7200 }) };
  return { ok: true, status: 200, json: async () => ({ code: 0, data: { message_id: 'om_1' } }) }; };

// token: exact endpoint + credentials body + failure modes
await getTenantToken(fTok, 'APP1', 'SEC1');
ok(calls[0].url === 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', 'token endpoint exact');
ok(JSON.parse(calls[0].init.body).app_id === 'APP1' && JSON.parse(calls[0].init.body).app_secret === 'SEC1', 'credentials in body');
const fBad = async () => ({ ok: false, status: 401, json: async () => ({ code: 9999, msg: 'app secret mismatch' }) });
let threw = false; try { await getTenantToken(fBad, 'a', 's'); } catch (e) { threw = /code 9999/.test(e.message); }
ok(threw, 'token failure surfaces code');

// send: URL, auth header, content is JSON-SERIALIZED string, cap
calls.length = 0;
await sendText(fTok, 't-abc', 'chat_id', 'oc_1', 'hello');
ok(calls[0].url === 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', 'send URL exact');
ok(calls[0].init.headers.authorization === 'Bearer t-abc', 'bearer header');
const body = JSON.parse(calls[0].init.body);
ok(body.msg_type === 'text' && body.receive_id === 'oc_1', 'body fields');
ok(body.content === '{"text":"hello"}', 'content is serialized JSON string (docs)');
await sendText(fTok, 't', 'open_id', 'ou_1', 'x'.repeat(200000));
ok(JSON.parse(calls.at(-1).init.body).content.length < 150 * 1024 + 50, '150KB cap applied');

// receiveEvent shapes
ok(receiveEvent({ type: 'url_verification', challenge: 'c123' }).challenge === 'c123', 'challenge passthrough');
const EV = { schema: '2.0', header: { event_type: 'im.message.receive_v1' },
  event: { message: { chat_id: 'oc_9', message_id: 'om_9', content: '{"text":"fix the bug"}' },
           sender: { sender_type: 'user' } } };
let ev = receiveEvent(EV);
ok(ev.kind === 'message' && ev.chatId === 'oc_9' && ev.text === 'fix the bug' && ev.senderType === 'user', 'receive_v1 parsed');
ok(receiveEvent({ header: { event_type: 'other.event' }, event: {} }).kind === 'ignored', 'other events ignored');
ok(receiveEvent({ header: { event_type: 'im.message.receive_v1' }, event: { message: { chat_id: 'c', content: '{"img":"x"}' } } }).kind === 'ignored', 'non-text content ignored');
ok(receiveEvent(null).kind === 'ignored', 'null body ignored');

// tokenCache: one fetch across multiple calls; refresh after expiry
let fetches = 0;
const fCount = async () => { fetches++; return { ok: true, status: 200, json: async () => ({ code: 0, tenant_access_token: `t-${fetches}`, expire: 7200 }) }; };
const tc = tokenCache({ fetchImpl: fCount, appId: 'a', appSecret: 's' });
ok((await tc()) === 't-1' && (await tc()) === 't-1' && fetches === 1, 'cached within expiry');

// Webhook exposure: default bind must be loopback (a verified event can spawn
// an agent turn, so 0.0.0.0-by-default is drive-by RCE on any LAN), external bind
// must be explicit opt-in, and an unconfigured verify token must be a fresh
// per-run random — never a static shared constant.
{
  const { feishuWebhookConfig } = await import('./feishu.mjs');
  if (typeof feishuWebhookConfig !== 'function') { ok(false, 'feishuWebhookConfig exported'); }
  else {
  const env = { ZAGENT_FEISHU_APP_ID: 'a', ZAGENT_FEISHU_APP_SECRET: 's', ZAGENT_FEISHU_ALLOWED_CHATS: 'oc_1' };
  ok(feishuWebhookConfig(env).host === '127.0.0.1', 'webhook binds loopback by default');
  ok(feishuWebhookConfig({ ...env, ZAGENT_FEISHU_HOST: '0.0.0.0' }).host === '0.0.0.0', 'external bind is explicit opt-in only');
  ok(feishuWebhookConfig({ ...env, ZMAX_FEISHU_HOST: '0.0.0.0' }).host === '0.0.0.0', 'legacy ZMAX_ env names still read (compat)');
  const run1 = feishuWebhookConfig(env), run2 = feishuWebhookConfig(env);
  ok(run1.generatedToken === true && run2.generatedToken === true, 'unconfigured token is generated');
  ok(typeof run1.verifyToken === 'string' && run1.verifyToken.length >= 32, 'generated token has real entropy');
  ok(run1.verifyToken !== run2.verifyToken, 'two runs without a configured token do not share tokens');
  const fixed = feishuWebhookConfig({ ...env, ZAGENT_FEISHU_VERIFY_TOKEN: 'vt-static' });
  ok(fixed.verifyToken === 'vt-static' && fixed.generatedToken === false, 'configured token honored, not regenerated');
  }
}

// makeInbox: challenge answer, dedup by message_id, allowlist, handler-error-to-chat
const replies = []; const events = [];
const sendReply = async (chatId, text) => { replies.push([chatId, text]); };
const VT = 'vt-secret';
const inbox = makeInbox({ handler: async (c, t) => `${t.length}`, sendReply, allowedChatIds: ['oc_9'], onEvent: (t, d) => events.push([t, d]) });
let r = await inbox({ type: 'url_verification', challenge: 'ch-1' });
ok(r.body.challenge === 'ch-1', 'inbox answers challenge');

// verify-token gate — forged events (no/wrong header.token) never reach the handler
const repliesV = [];
const inboxV = makeInbox({ handler: async () => 'leak', sendReply: async (c, t) => { repliesV.push([c, t]); }, verifyToken: VT, onEvent: () => {} });
ok((await inboxV(EV)).status === 401, 'missing header.token -> 401, no handler');
ok((await inboxV({ ...EV, header: { ...EV.header, token: 'wrong' } })).status === 401, 'wrong token -> 401');
ok(repliesV.length === 0, 'no reply leaked to forged events');
ok((await inboxV({ ...EV, header: { ...EV.header, token: VT }, event: { ...EV.event, message: { ...EV.event.message, message_id: 'om_v1' } } })).status === 200, 'correct token passes');
ok(repliesV.length === 1 && repliesV[0][1] === 'leak', 'verified event handled');
await inbox(EV);
await inbox(EV); // duplicate push (docs: repeats happen; dedup by message_id)
ok(replies.length === 1, 'message_id dedup drops repeat push');
await inbox({ ...EV, event: { ...EV.event, message: { ...EV.event.message, chat_id: 'oc_other', message_id: 'om_x' } } });
ok(replies.length === 1 && events.some(e => e[0] === 'unauthorized'), 'allowlist blocks foreign chat');
const inbox2 = makeInbox({ handler: async () => { throw new Error('turn blew up'); },
  sendReply: async (c, t) => { replies.push([c, t]); }, onEvent: () => {} });
await inbox2({ ...EV, event: { ...EV.event, message: { ...EV.event.message, message_id: 'om_e' } } });
ok(replies.at(-1)[1].startsWith('error: turn blew up'), 'handler error reported to chat, no throw');

// bounded dedup memory
const inbox3 = makeInbox({ handler: async () => null, sendReply: async () => {}, maxDedup: 2 });
await inbox3({ ...EV, event: { ...EV.event, message: { ...EV.event.message, message_id: 'm1' } } });
await inbox3({ ...EV, event: { ...EV.event, message: { ...EV.event.message, message_id: 'm2' } } });
await inbox3({ ...EV, event: { ...EV.event, message: { ...EV.event.message, message_id: 'm3' } } });
await inbox3({ ...EV, event: { ...EV.event, message: { ...EV.event.message, message_id: 'm1' } } }); // m1 evicted -> handled (no sendReply anyway)
ok(true, 'bounded dedup does not throw');

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createChatTurnRunner } from './chat-turns.mjs';
const regression = async (name, fn) => {
  try { await fn(); ok(true, name); }
  catch (error) { ok(false, name); console.error(error); }
};

function runtime({ hang = false } = {}) {
  const messages = new Map(), sends = [];
  let next = 0, active = 0, maxActive = 0, closed = false;
  const client = {
    ready: Promise.resolve(), child: new EventEmitter(), onNotify() {}, sends,
    async createSession() { const sessionId = `s${++next}`; messages.set(sessionId, []); return { sessionId }; },
    async readSession(sessionId) { return { messages: [...messages.get(sessionId)] }; },
    async call(method, p) {
      if (method === 'session/read') return client.readSession(p.sessionId);
      assert.equal(method, 'session/send');
      const turnId = `t${sends.length + 1}`;
      const history = messages.get(p.sessionId);
      sends.push({ ...p, previous: [...history] });
      history.push({ info: { id: `${turnId}-u`, role: 'user' }, parts: [{ type: 'text', text: p.content }] });
      active++; maxActive = Math.max(maxActive, active);
      const emit = kind => client.onNotify({ method: 'computer-use/operation-event', params: { kind, turnId, sessionId: p.sessionId } });
      emit('turn-started');
      if (!hang) setImmediate(() => {
        if (closed) return;
        history.push({ info: { id: `${turnId}-a`, role: 'assistant' }, parts: [{ type: 'text', text: `reply:${p.content}` }] });
        active--; emit('turn-completed');
      });
      return { turnId };
    },
    close() { closed = true; client.child.emit('exit', 0); },
    maxActive: () => maxActive,
  };
  return client;
}

await regression('concurrent bot messages are serialized and different chats have separate histories', async () => {
  const client = runtime();
  const turns = createChatTurnRunner({ workspace: '/fixture', createClient: () => client });
  try {
    const replies = await Promise.all([turns.run('A', 'private A'), turns.run('B', 'private B'), turns.run('A', 'next A')]);
    assert.deepEqual(replies, ['reply:private A', 'reply:private B', 'reply:next A']);
    assert.equal(client.maxActive(), 1);
    assert.notEqual(client.sends[0].sessionId, client.sends[1].sessionId);
    assert.equal(client.sends[0].sessionId, client.sends[2].sessionId);
    assert.deepEqual(client.sends[1].previous, []);
    assert.equal(client.sends[2].previous.length, 2);
  } finally { turns.close(); }
});

await regression('a timed out bot runtime is discarded and the next message gets a fresh client', async () => {
  let creates = 0;
  const turns = createChatTurnRunner({ workspace: '/fixture', timeoutMs: 10,
    createClient: () => runtime({ hang: ++creates === 1 }),
  });
  try {
    await assert.rejects(turns.run('A', 'hang'), error => /timeout/.test(error.message) && error.retryable === false);
    assert.equal(await turns.run('A', 'recover'), 'reply:recover');
    assert.equal(creates, 2);
  } finally { turns.close(); }
  await assert.rejects(turns.run('A', 'after close'), /stopping/);
});

const event = id => ({ header: { event_type: 'im.message.receive_v1' }, event: {
  message: { chat_id: 'chat', message_id: id, content: JSON.stringify({ text: id }) },
} });

await regression('Feishu concurrent messages queue while duplicate in-flight deliveries share the result', async () => {
  const order = [], replies = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const inbox = makeInbox({ handler: async (chat, text) => { order.push(text); if (text === 'one') await gate; return text; },
    sendReply: async (chat, text) => replies.push(text),
  });
  const one = inbox(event('one')), duplicate = inbox(event('one')), two = inbox(event('two'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['one']);
  release();
  assert.deepEqual((await Promise.all([one, duplicate, two])).map(r => r.status), [200, 200, 200]);
  assert.deepEqual(order, ['one', 'two']);
  assert.deepEqual(replies, ['one', 'two']);
  await inbox(event('one'));
  assert.deepEqual(order, ['one', 'two']);
});

await regression('Feishu retries explicitly safe admission failures instead of marking them complete', async () => {
  let attempts = 0;
  const inbox = makeInbox({ handler: async () => { if (++attempts === 1) throw Object.assign(new Error('try again'), { retryable: true }); return 'ok'; }, sendReply: async () => {} });
  assert.equal((await inbox(event('retry'))).status, 503);
  assert.equal((await inbox(event('retry'))).status, 200);
  assert.equal((await inbox(event('retry'))).status, 200);
  assert.equal(attempts, 2);
});

await regression('Feishu delivery retry reuses the successful answer instead of rerunning the agent', async () => {
  let executions = 0, deliveries = 0;
  const inbox = makeInbox({ handler: async () => { executions++; return 'completed work'; },
    sendReply: async () => { if (++deliveries === 1) throw new Error('temporary send failure'); },
  });
  assert.equal((await inbox(event('delivery'))).status, 503);
  assert.equal((await inbox(event('delivery'))).status, 200);
  assert.equal(executions, 1);
  assert.equal(deliveries, 2);
});

await regression('ambiguous handler failures are never reexecuted, including failed error delivery', async () => {
  let executions = 0, deliveries = 0;
  const inbox = makeInbox({ handler: async () => { executions++; throw new Error('transport lost after write'); },
    sendReply: async () => { if (++deliveries === 1) throw new Error('send unavailable'); },
  });
  assert.equal((await inbox(event('ambiguous'))).status, 503);
  assert.equal((await inbox(event('ambiguous'))).status, 200);
  assert.equal((await inbox(event('ambiguous'))).status, 200);
  assert.equal(executions, 1);
  assert.equal(deliveries, 2);
});

await regression('bot startup failures are explicitly safe to retry', async () => {
  const turns = createChatTurnRunner({ workspace: '/fixture', createClient: () => { throw new Error('runtime unavailable'); } });
  try { await assert.rejects(turns.run('A', 'not submitted'), error => error.retryable === true); }
  finally { turns.close(); }
});

await regression('Feishu messages without usable IDs are rejected before execution', async () => {
  let calls = 0;
  const inbox = makeInbox({ handler: async () => { calls++; }, sendReply: async () => {} });
  for (const id of [undefined, '', 3]) {
    const invalid = event('valid text');
    invalid.event.message.message_id = id;
    assert.equal((await inbox(invalid)).status, 400);
  }
  assert.equal(calls, 0);
});

console.log(fails ? `FAIL (${fails})` : 'PASS feishu');
process.exit(fails ? 1 : 0);
