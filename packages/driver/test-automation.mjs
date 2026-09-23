// D7 tests — r7-hardened semantics: strict grammar, dom/dow OR, dow 7, 1-based steps,
// claim/complete lifecycle, ENOENT-vs-corrupt, atomic save.
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cronMatches, parseCron, dueJobs, loadJobs, saveJobs, mutateJobs, jobsLine, claimJob, completeJob, runTimedProcess } from './automation.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const T = (h, m = 0, dom = 6, mon = 8, dow = 0) => new Date(2026, mon, dom, h, m); // 2026-09-06 is Sunday

ok(cronMatches('* * * * *', T(9, 5)), 'every-minute');
ok(cronMatches('0 9 * * *', T(9)), 'daily 9am');
ok(!cronMatches('0 9 * * *', T(9, 1)), 'off-minute');
ok(cronMatches('*/15 * * * *', T(9, 45)), '*/15 min anchored at 0');
ok(!cronMatches('*/15 * * * *', T(9, 50)), '*/15 miss');
// r7 #3: 1-based anchoring — */2 on months matches odd months (1,3,5,7,9,11) from Jan
ok(cronMatches('* * * */2 *', T(9, 0, 6, 8)), '*/2 month matches Sept (1-based anchor)');
ok(!cronMatches('* * * */2 *', T(9, 0, 6, 9)), '*/2 month misses Oct');
// r7 #2: dow 7 == Sunday
ok(cronMatches('0 6 * * 7', T(6)), 'dow 7 matches Sunday');
// r7 #1: restricted dom+dow = OR — 2026-09-06 is Sunday(0); dom 1 does NOT match, dow 0 does
ok(cronMatches('0 0 1 * 0', T(0)), 'dom1+dow0 runs on Sunday via OR');
ok(!cronMatches('0 0 1 * 1', T(0)), 'dom1+dow1 misses Sunday');
ok(cronMatches('0 0 1 * *', T(0)) === false, 'dom-only 1 misses Sept 6');
ok(parseCron('61 * * * *') === null, 'minute out of range rejected');
ok(parseCron('* * 0 * *') === null, 'dom 0 rejected');
ok(parseCron('* * * 13 *') === null, 'month 13 rejected');
ok(parseCron('*/0 * * * *') === null, 'zero step rejected');
ok(parseCron('5,,7 * * * *') === null, 'empty list item rejected');
ok(parseCron('a b c d e') === null, 'garbage rejected');
ok(parseCron('1 2 3 4 5 6') === null, '6 fields rejected');
ok(parseCron('0 9 * * *') !== null, 'valid parses');

// P1: standard range/step/list/name forms the usage line advertises.
// 2026-09-14 is a Monday, 2026-09-18 a Friday (2026-09-06 is the Sunday above).
ok(parseCron('0 9 * * 1-5') !== null, 'advertised dow range 1-5 parses');
ok(parseCron('*/15 * * * *') !== null, 'advertised */15 step parses');
ok(cronMatches('0 9 * * 1-5', new Date(2026, 8, 14, 9, 0)), 'weekday range fires Monday');
ok(!cronMatches('0 9 * * 1-5', new Date(2026, 8, 13, 9, 0)), 'weekday range skips Sunday');
ok(cronMatches('0 9 * * MON-FRI', new Date(2026, 8, 18, 9, 0)), 'dow name range fires Friday');
ok(!cronMatches('0 9 * * MON-FRI', new Date(2026, 8, 19, 9, 0)), 'dow name range skips Saturday');
ok(cronMatches('0 0 1 JAN *', new Date(2026, 0, 1)), 'month name JAN');
ok(cronMatches('0 0 * JAN-MAR *', new Date(2026, 1, 10)), 'month name range');
ok(cronMatches('0-30/10 * * * *', T(9, 20)), 'stepped range a-b/n hits on-step');
ok(!cronMatches('0-30/10 * * * *', T(9, 25)), 'stepped range misses off-step');
ok(cronMatches('9-17/2 * * * *', T(9, 11)), 'stepped range anchored at range start');
ok(cronMatches('0 9 * * 5-7', T(9)), 'dow range through 7 includes Sunday');
ok(parseCron('9-1 * * * *') === null, 'reversed range rejected');
ok(parseCron('0-70 * * * *') === null, 'out-of-bounds range rejected');
ok(parseCron('0-30/0 * * * *') === null, 'zero step in range rejected');
ok(parseCron('5/2 * * * *') === null, 'bare step without range rejected');
ok(parseCron('FOO * * * *') === null, 'unknown name rejected');
// '*/n' in dom/dow is RESTRICTED, not '*': it still constrains the day.
// dom */2 anchors at dom-lo=1 -> odd days. 2026-09-06/07 are Sun/Mon.
ok(cronMatches('0 0 */2 * *', new Date(2026, 8, 7)), 'dom */2 fires odd day');
ok(!cronMatches('0 0 */2 * *', new Date(2026, 8, 8)), 'dom */2 skips even day');
// dow */2 anchors at 0 -> Sun/Tue/Thu/Sat; dom restricted -> OR.
ok(cronMatches('0 0 1 * */2', new Date(2026, 8, 8)), 'dom1+dow*/2 fires Tuesday via OR');
ok(cronMatches('0 0 1 * */2', new Date(2026, 8, 1)), 'dom1+dow*/2 fires dom 1 via OR');
ok(!cronMatches('0 0 2 * */2', new Date(2026, 8, 9)), 'dom2+dow*/2 skips Wednesday');
// dom */n + restricted dow -> OR on both sides.
ok(cronMatches('0 0 */2 * 0', new Date(2026, 8, 6)), 'dom*/2+dow0 fires Sunday');
ok(cronMatches('0 0 */2 * 0', new Date(2026, 8, 7)), 'dom*/2+dow0 fires odd day');
ok(parseCron('JAN * * * *') === null, 'month name rejected outside month field');
ok(parseCron('1- * * * *') === null, 'open-ended range rejected');

// Deduplicate the scheduled minute, independently of how long the job took.
const NOW = T(9);
ok(dueJobs([{ id: 'a', cron: '0 9 * * *', lastAttemptMs: null }], NOW).length === 1, 'never-attempted due');
ok(dueJobs([{ id: 'b', cron: '0 9 * * *', lastAttemptMs: NOW.getTime() + 5000 }], new Date(NOW.getTime() + 30_000)).length === 0, 'same scheduled minute is not due again');
ok(dueJobs([{ id: 'c', cron: '0 9 * * *', lastAttemptMs: NOW.getTime() - 61_000, lastSuccessMs: null }], NOW).length === 1, 'FAILED job re-fires next minute+');
ok(dueJobs([{ id: 'd', cron: '* * * * *', lastAttemptMs: NOW.getTime() + 5000 }], new Date(NOW.getTime() + 60_000)).length === 1,
   'previous-minute attempt is due at the next minute even when less than 60 seconds old');

// claim/complete lifecycle
let jobs = [{ id: 'x', cron: '* * * * *', status: 'idle' }];
ok(claimJob(jobs, 'x') !== null && jobs[0].status === 'running', 'claim marks running');
ok(claimJob(JSON.parse(JSON.stringify(jobs)), 'x') === null, 'second claim refused while fresh');
const stale = [{ id: 'x', cron: '* * * * *', status: 'running', claimedAtMs: Date.now() - 11 * 60_000 }];
ok(claimJob(stale, 'x') !== null, 'stale claim (>10min) reclaimed');
completeJob(jobs, 'x', { ok: false, error: 'boom' });
ok(jobs[0].status === 'failed' && jobs[0].error === 'boom' && jobs[0].lastAttemptMs > 0 && !jobs[0].lastSuccessMs, 'failure: attempt stamped, success not');
completeJob(jobs, 'x', { ok: true });
ok(jobs[0].status === 'idle' && jobs[0].lastSuccessMs > 0 && jobs[0].error === null, 'success clears error');

const timed = [{ id: 'minute', cron: '* * * * *', status: 'idle' }];
const timedClaim = claimJob(timed, 'minute', { nowMs: NOW.getTime() + 1000, scheduledAtMs: NOW.getTime() });
completeJob(timed, 'minute', { ok: true, nowMs: NOW.getTime() + 5000, claimToken: timedClaim.claimToken });
ok(timed[0].lastAttemptMs === NOW.getTime(), 'completion preserves the attempted schedule minute');
ok(claimJob(timed, 'minute', { nowMs: NOW.getTime() + 6000, scheduledAtMs: NOW.getTime() }) === null,
   'completed occurrence cannot be reclaimed by an overlapping tick');
ok(claimJob(timed, 'minute', { nowMs: NOW.getTime() + 60_000 }) !== null, 'every-minute job claims the next minute after a five-second run');
const activeToken = timed[0].claimToken;
ok(completeJob(timed, 'minute', { ok: true, claimToken: 'obsolete-claim' }) === null && timed[0].status === 'running' && timed[0].claimToken === activeToken,
   'stale completion cannot overwrite a newer claim');

// persistence: ENOENT empty; corrupt THROWS (r7 #8); atomic save
const home = mkdtempSync(path.join(os.tmpdir(), 'zauto7-'));
ok(loadJobs({ home }).length === 0, 'ENOENT -> []');
mkdirSync(`${home}/.zcode/cli`, { recursive: true });
writeFileSync(`${home}/.zcode/cli/automations.json`, '{torn');
let threw = false; try { loadJobs({ home }); } catch { threw = true; }
ok(threw, 'corrupt state THROWS (never silently empty)');
saveJobs([{ id: 'k', cron: '* * * * *', prompt: 'p' }], { home });
ok(loadJobs({ home }).length === 1, 'atomic save roundtrip');
let transactionFailed = false;
try { mutateJobs(j => { j.push({ id: 'uncommitted' }); throw new Error('fixture failure'); }, { home }); }
catch { transactionFailed = true; }
ok(transactionFailed && loadJobs({ home }).length === 1, 'failed transaction leaves persisted jobs intact');
mutateJobs(j => j.push({ id: 'committed' }), { home });
ok(loadJobs({ home }).length === 2, 'transaction releases its lock on failure and later writes succeed');
ok(jobsLine([{ id: 'k', cron: '* * * * *', prompt: 'p', status: 'failed', error: 'e' }]).includes('FAILED'), 'listing shows failures');

// A failed run must not re-fire at an occurrence that had already passed while
// it was still running — only at the first scheduled occurrence AFTER the
// failure. Old code keyed the dedup on the attempt minute, so a job whose run
// crossed a minute boundary re-fired on the very next tick.
{
  const t0 = NOW.getTime();
  const jobs = [{ id: 'f', cron: '* * * * *', status: 'idle', lastAttemptMs: null }];
  const claim = claimJob(jobs, 'f', { nowMs: t0, scheduledAtMs: t0 });
  const failAt = t0 + 150_000; // claimed at 9:00, the run dies at 9:02:30
  completeJob(jobs, 'f', { ok: false, error: 'boom', nowMs: failAt, claimToken: claim.claimToken });
  ok(jobs[0].failedAtMs === failAt, 'failure stamps failedAtMs');
  ok(dueJobs(jobs, new Date(t0 + 150_500)).length === 0,
     'failed job is not due at an occurrence that passed while it was still running');
  ok(dueJobs(jobs, new Date(t0 + 180_000)).length === 1,
     'failed job is due at the next occurrence after the failure');
  completeJob(jobs, 'f', { ok: true, nowMs: t0 + 190_000, claimToken: jobs[0].claimToken });
  ok(jobs[0].failedAtMs == null, 'success clears failedAtMs');
}

// A timed-out job must lose its whole process group: the old spawnSync timeout
// SIGTERMed only the direct child and left the runtime grandchild burning quota.
if (process.platform !== 'win32') {
  const markerDir = mkdtempSync(path.join(os.tmpdir(), 'zjob-'));
  const pidFile = path.join(markerDir, 'grandchild.pid');
  const childSrc = `const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
    setInterval(() => {}, 1e9);`;
  const r = await runTimedProcess(process.execPath, ['-e', childSrc], { timeoutMs: 800 });
  ok(r.timedOut === true, 'a job that overruns its budget is marked timed out');
  const gpid = Number(readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try { process.kill(gpid, 0); } catch { alive = false; }
    if (alive) await new Promise(r2 => setTimeout(r2, 50));
  }
  ok(!alive, 'the grandchild dies with the job, not just the direct child');
  rmSync(markerDir, { recursive: true, force: true });
}
rmSync(home, { recursive: true, force: true });
console.log(fails ? `FAIL (${fails})` : 'PASS automation-d7-r7');
process.exit(fails ? 1 : 0);
