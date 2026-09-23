// session-control tests — fake client recording calls; param shapes asserted against
// the live-verified zod contracts (wrong shape = -32602 in the real runtime).
import { sessionUsage, compactSession, setModel, setThoughtLevel, setMode, MODES } from './session-control.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const fake = replies => { const calls = [];
  return { calls, call: async (method, params) => { calls.push({ method, params });
    const r = replies[method]; if (r instanceof Error) throw r; return r; } }; };

// usage: normalizes and passes junk through safely
let f = fake({ 'session/usage': { totalTokens: 100, inputTokens: 90, outputTokens: 10, inputBaselineBySource: { main_turn: 90 } } });
let u = await sessionUsage(f, 's1');
ok(u.totalTokens === 100 && u.baselineBySource.main_turn === 90, 'usage passthrough');
ok(f.calls[0].method === 'session/usage' && f.calls[0].params.sessionId === 's1', 'usage calls session/usage with sessionId');
f = fake({ 'session/usage': { totalTokens: 'junk', inputBaselineBySource: undefined } });
u = await sessionUsage(f, 's1');
ok(u.totalTokens === 0 && Object.keys(u.baselineBySource).length === 0, 'junk normalized to 0/{}');

// compact: params + timeout plumb
f = fake({ 'session/compact': { response: '', snapshot: { messages: [] } } });
const c = await compactSession(f, 's1');
ok(c.snapshot && f.calls[0].method === 'session/compact' && f.calls[0].params.sessionId === 's1', 'compact calls session/compact');

// setModel: {model: {modelId, providerId}} — string modelId is the -32602 trap
f = fake({ 'session/setModel': {} });
await setModel(f, 's1', 'glm-5.3-flash');
ok(f.calls[0].method === 'session/setModel' && JSON.stringify(f.calls[0].params.model) === '{"modelId":"glm-5.3-flash","providerId":"zai"}', 'setModel method + object shape');
await setModel(f, 's1', 'x', 'other-provider');
ok(f.calls[1].params.model.providerId === 'other-provider', 'providerId override');

// setThoughtLevel: key is thoughtLevel (not level — the -32602 trap)
f = fake({ 'session/setThoughtLevel': {} });
await setThoughtLevel(f, 's1', 'high');
ok(f.calls[0].method === 'session/setThoughtLevel' && f.calls[0].params.thoughtLevel === 'high' && !('level' in f.calls[0].params), 'setThoughtLevel method + thoughtLevel key');

// setMode: enum guard client-side
f = fake({ 'session/setMode': {} });
await setMode(f, 's1', 'yolo');
ok(f.calls[0].method === 'session/setMode' && f.calls[0].params.mode === 'yolo', 'setMode method + valid enum passes');
let threw = false; try { await setMode(f, 's1', 'YOLO'); } catch { threw = true; }
ok(threw, 'setMode rejects invalid (client-side, before the runtime roundtrip)');
ok(MODES.join(',') === 'plan,build,edit,yolo,auto', 'MODES catalog');

// error propagation
f = fake({}); f.call = async () => { const e = new Error('x'); e.code = -32601; throw e; };
threw = false; try { await compactSession(f, 's1'); } catch (e) { threw = e.code === -32601; }
ok(threw, 'runtime errors propagate');

console.log('part 1:', fails ? `FAIL (${fails})` : 'ok');

// subscribe/replay
import { subscribeSession, replayEvents, DELIVERY_KINDS } from './session-control.mjs';
f = fake({ 'session/subscribe': { eventSeq: 0, events: [], sessionId: 's1' }, 'session/events': { events: [1, 2] } });
const sub = await subscribeSession(f, 's1', 'desktop-continuous');
ok(sub.eventSeq === 0 && f.calls[0].method === 'session/subscribe' && f.calls[0].params.deliveryKind === 'desktop-continuous', 'subscribe shape');
ok((await replayEvents(f, 's1')).events.length === 2, 'replay');
let threw2 = false; try { await subscribeSession(f, 's1', 'bogus'); } catch { threw2 = true; }
ok(threw2, 'deliveryKind guard');
ok(DELIVERY_KINDS.join('|') === 'desktop-continuous|web-remote-replayable', 'enum catalog');
console.log('part 2:', fails ? `FAIL (${fails})` : 'ok');

// cursor forwarding + enum strictness
f = fake({ 'session/events': { events: [] }, 'session/subscribe': { eventSeq: 5, events: [] } });
await replayEvents(f, 's1', { afterSeq: 42, limit: 10 });
ok(f.calls.at(-1).params.afterSeq === 42 && f.calls.at(-1).params.limit === 10, 'cursor+limit forwarded');
await replayEvents(f, 's1', {});
ok(JSON.stringify(f.calls.at(-1).params) === '{"sessionId":"s1"}', 'undefined cursor/limit omitted');
await replayEvents(f, 's1', { afterSeq: -1, limit: 0 });
ok(!('afterSeq' in f.calls.at(-1).params) && !('limit' in f.calls.at(-1).params), 'invalid cursor/limit dropped');
let threw3 = false; try { await subscribeSession(f, 's1', 'Desktop-Continuous'); } catch { threw3 = true; }
ok(threw3, 'enum case-sensitive');
threw3 = false; try { await subscribeSession(f, 's1', ' desktop-continuous'); } catch { threw3 = true; }
ok(threw3, 'enum whitespace rejected');
await subscribeSession(f, 's1', 'web-remote-replayable', { includeSnapshot: true });
ok(f.calls.at(-1).params.includeSnapshot === true, 'includeSnapshot forwarded');



// event catalog
import { SESSION_EVENT_TYPES, sessionEventEnvelope, sessionEventMeta } from './session-control.mjs';
ok(SESSION_EVENT_TYPES.length === 6 && SESSION_EVENT_TYPES.includes('model.streaming'), 'catalog from live capture');
const env = sessionEventEnvelope({ type: 'turn.started', seq: 2, turnId: 't1', payload: { input: 'x' } });
ok(env.type === 'turn.started' && env.seq === 2 && env.deliveryKind === null, 'envelope normalize');
ok(sessionEventEnvelope(null).type === null, 'null safe');



// exact envelope object, malformed metadata, meta projection
const env2 = sessionEventEnvelope({ type: 'turn.started', seq: 'not-int', turnId: 7, deliveryKind: 'desktop-continuous', payload: { input: 'secret-ish' }, junk: 1 });
ok(JSON.stringify(env2) === '{"type":"turn.started","seq":null,"turnId":null,"deliveryKind":"desktop-continuous","payload":{"input":"secret-ish"}}', 'malformed metadata nulled, extra fields stripped, payload preserved raw');
ok(JSON.stringify(sessionEventMeta(env2)) === '{"type":"turn.started","seq":null,"turnId":null,"deliveryKind":"desktop-continuous"}', 'meta projection carries NO payload');
ok(JSON.stringify(sessionEventEnvelope(null)) === '{"type":null,"seq":null,"turnId":null,"deliveryKind":null,"payload":null}', 'full null shape exact');
console.log(fails ? `FAIL (${fails})` : 'PASS session-control');
process.exit(fails ? 1 : 0);
