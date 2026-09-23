// I5 robustness trio test — pure, no network, deterministic.
import { isQuotaError, withModelRetry, mcpVersionDiagnostic } from './zcode-protocol.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1) isQuotaError
ok(isQuotaError({ code: 1302 }), '1302 is quota');
ok(isQuotaError({ code: 'PROVIDER_BUSINESS_ERROR' }), 'PROVIDER_BUSINESS_ERROR is quota');
ok(!isQuotaError({ code: -32601 }), 'method-not-found is not quota');

// 2) withModelRetry: blank retried, then succeeds
let calls = 0;
const r1 = await withModelRetry(async () => { calls++; return calls < 3 ? '' : 'answer'; }, { baseDelayMs: 10 });
ok(r1 === 'answer' && calls === 3, `blank retried until success (${calls} calls)`);

// 3) withModelRetry: quota error NOT retried
let quotaCalls = 0;
try {
  await withModelRetry(async () => { quotaCalls++; throw Object.assign(new Error('rate'), { code: 1302 }); }, { baseDelayMs: 10 });
  ok(false, 'should have thrown');
} catch (e) {
  ok(quotaCalls === 1 && e.code === 1302, `quota error thrown immediately, no retry (${quotaCalls} call)`);
}

// 4) withModelRetry: non-quota error retried then thrown after max
let errCalls = 0;
try {
  await withModelRetry(async () => { errCalls++; throw new Error('network'); }, { maxRetries: 2, baseDelayMs: 10 });
} catch {
  ok(errCalls === 3, `non-quota error retried to max then thrown (${errCalls} calls)`);
}

// 5) mcpVersionDiagnostic
ok(mcpVersionDiagnostic('fs', '2024', '2025')?.includes('protocol 2025') === true, 'mismatch produces guidance');
ok(mcpVersionDiagnostic('fs', '2024', '2024') === null, 'match produces no diagnostic');

console.log(fails ? `FAIL (${fails})` : 'PASS robustness');
process.exit(fails ? 1 : 0);
