// listSubagents tests — fake client, shape from live probe 2026-09-05.
import { listSubagents } from './session-control.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const fake = r => { const calls = []; return { calls, call: async (m, p) => { calls.push({ m, p }); return r; } }; };

const f1 = fake({ revision: 2, childSessionIds: ['a', 'b'], running: [], ended: { total: 0, items: [] } });
let s = await listSubagents(f1, 's1');
ok(s.revision === 2 && s.childSessionIds.length === 2 && s.endedCount === 0, 'passthrough');
// oracle (review r4): the RIGHT RPC must be called with the RIGHT params — a fake that
// answers any method lets a wrong-method regression pass silently.
ok(f1.calls.length === 1 && f1.calls[0].m === 'session/subagents' && f1.calls[0].p.sessionId === 's1', 'calls session/subagents with sessionId');
ok(JSON.stringify(f1.calls[0].p) === '{"sessionId":"s1"}', 'params exactly {sessionId}');
s = await listSubagents(fake({}), 's1');
ok(s.revision === 0 && Array.isArray(s.childSessionIds) && Array.isArray(s.ended), 'junk -> safe defaults');
s = await listSubagents(fake({ running: [{ sid: 'r1' }], ended: { total: 3, items: [{}, {}] } }), 's1');
ok(s.running.length === 1 && s.endedCount === 3 && s.ended.length === 2, 'running/ended arrays preserved');
console.log(fails ? `FAIL (${fails})` : 'PASS subagents');
process.exit(fails ? 1 : 0);
