// Hermetic driver unit test — fake NDJSON runtime over stdio. No GLM runtime, no network,
// no credentials. Covers the requestHandlers injection seam, fail-fast on runtime exit,
// event-driven ready, and the sessionSid unwrap.
import { ZCodeProtocolClient, sessionSid, runTurn, warmTurn, sessionCache, clearSessionCache } from './zcode-protocol.mjs';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ok, eq, summary } from './test-util.mjs';

const FIXTURE = path.join(tmpdir(), `zcode-fake-runtime-${process.pid}.mjs`);
writeFileSync(FIXTURE, `
  const send = o => process.stdout.write(JSON.stringify(o) + '\\n');
  const seen = [];
  let waiters = [];
  const flush = () => { if (seen.length >= 3 && waiters.length) { for (const id of waiters) send({ id, result: seen }); waiters = []; } };
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.method === 'waitSeen') { waiters.push(m.id); flush(); } // sync point: both replies landed
      else if (m.method === 'die') process.exit(0);
      else if (m.id !== undefined && !m.method) { seen.push(m); flush(); } // replies to server->client requests
    }
  });
  // boot banner: three server->client requests, like the real runtime
  send({ id: 's1', method: 'session/requestRuntimePreferences' });
  send({ id: 's2', method: 'interaction/requestPermission', params: { options: [{ kind: 'allow_once', response: { decision: 'allow' } }] } });
  send({ id: 's3', method: 'interaction/requestUserInput', params: { requestId: 'r1', sessionId: 'sess', toolCallId: 'tc1', toolName: 'ExitPlanMode', prompt: 'plan ready', questions: [{ header: 'Plan', question: 'Approve?', options: [{ label: 'Approve', value: 'approve' }] }], schema: { interaction: 'plan_approval', toolName: 'ExitPlanMode' } } });
`);
try {
  const c = new ZCodeProtocolClient({ runtime: FIXTURE, requestHandlers: {
    'interaction/requestPermission': p => p?.options?.find(o => o.kind === 'allow_once')?.response ?? { decision: 'allow' },
  } });
  await c.ready;
  const seen = await c.call('waitSeen'); // deterministic: fake replies only after BOTH auto-replies landed
  const perm = seen.find(m => m.id === 's2');
  ok(!!perm, 'injected requestHandlers answered interaction/requestPermission');
  eq(perm?.result?.decision, 'allow', 'injected handler result reaches the runtime');
  const prefs = seen.find(m => m.id === 's1');
  ok(!!prefs && prefs.result?.memoryEnabled === true, 'default requestRuntimePreferences handler still active');
  const input = seen.find(m => m.id === 's3');
  ok(!!input && !input.error, 'default handler answered interaction/requestUserInput (no -32601)');
  eq(input?.result?.action, 'decline', 'headless default declines user input — never auto-approves a plan');
  // in-flight call must reject when the runtime exits mid-call (not hang to its timeout)
  const hang = c.call('hang', undefined, 10000);
  await c.call('die').catch(() => {}); // fake exits without replying -> this call rejects too
  let code = null;
  try { await hang; } catch (e) { code = e.code; }
  eq(code, 'E_RUNTIME_EXITED', 'in-flight call rejects on runtime exit');
  let dead = null;
  try { await c.call('anything'); } catch (e) { dead = e.message; }
  eq(dead, 'runtime exited', 'call after exit rejects via dead flag');
  c.close();
  // write-after-close must not crash the host process (stdin error sink)
  const c2 = new ZCodeProtocolClient({ runtime: FIXTURE });
  await c2.ready;
  c2.close();
  let why = '';
  try { await c2.call('x'); } catch (e) { why = e.message; }
  ok(why.length > 0, `call after close rejects cleanly, no crash (${why})`);
  // requestHandlers override wins over the built-in decline (same seam as requestPermission)
  const c3 = new ZCodeProtocolClient({ runtime: FIXTURE, requestHandlers: {
    'interaction/requestUserInput': () => ({ action: 'accept', content: { answers: { 'Approve?': ['approve'] } } }),
  } });
  await c3.ready;
  const seen3 = await c3.call('waitSeen');
  const input3 = seen3.find(m => m.id === 's3');
  eq(input3?.result?.action, 'accept', 'injected requestUserInput handler overrides the default');
  eq(input3?.result?.content?.answers?.['Approve?']?.[0], 'approve', 'injected answer payload reaches the runtime');
  c3.close();
  // sessionSid seam
  eq(sessionSid({ session: { sessionId: 'sess_1' } }), 'sess_1', 'sessionSid unwraps {session:{sessionId}}');
  eq(sessionSid({ sessionId: 'sess_2' }), 'sess_2', 'sessionSid unwraps flat {sessionId}');
  // overlapping turns must fail loudly, not silently drop the inner turn's events
  c._turnInFlight = true;
  let guarded = '';
  try { await runTurn(c, 's', 'x', { timeoutMs: 100 }); } catch (e) { guarded = e.message; }
  c._turnInFlight = false;
  ok(/already active/.test(guarded), 'runTurn refuses overlapping turns');
} finally { try { rmSync(FIXTURE); } catch {} }
import { turnAnswer } from './zcode-protocol.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
const regression = async (name, fn) => {
  try { await fn(); ok(true, name); }
  catch (error) { ok(false, name); console.error(error); }
};

const emit = (client, sessionId, turnId, kind) => client.onNotify({
  method: 'computer-use/operation-event', params: { sessionId, turnId, kind },
});
const fake = () => ({ onNotify() {}, child: new EventEmitter(), async call() { return { turnId: 'main' }; } });
const nextTick = () => new Promise(resolve => setImmediate(resolve));

await regression('foreign-session and stale-turn completions cannot finish the current turn', async () => {
  const client = fake(), original = client.onNotify;
  let finished = false;
  const running = runTurn(client, 'parent', 'hello', { timeoutMs: 1000 }).then(r => { finished = true; return r; });
  emit(client, 'parent', 'main', 'turn-started');
  emit(client, 'child', 'main', 'turn-completed');
  emit(client, 'parent', 'old', 'turn-completed');
  await nextTick();
  assert.equal(finished, false);
  emit(client, 'parent', 'main', 'turn-completed');
  const result = await running;
  assert.equal(result.end.turnId, 'main');
  assert.equal(result.events.some(e => e.params.sessionId === 'child'), false);
  assert.equal(client.onNotify, original);
  assert.equal(client.child.listenerCount('exit'), 0);
});

await regression('send acknowledgement identifies the turn when lifecycle arrives before its reply', async () => {
  const client = fake();
  client.call = async () => {
    emit(client, 'parent', 'old', 'turn-started');
    emit(client, 'parent', 'old', 'turn-completed');
    emit(client, 'parent', 'main', 'turn-started');
    emit(client, 'parent', 'main', 'turn-completed');
    return { turnId: 'main' };
  };
  assert.equal((await runTurn(client, 'parent', 'hello')).end.turnId, 'main');
});

await regression('stale same-session text, usage and tools are filtered before callbacks and collection', async () => {
  const client = fake(), consumed = [], broadcast = [];
  client.onNotify = msg => broadcast.push(msg);
  client.call = async () => {
    for (const method of ['message.updated', 'v4/telemetry/event', 'computer-use/operation-event']) {
      client.onNotify({ method, params: { sessionId: 'parent', turnId: 'old', kind: 'tool-started', text: 'STALE' } });
    }
    emit(client, 'parent', 'main', 'turn-started');
    emit(client, 'parent', 'main', 'turn-completed');
    return { turnId: 'main' };
  };
  const result = await runTurn(client, 'parent', 'hello', { onEvent: (kind, params) => consumed.push({ kind, params }) });
  assert.equal(broadcast.length, 5);
  assert.equal(result.events.length, 2);
  assert.deepEqual(consumed, result.events);
  assert.equal(consumed.some(e => e.params.turnId === 'old'), false);
});

await regression('legacy send replies without a turn ID bind completion to the observed start', async () => {
  const client = fake();
  client.call = async () => {
    emit(client, 'parent', 'main', 'turn-started');
    emit(client, 'parent', 'old', 'turn-completed');
    emit(client, 'parent', 'main', 'turn-failed');
    return {};
  };
  assert.deepEqual((await runTurn(client, 'parent', 'hello')).end, { ended: 'turn-failed', turnId: 'main' });
});

await regression('runtime exit after send acknowledgement rejects immediately and restores listeners', async () => {
  const client = fake(), original = client.onNotify;
  const running = runTurn(client, 'parent', 'hello', { timeoutMs: 10000 });
  await nextTick();
  client.child.emit('exit', 1);
  await assert.rejects(running, { code: 'E_RUNTIME_EXITED' });
  assert.equal(client.onNotify, original);
  assert.equal(client._turnInFlight, false);
  assert.equal(client.child.listenerCount('exit'), 0);
  assert.equal(client.child.listenerCount('error'), 0);
});

await regression('injectable clients can report runtime death through the public exited promise', async () => {
  const client = fake();
  delete client.child;
  client.exited = Promise.resolve({ code: 1 });
  await assert.rejects(runTurn(client, 'parent', 'hello', { timeoutMs: 10000 }), { code: 'E_RUNTIME_EXITED' });
});

await regression('send failure and timeout both restore the original notify consumer', async () => {
  const client = fake(), original = client.onNotify;
  client.call = async () => { throw new Error('send rejected'); };
  await assert.rejects(runTurn(client, 'parent', 'hello'), /send rejected/);
  assert.equal(client.onNotify, original);
  client.call = async () => ({});
  assert.equal((await runTurn(client, 'parent', 'hello', { timeoutMs: 5 })).end.ended, 'timeout');
  assert.equal(client.onNotify, original);
  assert.equal(client._turnInFlight, false);
  assert.equal(client.child.listenerCount('exit'), 0);
});

await regression('a late send acknowledgement cannot deliver events after turn timeout', async () => {
  const client = fake(), callbacks = [];
  let acknowledge;
  client.call = () => {
    client.onNotify({ method: 'v4/telemetry/event', params: { sessionId: 'parent', turnId: 'late', kind: 'usage.delta' } });
    return new Promise(resolve => { acknowledge = resolve; });
  };
  const result = await runTurn(client, 'parent', 'hello', { timeoutMs: 5, onEvent: (...args) => callbacks.push(args) });
  assert.equal(result.end.ended, 'timeout');
  acknowledge({ turnId: 'late' });
  await nextTick();
  assert.deepEqual(callbacks, []);
  assert.deepEqual(result.events, []);
  assert.equal(result.sendResult, undefined);
});

await regression('session/send shares the turn timeout budget, not the 20s call default', async () => {
  const client = fake(); let sendTimeout = null;
  client.call = async (method, params, timeoutMs) => {
    sendTimeout = timeoutMs;
    emit(client, 'parent', 'main', 'turn-started');
    emit(client, 'parent', 'main', 'turn-completed');
    return { turnId: 'main' };
  };
  await runTurn(client, 'parent', 'hello', { timeoutMs: 90000 });
  assert.equal(sendTimeout, 90000);
});

await regression('warmTurn never replays a quota error and closes an evicted client', async () => {
  clearSessionCache();
  const ws = `warmturn-test-${process.pid}`;
  let closes = 0, sends = 0, connects = 0;
  const connect = async () => { connects++; throw new Error('no runtime in test'); };
  const quotaClient = fake();
  quotaClient.close = () => { closes++; };
  // The real rejection shape: JSON-RPC code -32000, provider signature in message.
  quotaClient.call = async () => { sends++; throw Object.assign(new Error('ProviderBusinessError: [1308][usage limit]'), { code: -32000 }); };
  sessionCache.set(ws, { client: quotaClient, sessionId: 's', lastUsed: Date.now() });
  await assert.rejects(warmTurn(ws, 'x', { connect }), /ProviderBusinessError/);
  assert.equal(sends, 1, 'a quota failure is not replayed');
  assert.equal(connects, 0, 'no fresh session is created for a quota failure');
  assert.equal(closes, 0, 'a still-cached client is not closed');
  assert.equal(sessionCache.has(ws), true, 'quota failure keeps the cached session');

  const stale = fake();
  stale.close = () => { closes++; };
  stale.call = async () => { throw new Error('session gone'); };
  sessionCache.set(ws, { client: stale, sessionId: 's', lastUsed: Date.now() });
  await assert.rejects(warmTurn(ws, 'x', { connect }), /no runtime in test/);
  assert.equal(closes, 1, 'an evicted client is closed');
  assert.equal(connects, 1, 'a non-quota failure falls through to a fresh session');
  assert.equal(sessionCache.has(ws), false, 'evicted entry leaves the cache');

  const busy = fake();
  busy.close = () => { closes++; };
  busy.call = async () => { throw new Error('runTurn: another turn is already active on this client'); };
  sessionCache.set(ws, { client: busy, sessionId: 's', lastUsed: Date.now() });
  await assert.rejects(warmTurn(ws, 'x', { connect }), /another turn is already active/);
  assert.equal(closes, 1, 'a busy client is not closed under a concurrent caller');
  assert.equal(sessionCache.has(ws), true, 'in-flight session stays cached');

  const ws2 = `warmturn-fresh-${process.pid}`;
  const fresh = fake();
  fresh.close = () => { closes++; };
  fresh.createSession = async () => ({ sessionId: 's2' });
  fresh.call = async () => { throw new Error('first turn blew up'); };
  await assert.rejects(warmTurn(ws2, 'x', { connect: async () => fresh }), /first turn blew up/);
  assert.equal(closes, 2, 'a failed first turn closes the fresh client');
  assert.equal(sessionCache.has(ws2), false, 'a failed first turn is not left cached');
});

await regression('protocol preserves multibyte text across every possible stdout chunk boundary', () => {
  const text = '你好🙂 /tmp/文件';
  const bytes = Buffer.from(JSON.stringify({ method: 'event', params: { text } }) + '\n');
  for (let split = 1; split < bytes.length; split++) {
    const messages = [];
    const client = { buf: '', pending: new Map(), onNotify: m => messages.push(m) };
    ZCodeProtocolClient.prototype._feed.call(client, bytes.subarray(0, split));
    ZCodeProtocolClient.prototype._feed.call(client, bytes.subarray(split));
    assert.equal(messages[0].params.text, text, `split ${split}`);
  }
});

await regression('synchronous request handler errors produce an RPC error reply', async () => {
  const replies = [];
  const client = { buf: '', pending: new Map(), onNotify() {},
    child: { stdin: { write: line => replies.push(JSON.parse(line)) } },
    requestHandlers: { permission() { throw new Error('permission prompt closed'); } },
  };
  assert.doesNotThrow(() => ZCodeProtocolClient.prototype._feed.call(client, Buffer.from('{"id":7,"method":"permission"}\n')));
  await nextTick();
  assert.deepEqual(replies, [{ id: 7, error: { code: -32000, message: 'permission prompt closed' } }]);
});

await regression('turnAnswer returns current-turn text and returns no stale answer for an empty turn', async () => {
  const message = (id, role, text) => ({ info: { id, role }, parts: [{ type: 'text', text }] });
  const before = [message('u1', 'user', 'first'), message('a1', 'assistant', 'old answer')];
  const after = [...before, message('u2', 'user', 'second'), message('a2', 'assistant', 'new answer')];
  const client = { async call() { return { messages: after }; } };
  assert.equal(await turnAnswer(client, 's', { beforeMessages: before }), 'new answer');
  assert.equal(await turnAnswer(client, 's'), 'new answer');
  client.call = async () => ({ messages: before });
  assert.equal(await turnAnswer(client, 's', { beforeMessages: before }), '');
  client.call = async () => ({ messages: [before[1], after[3]] });
  assert.equal(await turnAnswer(client, 's'), 'new answer');
});

summary('driver unit');
