// D3 phase-2 test: router answers controller app-payloads with the envelope shapes the
// relay data channel carries ({type:"data",payload:{zcode_type}} in; routed reply out).
// The official web controller cannot be scripted headlessly, so this verifies the device
// side deterministically; the relay wiring itself is live-verified in test-relay runs.
import { routePayload } from './controller-router.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const ctx = { deviceSid: 'd_E2E', tasks: [{ id: 't1', title: 'demo' }], initialViewState: { tab: 'tasks' } };
const req = { zcode_type: 'bootstrap-request', requestId: 'e2e-1' };
const reply = routePayload(req, ctx);
ok(reply?.zcode_type === 'bootstrap-response' && reply.requestId === 'e2e-1' && reply.success === true,
   'router answers bootstrap (requestId preserved, success)');
ok(reply.result.tasks.length === 1 && reply.result.initialViewState.tab === 'tasks',
   'ctx (tasks/initialViewState) flows into the controller view');

const wl = routePayload({ zcode_type: 'workspace-list-request', requestId: 'e2e-2' }, ctx);
ok(Array.isArray(wl?.result?.workspaces), 'workspace-list serves the registry shape');

console.log(fails ? `FAIL (${fails})` : 'PASS d3 phase-2');
process.exit(fails ? 1 : 0);
