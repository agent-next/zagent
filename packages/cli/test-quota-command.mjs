import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { quotaError, codingPlanKey, resolveCodingPlanKey, normalizeQuota, normalizeUsage, usageRange, codingPlanStatus } from '../driver/quota.mjs';

const home = mkdtempSync(path.join(tmpdir(), 'zagent-quota-test-'));
const bin = fileURLToPath(new URL('../../bin/zagent-quota', import.meta.url));
try {
  mkdirSync(path.join(home, '.zcode/v2'), { recursive: true });
  writeFileSync(path.join(home, '.zcode/v2/credentials.json'), JSON.stringify({
    zcodejwttoken: 'fixture-jwt', 'oauth:zai:access_token': 'fixture-oauth',
  }));
  const run = (status, body, args = ['reset'], expectedPath) => {
    const preload = `globalThis.fetch = async (url, options) => {
      if (${JSON.stringify(expectedPath ?? '')} && !url.includes(${JSON.stringify(expectedPath ?? '')})) throw Error('wrong quota endpoint');
      if (url.includes('/api/monitor/')) {
        if (!url.startsWith('https://api.z.ai/') || options.headers.authorization !== 'fixture-plan-key' || options.redirect !== 'error' || !options.signal) throw Error('unsafe monitor request');
      } else if (options.redirect !== 'error' || !options.signal) throw Error('unsafe credentialed quota request');
      return {status:${status}, json:async()=>(${JSON.stringify(body)})};
    };`;
    return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, bin, ...args], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home,
        ZAI_API_KEY: 'fixture-plan-key', ZCODE_DEVICE_MID: 'fixture-device', ZCODE_BASE_URL: 'https://quota.invalid' },
    });
  };
  for (const [status, body] of [
    [401, { code: 401, message: 'fixture unauthorized' }],
    [200, { code: 3103, message: 'fixture service failure' }],
    [200, {}],
  ]) for (const args of [['reset'], ['reset', '--json'], ['balance']]) {
    const r = run(status, body, args);
    assert.equal(r.status, 1, r.stderr);
    assert.doesNotMatch(r.stdout, /resets: none available|fiveHourAvailable/);
    assert.match(r.stderr, /quota:/);
    if (body.message) assert.match(r.stderr, new RegExp(body.message));
  }
  const success = run(200, { code: 0, data: { available_five_hour_resets: [], available_week_resets: [] } });
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /resets: none available/);
  // Reset actions (3.12.1 host contract): POST /reset|use|opportunity with
  // {idempotency_key, reset_type?} under the same dual-token auth.
  const runAction = (status, body, args, expectPath, expectBody) => {
    const preload = `globalThis.fetch = async (url, options) => {
      if (!url.includes(${JSON.stringify(expectPath)})) throw Error('wrong reset endpoint ' + url);
      if (options.method !== 'POST') throw Error('reset action must POST');
      const sent = JSON.parse(options.body);
      const want = ${JSON.stringify(expectBody)};
      for (const [k, v] of Object.entries(want)) if (sent[k] !== v) throw Error('bad body ' + k + '=' + sent[k]);
      if (!/^[0-9a-f-]{36}$/.test(sent.idempotency_key ?? '')) throw Error('missing uuid idempotency_key');
      if (options.headers['content-type'] !== 'application/json') throw Error('missing json content-type');
      if (options.redirect !== 'error' || !options.signal) throw Error('unsafe credentialed reset request');
      return {status:${status}, json:async()=>(${JSON.stringify(body)})};
    };`;
    return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, bin, ...args], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home,
        ZAI_API_KEY: 'fixture-plan-key', ZCODE_DEVICE_MID: 'fixture-device', ZCODE_BASE_URL: 'https://quota.invalid' },
    });
  };
  const usedFiveHour = runAction(200, { code: 0, data: { used: true } },
    ['reset', 'use', 'five-hour', '--yes'], '/coding-plan/reset/use', { reset_type: 'FIVE_HOUR' });
  assert.equal(usedFiveHour.status, 0, usedFiveHour.stderr);
  assert.match(usedFiveHour.stdout, /five-hour reset used/);
  const usedWeek = runAction(200, { code: 0, data: { used: true } },
    ['reset', 'use', 'week', '--json', '--yes'], '/coding-plan/reset/use', { reset_type: 'WEEK' });
  assert.equal(usedWeek.status, 0, usedWeek.stderr);
  assert.equal(JSON.parse(usedWeek.stdout).data.used, true);
  const unconfirmed = runAction(200, { code: 0, data: { used: false } },
    ['reset', 'use', 'week', '--yes'], '/coding-plan/reset/use', { reset_type: 'WEEK' });
  assert.equal(unconfirmed.status, 0, unconfirmed.stderr);
  assert.match(unconfirmed.stdout, /not confirmed used/);
  const claimed = runAction(200, { code: 0, data: { granted: true } },
    ['reset', 'claim'], '/coding-plan/reset/opportunity', {});
  assert.equal(claimed.status, 0, claimed.stderr);
  assert.match(claimed.stdout, /reset ticket claimed/);
  const declined = runAction(200, { code: 3301, data: { granted: false, next_try_at: 1789000000 } },
    ['reset', 'claim'], '/coding-plan/reset/opportunity', {});
  assert.equal(declined.status, 0, declined.stderr);
  assert.match(declined.stdout, /no reset granted; next try at 2026-09-/);
  for (const [status, body] of [[401, { code: 401, message: 'fixture unauthorized' }],
      [200, { code: 3103, message: 'fixture service failure' }]]) {
    const failed = runAction(status, body, ['reset', 'use', 'five-hour', '--yes'], '/coding-plan/reset/use', {});
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stderr, /quota:/);
  }
  // Consume-safety gate: a reset ticket is a scarce entitlement, so `reset use`
  // refuses without an explicit --yes when stdin is not a TTY (piped runs,
  // --json runs); the refusal must happen before ANY request is sent.
  const marker = path.join(home, 'fetch-called');
  const runGuard = (args) => {
    const preload = `globalThis.fetch = async () => {
      (await import('node:fs')).writeFileSync(${JSON.stringify(marker)}, 'called');
      return {status:200, json:async()=>({code:0, data:{used:true}})};
    };`;
    return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, bin, ...args], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home,
        ZAI_API_KEY: 'fixture-plan-key', ZCODE_DEVICE_MID: 'fixture-device', ZCODE_BASE_URL: 'https://quota.invalid' },
    });
  };
  for (const args of [['reset', 'use', 'five-hour'], ['reset', 'use', 'week'],
      ['reset', 'use', 'five-hour', '--json']]) {
    rmSync(marker, { force: true });
    const r = runGuard(args);
    assert.equal(r.status, 2, `expected refusal for ${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, /--yes/);
    assert.equal(existsSync(marker), false, `no request may fire without --yes (${args.join(' ')})`);
  }
  // Idempotency persistence: the key is stored BEFORE the POST and replayed on
  // retry after an unsettled (transport) failure; a settled response clears it.
  const pendingPath = path.join(home, '.zcode/cli/reset-pending/use-FIVE_HOUR.json');
  rmSync(path.dirname(pendingPath), { recursive: true, force: true });
  const spawnReset = (preload, args) => spawnSync(process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, bin, ...args], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home,
        ZAI_API_KEY: 'fixture-plan-key', ZCODE_DEVICE_MID: 'fixture-device', ZCODE_BASE_URL: 'https://quota.invalid' },
    });
  const boomPreload = `globalThis.fetch = async () => { throw new Error('fixture transport down'); };`;
  const boom = spawnReset(boomPreload, ['reset', 'use', 'five-hour', '--yes']);
  assert.equal(boom.status, 1, boom.stdout);
  const stored = JSON.parse(readFileSync(pendingPath, 'utf8')).idempotency_key;
  assert.match(stored, /^[0-9a-f-]{36}$/);
  // win32 has no POSIX mode bits — Node reports a synthetic 0666 there
  if (process.platform !== 'win32')
    assert.equal(statSync(pendingPath).mode & 0o777, 0o600, 'pending key file must be owner-only');
  const echoPreload = `globalThis.fetch = async (url, options) => {
    const sent = JSON.parse(options.body);
    return {status:200, json:async()=>({code:0, data:{used:true, echo:sent.idempotency_key}})};
  };`;
  const retry = spawnReset(echoPreload, ['reset', 'use', 'five-hour', '--yes', '--json']);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).data.echo, stored, 'retry must replay the persisted key');
  assert.equal(existsSync(pendingPath), false, 'a settled response clears the pending key');
  // A 5xx leaves the outcome unknown: the key stays parked so a retry replays
  // the same key for server-side dedupe instead of minting a competing one.
  const fivexxPreload = `globalThis.fetch = async () =>
    ({status:502, json:async()=>({code:502, message:'fixture gateway'})});`;
  const fivexx = spawnReset(fivexxPreload, ['reset', 'use', 'five-hour', '--yes']);
  assert.equal(fivexx.status, 1, fivexx.stdout);
  const storedAfter5xx = JSON.parse(readFileSync(pendingPath, 'utf8')).idempotency_key;
  assert.match(storedAfter5xx, /^[0-9a-f-]{36}$/, 'a 5xx must keep a pending key parked');
  const retryAfter5xx = spawnReset(echoPreload, ['reset', 'use', 'five-hour', '--yes', '--json']);
  assert.equal(retryAfter5xx.status, 0, retryAfter5xx.stderr);
  assert.equal(JSON.parse(retryAfter5xx.stdout).data.echo, storedAfter5xx,
    'post-5xx retry must replay the parked key');
  assert.equal(existsSync(pendingPath), false);
  // A corrupt pending file falls back to a fresh key, then persists THAT key.
  mkdirSync(path.dirname(pendingPath), { recursive: true });
  writeFileSync(pendingPath, '{not json');
  const corruptRun = spawnReset(echoPreload, ['reset', 'use', 'five-hour', '--yes', '--json']);
  assert.equal(corruptRun.status, 0, corruptRun.stderr);
  assert.match(JSON.parse(corruptRun.stdout).data.echo, /^[0-9a-f-]{36}$/,
    'corrupt pending file must mint a fresh valid key');
  assert.equal(existsSync(pendingPath), false);
  // The oauth credential falls back to the bigmodel family key like the host.
  const home2 = mkdtempSync(path.join(tmpdir(), 'zagent-quota-bm-'));
  mkdirSync(path.join(home2, '.zcode/v2'), { recursive: true });
  writeFileSync(path.join(home2, '.zcode/v2/credentials.json'), JSON.stringify({
    zcodejwttoken: 'fixture-jwt', 'oauth:bigmodel:access_token': 'fixture-bigmodel',
  }));
  const bmPreload = `globalThis.fetch = async (url, options) => {
    if (options.headers['x-bigmodel-authorization'] !== 'fixture-bigmodel') throw Error('oauth family fallback missing');
    return {status:200, json:async()=>({code:0, data:{granted:true}})};
  };`;
  const bm = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bmPreload)}`, bin, 'reset', 'claim'], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: home2, USERPROFILE: home2, ZAGENT_TEST_SANDBOX: home2,
      ZAI_API_KEY: 'fixture-plan-key', ZCODE_DEVICE_MID: 'fixture-device', ZCODE_BASE_URL: 'https://quota.invalid' },
  });
  rmSync(home2, { recursive: true, force: true });
  assert.equal(bm.status, 0, bm.stderr);
  assert.match(bm.stdout, /reset ticket claimed/);
  for (const args of [['reset', 'use'], ['reset', 'use', 'bogus'], ['reset', 'claim', 'week'],
      ['reset', 'five-hour'], ['reset', 'use', 'week', 'use', 'five-hour'], ['reset', 'claim', 'claim'],
      ['reset', 'claim', '--yes'], ['status', '--yes'], ['reset', 'use', 'week', '--yes', '--yes'],
      ['reset', 'use', '--yes']]) {
    const r = run(200, { code: 0 }, args);
    assert.equal(r.status, 2, `expected usage error for ${args.join(' ')}`);
    assert.match(r.stderr, /usage:/);
  }
  // Subcommand-position typos name the likely intent (same OSA-Damerau rule
  // as the entry dispatcher's flag hints); out-of-position/flag tokens do not.
  for (const [args, hint] of [
    [['stauts'], /did you mean 'status'\?/],
    // U1: 'preive' is a transposition+deletion — Levenshtein 3 but
    // OSA-Damerau 2 — and used to fall off the d<3 bound.
    [['preive'], /did you mean 'preview'\?/],
    [['usagee'], /did you mean 'usage'\?/],
    [['reset', 'ues'], /did you mean 'use'\?/],
    [['reset', 'cliam'], /did you mean 'claim'\?/],
    [['reset', 'use', 'wek'], /did you mean 'week'\?/],
    // Reset vocabulary at top level names the full `reset` form.
    [['use'], /did you mean 'reset use'\?/],
    [['cliam'], /did you mean 'reset claim'\?/],
    [['wek'], /did you mean 'reset use week'\?/],
    // Glued reset phrases suggest the spaced form the grammar parses —
    // inside `reset …` the bare spaced words, at top level the full command.
    [['reset', 'use-five-hor'], /did you mean 'use five-hour'\?/],
    [['reset', 'use-wek'], /did you mean 'use week'\?/],
    [['reset', 'use-five-hour'], /did you mean 'use five-hour'\?/],
    // Bare type words at the action position complete the grammar tail.
    [['reset', 'wek'], /did you mean 'use week'\?/],
    [['reset', 'five-hour'], /did you mean 'use five-hour'\?/],
    [['use-five-hor'], /did you mean 'reset use five-hour'\?/],
    [['use-wek'], /did you mean 'reset use week'\?/],
  ]) {
    const r = run(200, { code: 0 }, args);
    assert.equal(r.status, 2, `expected usage error for ${args.join(' ')}`);
    assert.match(r.stderr, hint);
  }
  // Single-char tokens never hint — 's' is 2 edits from 'use' but almost
  // never means it (the usage-hint <2-char guard, applied here too).
  for (const args of [['status', 'extra'], ['--bogus'], ['xyz-nomatch'], ['usage', '--days', 'abc'],
      ['reset', 'use-zzzzz'], ['reset', 'use', 'zzz'], ['s'], ['u'], ['reset', 'u'], ['stax']]) {
    const r = run(200, { code: 0 }, args);
    assert.equal(r.status, 2, `expected usage error for ${args.join(' ')}`);
    assert.doesNotMatch(r.stderr, /did you mean/);
  }
  const typoJson = run(200, { code: 0 }, ['stauts', '--json']);
  assert.equal(typoJson.status, 2);
  assert.match(JSON.parse(typoJson.stdout).error, /^usage: zagent quota/);
  assert.match(typoJson.stderr, /did you mean 'status'\?/);
  assert.match(quotaError({ status: 200, body: { success: false, message: 'rejected' } }), /rejected/);
  assert.equal(quotaError({ status: 200, body: { code: 0, data: {} } }), null);
  for (const [args, endpoint] of [
    [['balance', '--json'], '/billing/balance?'],
    [['--json', 'reset'], '/coding-plan/reset/status'],
    [['reset', '--json'], '/coding-plan/reset/status'],
    [['preview', '--json'], '/billing/preview?'],
  ]) {
    const r = run(200, { code: 0, data: {} }, args, endpoint);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).code, 0);
  }
  for (const args of [['unknown'], ['balance', 'reset'], ['--days', '7'], ['usage', '--days'],
    ['usage', '--days', '0'], ['usage', '--days', '31'], ['usage', '--days', '1.5'],
    ['usage', '--days', '1', '--days', '2'], ['usage', '--json', '--json']]) {
    const r = run(200, { code: 0 }, args);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage:/);
  }
  const limits = [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 39, nextResetTime: 1789052911430 }];
  const status = run(200, { code: 200, success: true, data: { level: 'max', limits } }, ['--json'], '/api/monitor/usage/quota/limit');
  assert.equal(status.status, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.pools[0].remainingPercent, 61);
  assert.equal(parsed.pools[0].remaining, null);
  assert.equal(parsed.scope, 'account');
  assert.equal(parsed.keySource, 'ZAI_API_KEY');
  assert.equal(parsed.plan, null);
  assert.doesNotMatch(status.stdout, /fixture-plan-key|fixture-jwt/);
  const human = run(200, { data: { limits } }, []);
  assert.equal(human.status, 0, human.stderr);
  // The fixture's reset stamp is in the past: say so instead of "in 0m".
  assert.match(human.stdout, /5-hour window: 39% used · reset pending/);
  assert.match(human.stdout, /Key: "ZAI_API_KEY"; the plan name is not derivable/);
  assert.match(human.stdout, /Monthly tool calls: not reported/);
  assert.doesNotMatch(human.stdout, /raw service codes|unit=|number=/);
  const soon = Date.now() + 2 * 3600e3 + 5 * 60e3, nextMonth = Date.now() + 10 * 86400e3;
  const live = [
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 39, nextResetTime: soon },
    { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 15, usage: 4000, currentValue: 600, remaining: 3400, nextResetTime: nextMonth },
  ];
  const liveHuman = run(200, { data: { limits: live } }, []);
  assert.equal(liveHuman.status, 0, liveHuman.stderr);
  assert.match(liveHuman.stdout, /5-hour window: 39% used · resets \d{2}:\d{2} UTC \(in 2h [0-9]m\)/);
  assert.match(liveHuman.stdout, /Monthly tool calls: 3,400 of 4,000 left · resets [A-Z][a-z]{2} \d{1,2}/);
  const totalUsage = { totalModelCallCount: 12, totalTokensUsage: 900,
    modelSummaryList: [{ modelName: 'GLM-5.3', totalTokens: 900 }] };
  const used = run(200, { code: 200, data: { totalUsage } }, ['usage', '--days', '1', '--json'], '/api/monitor/usage/model-usage?');
  assert.equal(used.status, 0, used.stderr);
  assert.equal(JSON.parse(used.stdout).reportedTokens, 900);
  assert.match(JSON.parse(used.stdout).attribution, /cannot attribute/);
  for (const args of [[], ['usage']]) for (const [http, body] of [
    [401, { code: 401, message: 'fixture-plan-key' }], [200, { code: 3103, data: { limits, totalUsage } }],
    [200, { data: {} }], [200, {}], [200, { data: { limits: [], totalUsage: { totalTokensUsage: 0 } } }],
  ]) {
    const failed = run(http, body, args);
    assert.equal(failed.status, 1, failed.stdout);
    assert.equal(failed.stdout, '');
    assert.doesNotMatch(failed.stderr, /fixture-plan-key/);
  }
  // A failing quota call must say WHICH problem it is — a rejected
  // credential (sign-in), a real usage limit (quota window), or a transport
  // failure — because the fixes differ. Server message text stays out of the
  // monitor error: it can carry anything (the fixture pins the key must not
  // be echoed).
  const authFail = run(401, { code: 401, message: 'fixture-plan-key' }, ['status']);
  assert.equal(authFail.status, 1);
  assert.match(authFail.stderr, /sign-in problem/);
  assert.match(authFail.stderr, /zagent login|ZAI_API_KEY/);
  assert.doesNotMatch(authFail.stderr, /fixture-plan-key/);
  for (const [http, body] of [
    [429, { code: 429, message: 'fixture slow down' }],
    [200, { code: 1308, message: 'fixture window exhausted' }],
    [200, { code: 1113, message: 'fixture balance empty' }],
  ]) {
    const limitFail = run(http, body, ['usage']);
    assert.equal(limitFail.status, 1, `${http}: ${limitFail.stdout}`);
    assert.match(limitFail.stderr, /usage limit|quota.window/i);
    assert.match(limitFail.stderr, /not a sign-in problem/);
    assert.match(limitFail.stderr, /quota reset/);
  }
  // The same classification reaches the desktop-credential verbs (billing) —
  // and a business code on a 2xx classifies the same as its HTTP twin.
  const authBilling = run(401, { code: 401, message: 'fixture unauthorized' }, ['balance']);
  assert.equal(authBilling.status, 1);
  assert.match(authBilling.stderr, /sign-in problem/);
  // The desktop verbs authenticate via the zcode JWT — ZAI_API_KEY is not a
  // fix there and must not be named.
  assert.doesNotMatch(authBilling.stderr, /ZAI_API_KEY/);
  const bizAuth = run(200, { code: 401, message: 'fixture unauthorized' }, ['status']);
  assert.equal(bizAuth.status, 1);
  assert.match(bizAuth.stderr, /sign-in problem/);
  // The class is also a FIELD on the JSON error objects — a machine
  // consumer must not have to parse the stderr prose. The raw {http,...body}
  // failure envelope carries `class`; unclassified failures carry null.
  assert.equal(JSON.parse(authBilling.stdout).class, 'auth');
  const limitBilling = run(429, { code: 429, message: 'fixture slow down' }, ['balance']);
  assert.equal(limitBilling.status, 1);
  assert.equal(JSON.parse(limitBilling.stdout).class, 'limit');
  const unclassified = run(200, { code: 3103, message: 'fixture service failure' }, ['balance']);
  assert.equal(unclassified.status, 1);
  assert.strictEqual(JSON.parse(unclassified.stdout).class, null);
  // The {"error"} envelope (monitor verbs) carries the same classes.
  const authJson = run(401, { code: 401, message: 'fixture unauthorized' }, ['status', '--json']);
  assert.equal(authJson.status, 1);
  assert.equal(JSON.parse(authJson.stdout.trim()).class, 'auth');
  const limitJson = run(429, { code: 429, message: 'fixture slow down' }, ['usage', '--json']);
  assert.equal(limitJson.status, 1);
  assert.equal(JSON.parse(limitJson.stdout.trim()).class, 'limit');
  const plainJson = run(200, { code: 3103, message: 'fixture service failure' }, ['status', '--json']);
  assert.equal(plainJson.status, 1);
  assert.strictEqual(JSON.parse(plainJson.stdout.trim()).class, null);
  // A usage error is not a quota failure: class stays null on that envelope too.
  const usageJson = run(200, { code: 0 }, ['bogus', '--json']);
  assert.equal(usageJson.status, 2);
  const usageEnv = JSON.parse(usageJson.stdout.trim());
  assert.match(usageEnv.error, /usage:/);
  assert.strictEqual(usageEnv.class, null);
  assert.deepEqual(usageRange(2, new Date('2026-09-10T17:00:00Z')),
    { startTime: '2026-09-10 00:00:00', endTime: '2026-09-11 23:59:59' });
  assert.throws(() => usageRange(0), /--days/);
  assert.equal(normalizeUsage({ totalUsage: { totalModelCallCount: 0, totalTokensUsage: 0 } }).models, null);
  for (const invalid of [-1, NaN, Infinity, '39', 101])
    assert.throws(() => normalizeQuota({ limits: [{ type: 'TOKENS_LIMIT', percentage: invalid }] }));
  assert.throws(() => normalizeQuota({ limits: [{ type: 'TOKENS_LIMIT' }] }));
  assert.throws(() => normalizeUsage({ totalUsage: { ...totalUsage, totalTokensUsage: '900' } }));
  assert.throws(() => normalizeUsage({ totalUsage: { ...totalUsage, modelSummaryList: {} } }));
  assert.equal(codingPlanKey({ env: { ZAI_API_KEY: ' explicit ' }, home }), 'explicit');
  assert.deepEqual(resolveCodingPlanKey({ env: { ZAI_API_KEY: ' explicit ' }, home }),
    { key: 'explicit', source: 'ZAI_API_KEY', plan: null });
  mkdirSync(path.join(home, '.config', 'ccz'), { recursive: true });
  writeFileSync(path.join(home, '.config', 'ccz', '.api_key'), 'fallback');
  assert.equal(codingPlanKey({ env: {}, home }), 'fallback');
  assert.deepEqual(resolveCodingPlanKey({ env: {}, home }),
    { key: 'fallback', source: 'ccz-fallback', plan: null });
  mkdirSync(path.join(home, '.zcode/cli'), { recursive: true });
  const configPath = path.join(home, '.zcode/cli/config.json');
  writeFileSync(configPath, JSON.stringify({ model: { main: 'zai/glm-5.3' }, provider: {
    zai: { options: { baseURL: 'https://api.z.ai/api/anthropic/', apiKey: 'selected' } },
  } }));
  assert.equal(codingPlanKey({ env: {}, home }), 'selected');
  assert.deepEqual(resolveCodingPlanKey({ env: {}, home }),
    { key: 'selected', source: 'cli-config', plan: { providerId: 'zai', name: null } });
  // End-to-end: with no ZAI_API_KEY the CLI-config key is used and its plan is named.
  // A provider_config.json that disagrees must NOT win — cli-config precedes it.
  writeFileSync(path.join(home, '.zcode/v2/provider_config.json'), JSON.stringify({
    config: { providerConfigRules: { providerRules: [
      { providerId: 'zai', config: { access: { apiKey: 'should-not-win' } } }] } },
  }));
  writeFileSync(configPath, JSON.stringify({ model: { main: 'zai/glm-5.3' }, provider: {
    zai: { name: 'Z.AI Coding Plan', options: { baseURL: 'https://api.z.ai/api/anthropic', apiKey: 'fixture-plan-key' } },
  } }));
  assert.deepEqual(resolveCodingPlanKey({ env: {}, home }),
    { key: 'fixture-plan-key', source: 'cli-config', plan: { providerId: 'zai', name: 'Z.AI Coding Plan' } });
  // A zai-shaped cli config with an EMPTY apiKey (OAuth-written before
  // provisioning) falls through to the provisioned key instead of throwing.
  writeFileSync(configPath, JSON.stringify({ model: { main: 'zai/glm-5.3' }, provider: {
    zai: { name: 'Z.AI Coding Plan', options: { baseURL: 'https://api.z.ai/api/anthropic', apiKey: '' } },
  } }));
  assert.deepEqual(resolveCodingPlanKey({ env: {}, home }),
    { key: 'should-not-win', source: 'provider-config', plan: null });
  writeFileSync(configPath, JSON.stringify({ model: { main: 'zai/glm-5.3' }, provider: {
    zai: { name: 'Z.AI Coding Plan', options: { baseURL: 'https://api.z.ai/api/anthropic', apiKey: 'fixture-plan-key' } },
  } }));
  const planEnv = { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home,
    ZCODE_DEVICE_MID: 'fixture-device', ZCODE_BASE_URL: 'https://quota.invalid' };
  delete planEnv.ZAI_API_KEY;
  const planRun = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(
    `globalThis.fetch = async (url, options) => {
      if (!url.includes('/api/monitor/usage/quota/limit')) throw Error('wrong quota endpoint');
      if (options.headers.authorization !== 'fixture-plan-key') throw Error('unsafe monitor request');
      return {status:200, json:async()=>({code:200,success:true,data:{level:'max',limits:${JSON.stringify(limits)}}})};
    };`)}`, bin, '--json'], { encoding: 'utf8', timeout: 10000, env: planEnv });
  assert.equal(planRun.status, 0, planRun.stderr);
  assert.equal(JSON.parse(planRun.stdout).keySource, 'cli-config');
  assert.deepEqual(JSON.parse(planRun.stdout).plan, { providerId: 'zai', name: 'Z.AI Coding Plan' });
  writeFileSync(configPath, JSON.stringify({ model: { main: 'other/model' } }));
  assert.throws(() => codingPlanKey({ env: {}, home }), /Selected CLI provider/);
  writeFileSync(configPath, 'invalid JSON');
  assert.throws(() => codingPlanKey({ env: {}, home }), /Cannot read CLI/);
  await assert.rejects(codingPlanStatus({ env: { ZAI_API_KEY: 'fixture' }, home,
    fetchImpl: async () => ({ status: 200, json: async () => { throw Error('bad JSON'); } }),
  }), /Invalid Coding Plan JSON/);
  for (const [key, preload, expected, expectedClass] of [
    ['synthetic-secret\nsecond-part', 'globalThis.fetch = async (url, options) => new Request(url, options);', /Invalid Coding Plan key format/, 'auth'],
    ['synthetic-secret', 'globalThis.fetch = async (url, options) => { throw Error("network failure: " + options.headers.authorization); };', /Coding Plan transport failed — a network problem/, 'network'],
  ]) {
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, bin, '--json'], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, HOME: home, USERPROFILE: home,
        ZAGENT_TEST_SANDBOX: home, ZAI_API_KEY: key },
    });
    assert.equal(result.status, 1);
    // --json failures keep stdout machine-readable: the error is a
    // JSON object there, with the human line still on stderr.
    // The {"error"} envelope carries the class as a field too.
    const envelope = JSON.parse(result.stdout.trim());
    assert.match(envelope.error, expected);
    assert.equal(envelope.class, expectedClass);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /synthetic-secret|second-part/);
    assert.doesNotMatch(result.stdout, /synthetic-secret|second-part/);
  }
  // On a credential-free machine (no ~/.zcode/v2/credentials.json)
  // the desktop-credential verbs must say "sign in", never a raw ENOENT.
  const bare = mkdtempSync(path.join(tmpdir(), 'zagent-quota-bare-'));
  const bareEnv = { ...process.env, HOME: bare, USERPROFILE: bare,
    ZAGENT_TEST_SANDBOX: bare, ZCODE_DEVICE_MID: 'fixture-device',
    ZCODE_BASE_URL: 'https://quota.invalid' };
  delete bareEnv.ZAI_API_KEY;
  const noFetch = `globalThis.fetch = async () => { throw Error('no request may fire without credentials'); };`;
  const bareRun = (args) => spawnSync(process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(noFetch)}`, bin, ...args],
    { encoding: 'utf8', timeout: 10000, env: bareEnv });
  for (const args of [['balance'], ['balance', '--json'], ['preview'], ['reset'],
      ['reset', 'claim'], ['reset', 'use', 'five-hour', '--yes'],
      ['reset', 'use', 'week', '--yes']]) {
    const r = bareRun(args);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /zagent login/, `${args.join(' ')} should point at sign-in`);
    // The desktop-credential verbs carry the same failure-class
    // phrasing as the Coding-Plan-key verbs (a sign-in problem, not a quota
    // limit) — but must NOT offer ZAI_API_KEY, which cannot feed the JWT path.
    assert.match(r.stderr, /sign-in problem, not a quota limit/,
      `${args.join(' ')} should name the sign-in class like status/usage do`);
    assert.doesNotMatch(r.stderr, /ZAI_API_KEY/,
      `${args.join(' ')} must not prescribe ZAI_API_KEY for the desktop-JWT path`);
    assert.doesNotMatch(r.stderr, /ENOENT|no such file/i,
      `${args.join(' ')} must not leak the raw ENOENT`);
  }
  // A store without the JWT is the same signed-out state — same message.
  mkdirSync(path.join(bare, '.zcode/v2'), { recursive: true });
  writeFileSync(path.join(bare, '.zcode/v2/credentials.json'),
    JSON.stringify({ 'oauth:zai:access_token': 'fixture-oauth' }));
  const noJwt = bareRun(['balance']);
  assert.equal(noJwt.status, 1, noJwt.stdout);
  assert.match(noJwt.stderr, /zagent login/);
  assert.match(noJwt.stderr, /sign-in problem, not a quota limit/);
  assert.doesNotMatch(noJwt.stderr, /credential blob|ZAI_API_KEY/);
  // The JWT-less store also precedes the `reset use` confirmation.
  const noJwtUse = bareRun(['reset', 'use', 'five-hour']);
  assert.equal(noJwtUse.status, 1, noJwtUse.stdout);
  assert.match(noJwtUse.stderr, /zagent login/);
  assert.doesNotMatch(noJwtUse.stderr, /--yes/);
  // Every degraded-auth env refuses the consume paths too — if
  // resetRequest ever throws on material the preflight misses, one of these
  // parks a reset-pending key and turns red.
  for (const args of [['reset', 'use', 'five-hour', '--yes'], ['reset', 'claim']]) {
    const r = bareRun(args);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /zagent login/, `${args.join(' ')} names the sign-in fix`);
  }
  assert.equal(existsSync(path.join(bare, '.zcode/cli/reset-pending')), false,
    'JWT-less store: refused reset actions park no pending key');
  // Corrupt/undecryptable store state is the same class with the same remedy —
  // named as unreadable, never a raw SyntaxError or 'credential blob:' leak.
  writeFileSync(path.join(bare, '.zcode/v2/credentials.json'), 'not json{{');
  const corruptStore = bareRun(['balance']);
  assert.equal(corruptStore.status, 1, corruptStore.stdout);
  assert.match(corruptStore.stderr, /corrupt — a sign-in problem/);
  assert.match(corruptStore.stderr, /zagent login/);
  assert.doesNotMatch(corruptStore.stderr, /SyntaxError|Unexpected token|ZAI_API_KEY/);
  writeFileSync(path.join(bare, '.zcode/v2/credentials.json'),
    JSON.stringify({ zcodejwttoken: 'enc:v1:not.a.real-blob' }));
  const badBlob = bareRun(['balance']);
  assert.equal(badBlob.status, 1, badBlob.stdout);
  assert.match(badBlob.stderr, /unreadable — a sign-in problem/);
  assert.match(badBlob.stderr, /zagent login/);
  assert.doesNotMatch(badBlob.stderr, /credential blob|ZAI_API_KEY/);
  // Parseable-but-not-an-object store (`null`) gets named, not a TypeError.
  writeFileSync(path.join(bare, '.zcode/v2/credentials.json'), 'null');
  const nullStore = bareRun(['balance']);
  assert.equal(nullStore.status, 1, nullStore.stdout);
  assert.match(nullStore.stderr, /not a JSON object/);
  assert.match(nullStore.stderr, /sign-in problem, not a quota limit/);
  assert.match(nullStore.stderr, /zagent login/);
  assert.doesNotMatch(nullStore.stderr, /Cannot read properties|TypeError|ZAI_API_KEY/);
  rmSync(path.join(bare, '.zcode/v2/credentials.json'));
  // `status`/`usage` keep their own Coding-Plan-key message (regression guard).
  // It must also name the problem class and both fix paths.
  for (const args of [[], ['usage']]) {
    const r = bareRun(args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No Coding Plan key/);
    assert.match(r.stderr, /sign-in problem/);
    assert.match(r.stderr, /zagent login/);
    assert.match(r.stderr, /ZAI_API_KEY/);
    assert.doesNotMatch(r.stderr, /ENOENT/i);
  }
  // --json error paths emit a parseable {"error": ...} on stdout —
  // the same failures used to answer with human prose on stderr only.
  for (const args of [['--json'], ['status', '--json'], ['usage', '--json'],
      ['balance', '--json'], ['preview', '--json'], ['reset', '--json']]) {
    const r = bareRun(args);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    const body = JSON.parse(r.stdout.trim());
    assert.match(body.error, /credential|Coding Plan key/i,
      `${args.join(' ')}: stdout must carry an {"error"} object`);
    assert.equal(body.class, 'auth',
      `${args.join(' ')}: a credential-free failure is the auth class`);
    assert.match(r.stderr, /quota:/, 'the human line stays on stderr');
  }
  // On a credential-free machine `reset use` must surface the
  // sign-in failure BEFORE the --yes confirmation — a no-credential user cannot
  // consume a ticket, so there is nothing to confirm (same order as `reset
  // claim`, which has no gate). The {"error"} envelope carries the auth class.
  for (const args of [['reset', 'use', 'five-hour'], ['reset', 'use', 'week'],
      ['reset', 'use', 'five-hour', '--json'], ['reset', 'use', 'week', '--json']]) {
    const r = bareRun(args);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /zagent login/, `${args.join(' ')} names the sign-in fix`);
    assert.doesNotMatch(r.stderr, /--yes|ENOENT|no such file/i,
      `${args.join(' ')} never asks to confirm an impossible consume`);
  }
  {
    const r = bareRun(['reset', 'use', 'five-hour', '--json']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const body = JSON.parse(r.stdout.trim());
    assert.match(body.error, /credential|zagent login/i);
    assert.equal(body.class, 'auth');
  }
  // The --yes consume path runs the same preflight — before resetUse()
  // can park an idempotency key under .zcode/cli/reset-pending/ — so a
  // credential-free machine refuses the consume without leaving a trace.
  for (const args of [['reset', 'use', 'five-hour', '--yes'],
      ['reset', 'use', 'week', '--yes']]) {
    const r = bareRun(args);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /zagent login/, `${args.join(' ')} names the sign-in fix`);
    assert.doesNotMatch(r.stderr, /--yes|ENOENT|no such file/i,
      `${args.join(' ')} never asks to confirm an impossible consume`);
  }
  {
    const r = bareRun(['reset', 'use', 'five-hour', '--yes', '--json']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout.trim()).class, 'auth');
  }
  assert.equal(existsSync(path.join(bare, '.zcode/cli/reset-pending')), false,
    'refused reset actions (use --yes and claim, run above) park no pending key on a credential-free HOME');
  // Pin the TTY cell's order too — spawnSync cannot drive a terminal,
  // so assert the preflight call site sits inside the reset-action gate ahead
  // of the readline branch; the behavioral --yes/claim oracles above backstop
  // what a textual pin cannot see.
  {
    const src = readFileSync(bin, 'utf8');
    const gateAt = src.indexOf('if (resetAction) {');
    const callAt = src.indexOf('resetAuthPreflight();', gateAt);
    const confirmAt = src.indexOf('createInterface(');
    assert.ok(gateAt !== -1 && callAt > gateAt && confirmAt > callAt,
      'resetAuthPreflight() must run inside the reset-action gate before the interactive confirmation');
  }
  // `zagent login` makes the kernel provision the plan key into
  // v2/provider_config.json — quota must resolve it directly so the sign-in
  // advice works on the first retry (cli/config.json only picks it up later).
  writeFileSync(path.join(bare, '.zcode/v2/provider_config.json'), JSON.stringify({
    config: { providerConfigRules: { providerRules: [
      { providerId: 'zai', config: { access: { apiKey: 'provisioned-plan-key' } } }] } },
  }));
  assert.deepEqual(resolveCodingPlanKey({ env: {}, home: bare }),
    { key: 'provisioned-plan-key', source: 'provider-config', plan: null });
  {
    const preload = `globalThis.fetch = async (url, options) => {
      if (!url.includes('/api/monitor/usage/quota/limit')) throw Error('wrong quota endpoint');
      if (options.headers.authorization !== 'provisioned-plan-key') throw Error('provisioned key not used');
      return {status:200, json:async()=>({code:200,success:true,data:{level:'max',limits:${JSON.stringify(limits)}}})};
    };`;
    const r = spawnSync(process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, bin, '--json'],
      { encoding: 'utf8', timeout: 10000, env: bareEnv });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).keySource, 'provider-config');
  }
  // An unprovisioned device identity is the same sign-in class as a missing
  // JWT — the desktop verbs need it for x-device-mid before any request.
  writeFileSync(path.join(bare, '.zcode/v2/credentials.json'),
    JSON.stringify({ zcodejwttoken: 'fixture-jwt' }));
  const noMidEnv = { ...bareEnv };
  delete noMidEnv.ZCODE_DEVICE_MID;
  const noMid = spawnSync(process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(noFetch)}`, bin, 'balance', '--json'],
    { encoding: 'utf8', timeout: 10000, env: noMidEnv });
  assert.equal(noMid.status, 1, noMid.stdout + noMid.stderr);
  assert.equal(JSON.parse(noMid.stdout.trim()).class, 'auth');
  assert.match(noMid.stderr, /device mid/);
  // An unprovisioned device identity also precedes the `reset use`
  // confirmation — same auth class, same ordering.
  const noMidUse = spawnSync(process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(noFetch)}`, bin, 'reset', 'use', 'five-hour', '--json'],
    { encoding: 'utf8', timeout: 10000, env: noMidEnv });
  assert.equal(noMidUse.status, 1, noMidUse.stdout + noMidUse.stderr);
  assert.equal(JSON.parse(noMidUse.stdout.trim()).class, 'auth');
  assert.match(noMidUse.stderr, /device mid/);
  assert.doesNotMatch(noMidUse.stderr, /--yes/);
  // The consume paths refuse under this env too — same preflight,
  // same no-trace invariant as the no-store and JWT-less cells.
  for (const args of [['reset', 'use', 'five-hour', '--yes'], ['reset', 'claim']]) {
    const r = spawnSync(process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(noFetch)}`, bin, ...args],
      { encoding: 'utf8', timeout: 10000, env: noMidEnv });
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /device mid/, `${args.join(' ')} names the missing mid`);
  }
  assert.equal(existsSync(path.join(bare, '.zcode/cli/reset-pending')), false,
    'unprovisioned mid: refused reset actions park no pending key');
  rmSync(bare, { recursive: true, force: true });
  console.log('PASS quota HTTP/service failures and successful reset CLI');
} finally { rmSync(home, { recursive: true, force: true }); }
