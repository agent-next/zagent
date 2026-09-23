#!/usr/bin/env node
// Built from a live failure: the plan's 5-hour window was exhausted and the CLI
// printed 63 lines of stack trace with the only actionable fact — the reset time
// — buried in line 1.
import { strict as assert } from 'node:assert';
import { explainProviderError, formatProviderError, resolveReset, humanDelta, RETRYABLE, EXHAUSTED }
  from './provider-errors.mjs';

// Verbatim from the runtime, 2026-09-07.
const USAGE = 'ProviderBusinessError: [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-09-08 06:05:37][202609080413175c26b2cf149e46ce]';
const RATE  = 'ProviderBusinessError: [1302][Rate limit reached for requests][202609080312054dd52858362f49d2]';
const NOW   = Date.UTC(2026, 8, 7, 20, 13, 0); // 2026-09-07 20:13 UTC, when it was captured

const tests = [];
const test = (n, f) => tests.push([n, f]);

test('the real 1308 is read as an exhausted window, not a retryable blip', () => {
  const e = explainProviderError(USAGE, { now: NOW });
  assert.equal(e.code, 1308);
  assert.equal(e.kind, EXHAUSTED);
  assert.equal(e.requestId, '202609080413175c26b2cf149e46ce');
});

test('the real 1302 stays retryable', () => {
  const e = explainProviderError(RATE, { now: NOW });
  assert.equal(e.code, 1302);
  assert.equal(e.kind, RETRYABLE);
  assert.match(e.advice, /retry/i);
  assert.equal(e.reset, null, 'a rate limit carries no reset time');
});

// The two used to be conflated. They need opposite responses: retrying a 1308
// just burns attempts until the reset.
test('the two limits are never given the same kind', () => {
  assert.notEqual(explainProviderError(USAGE, { now: NOW }).kind,
                  explainProviderError(RATE, { now: NOW }).kind);
});

test('a wire retry-after in the error dump is surfaced, not denied', () => {
  // Live shape, 2026-09-17: a 1302 came back with `retry-after: 6` in the
  // dumped responseHeaders while the advice claimed the provider sent none.
  const dump = RATE + "\n  responseHeaders: { connection: 'keep-alive', 'retry-after': '6' }";
  const e = explainProviderError(dump, { now: NOW });
  assert.equal(e.retryAfterSec, 6);
  assert.match(e.advice, /retry in ~6s/);
  assert.doesNotMatch(e.advice, /no retry-after/i);
});

test('json-shaped and unquoted retry-after parse too', () => {
  assert.equal(explainProviderError(RATE + ' {"responseHeaders":{"retry-after":"8"}}', { now: NOW }).retryAfterSec, 8);
  assert.equal(explainProviderError(RATE + ' retry-after: 12', { now: NOW }).retryAfterSec, 12);
});

test('absent or absurd retry-after stays honest without asserting the wire', () => {
  const e = explainProviderError(RATE, { now: NOW });
  assert.equal(e.retryAfterSec, null);
  assert.doesNotMatch(e.advice, /retry-after/i); // callers truncate/tail: absent-in-text ≠ absent-on-wire
  assert.equal(explainProviderError(RATE + " 'retry-after': '9999999'", { now: NOW }).retryAfterSec, null);
  assert.equal(explainProviderError(RATE + " 'retry-after': '0036009'", { now: NOW }).retryAfterSec, null); // 36009s — the bound sees the real value, not a 6-digit truncation
  assert.equal(explainProviderError(RATE + ' Retry-After: Tue, 01 Jan 2030 00:00:00 GMT', { now: NOW }).retryAfterSec, null);
});

test('a retry-after before the error signature belongs to an earlier dump', () => {
  // Multi-error buffers (retry-heavy kernel stderr tail): the header before the
  // matched [code] line is a previous response's, not this failure's.
  const earlier = "'retry-after': '42'\n" + RATE;
  assert.equal(explainProviderError(earlier, { now: NOW }).retryAfterSec, null);
  const both = "'retry-after': '42'\n" + RATE + "\n'retry-after': '6'";
  assert.equal(explainProviderError(both, { now: NOW }).retryAfterSec, 6);
});

test('the provider zone is inferred, not guessed', () => {
  // The stamp carries no zone. Only one offset puts the reset in the future AND
  // within the 5-hour window it belongs to — here UTC+8, the provider's zone.
  const r = resolveReset('2026-09-08 06:05:37', { windowHours: 5, now: NOW });
  assert.ok(r, 'no candidate resolved');
  assert.equal(r.offset, 8);
  assert.ok(r.delta > 0 && r.delta <= 5 * 3600_000, `delta ${r.delta} outside the window`);
  assert.equal(new Date(r.at).toISOString(), '2026-09-07T22:05:37.000Z');
});

test('a stamp that fits no offset resolves to nothing rather than a wrong answer', () => {
  // Far past: every candidate is behind `now`.
  assert.equal(resolveReset('2020-01-01 00:00:00', { now: NOW }), null);
  assert.equal(resolveReset('not a timestamp', { now: NOW }), null);
  assert.equal(resolveReset(undefined, { now: NOW }), null);
});

test('the window length is taken from the message, not assumed', () => {
  const e = explainProviderError(
    '[1308][Usage limit reached for 1 hour. Your limit will reset at 2026-09-07 20:30:00][x]',
    { now: NOW });
  // 20:30 UTC is 17m away; only offset 0 fits inside a 1-hour window.
  assert.equal(e.reset.offset, 0);
});

test('an unknown code is reported, not silently swallowed', () => {
  const e = explainProviderError('[9999][Something new][req]', { now: NOW });
  assert.equal(e.code, 9999);
  assert.equal(e.kind, 'unknown');
  assert.match(e.advice, /Unrecognised/);
});

test('text with no provider error yields null, so ordinary failures are untouched', () => {
  assert.equal(explainProviderError('TypeError: x is not a function', { now: NOW }), null);
  assert.equal(explainProviderError(''), null);
  assert.equal(explainProviderError(undefined), null);
});

test('the formatted block leads with the actionable fact', () => {
  const out = formatProviderError(explainProviderError(USAGE, { now: NOW }));
  const lines = out.split('\n');
  assert.match(lines[0], /Usage limit reached/);
  assert.match(lines[1], /resets at .* \(in 1h 53m\)/);
  assert.ok(!/ at .*\.cjs:/.test(out), 'must not carry stack frames');
  assert.ok(out.split('\n').length <= 6, 'must stay readable, unlike the 63-line dump');
});

test('humanDelta reads as a person would say it', () => {
  assert.equal(humanDelta(0), '0m');
  assert.equal(humanDelta(59 * 60_000), '59m');
  assert.equal(humanDelta(60 * 60_000), '1h 0m');
  assert.equal(humanDelta(112 * 60_000), '1h 52m');
});

let pass = 0, fail = 0;
for (const [n, f] of tests) {
  try { f(); pass++; } catch (e) { fail++; console.error(`FAIL ${n}\n  ${e.message}`); }
}
console.log(`${pass}/${tests.length} provider-error tests passed`);
process.exit(fail ? 1 : 0);
