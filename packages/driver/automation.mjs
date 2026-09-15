// D7 automation — CLI-side scheduled prompts (upstream automations are GUI-only).
// r7-hardened: strict cron grammar with STANDARD dom/dow OR semantics, dow 7→0,
// 1-based step anchoring, atomic (tmp+rename) state writes, ENOENT-only empty read,
// per-job claim/complete lifecycle (no batch replay, no silent double-fire).
// No daemon: the user's crontab calls `zmax cron tick`; every tick appends a heartbeat
// receipt and exits nonzero on failures (no-bare-cron rule).

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';

const BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]; // m h dom mon dow (dow 7 == 0 == Sunday)
const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function jobsPath({ home = os.homedir() } = {}) { return `${home}/.zcode/cli/automations.json`; }

// Strict single-field parser -> predicate, or null when malformed (r7 #4).
// Standard 5-field grammar per field: '*', '*/n', atoms, 'a-b' ranges, 'a-b/n'
// stepped ranges, and comma lists of those. Month/dow also take names
// (JAN..DEC, SUN..SAT, case-insensitive). dow 7 aliases 0 (r7 #2).
function fieldMatcher(field, i) {
  const [lo, hi] = BOUNDS[i];
  const names = i === 3 ? MONTH_NAMES : i === 4 ? DOW_NAMES : null;
  const atom = s => /^\d+$/.test(s) ? +s : (names?.[s.toLowerCase()] ?? null);
  // On dow, raw value 7 aliases Sunday: a range reaching 7 must also match 0.
  const inRange = (v, a, b, n) => (v >= a && v <= b && (n == null || (v - a) % n === 0)) ||
    (i === 4 && v === 0 && 7 >= a && 7 <= b && (n == null || (7 - a) % n === 0));
  const matchers = [];
  for (const el of String(field).split(',')) {
    if (el === '*') { matchers.push(() => true); continue; }
    const stepAll = el.match(/^\*\/(\d+)$/);
    if (stepAll) {
      const n = +stepAll[1]; if (n <= 0) return null;
      matchers.push(v => (v - lo) % n === 0); continue; // anchor at the field's own lower bound (r7 #3)
    }
    const m = el.match(/^([A-Za-z]+|\d+)(?:-([A-Za-z]+|\d+))?(?:\/(\d+))?$/);
    if (!m) return null;
    const a = atom(m[1]);
    const b = m[2] === undefined ? a : atom(m[2]);
    const n = m[3] === undefined ? null : +m[3];
    if (a == null || b == null || a > b || a < lo || b > hi || n === 0) return null;
    if (n != null && m[2] === undefined) return null; // 'a/n' is not standard cron — steps are */n or a-b/n
    matchers.push(v => inRange(v, a, b, n));
  }
  return v => matchers.some(f => f(v));
}

export function parseCron(cron) { // -> predicate or null (shared by matching AND validation)
  const f = String(cron ?? '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const ms = f.map(fieldMatcher);
  return ms.every(Boolean) ? ms : null;
}

export function cronMatches(cron, d) {
  const m = parseCron(cron);
  if (!m) return false;
  const [mi, h, dom, mon, dow] = m;
  if (!mi(d.getMinutes()) || !h(d.getHours()) || !mon(d.getMonth() + 1)) return false;
  const domStar = String(cron).trim().split(/\s+/)[2] === '*';
  const dowStar = String(cron).trim().split(/\s+/)[4] === '*';
  const domOk = dom(d.getDate()), dowOk = dow(d.getDay());
  // Standard cron: only a literal '*' is unrestricted — '*/n' still constrains
  // the day. Both restricted -> OR; a starred side -> AND with the other (r7 #1)
  if (domStar || dowStar) return domOk && dowOk;
  return domOk || dowOk;
}

export function loadJobs({ home = os.homedir() } = {}) {
  try { const j = JSON.parse(readFileSync(jobsPath({ home }), 'utf8')); return Array.isArray(j.jobs) ? j.jobs : []; }
  catch (e) { if (e?.code === 'ENOENT') return []; throw new Error(`automations state unreadable: ${e.message}`); } // r7 #8: corrupt ≠ empty
}

export function saveJobs(jobs, { home = os.homedir() } = {}) {
  const dir = `${home}/.zcode/cli`;
  mkdirSync(dir, { recursive: true }); // also guarantees the heartbeat file's dir (r7 #9)
  const p = jobsPath({ home });
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 2, jobs }, null, 2));
    renameSync(tmp, p); // atomic: readers never see a truncated file
  } finally { try { unlinkSync(tmp); } catch {} }
  return p;
}

// All read/modify/write operations use this transaction. Atomic rename alone
// protects readers from torn JSON, but cannot serialize competing job claims.
// SQLite only coordinates writers; jobs stay in JSON. Its OS lock is released
// even on process death, without a stale-lock takeover protocol. Callbacks are
// synchronous and the transaction closes before running an agent job.
export function mutateJobs(update, { home = os.homedir(), lockTimeoutMs = 5000 } = {}) {
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 2147483647)
    throw new Error('invalid automation lock timeout');
  mkdirSync(`${home}/.zcode/cli`, { recursive: true });
  const db = new DatabaseSync(`${jobsPath({ home })}.coordination.sqlite`);
  try {
    db.exec(`PRAGMA busy_timeout = ${lockTimeoutMs}; BEGIN IMMEDIATE`);
    const jobs = loadJobs({ home });
    const result = update(jobs);
    saveJobs(jobs, { home });
    db.exec('COMMIT');
    return result;
  } finally { db.close(); }
}

const minuteOf = ms => Math.floor(ms / 60_000);
export function dueJobs(jobs, now = new Date()) {
  return jobs.filter(j => cronMatches(j.cron, now) &&
    (j.lastAttemptMs == null || minuteOf(j.lastAttemptMs) < minuteOf(now.getTime())) &&
    // failedAtMs: an occurrence whose minute had already passed while the failed
    // run was still going is NOT the next occurrence — the next one is.
    (j.failedAtMs == null || minuteOf(now.getTime()) * 60_000 > j.failedAtMs));
}

// Use inside mutateJobs: recheck the scheduled minute while holding the lock.
// Stale claims (>10min, crashed mid-run) can run on a later scheduled occurrence.
export function claimJob(jobs, id, { nowMs = Date.now(), scheduledAtMs = nowMs, staleAfterMs = 10 * 60_000 } = {}) {
  const j = jobs.find(x => x.id === id);
  if (!j) return null;
  if (j.status === 'running' && nowMs - (j.claimedAtMs ?? 0) < staleAfterMs) return null; // live elsewhere
  if (!dueJobs([j], new Date(scheduledAtMs)).length) return null;
  j.status = 'running'; j.claimedAtMs = nowMs; j.lastAttemptMs = scheduledAtMs;
  j.claimToken = randomUUID();
  return j;
}

export function completeJob(jobs, id, { ok, error = null, nowMs = Date.now(), claimToken } = {}) {
  const j = jobs.find(x => x.id === id);
  if (!j || (claimToken !== undefined && j.claimToken !== claimToken)) return null;
  if (ok) { j.lastSuccessMs = nowMs; j.status = 'idle'; j.error = null; j.failedAtMs = null; }
  else { j.status = 'failed'; j.error = String(error).slice(0, 200); j.failedAtMs = nowMs; }
  return j;
}

// A timed-out job must lose its whole process GROUP: the zmax child spawns the
// runtime, and signalling only the direct child leaves the grandchild burning
// quota. The child is spawned detached so it leads its own group on POSIX.
export function killProcessTree(pid, signal = 'SIGTERM') {
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    return;
  }
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch {} }
}

// spawnSync's timeout only signals the direct child. This resolves with the same
// result shape the tick consumes ({status, stdout, stderr}) plus timedOut, and
// on timeout kills the process tree: SIGTERM, SIGKILL after a grace, and a final
// settle so a child that survives even that cannot hang the tick forever.
export function runTimedProcess(cmd, args, { cwd, env, timeoutMs = 300000, maxBuffer = 64e6 } = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, settled = false, force, hang;
    const finish = res => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(force); clearTimeout(hang);
      resolve(res);
    };
    child.stdout.on('data', d => { if (Buffer.byteLength(stdout) < maxBuffer) stdout += d; });
    child.stderr.on('data', d => { if (Buffer.byteLength(stderr) < maxBuffer) stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, 'SIGTERM');
      force = setTimeout(() => killProcessTree(child.pid, 'SIGKILL'), 3000);
      hang = setTimeout(() => finish({ status: null, signal: 'SIGTERM', stdout, stderr, timedOut }), 10000);
      force.unref(); hang.unref();
    }, timeoutMs);
    child.on('error', error => finish({ status: null, error, stdout, stderr, timedOut }));
    child.on('close', (status, signal) => finish({ status, signal, stdout, stderr, timedOut }));
  });
}

export function jobsLine(jobs) {
  if (!jobs.length) return 'no automations';
  return jobs.map(j => `${j.id}: '${j.cron}' → ${String(j.prompt).slice(0, 40)}` +
    (j.status === 'failed' ? ` FAILED(${j.error ?? '?'})` : j.status === 'running' ? ' [running]' : '') +
    (j.lastSuccessMs ? ` (ok ${new Date(j.lastSuccessMs).toISOString().slice(0, 16).replace('T', ' ')}Z)` : ' (never succeeded)')).join('\n');
}
