// Real-oracle test: drives the actual runtime; asserts protocol round trips. Zero model calls = zero quota.
import { ZCodeProtocolClient, sessionSid } from './zcode-protocol.mjs';
import { assert } from './test-util.mjs';
const c = new ZCodeProtocolClient({ cwd: process.cwd() });
await c.ready; // event-driven readiness — replaces the old fixed 1200ms sleep
const list = await c.listSessions();
assert(Array.isArray(list.sessions) && list.sessions.length >= 0, `session/list returns array (${list.sessions?.length ?? '?'} sessions)`);
const sid = sessionSid(await c.createSession(process.cwd()));
assert(!!sid?.startsWith('sess_'), `session/create returns sess_ id (${sid?.slice(0, 14)}…)`);
const read = await c.readSession(sid);
assert(read.sessionId === sid || !!read.session, 'session/read round-trips');
let notFound = false;
try { await c.call('bogus/method', {}); } catch (e) { notFound = e.code === -32601; }
assert(notFound, 'unknown method -> -32601');
c.close();
// ready must reject (not hang) when the runtime cannot boot at all.
const bad = new ZCodeProtocolClient({ runtime: '/nonexistent/zcode-runtime.mjs', cwd: process.cwd() });
let bootFailed = false;
try { await bad.ready; } catch { bootFailed = true; }
assert(bootFailed, 'ready rejects when the runtime fails to boot');
console.log('PASS driver test');
process.exit(0);
