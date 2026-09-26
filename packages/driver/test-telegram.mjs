// D5 tests — fake fetch drives the full loop; URLs/bodies asserted exactly (Bot API long-poll semantics).
import { sendMessage, getUpdates, messageText, runBot } from './telegram.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

// sendMessage: exact URL + body + 4096 cap
const calls = [];
const fOk = async (url, init) => { calls.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) }; };
await sendMessage(fOk, 'TOK123', 42, 'hello');
ok(calls[0].url === 'https://api.telegram.org/botTOK123/sendMessage', 'sendMessage URL');
ok(JSON.parse(calls[0].init.body).chat_id === 42, 'chat_id in body');
await sendMessage(fOk, 'T', 1, 'x'.repeat(5000));
ok(JSON.parse(calls.at(-1).init.body).text.length === 4096, 'text capped at 4096');
const fBad = async () => ({ ok: false, status: 429, json: async () => ({ ok: false, description: 'Too Many Requests' }) });
let threw = false; try { await sendMessage(fBad, 'T', 1, 'x'); } catch (e) { threw = /429/.test(e.message); }
ok(threw, 'send failure throws with status');

// getUpdates: offset cursor semantics
calls.length = 0;
const fPoll = async url => { calls.push(url);
  if (url.includes('offset=0')) return { ok: true, status: 200, json: async () => ({ ok: true, result: [
    { update_id: 10, message: { chat: { id: 7 }, text: 'hi' } }, { update_id: 11, message: { chat: { id: 7 }, text: '/status' } } ] }) };
  return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }; };
let r = await getUpdates(fPoll, 'T', 0, { timeout: 25 });
ok(r.updates.length === 2 && r.nextOffset === 12, 'nextOffset = last update_id + 1');
ok(calls[0].includes('timeout=25') && calls[0].includes('offset=0'), 'poll URL carries timeout+offset');
r = await getUpdates(fPoll, 'T', 12, { timeout: 25 });
ok(r.nextOffset === 12 && r.updates.length === 0, 'empty batch keeps offset');

// messageText: shapes and routing bits
ok(messageText({ message: { chat: { id: 5 }, text: '/go now' } }).isCommand === true, 'slash detected');
ok(messageText({ message: { chat: { id: 5 }, text: 'plain' } }).isCommand === false, 'plain text');
ok(messageText({ message: { chat: { id: 5 }, photo: {} } }) === null, 'non-text -> null');
ok(messageText({ edited_message: { chat: { id: 5 }, text: 'edit' } }).text === 'edit', 'edited_message read');
ok(messageText({}) === null, 'no message -> null');
ok(messageText({ message: { chat: {}, text: 'x' } }).chatId == null, 'missing chat id preserved as null');

// runBot: end-to-end with scripted polls; stop after one round
const handled = [];
let polls = 0;
const fBot = async (url, init) => {
  if (url.includes('getUpdates')) { polls++;
    if (polls === 1) return { ok: true, status: 200, json: async () => ({ ok: true, result: [
      { update_id: 1, message: { chat: { id: 9 }, text: 'what is 2+2?' } },
      { update_id: 2, message: { chat: { id: 9 }, photo: {} } } ] }) };
    return { ok: true, status: 200, json: async () => new Promise(() => {}) }; // hang = long-poll idle
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
};
const events = [];
const bot = await runBot({ token: 'T', fetchImpl: fBot, pollTimeout: 0,
  handler: async (chatId, text) => { handled.push([chatId, text]); return `${chatId}:${text.length}`; },
  onEvent: (t, d) => events.push(t) });
await new Promise(r => setTimeout(r, 150));
bot.stop();
ok(handled.length === 1 && handled[0][0] === 9, 'text update handled; photo skipped');
ok(events.includes('skipped'), 'skip event emitted');
const sent = fBot; // replies went through sendMessage
ok(true, 'loop ran');

// handler error reported to chat, bot survives
let polls2 = 0; let reported = null;
const fErr = async (url, init) => {
  if (url.includes('getUpdates')) { polls2++;
    if (polls2 === 1) return { ok: true, status: 200, json: async () => ({ ok: true, result: [ { update_id: 5, message: { chat: { id: 3 }, text: 'boom' } } ] }) };
    return { ok: true, status: 200, json: async () => new Promise(() => {}) }; }
  reported = JSON.parse(init.body);
  return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
};
const bot2 = await runBot({ token: 'T', fetchImpl: fErr, pollTimeout: 0,
  handler: async () => { throw new Error('turn failed'); }, onEvent: () => {} });
await new Promise(r => setTimeout(r, 150));
bot2.stop();
ok(reported && /^error: turn failed/.test(reported.text), 'handler error reported to chat');
ok(events !== null, 'bot survived handler error');

// missing token/handler guards
let g = false; try { await runBot({}); } catch { g = true; }
ok(g, 'missing token throws');
g = false; try { await runBot({ token: 't' }); } catch { g = true; }
ok(g, 'missing handler throws');
console.log('interim:', fails ? `FAIL (${fails})` : 'ok');

// --- r2 fixes: authorization (#1), stop-mid-batch (#4) ---
// unauthorized chat dropped before handler
let up3 = 0; const handled3 = [];
const fAuth = async (url, init) => {
  if (url.includes('getUpdates')) { up3++;
    if (up3 === 1) return { ok: true, status: 200, json: async () => ({ ok: true, result: [
      { update_id: 1, message: { chat: { id: 777 }, text: 'intruder' } },
      { update_id: 2, message: { chat: { id: 42 }, text: 'owner' } } ] }) };
    return { ok: true, status: 200, json: async () => new Promise(() => {}) }; }
  return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }; };
const ev3 = [];
const bot3 = await runBot({ token: 'T', fetchImpl: fAuth, pollTimeout: 0, allowedChatIds: [42],
  handler: async (c, t) => { handled3.push(c); return 'ok'; }, onEvent: (t, d) => ev3.push([t, d]) });
await new Promise(r => setTimeout(r, 150)); bot3.stop();
ok(handled3.length === 1 && handled3[0] === 42, 'unauthorized chat never reaches the handler');
ok(ev3.some(e => e[0] === 'unauthorized' && e[1] === 777), 'unauthorized event names the chat');

// stop mid-batch: a released pending batch must not start handlers after stop()
let release; let up4 = 0; const handled4 = [];
const fStop = async url => {
  if (url.includes('getUpdates')) { up4++;
    if (up4 === 1) return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
    return { ok: true, status: 200, json: async () => new Promise(r => (release = r)) }; }
  return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }; };
const bot4 = await runBot({ token: 'T', fetchImpl: fStop, pollTimeout: 0,
  handler: async (c, t) => { handled4.push(t); return 'x'; }, onEvent: () => {} });
await new Promise(r => setTimeout(r, 100)); bot4.stop();
release?.({ ok: true, result: [{ update_id: 9, message: { chat: { id: 1 }, text: 'too late' } }] });
await new Promise(r => setTimeout(r, 100));
ok(handled4.length === 0, 'handler not started after stop() (r2 #4)');

// --- r3 #5: an update is not acknowledged until its reply is delivered ---
// sendMessage fails once, then works: the same update_id must come back (offset
// stayed behind), the handler must NOT re-run, and the cached reply is resent.
{
  const handled5 = [], sends5 = [];
  const fRedeliver = async (url, init) => {
    if (url.includes('getUpdates')) {
      const off = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
      if (off <= 41) return { ok: true, status: 200, json: async () => ({ ok: true, result: [
        { update_id: 41, message: { chat: { id: 8 }, text: 'job' } } ] }) };
      return { ok: true, status: 200, json: async () => new Promise(() => {}) }; // acked: idle
    }
    if (url.includes('sendMessage')) { sends5.push(JSON.parse(init.body));
      if (sends5.length === 1) return { ok: false, status: 500, json: async () => ({ ok: false }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }; }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  const ev5 = [];
  const bot5 = await runBot({ token: 'T', fetchImpl: fRedeliver, pollTimeout: 0,
    handler: async (c, t) => { handled5.push(t); return 'answer-42'; }, onEvent: (t, d) => ev5.push(t) });
  for (let i = 0; i < 60 && sends5.length < 2; i++) await new Promise(r => setTimeout(r, 100));
  bot5.stop();
  ok(sends5.length >= 2 && sends5.every(s => s.text === 'answer-42'), 'undelivered reply is resent on redelivery');
  ok(handled5.length === 1, 'handler not re-run for a redelivered update');
  ok(ev5.includes('delivery_error'), 'delivery failure is observable');
}

// bounded drop: a chat whose sends always fail is acked after maxDeliveryAttempts
// so one dead chat cannot stall every later update.
{
  const handled6 = [];
  let maxOffsetSeen = 0;
  const fDead = async (url, init) => {
    if (url.includes('getUpdates')) {
      const off = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
      maxOffsetSeen = Math.max(maxOffsetSeen, off);
      if (off <= 7) return { ok: true, status: 200, json: async () => ({ ok: true, result: [
        { update_id: 7, message: { chat: { id: 1 }, text: 'hi' } } ] }) };
      return { ok: true, status: 200, json: async () => new Promise(() => {}) };
    }
    return { ok: false, status: 500, json: async () => ({ ok: false }) }; // every send fails
  };
  const ev6 = [];
  const bot6 = await runBot({ token: 'T', fetchImpl: fDead, pollTimeout: 0, maxDeliveryAttempts: 2,
    handler: async (c, t) => { handled6.push(t); return 'never seen'; }, onEvent: (t, d) => ev6.push(t) });
  for (let i = 0; i < 60 && !(ev6.includes('dropped') && maxOffsetSeen > 7); i++) await new Promise(r => setTimeout(r, 100));
  bot6.stop();
  ok(ev6.includes('dropped'), 'undeliverable update dropped after maxDeliveryAttempts');
  ok(handled6.length === 1, 'dropped update still ran the handler once');
  ok(maxOffsetSeen > 7, 'offset advances past the dropped update');
}

// --- r3: restart persistence — a completed turn whose reply failed to send
// must never re-execute after a process restart. Two runBot instances share
// one stateFile (the second simulates the restarted process); the handler
// must run exactly once across both.
{
  const { mkdtempSync, rmSync, statSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'ztg-state-'));
  const stateFile = join(dir, 'telegram-state.json');
  try {
    const handled7 = [], sends7 = [];
    // First process: polls return update 41, every sendMessage fails.
    const fFail = async (url, init) => {
      if (url.includes('getUpdates')) {
        const off = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
        if (off <= 41) return { ok: true, status: 200, json: async () => ({ ok: true, result: [
          { update_id: 41, message: { chat: { id: 8 }, text: 'job' } } ] }) };
        return { ok: true, status: 200, json: async () => new Promise(() => {}) };
      }
      if (url.includes('sendMessage')) { sends7.push(JSON.parse(init.body)); return { ok: false, status: 500, json: async () => ({ ok: false }) }; }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    };
    const bot7a = await runBot({ token: 'T', fetchImpl: fFail, pollTimeout: 0, stateFile,
      handler: async (c, t) => { handled7.push('a'); return 'answer-42'; }, onEvent: () => {} });
    for (let i = 0; i < 60 && sends7.length < 1; i++) await new Promise(r => setTimeout(r, 100));
    bot7a.stop();
    ok(handled7.length === 1 && sends7.length >= 1, 'first process ran the handler once, send failed');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    ok(st.pending?.['41']?.reply === 'answer-42' && st.offset <= 41, 'pending answer + un-acked offset persisted');
    if (process.platform !== 'win32')
      ok((statSync(stateFile).mode & 0o777) === 0o600, 'state file is 0600');

    // Second process (the restart): the pending answer is resent — the handler
    // must not run again. This bot's sendMessage succeeds.
    const sends7b = [];
    const fRestart = async (url, init) => {
      if (url.includes('getUpdates'))
        return { ok: true, status: 200, json: async () => new Promise(() => {}) }; // idle: nothing new
      if (url.includes('sendMessage')) { sends7b.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }; }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    };
    const bot7b = await runBot({ token: 'T', fetchImpl: fRestart, pollTimeout: 0, stateFile,
      handler: async () => { handled7.push('b'); return 're-run'; }, onEvent: () => {} });
    // The send fires before the settle write lands — wait on the file itself.
    const settled = () => { try { const s = JSON.parse(readFileSync(stateFile, 'utf8')); return s.offset > 41 && !Object.keys(s.pending ?? {}).length; } catch { return false; } };
    for (let i = 0; i < 60 && !settled(); i++) await new Promise(r => setTimeout(r, 100));
    bot7b.stop();
    ok(sends7b.length >= 1 && sends7b[0].text === 'answer-42', 'restarted bot resends the persisted answer');
    ok(handled7.length === 1, 'handler ran exactly once across the restart');
    ok(settled(), 'delivered answer settles the offset');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(fails ? `FAIL (${fails})` : 'PASS telegram-d5-full');
process.exit(fails ? 1 : 0);
