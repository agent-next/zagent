// `zagent offpeak` contract.
//
// packages/driver/offpeak.mjs shipped in the package with no way to
// invoke it — no bin entry, no subcommand. A scheduler a user cannot ask is dead
// weight in the tarball. These assertions are what makes it reachable AND what
// makes its answer usable from a shell.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inOffPeak, defaultWindow, campaignActive } from './offpeak.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(root, 'packages', 'cli', 'zagent-offpeak.mjs');
// A fake HOME keeps a stale real offpeak-cache.json from flipping the expected
// window — cachedWindow() misses, the CLI falls back to defaultWindow().
const fakeHome = mkdtempSync(path.join(tmpdir(), 'zagent-offpeak-'));
process.on('exit', () => rmSync(fakeHome, { recursive: true, force: true }));
const run = (...args) => spawnSync(process.execPath, [cli, ...args],
  { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, ZAGENT_TEST_SANDBOX: fakeHome } });

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

// --- the window matches the announced campaign ---------------------------------
// The provider's announced campaign is "8 AM-6 PM PT every day, Sep 3-20". The window is stored in SGT;
// 23:00-09:00 SGT is exactly 08:00-18:00 PT. If these ever disagree, the command
// is confidently telling users the wrong hours.
const win = defaultWindow();
const atPT = (hour, minute = 0) => new Date(Date.UTC(2026, 8, 8, hour + 7, minute)); // PDT = UTC-7
ok(inOffPeak(atPT(8, 30), win) === true, '08:30 PT is inside the announced window');
ok(inOffPeak(atPT(17, 30), win) === true, '17:30 PT is inside the announced window');
ok(inOffPeak(atPT(7, 30), win) === false, '07:30 PT is outside — the window opens at 8 AM PT');
ok(inOffPeak(atPT(18, 30), win) === false, '18:30 PT is outside — the window closes at 6 PM PT');
ok(win.campaignEnd === '2026-09-20', 'the campaign end matches the announcement');

// --- exit code is the answer ---------------------------------------------------
// `zagent offpeak && run-the-batch` has to work, so the code must track the window
// rather than always being 0.
const result = run();
ok([0, 1].includes(result.status), `exit code is 0 or 1 (got ${result.status})`);
const openNow = inOffPeak(new Date(), win) && campaignActive(new Date(), win);
ok((result.status === 0) === openNow,
   `exit 0 exactly when the campaign window is active (window open: ${openNow}, exit: ${result.status})`);
ok(result.stderr === '', 'a closed window is not an error — nothing on stderr');

// --- human output --------------------------------------------------------------
ok(/off-peak window: .*local/.test(result.stdout), 'the window is stated in local time');
ok(/SGT/.test(result.stdout), 'and in the campaign zone it is defined in');
ok(/campaign ends 2026-09-20|campaign ended 2026-09-20/.test(result.stdout), 'the campaign end is stated');
ok(!/routing now/.test(result.stdout), 'no per-minute routing verdict in human output');
ok(/Billing for this window is not verified by zagent\./.test(result.stdout), 'billing caveat is stated plainly');
ok(result.stdout.trim().split('\n').length <= 3, 'human output stays at three lines or fewer');

// --- machine output ------------------------------------------------------------
const json = run('--json');
ok(json.status === result.status, '--json does not change the exit code');
let parsed = null;
try { parsed = JSON.parse(json.stdout); } catch {}
ok(parsed !== null, '--json emits parseable JSON and nothing else');
for (const key of ['open', 'campaignActive', 'campaignEnd', 'windowSGT', 'minutesUntilOpen',
  'routeMechanicalToFlash', 'reason']) {
  ok(key in parsed, `--json reports ${key}`);
}
ok(parsed.open === openNow, '--json agrees with the driver about the window');
ok(parsed.routeMechanicalToFlash === (result.status === 0), '--json routing agrees with the exit code');
ok(typeof parsed.minutesUntilOpen === 'number' && parsed.minutesUntilOpen >= 0,
   'minutesUntilOpen is a non-negative number, never NaN');

// --- reachable, and shipped ----------------------------------------------------
const bin = readFileSync(path.join(root, 'bin', 'zagent'), 'utf8');
ok(/offpeak:\s*\['packages\/cli\/zagent-offpeak\.mjs'\]/.test(bin),
   'the bin dispatcher routes the offpeak subcommand');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
ok(pkg.files.includes('packages/cli/zagent-offpeak.mjs'), 'the command ships in the package');
ok(pkg.files.includes('packages/driver/offpeak.mjs'), 'so does the driver it calls');
const help = spawnSync(process.execPath, [path.join(root, 'packages', 'cli', 'zagent-help.mjs')],
  { encoding: 'utf8', timeout: 20000 });
ok(/offpeak/.test(help.stdout), 'help lists it — an unlisted command may as well not exist');

// --- stray argv is a usage error, not a silent window check -------------------
for (const [args, note] of [
  [['bogus'], 'stray positional'],
  [['--bogus'], 'unknown flag'],
  [['x', 'tools'], 'word before tools'],
  [['tools', '--refresh'], '--refresh does not apply to tools'],
  [['tools', 'bogus'], 'unknown tools verb'],
  [['tools', 'on', '--bogus'], 'flag after a valid verb is still unknown'],
]) {
  const r = run(...args);
  ok(r.status === 2, `offpeak ${args.join(' ')}: ${note} exits 2 (got ${r.status})`);
  ok(/usage: zagent offpeak/.test(r.stderr), `offpeak ${args.join(' ')}: usage on stderr`);
}

// --refresh is the only argv that reaches fetchWindow(); it fails soft to the
// default window offline, so the exit contract and JSON shape still hold.
for (const args of [['--refresh'], ['--json', '--refresh']]) {
  const r = run(...args);
  ok(r.status === 0 || r.status === 1, `offpeak ${args.join(' ')}: exit tracks window (got ${r.status})`);
  if (args.includes('--json')) {
    try { JSON.parse(r.stdout); ok(true, 'offpeak --json --refresh: JSON parses'); }
    catch { ok(false, `offpeak --json --refresh: stdout not JSON — ${r.stdout.slice(0, 80)}`); }
  }
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
