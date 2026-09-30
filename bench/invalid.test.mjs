#!/usr/bin/env node
// A throttled cell is a cell with no measurement in it, not a failed task.
// z.ai answers `[1302] Rate limit reached` with no retry-after and the harness
// exits empty, which grades as pass:false — indistinguishable from the model
// getting the task wrong, and biased toward whichever lane got throttled. The
// four-way matrix scored zcode-app-cli 0/2 that way before this was caught.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./run-multi.mjs', import.meta.url), 'utf8');
const m = src.match(/const PROVIDER_FAIL = \[([\s\S]*?)\];/);
assert.ok(m, 'PROVIDER_FAIL table present');
const patterns = [...m[1].matchAll(/\[(\/.*?\/[a-z]*), '([a-z-]+)'\]/g)]
  .map(([, re, label]) => [eval(re), label]);
assert.ok(patterns.length >= 4, 'table has entries');

const classify = (text) => patterns.find(([re]) => re.test(text))?.[1] ?? null;

const tests = [];
const test = (n, f) => tests.push([n, f]);

test('the real z.ai throttle message is classified as rate-limited', () => {
  // Verbatim from a run of zcode-app-cli under the flash-pinned HOME, 2026-09-07.
  const real = 'ProviderBusinessError: [1302][Rate limit reached for requests][202609080312054dd52858362f49d2]';
  assert.equal(classify(real), 'rate-limited');
});

test('network drops are classified, not scored', () => {
  assert.equal(classify('Error: socket hang up'), 'network');
  assert.equal(classify('connect ETIMEDOUT 1.2.3.4:443'), 'network');
});

test('auth failures are classified', () => {
  assert.equal(classify('401 Unauthorized'), 'auth');
});

test('an ordinary wrong answer is NOT classified as a provider failure', () => {
  assert.equal(classify(''), null);
  assert.equal(classify('AssertionError: expected 3 got 4'), null);
});

test('run-multi records pass:null when a cell is invalid', () => {
  assert.match(src, /pass:\s*invalid\s*\?\s*null\s*:/,
    'an invalid cell must not carry a pass/fail verdict');
});

test('the matrix re-runs invalid receipts instead of resuming past them', () => {
  const sh = readFileSync(new URL('./offpeak-matrix.sh', import.meta.url), 'utf8');
  assert.match(sh, /process\.exit\(r\.invalid \? 1 : 0\)/,
    'a receipt marked invalid must not count as an already-done cell');
  assert.match(sh, /backing off/, 'throttling must widen the gap, not keep hammering');
});

// The flash pin isolates HOME so the kernel reads a flash-pinned config. That must
// not relocate the installed harnesses: zcode-app-cli located its entry with
// os.homedir(), so under the pin it resolved into the throwaway temp HOME and died
// with MODULE_NOT_FOUND — scoring 0/3 for a reason with nothing to do with the model.
test('harness entry paths resolve from the real home, not the pinned one', () => {
  assert.match(src, /const REAL_HOME = process\.env\.BENCH_REAL_HOME \|\| os\.homedir\(\)/,
    'a real-home escape hatch must exist');
  const table = src.slice(src.indexOf('const HARNESS_CMDS'), src.indexOf('const hc = HARNESS_CMDS'));
  assert.ok(!/os\.homedir\(\)/.test(table),
    'no harness may locate its binary via os.homedir(): HOME is overridden by the flash pin');
  const sh = readFileSync(new URL('./offpeak-matrix.sh', import.meta.url), 'utf8');
  const exportAt = sh.indexOf('export BENCH_REAL_HOME');
  const pinAt = sh.indexOf('FLASH_HOME=');
  assert.ok(exportAt > 0 && exportAt < pinAt,
    'the real home must be captured before HOME is overridden');
});

// 1308 arrives as HTTP 429 too, but it is the plan's usage WINDOW, not concurrency.
// Retrying it burns the rest of the run against a wall that lasts hours. The
// 2026-09-07 matrix mislabelled 4 cells this way before the codes were split.
test('the usage window is classified apart from the rate limit', () => {
  const usage = 'ProviderBusinessError: [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-09-08 06:05:37][x]';
  const rate = 'ProviderBusinessError: [1302][Rate limit reached for requests][y]';
  assert.equal(classify(usage), 'usage-limit');
  assert.equal(classify(rate), 'rate-limited');
  assert.notEqual(classify(usage), classify(rate));
});

test('a bare 429 with no provider code still classifies as a rate limit', () => {
  assert.equal(classify('HTTP 429 Too Many Requests'), 'rate-limited');
});

test('the matrix stops on a usage wall instead of backing off into it', () => {
  const sh = readFileSync(new URL('./offpeak-matrix.sh', import.meta.url), 'utf8');
  assert.match(sh, /usage-limit/);
  assert.match(sh, /break 3/, 'must leave all three loops, not just the innermost');
});

test('an invalid receipt keeps the provider error LINE, not just a tail', () => {
  // errTail is the last 300 chars, which on a real failure was HTTP headers — the
  // code lives near the start, so four receipts could not be told apart afterwards.
  assert.match(src, /errLine:/);
  assert.match(src, /\\\[\\d\{3,6\}\\\]/, 'must extract the [code][message] shape');
});

let pass = 0, fail = 0;
for (const [n, f] of tests) {
  try { f(); pass++; } catch (e) { fail++; console.error(`FAIL ${n}\n  ${e.message}`); }
}
console.log(`${pass}/${tests.length} invalid-cell tests passed`);
process.exit(fail ? 1 : 0);
