// D3 router test — mock frame injection (no relay, no phone; shapes from the catalog).
import { routePayload, APP_TYPES, workspaces } from './controller-router.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const seen = { view: [], err: [] };
const ctx2 = { deviceSid: 'd_TEST', onViewState: (v) => seen.view.push(v), onError: (e) => seen.err.push(e) };

// 1) catalog completeness
ok(APP_TYPES.length === 18, `catalog has 18 types (${APP_TYPES.length})`);

// 2) bootstrap round-trip shape
const bs = routePayload({ zcode_type: 'bootstrap-request', requestId: 'r1' }, ctx2);
ok(bs.zcode_type === 'bootstrap-response' && bs.requestId === 'r1' && bs.success === true, 'bootstrap -> response shape');
ok(Array.isArray(bs.result.workspaces), 'bootstrap carries a workspaces array (machine-independent)');
ok(bs.result.windowControlSessionId === 'd_TEST', 'windowControlSessionId = deviceSid');

// 3) workspace-list round-trip
const wl = routePayload({ zcode_type: 'workspace-list-request', requestId: 'r2' }, ctx2);
ok(wl.zcode_type === 'workspace-list-response' && Array.isArray(wl.result.workspaces), 'workspace-list -> response');

// 4) view-state update fires callback, no reply
const vs = routePayload({ zcode_type: 'mobile-view-state-update', viewState: { tab: 'tasks' } }, ctx2);
ok(vs === null && seen.view.length === 1, 'view-state -> callback, no reply');

// 5) platform-request declines explicitly
const pr = routePayload({ zcode_type: 'platform-request', requestId: 'r3', method: 'isDockerAvailable' }, ctx2);
ok(pr.zcode_type === 'platform-response' && pr.success === false, 'platform-request -> explicit not-implemented');

// 6) unknown/push types pass silently
ok(routePayload({ zcode_type: 'workspace-list-updated' }, ctx2) === null, 'push types -> null');

// 7) real registry reads the actual setting.json
ok(Array.isArray(workspaces()), 'workspaces() survives missing registry (env-independent)');

console.log(fails ? `FAIL (${fails})` : 'PASS router test');
process.exit(fails ? 1 : 0);
