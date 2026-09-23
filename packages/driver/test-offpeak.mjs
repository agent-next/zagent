// Off-peak scheduler + ticket lifecycle tests — pure functions, deterministic.
import { inOffPeak, campaignActive, routeToFlash, minutesUntilWindow, defaultWindow,
         nextDelayMs, classifyOffPeakError } from './offpeak.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const W = defaultWindow();

const midnightSGT = new Date('2026-09-04T16:00:00Z'); // 00:00 SGT
const noonSGT = new Date('2026-09-04T04:00:00Z');     // 12:00 SGT
const beforeWindow = new Date('2026-09-04T14:00:00Z'); // 22:00 SGT
const insideEarly = new Date('2026-09-04T17:00:00Z');  // 01:00 SGT

// Window checks
ok(inOffPeak(midnightSGT, W), 'midnight SGT inside window');
ok(inOffPeak(insideEarly, W), '01:00 SGT inside window');
ok(!inOffPeak(noonSGT, W), 'noon SGT outside window');
ok(!inOffPeak(beforeWindow, W), '22:00 SGT outside (before 23:00)');

// Campaign timing
ok(campaignActive(new Date('2026-09-10T00:00:00Z'), W), 'campaign active on 09-10');
ok(!campaignActive(new Date('2026-09-21T02:00:00Z'), W), 'campaign ended by 09-21 09:00 SGT');

// Routing
ok(routeToFlash(midnightSGT, { mechanical: true, win: W }).flash === true, 'mechanical+in-window → flash');
ok(routeToFlash(midnightSGT, { mechanical: false, win: W }).flash === false, 'judgment → never flash');
ok(routeToFlash(noonSGT, { mechanical: true, win: W }).flash === false, 'outside window → no flash');
ok(routeToFlash(new Date('2026-09-25T16:00:00Z'), { mechanical: true, win: W }).flash === false, 'after campaign → no flash');

// Countdown
ok(minutesUntilWindow(midnightSGT, W) === 0, 'already in window: 0 min');
ok(minutesUntilWindow(noonSGT, W) === 660, 'noon sharp → 660 min');
ok(minutesUntilWindow(beforeWindow, W) === 60, '22:00 → 60 min');

// Poll delay
ok(nextDelayMs({ body: { data: { next_poll_after: 30 } } }) === 30000, 'poll delay 30s from server');
ok(nextDelayMs({ body: {} }) === 5000, 'default poll delay 5s');
ok(nextDelayMs({ body: { data: { next_poll_after: 1 } } }) === 5000, 'min clamp 5s');
ok(nextDelayMs({ body: { data: { next_poll_after: 999 } } }) === 300000, 'max clamp 300s');
ok(nextDelayMs({}, 1) === 10000, 'error backoff round 1 = 10s');
ok(nextDelayMs({}, 3) === 40000, 'error backoff round 3 = 40s');
ok(nextDelayMs({}, 10) === 300000, 'error backoff cap 5min');

// Error classification
ok(classifyOffPeakError(429, 3102).action === 'abort_retake', '3102 → abort+retake');
ok(classifyOffPeakError(400, 3001).action === 'invalid_request', '3001 parameter error must not trigger retake');
ok(classifyOffPeakError(200, 3105).action === 'wait', '3105 → wait');
ok(classifyOffPeakError(429, 0).retry === true, '429 → retry');
ok(classifyOffPeakError(200, 3103).action === 'quota_wait', '3103 → quota wait');
ok(classifyOffPeakError(200, 3101).action === 'eligibility_fail', '3101 → eligibility fail');

// Gate: explicit can_take_number === true only; empty 200 data = NOT eligible.
import { gateFromAvailability } from './offpeak.mjs';
import assert from 'node:assert/strict';
import { offPeakTurn, onPollResult, offPeakPlanKey, offPeakRequest } from './offpeak.mjs';
const previousFetch = globalThis.fetch;
const previousDeviceMid = process.env.ZCODE_DEVICE_MID;
try {
  process.env.ZCODE_DEVICE_MID = 'fixture-device';
  globalThis.fetch = async () => ({ status: 200, json: async () => { throw new SyntaxError('fixture invalid JSON'); } });
  await assert.rejects(offPeakRequest('/ticket/owned/settle', {}, { jwt: 'fixture-jwt', apiKey: 'fixture-key' }), /Invalid off-peak ticket JSON/);
  globalThis.fetch = async () => ({ status: 200, json: async () => ({}) });
  assert.deepEqual(await offPeakRequest('/ticket/owned/settle', {}, { jwt: 'fixture-jwt', apiKey: 'fixture-key' }), { status: 200, body: {} });
  // Desktop-credentialed ticket calls refuse redirects and stay bounded, and a
  // transport failure never leaks the request headers it was carrying.
  let sent;
  globalThis.fetch = async (url, init) => { sent = init; return { status: 200, json: async () => ({}) }; };
  await offPeakRequest('/ticket/owned/settle', {}, { jwt: 'fixture-jwt', apiKey: 'fixture-key' });
  assert.equal(sent.redirect, 'error');
  assert.ok(sent.signal instanceof AbortSignal, 'ticket calls carry an abort timeout');
  globalThis.fetch = async () => { throw new Error('net fail Authorization: Bearer test-token test-key'); };
  await assert.rejects(offPeakRequest('/ticket/owned/settle', {}, { jwt: 'fixture-jwt', apiKey: 'fixture-key' }),
    e => { assert.doesNotMatch(e.message, /fixture-jwt|fixture-key|test-token|test-key|Authorization/); return true; });
} finally {
  globalThis.fetch = previousFetch;
  if (previousDeviceMid === undefined) delete process.env.ZCODE_DEVICE_MID;
  else process.env.ZCODE_DEVICE_MID = previousDeviceMid;
}
// Credentials resolve BEFORE the transport try/catch: a missing desktop
// connection surfaces as its own error and fetch is never reached.
{
  const previousHome = process.env.HOME;
  const previousMid = process.env.ZCODE_DEVICE_MID;
  let fetchCalls = 0;
  try {
    process.env.HOME = `/nonexistent-zcode-home-${process.pid}`;
    delete process.env.ZCODE_DEVICE_MID;
    globalThis.fetch = async () => { fetchCalls++; return { status: 200, json: async () => ({}) }; };
    await assert.rejects(offPeakRequest('/ticket', {}, { jwt: 'j' }),
      e => { assert.doesNotMatch(e.message, /transport failed/);
        return /Cannot read the selected desktop Coding Plan connection/.test(e.message); });
    await assert.rejects(offPeakRequest('/ticket', {}, { jwt: 'j', apiKey: 'k' }), /device mid unknown/);
    assert.equal(fetchCalls, 0, 'missing credentials must not reach fetch');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousMid === undefined) delete process.env.ZCODE_DEVICE_MID; else process.env.ZCODE_DEVICE_MID = previousMid;
  }
}
const connection = { activeProvider: 'zai', settings: { providerFamilyDomain: 'zai',
  modelProviderFamilyModes: { zai: 'oauth' }, modelProviderFamilySelectedKeys: { zai: 'coding-plan:builtin:zai-coding-plan' } },
  config: { provider: { 'builtin:zai-coding-plan': { options: { baseURL: 'https://api.z.ai/api/anthropic', apiKey: 'desktop-plan-key' } } } } };
assert.equal(offPeakPlanKey(connection), 'desktop-plan-key');
assert.throws(() => offPeakPlanKey({ ...connection, activeProvider: 'bigmodel' }), /personal Z.ai/);
assert.throws(() => offPeakPlanKey({ ...connection, config: {} }), /unavailable/);
for (const mode of ['apiKey', undefined]) assert.throws(() => offPeakPlanKey({ ...connection,
  settings: { ...connection.settings, modelProviderFamilyModes: { zai: mode } } }), /personal Z.ai/);
for (const key of ['', 'bad\nkey', 'bad key']) {
  const bad = structuredClone(connection); bad.config.provider['builtin:zai-coding-plan'].options.apiKey = key;
  assert.throws(() => offPeakPlanKey(bad), /invalid/);
}
const queued = { state: 'queued', ticketId: 'owned' };
assert.equal(onPollResult(queued, { data: { tickets: [{ ticket_id: 'owned', state: 'ready' }] } }).state, 'ready');
assert.equal(onPollResult(queued, { data: { tickets: [{ ticket_id: 'owned', state: 'active' }] } }).state, 'running');
assert.equal(onPollResult(queued, { data: { tickets: [{ ticket_id: 'owned', state: 'settled' }] } }).state, 'settled');
assert.equal(onPollResult(queued, { data: { tickets: [{ ticket_id: 'other', state: 'ready' }] } }).state, 'queued');
assert.equal(gateFromAvailability({ status: 200, body: { code: 3101, data: { can_take_number: true } } }).eligible, false);
for (const body of [undefined, null]) assert.equal(gateFromAvailability({ status: 200, body }).eligible, false);
for (const label of ['constructor', '__proto__', 'toString']) {
  for (const field of ['state', 'status']) assert.equal(onPollResult(queued,
    { tickets: [{ ticket_id: 'owned', [field]: label }] }).state, 'queued');
}
await assert.rejects(offPeakTurn([], { ticketId: '' }), /ticket ID/);
let request, inference;
const previousTurnMid = process.env.ZCODE_DEVICE_MID;
try {
  process.env.ZCODE_DEVICE_MID = 'fixture-device';
  inference = await offPeakTurn([{ role: 'user', content: 'fixture' }], {
    ticketId: 'owned', jwt: 'fixture-jwt', apiKey: 'fixture-key', fetchImpl: async (url, init) => {
      request = { url, init }; return { status: 200, json: async () => ({ content: [{ type: 'text', text: 'long output '.repeat(10) }],
        usage: { input_tokens: 100, output_tokens: 20 }, 'fixture-key': { 'fixture-jwt': 'credential property' },
        error: 'fixture-jwt fixture-key' }) };
    },
  });
} finally {
  if (previousTurnMid === undefined) delete process.env.ZCODE_DEVICE_MID;
  else process.env.ZCODE_DEVICE_MID = previousTurnMid;
}
assert.equal(request.init.headers['x-off-peak-ticket-id'], 'owned');
assert.equal(request.init.headers['x-api-key'], 'fixture-jwt');
assert.equal(request.init.headers['anthropic-version'], '2023-06-01');
assert.match(request.init.headers['user-agent'], /^ZCode\//);
assert.equal(request.init.headers['X-ZCode-Agent'], 'glm');
assert.equal(request.init.headers['x-device-mid'], 'fixture-device');
assert.ok(request.init.headers['x-request-id']);
for (const name of ['X-Client-Ts', 'X-Client-Version', 'X-Client-Sig', 'X-Client-Nonce',
  'X-Client-Pow', 'X-App-Id', 'X-Client-Sign-Verified']) {
  assert.equal(request.init.headers[name], undefined, `${name} must stay absent (kernel sendUnsigned)`);
  assert.equal(request.init.headers[name.toLowerCase()], undefined, `${name} lowercase must stay absent`);
}
assert.equal(JSON.parse(request.init.body).model, 'GLM-5.3-Flash');
assert.equal(request.init.redirect, 'error');
assert.ok(request.init.signal);
assert.equal(inference.body.usage.input_tokens, 100);
assert.equal(inference.body.content[0].text, 'long output '.repeat(10));
assert.doesNotMatch(JSON.stringify(inference), /fixture-jwt|fixture-key/);
await assert.rejects(offPeakTurn([], { ticketId: 'owned', jwt: 'fixture-jwt', apiKey: 'fixture-key',
  fetchImpl: async () => { throw Error('fixture-key'); } }), /Off-peak inference transport failed/);
ok(gateFromAvailability({ status: 200, body: { data: { can_take_number: true } } }).eligible === true, 'gate: 200 + true -> eligible');
ok(gateFromAvailability({ status: 200, body: { data: { can_take_number: false } } }).eligible === false, 'gate: false -> not eligible');
ok(gateFromAvailability({ status: 200, body: { data: {} } }).eligible === false, 'gate: 200 with EMPTY data -> NOT eligible (regressed to eligible once)');
ok(gateFromAvailability({ status: 200, body: {} }).eligible === false, 'gate: 200 no data key -> not eligible');
ok(gateFromAvailability({ status: 500, body: { data: { can_take_number: true } } }).eligible === false, 'gate: non-200 -> not eligible');
ok(gateFromAvailability(undefined).eligible === false, 'gate: no response -> not eligible');
ok(gateFromAvailability({ status: 500, body: {} }).reasons.length === 1, 'gate: one reason when failing');
console.log(fails ? `FAIL (${fails})` : 'PASS offpeak-full');
process.exit(fails ? 1 : 0);
