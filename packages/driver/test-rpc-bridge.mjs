// D3 rpc-bridge round-trip tests — relay envelope shape + codec + fake RPC executor.
import { createRpcBridge } from './rpc-bridge.mjs';
import { buildFrames, frameValidationError, LIMITS } from './rpc-frame.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); }

const sent = [];
const send = p => sent.push(p);
const calls = [];
const call = async (method, params) => { calls.push({ method, params }); if (method === 'boom') { const e = new Error('kaput'); e.code = -32601; throw e; } return { ok: true, echo: params?.x }; };
const br = createRpcBridge({ send, call });

// single-fragment request → ack + response frame carrying the RPC result
const req = { jsonrpc: '2.0', id: 7, method: 'session/usage', params: { x: 42 } };
let r = await br.ingest({ ...buildFrames({ bridgeSessionId: 'b1', message: JSON.stringify(req), seq: 1, messageSeq: 1 })[0] });
ok(r.handled === 'replied', 'single-fragment replied');
ok(calls[0].method === 'session/usage' && calls[0].params.x === 42, 'RPC executed with parsed body');
const ackFrame = sent.find(p => p.payload.zcode_type === 'rpc-frame-ack');
ok(ackFrame?.payload.ackMessageSeq === 1 && ackFrame.payload.bridgeSessionId === 'b1', 'receipt ack for request messageSeq');
const respFrame = sent.filter(p => p.payload.zcode_type === 'rpc-frame').at(-1);
ok(JSON.parse(respFrame.payload.dataBase64 ? atob(respFrame.payload.dataBase64) : '{}') === null || true, 'placeholder');
import { assembleFrames } from './rpc-frame.mjs';
const respMsg = JSON.parse(assembleFrames([respFrame.payload]).message);
ok(respMsg.id === 7 && respMsg.result.echo === 42, 'response frame assembles to the RPC result');

// multi-fragment: all parts before assembly; ack only after complete
sent.length = 0;
const big = JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'm', params: { blob: 'z'.repeat(3000) } });
const frames = buildFrames({ bridgeSessionId: 'b2', message: big, seq: 1, messageSeq: 5, maxBytesPerFrame: 1000 });
r = await br.ingest(frames[1]);
ok(r.handled === 'partial' && frames.length === 4 && !sent.some(p => p.payload.zcode_type === 'rpc-frame-ack'), 'no ack on partial (4 fragments expected)');
for (let i = 0; i < frames.length; i++) if (i !== 1) await br.ingest(frames[i]); // all remaining, order shuffled
ok(sent.some(p => p.payload.zcode_type === 'rpc-frame-ack' && p.payload.ackMessageSeq === 5), 'ack after full assembly');
ok(br.buffered() === 0, 'buffer cleaned after assembly');

// duplicate fragment refused (desktop strictness)
sent.length = 0;
await br.ingest({ ...buildFrames({ bridgeSessionId: 'b3', message: JSON.stringify({ id: 1, method: 'm' }), seq: 1, messageSeq: 9 })[0] });
const dup = { ...buildFrames({ bridgeSessionId: 'b3', message: JSON.stringify({ id: 1, method: 'm' }), seq: 1, messageSeq: 9 })[0] };
r = await br.ingest(dup);
ok(r.handled === 'duplicate', 'duplicate fragment not double-buffered');

// malformed frame rejected pre-buffer
r = await br.ingest({ zcode_type: 'rpc-frame', bridgeSessionId: 'bad id!', seq: 1, messageSeq: 1, fragmentIndex: 0, fragmentCount: 1, messageBytes: 1, checksum: { algorithm: 'crc32', value: 'deadbeef' }, dataBase64: 'AAAA' });
ok(r.handled === 'invalid', 'malformed frame rejected');

// RPC error path -> error object framed, not a crash
sent.length = 0;
await br.ingest(buildFrames({ bridgeSessionId: 'b4', message: JSON.stringify({ id: 2, method: 'boom' }), seq: 1, messageSeq: 3 })[0]);
const errFrame = sent.filter(p => p.payload.zcode_type === 'rpc-frame').at(-1);
const errMsg = JSON.parse(assembleFrames([errFrame.payload]).message);
ok(errMsg.error.code === -32601 && errMsg.error.message === 'kaput', 'RPC error framed as JSON-RPC error');

// passthrough types
ok((await br.ingest({ zcode_type: 'bootstrap-request', requestId: 'r' })).handled === 'ignored', 'non-rpc payloads ignored');
ok((await br.ingest({ zcode_type: 'rpc-frame-ack', bridgeSessionId: 'b', ackMessageSeq: 12 })).handled === 'ack', 'acks acknowledged');

// guard
let threw = false; try { createRpcBridge({}); } catch { threw = true; }
ok(threw, 'constructor guards missing send/call');

console.log('interim:', fails ? `FAIL (${fails})` : 'ok');

// --- r9: per-fragment seq, per-bridge counters, generation echo, bounded state ---
const sent2 = []; const br2 = createRpcBridge({ send: p => sent2.push(p), call: async () => ({ r: 1 }) });
// multi-fragment response: distinct physical seq per fragment (r9 #3)
sent2.length = 0;
await br2.ingest(buildFrames({ bridgeSessionId: 's9', message: JSON.stringify({ id: 1, method: 'm', params: { b: 'y'.repeat(3000) } }), seq: 1, messageSeq: 1, maxBytesPerFrame: 1000 })[0]);
const rf = sent2.filter(p => p.payload.zcode_type === 'rpc-frame').map(p => p.payload.seq);
ok(new Set(rf).size === rf.length, 'response fragments carry DISTINCT seqs');
ok(rf.every((v, i) => i === 0 || v > rf[i - 1]), 'seqs monotonic');

// interleaved bridges: no shared counter (r9 #4)
sent2.length = 0;
await br2.ingest(buildFrames({ bridgeSessionId: 'ib1', message: JSON.stringify({ id: 1, method: 'm' }), seq: 1, messageSeq: 1 })[0]);
await br2.ingest(buildFrames({ bridgeSessionId: 'ib2', message: JSON.stringify({ id: 2, method: 'm' }), seq: 1, messageSeq: 1 })[0]);
await br2.ingest(buildFrames({ bridgeSessionId: 'ib1', message: JSON.stringify({ id: 3, method: 'm' }), seq: 2, messageSeq: 2 })[0]);
const s1 = sent2.filter(p => p.payload.bridgeSessionId === 'ib1' && p.payload.zcode_type === 'rpc-frame').map(p => p.payload.seq);
ok(s1.length === 2 && s1[0] === 1 && s1[1] === 2, 'ib1 own seq stream contiguous despite ib2 interleave');

// generation echoed on ack + frames (r9 #5)
sent2.length = 0;
await br2.ingest(buildFrames({ bridgeSessionId: 'g7', bridgeGeneration: 7, message: JSON.stringify({ id: 1, method: 'm' }), seq: 1, messageSeq: 1 })[0]);
ok(sent2.find(p => p.payload.zcode_type === 'rpc-frame-ack')?.payload.bridgeGeneration === 7, 'ack echoes generation');
ok(sent2.filter(p => p.payload.zcode_type === 'rpc-frame').every(p => p.payload.bridgeGeneration === 7), 'response frames echo generation');
// same messageSeq in a NEW generation is NOT a replay
const r2g = await br2.ingest(buildFrames({ bridgeSessionId: 'g7', bridgeGeneration: 8, message: JSON.stringify({ id: 1, method: 'm' }), seq: 5, messageSeq: 1 })[0]);
ok(r2g.handled === 'replied', 'generation change re-accepts the same messageSeq');

// assembly timeout: stale partials evicted (r9 #1)
let t = 1000; const br3 = createRpcBridge({ send: () => {}, call: async () => ({}), now: () => t });
await br3.ingest(buildFrames({ bridgeSessionId: 'to', message: JSON.stringify({ id: 1, method: 'm', params: { b: 'z'.repeat(3000) } }), seq: 1, messageSeq: 1, maxBytesPerFrame: 1000 })[0]);
ok(br3.buffered('to') === 1, 'partial buffered');
t += LIMITS.assemblyTimeoutMs + 1;
await br3.ingest(buildFrames({ bridgeSessionId: 'to', message: JSON.stringify({ id: 2, method: 'm' }), seq: 9, messageSeq: 9 })[0]);
ok(br3.buffered('to') === 0, 'stale partial evicted on touch (30s assembly timeout)');

// bounded replay window (r9 #2)
const sent4 = []; const br4 = createRpcBridge({ send: p => sent4.push(p), call: async () => ({}) });
for (let i = 1; i <= 600; i++) await br4.ingest(buildFrames({ bridgeSessionId: 'w', message: JSON.stringify({ id: i, method: 'm' }), seq: i, messageSeq: i })[0]);
const early = await br4.ingest(buildFrames({ bridgeSessionId: 'w', message: JSON.stringify({ id: 0, method: 'm' }), seq: 1, messageSeq: 1 })[0]);
ok(early.handled === 'replied', 'replay window is BOUNDED (seq 1 forgotten after 512 newer)');

import assert from 'node:assert/strict';
const regression = async (name, fn) => {
  try { await fn(); ok(true, name); }
  catch (error) { ok(false, name); console.error(error); }
};

const partial = messageSeq => buildFrames({ bridgeSessionId: 'budget', messageSeq,
  message: JSON.stringify({ id: messageSeq, method: 'm', params: { text: 'x'.repeat(100) } }), maxBytesPerFrame: 10,
})[0];

await regression('incoming frame and declared message size limits are enforced before assembly', () => {
  const base = partial(1);
  assert.equal(frameValidationError({ ...base, messageBytes: 2 ** 40 }), 'messageBytes');
  assert.equal(frameValidationError({ ...base, dataBase64: Buffer.alloc(128 * 1024).toString('base64') }), 'dataBase64');
  assert.equal(frameValidationError({ ...base, bridgeSessionId: 'x'.repeat(257) }), 'bridgeSessionId');
  assert.equal(frameValidationError({ ...base, bridgeGeneration: -1 }), 'bridgeGeneration');
  assert.throws(() => buildFrames({ bridgeSessionId: 'b', message: 'x', maxBytesPerFrame: 0 }), /positive integer/);
});

await regression('partial-message count is bounded for a single bridge session', async () => {
  const bridge = createRpcBridge({ send() {}, call: async () => ({}) });
  try {
    for (let n = 1; n <= LIMITS.maxBufferedMessages; n++) assert.equal((await bridge.ingest(partial(n))).handled, 'partial');
    assert.equal((await bridge.ingest(partial(LIMITS.maxBufferedMessages + 1))).reason, 'assembly budget exceeded');
    assert.equal(bridge.buffered(), LIMITS.maxBufferedMessages);
    assert.equal(bridge.bufferedBytes(), LIMITS.maxBufferedMessages * 10);
  } finally { bridge.close(); }
  assert.equal(bridge.bufferedBytes(), 0);
});

await regression('incoming partial bytes are bounded independently of the message count', async () => {
  const bridge = createRpcBridge({ send() {}, call: async () => ({}) });
  const dataBase64 = Buffer.alloc(LIMITS.maxPhysicalFrameBytes).toString('base64');
  try {
    for (let n = 1; n <= 2; n++) {
      for (let index = 0; index < 63; index++) {
        const f = { ...partial(n), fragmentCount: 64, fragmentIndex: index, messageBytes: LIMITS.maxMessageBytes, dataBase64 };
        assert.equal((await bridge.ingest(f)).handled, 'partial');
      }
    }
    await bridge.ingest({ ...partial(3), fragmentCount: 64, messageBytes: LIMITS.maxMessageBytes, dataBase64 });
    await bridge.ingest({ ...partial(3), fragmentCount: 64, fragmentIndex: 1, messageBytes: LIMITS.maxMessageBytes, dataBase64 });
    assert.equal(bridge.bufferedBytes(), LIMITS.maxBufferedBytes);
    assert.equal((await bridge.ingest({ ...partial(3), fragmentCount: 64, fragmentIndex: 2, messageBytes: LIMITS.maxMessageBytes, dataBase64 })).reason, 'assembly budget exceeded');
    assert.equal(bridge.bufferedBytes(), LIMITS.maxBufferedBytes);
  } finally { bridge.close(); }
});

await regression('silent incomplete assemblies expire without another inbound frame', async () => {
  let expired;
  const expiration = new Promise(resolve => { expired = resolve; });
  const bridge = createRpcBridge({ send() {}, call: async () => ({}), assemblyTimeoutMs: 5,
    onEvent: type => { if (type === 'assembly-timeout') expired(); },
  });
  let guard;
  try {
    await bridge.ingest(partial(1));
    await Promise.race([expiration, new Promise((resolve, reject) => { guard = setTimeout(() => reject(new Error('assembly was not expired')), 1000); })]);
    assert.equal(bridge.buffered(), 0);
    assert.equal(bridge.bufferedBytes(), 0);
  } finally { clearTimeout(guard); bridge.close(); }
});

await regression('invalid JSON requests receive framed errors without invoking the executor', async () => {
  const sent = [];
  let calls = 0;
  const bridge = createRpcBridge({ send: p => sent.push(p.payload), call: async () => { calls++; } });
  try {
    for (const [index, message] of ['null', '[]', '7', '{}', '{"id":1,"method":2}', '{"id":1,"method":"m","params":null}', '{broken'].entries()) {
      sent.length = 0;
      assert.equal((await bridge.ingest(buildFrames({ bridgeSessionId: 'invalid', messageSeq: index + 1, message })[0])).handled, 'replied');
      const response = JSON.parse(assembleFrames(sent.filter(f => f.zcode_type === 'rpc-frame')).message);
      assert.equal(response.id, null);
      assert.equal(response.error.code, message === '{broken' ? -32700 : -32600);
      assert.equal(sent.filter(f => f.zcode_type === 'rpc-frame-ack').length, 1);
    }
    assert.equal(calls, 0);
    assert.equal(bridge.bufferedBytes(), 0);
  } finally { bridge.close(); }
});

await regression('oversized request IDs are rejected before execution and the response remains encodable', async () => {
  const sent = [];
  let calls = 0;
  const bridge = createRpcBridge({ send: p => sent.push(p.payload), call: async () => { calls++; return {}; } });
  try {
    const frames = buildFrames({ bridgeSessionId: 'large-id', message: JSON.stringify({ id: 'x'.repeat(1600000), method: 'm' }),
      maxBytesPerFrame: LIMITS.maxPhysicalFrameBytes });
    for (const frame of frames) await bridge.ingest(frame);
    assert.equal(calls, 0);
    const response = JSON.parse(assembleFrames(sent.filter(f => f.zcode_type === 'rpc-frame')).message);
    assert.equal(response.id, null);
    assert.equal(response.error.code, -32600);
    assert.equal(bridge.bufferedBytes(), 0);
  } finally { bridge.close(); }
});

await regression('a slow executor cannot bypass outstanding request admission limits', async () => {
  const release = [], tasks = [];
  const bridge = createRpcBridge({ send() {}, call: () => new Promise(resolve => release.push(resolve)) });
  try {
    for (let n = 1; n <= LIMITS.maxBufferedMessages; n++) {
      tasks.push(bridge.ingest(buildFrames({ bridgeSessionId: 'slow', messageSeq: n, message: JSON.stringify({ id: n, method: 'm' }) })[0]));
    }
    const next = await bridge.ingest(buildFrames({ bridgeSessionId: 'slow', messageSeq: 1000, message: '{"id":1000,"method":"m"}' })[0]);
    assert.equal(next.reason, 'assembly budget exceeded');
    assert.equal(release.length, LIMITS.maxBufferedMessages);
  } finally { for (const resolve of release) resolve({}); await Promise.all(tasks); bridge.close(); }
  assert.equal(bridge.bufferedBytes(), 0);
});

console.log(fails ? `FAIL (${fails})` : 'PASS rpc-bridge');
process.exit(fails ? 1 : 0);
