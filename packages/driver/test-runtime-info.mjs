// CP-3 tests — fake client with per-method error codes (the -32601/-32602 oracle).
import assert from 'node:assert/strict';
import { probeMethod, runtimeCapabilities, capabilityLine, PROBE_METHODS } from './runtime-info.mjs';

const fake = codes => ({ call: async m => { if (codes[m] === 'ok') return {}; const e = new Error('x'); e.code = codes[m]; throw e; } });
assert.deepEqual(await probeMethod(fake({ a: 'ok' }), 'a'), { present: true, kind: 'ok' });
assert.deepEqual(await probeMethod(fake({ a: -32601 }), 'a'), { present: false, kind: 'absent' });
assert.deepEqual(await probeMethod(fake({ a: -32602 }), 'a'), { present: true, kind: 'param-rejected' });
const incon = await probeMethod(fake({ a: -32603 }), 'a');
assert.equal(incon.present, null); // no verdict on other errors
assert.equal((await probeMethod(fake({}), 'a')).present, null); // unclassifiable error → inconclusive, never guessed-absent

const codes = {}; for (const m of PROBE_METHODS) codes[m] = -32603; // default inconclusive
codes['session/goal'] = -32602; codes['session/fork'] = 'ok';
for (const m of ['artifacts/exec', 'automation/list', 'completion/complete', 'conversation/subscribe']) codes[m] = -32601;
const caps = await runtimeCapabilities(fake(codes), { methods: [...PROBE_METHODS] });
assert.ok(caps.present.includes('session/goal') && caps.present.includes('session/fork'));
assert.ok(caps.absent.includes('artifacts/exec'));
assert.equal(caps.inconclusive.length, 11); // remaining methods throw -32603 (inconclusive by design)
const line = capabilityLine(caps);
assert.ok(line.includes('2/17') || /\/17 methods/.test(line), line);
assert.ok(line.includes('sentinels'), 'sentinel discounting in line');

console.log('PASS runtime-info');
