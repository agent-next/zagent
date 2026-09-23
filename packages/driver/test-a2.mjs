// A2 real-oracle test: full turn E2E — one tiny model call.
import { ZCodeProtocolClient, sessionSid, runTurn } from './zcode-protocol.mjs';
import { assert } from './test-util.mjs';
const c = new ZCodeProtocolClient({ cwd: process.cwd() });
await c.ready; // event-driven readiness — replaces the old fixed 1200ms sleep
const sid = sessionSid(await c.createSession(process.cwd()));
assert(!!sid?.startsWith('sess_'), `session created (${sid?.slice(0, 14)}…)`);
const t0 = Date.now();
const { events, end } = await runTurn(c, sid, 'Reply with exactly: OK');
const kinds = events.map(e => e.kind);
if (process.env.A2_DEBUG) kinds.forEach(k => console.log('   evt:', k));
const completed = end.ended === 'turn-completed';
assert(completed, `turn completed (end=${end.ended}, ${kinds.length} events, ${((Date.now()-t0)/1000).toFixed(1)}s)`);
console.log('   event kinds:', [...new Set(kinds)].slice(0, 12).join(', '));
const read = await c.readSession(sid);
const lastMsg = JSON.stringify(read);
assert(/"OK"|OK/.test(lastMsg.slice(-2000)), 'final message contains OK');
c.close(); console.log('PASS a2 test'); process.exit(0);
