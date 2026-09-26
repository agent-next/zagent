// headless-retry tests — r5-hardened trigger oracle.
import { decideRetry, runHeadlessWithRetry, argvError } from './headless-retry.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

ok(decideRetry('', 0).retry === true, 'empty stdout retries');
ok(decideRetry('  \n ', 1).retry === true, 'whitespace-only retries');
ok(decideRetry('{"error":{"code":429}}', 0).retry === true, 'error envelope retries');
ok(decideRetry('{"isError":true}', 0).retry === true, 'isError retries');
ok(decideRetry('{"error":null,"response":"done"}', 0).retry === false, 'error:null is SUCCESS (r5 #3)');
ok(decideRetry('{"response":"done"}', 0).retry === false, 'good JSON no retry');
ok(decideRetry('plain text', 0, undefined, { jsonMode: false }).retry === false, 'non-json mode: plain text ok');
ok(decideRetry('{"partial":"json"', 0).retry === true, 'malformed JSON retries in jsonMode (r5 #2 fail-closed)');
ok(decideRetry('', 0, 'ENOENT').retry === false && decideRetry('', 0, 'ENOENT').terminal === true, 'spawn error terminal, no retry (r5 #6)');
ok(decideRetry('', 2).reason.includes('exit 2'), 'reason carries exit code');
// Real-shape pin (supervisor-verified vs installed 3.12.1): the kernel's usage
// dump emits BARE 'Usage:' with NO trailing space — the old colon+space pattern
// never matched it.
{
  const r = { stdout: '', stderr: 'zcode 0.16.5\n\nUsage:\n\nOptions:\n  -h, --help' };
  ok(argvError(r).terminal === true, 'bare Usage: dump (no trailing space) classifies terminal');
}

// EXHAUSTED-class provider errors (1308/1113) are deterministic until the window
// resets — an outer retry just replays a guaranteed-dead turn (P1 finding).
ok(decideRetry('{"error":{"code":-32000,"message":"ProviderBusinessError: [1308][Usage limit reached for 5 hour. Your limit will reset at 2030-01-01 00:00:00][req1]"}}', 0).retry === false,
  'EXHAUSTED 1308 error envelope does not retry');
ok(decideRetry('{"isError":true,"result":"[1113][insufficient balance][req2]"}', 0).retry === false,
  'EXHAUSTED 1113 inside isError envelope does not retry');
ok(decideRetry('{"error":{"message":"[1302][too many requests][req3]"}}', 0).retry === true,
  'RETRYABLE 1302 error envelope still retries');
ok(decideRetry('{"error":{"code":429}}', 0).retry === true, 'generic error envelope still retries');
ok(decideRetry('{"error":{"code":1308}}', 0).retry === false, 'numeric EXHAUSTED code without bracketed message does not retry');

// The kernel actually reports plan-window exhaustion on STDERR with empty/error
// stdout — the retry decision must see it too.
const exhausted = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("[1308][Usage limit reached for 5 hour. Your limit will reset at 2030-01-01 00:00:00][r]\\n"); process.exit(1)'],
  { backoffMs: [1] });
ok(exhausted.attempts === 1 && exhausted.exitCode === 1 && exhausted.terminal === true,
  'EXHAUSTED on stderr cancels the retry (1 attempt, kernel exit preserved)');
const retryable = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("[1302][rate limited][r]\\n"); process.exit(1)'],
  { backoffMs: [1] });
ok(retryable.attempts === 2 && retryable.exitCode === 1, 'RETRYABLE 1302 on stderr still retries once');

// Kernel argv-validation failures are deterministic for identical args — on the
// installed build, `--mode bogus` burned an 8s retry and then misreported
// 'empty output' while the real diagnostic sat on stderr.
const badMode = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("Unsupported --mode value: bogus. Supported modes: build, edit, plan, yolo.\\n"); process.exit(1)'],
  { backoffMs: [1] });
ok(badMode.attempts === 1 && badMode.terminal === true && badMode.exitCode === 1,
  'Unsupported --flag on stderr cancels the retry (1 attempt, kernel exit preserved)');
const badCwd = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("--cwd path is not accessible: /nonexistent\\n"); process.exit(1)'],
  { backoffMs: [1] });
ok(badCwd.attempts === 1 && badCwd.terminal === true, 'cwd preflight error on stderr cancels the retry');
const usageDump = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("Unknown option \'--tui\'\\n\\nUsage: zcode [options]\\n"); process.exit(1)'],
  { backoffMs: [1] });
ok(usageDump.attempts === 1 && usageDump.terminal === true, 'kernel usage dump on stderr cancels the retry');
const envRetry = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("Unknown option \'--x\'\\n"); process.stdout.write("{\\"error\\":{\\"code\\":429}}\\n")'],
  { backoffMs: [1] });
ok(envRetry.attempts === 2, 'envelope-bearing attempt keeps retry semantics despite usage-shaped stderr');

// Remaining kernel argv-rejection classes, all verified against the installed
// 3.12.1 kernel (zcode 0.16.5): the value-whitelist error, commander's
// missing-value error, and an anchored path-preflight that a mid-run file
// error must NOT trip.
const badFormat = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("--output-format must be one of text, json, stream-json (received: bogus).\\n"); process.exit(1)'],
  { backoffMs: [1] });
ok(badFormat.attempts === 1 && badFormat.terminal === true, 'must-be-one-of value error cancels the retry');
const missingValue = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("Option \'--mode <value>\' argument missing\\n\\nzcode 0.16.5\\n"); process.exit(1)'],
  { backoffMs: [1] });
ok(missingValue.attempts === 1 && missingValue.terminal === true, 'commander missing-value error cancels the retry');
const missingValueShort = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("Option \'-p, --prompt <value>\' argument missing\\n"); process.exit(1)'],
  { backoffMs: [1] });
ok(missingValueShort.attempts === 1 && missingValueShort.terminal === true, 'combined short/long missing-value error cancels the retry');
const midRunPath = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("some tool reported path is not accessible: /tmp/x\\n"); process.exit(1)'],
  { backoffMs: [1] });
ok(midRunPath.attempts === 2, 'unanchored mid-run "path is not accessible" still retries');
const silent = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.exit(1)'],
  { backoffMs: [1] });
ok(silent.attempts === 2, 'empty stdout + empty stderr still retries (the transient 429 shape)');

// Cross-flag and parseArgs-verbatim classes (observed on the installed build):
const crossFlag = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("--browser-executable requires --browser-use=headless.\\n"); process.exit(1)'],
  { backoffMs: [1] });
ok(crossFlag.attempts === 1 && crossFlag.terminal === true, 'requires-sibling flag error cancels the retry');
const cannotCombine = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("--target cannot be used with --prompt.\\n"); process.exit(1)'],
  { backoffMs: [1] });
ok(cannotCombine.attempts === 1 && cannotCombine.terminal === true, 'cannot-be-used-with error cancels the retry');
const badResume = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("Error: Session not found: nosuch (traceId: abc)\\n"); process.exit(1)'],
  { backoffMs: [1] });
ok(badResume.attempts === 1 && badResume.terminal === true, 'session-not-found resume error cancels the retry');
const shortOpt = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("Option \'-p <value>\' argument missing\\n"); process.exit(1)'],
  { backoffMs: [1] });
ok(shortOpt.attempts === 1 && shortOpt.terminal === true, 'single-dash missing-value error cancels the retry');
const boolArg = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("Option \'--json\' does not take an argument\\n"); process.exit(1)'],
  { backoffMs: [1] });
ok(boolArg.attempts === 1 && boolArg.terminal === true, 'does-not-take-an-argument error cancels the retry');
const strayPositional = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("Unexpected argument \'x\'. This command does not take positional arguments\\n"); process.exit(1)'],
  { backoffMs: [1] });
ok(strayPositional.attempts === 1 && strayPositional.terminal === true, 'unexpected-argument error cancels the retry');
const midRunUsage = runHeadlessWithRetry(process.execPath,
  ['-e', 'process.stderr.write("  tool printed Usage: like text mid-line\\n"); process.exit(1)'],
  { backoffMs: [1] });
ok(midRunUsage.attempts === 2, 'non-line-start "Usage:" still retries (anchor pin)');

console.log(fails ? `FAIL (${fails})` : 'PASS headless-retry');
process.exit(fails ? 1 : 0);
