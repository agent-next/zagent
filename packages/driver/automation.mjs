// D7 automation — CLI-side scheduled prompts (upstream automations are GUI-only).
// r7-hardened: strict cron grammar with STANDARD dom/dow OR semantics, dow 7→0,
// 1-based step anchoring, atomic (tmp+rename) state writes, ENOENT-only empty read,
// per-job claim/complete lifecycle (no batch replay, no silent double-fire).
// No daemon: the user's crontab calls `zmax cron tick`; every tick appends a heartbeat
// receipt and exits nonzero on failures (no-bare-cron rule).

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, appendFileSync, chmodSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';

const require = createRequire(import.meta.url);

const BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]; // m h dom mon dow (dow 7 == 0 == Sunday)
const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function jobsPath({ home = os.homedir() } = {}) { return `${home}/.zcode/cli/automations.json`; }
export function automationLogPath({ home = os.homedir() } = {}) { return `${home}/.zcode/cli/automation-heartbeat.log`; }

// Modes that bypass permission prompts at fire time (`--mode yolo`). The kernel
// boundary demotes them at create; a stored job carrying one WITHOUT the
// human-confirmation marker (modeConfirmed — set only by the human
// `zagent automation create --mode` path) is swept to 'build' on load, so a
// pre-fix or same-UID-injected store cannot still fire bypassing.
export const PRIVILEGED_JOB_MODES = new Set(['yolo', 'dontAsk', 'bypassPermissions']);

// Single audit trail for the automation subsystem: the tick heartbeats here and
// every automation/* store write appends a line — kernel-initiated writes are
// otherwise silent until the job fires. 0600: it can carry prompt fragments.
export function logAutomation(line, { home = os.homedir() } = {}) {
  try {
    const p = automationLogPath({ home });
    mkdirSync(`${home}/.zcode/cli`, { recursive: true });
    // Tighten a permissive pre-existing log BEFORE the secret-bearing line lands.
    // ENOENT is fine (the append creates it 0600); a real failure must warn —
    // otherwise the line lands in a still-permissive file silently.
    try { chmodSync(p, 0o600); }
    catch (e) { if (e?.code !== 'ENOENT')
      try { process.stderr.write(`automation audit log not owner-only: ${e?.message ?? e}\n`); } catch {} }
    appendFileSync(p, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch (e) {
    // Fail-open would let a kernel write land with zero audit trace — warn.
    try { process.stderr.write(`automation audit write failed: ${e?.message ?? e}\n`); } catch {}
  }
}

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
  try {
    const p = jobsPath({ home });
    // The store can carry arbitrary prompt text incl. observed secrets — repair
    // a permissive mode from before the 0600 rule (credentials.mjs pattern).
    try { if ((statSync(p).mode & 0o077) !== 0) chmodSync(p, 0o600); } catch {}
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const list = Array.isArray(j.jobs) ? j.jobs : [];
    // Repair-on-read (like the 0600 fix above): an unmarked privileged mode is
    // not human-confirmed — sweep it to 'build'. Persisted on the next save.
    for (const job of list)
      if (PRIVILEGED_JOB_MODES.has(job?.mode) && job.modeConfirmed !== true) job.mode = 'build';
    return list;
  }
  catch (e) { if (e?.code === 'ENOENT') return []; throw new Error(`automations state unreadable: ${e.message}`); } // r7 #8: corrupt ≠ empty
}

export function saveJobs(jobs, { home = os.homedir() } = {}) {
  const dir = `${home}/.zcode/cli`;
  mkdirSync(dir, { recursive: true }); // also guarantees the heartbeat file's dir (r7 #9)
  const p = jobsPath({ home });
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 2, jobs }, null, 2), { mode: 0o600 });
    renameSync(tmp, p); // atomic: readers never see a truncated file
    try { chmodSync(p, 0o600); } catch {} // belt-and-suspenders where mode is advisory
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
  // Lazy: node:sqlite is flag-gated on older engines and warns unflagged —
  // a top-level import would crash/warn every zcode-protocol consumer
  // (automation-host is wired into the protocol client by default).
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = `${jobsPath({ home })}.coordination.sqlite`;
  // Pre-create 0600 so a NEW db is never permissive; a pre-existing permissive
  // db is tightened post-open below (it coordinates writers — no secrets).
  try { appendFileSync(dbPath, '', { mode: 0o600 }); } catch {}
  const db = new DatabaseSync(dbPath);
  try { chmodSync(dbPath, 0o600); } catch {}
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

// --- schedule kinds -----------------------------------------------------------
// Three carriers share the store: calendar cron (j.cron), a one-shot relative
// delay (j.runAtMs — the kernel's delayMinutes path), and a recurring interval
// (j.interval {unit,n,anchorAtMs} — the kernel's scheduleRule carrier, whose
// cronExpr is display-only). All produce occurrence timestamps; a job is due
// when the latest occurrence <= now is newer than its last attempt.

// First cron occurrence strictly after afterMs, or null. Day-scan (<=1500 days,
// enough to reach a Feb-29 from any start) keeps yearly expressions cheap; a
// matching day then scans its own h/m fields.
export function nextCronMs(cron, afterMs) {
  const ms = parseCron(cron);
  if (!ms) return null;
  const [mi, h, dom, mon, dow] = ms;
  const f = String(cron).trim().split(/\s+/);
  const domStar = f[2] === '*', dowStar = f[4] === '*';
  const start = new Date(afterMs);
  for (let d = 0; d <= 1500; d++) {
    // Iterate local CALENDAR dates — local days are not 86400s across DST, so
    // day/hour components must come from the Date constructor, not epoch math.
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
    if (!mon(day.getMonth() + 1)) continue;
    const domOk = dom(day.getDate()), dowOk = dow(day.getDay());
    if (!(domStar || dowStar ? domOk && dowOk : domOk || dowOk)) continue;
    for (let hh = 0; hh < 24; hh++) {
      if (!h(hh)) continue;
      for (let mm = 0; mm < 60; mm++) {
        if (!mi(mm)) continue;
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm).getTime();
        if (t > afterMs) return t;
      }
    }
  }
  return null;
}

const INTERVAL_MS = { minute: 60_000, hourly: 3_600_000, daily: 86_400_000, weekly: 604_800_000 };
// The k-th interval occurrence (k>=1 — the anchor itself is not a fire). Linear
// units step epoch ms; monthly/yearly step the anchor's calendar date with the
// day CLAMPED to the target month (Jan 31 -> Feb 28), computed from the anchor
// each time so the landing day cannot drift across occurrences.
function intervalOccurrence({ unit, n, anchorAtMs }, k) {
  const p = INTERVAL_MS[unit];
  if (p != null) return anchorAtMs + k * n * p;
  const a = new Date(anchorAtMs);
  const d = new Date(a.getTime());
  if (unit === 'monthly') d.setMonth(a.getMonth() + k * n);
  else if (unit === 'yearly') d.setFullYear(a.getFullYear() + k * n);
  else return null;
  if (d.getDate() !== a.getDate()) d.setDate(0); // overflowed -> clamp to month's last day
  return d.getTime();
}

// Latest interval occurrence <= atMs.
function lastIntervalMs({ unit, n, anchorAtMs }, atMs) {
  const p = INTERVAL_MS[unit];
  if (p != null) {
    const k = Math.floor((atMs - anchorAtMs) / (p * n));
    return k >= 1 ? anchorAtMs + k * p * n : null;
  }
  if (unit !== 'monthly' && unit !== 'yearly') return null;
  let occ = null;
  for (let k = 1; k <= 2400; k++) {
    const t = intervalOccurrence({ unit, n, anchorAtMs }, k);
    if (t == null || t > atMs) break;
    occ = t;
  }
  return occ;
}

// First interval occurrence strictly after afterMs, or null.
function nextIntervalMs({ unit, n, anchorAtMs }, afterMs) {
  const p = INTERVAL_MS[unit];
  if (p != null) {
    // Linear units step epoch ms, so daily/weekly shift wall-clock ~1h across
    // DST; the displayed scheduleRule still pins the anchor's local time.
    const k = Math.max(1, Math.floor((afterMs - anchorAtMs) / (p * n)) + 1);
    return anchorAtMs + k * p * n;
  }
  if (unit !== 'monthly' && unit !== 'yearly') return null;
  for (let k = 1; k <= 2400; k++) {
    const t = intervalOccurrence({ unit, n, anchorAtMs }, k);
    if (t == null) return null;
    if (t > afterMs) return t;
  }
  return null;
}

// Most recent scheduled occurrence <= now, by schedule kind (null = none yet).
export function lastScheduledMs(j, nowMs) {
  if (j.runAtMs != null) return nowMs >= j.runAtMs ? j.runAtMs : null;
  if (j.interval) return lastIntervalMs(j.interval, nowMs);
  const now = new Date(nowMs);
  return cronMatches(j.cron, now) ? minuteOf(nowMs) * 60_000 : null;
}

// Next scheduled occurrence strictly after afterMs (for nextRunAt reporting).
export function nextRunMs(j, afterMs) {
  if (j.enabled === false || j.status === 'completed') return null;
  if (j.maxRuns != null && (j.runCount ?? 0) >= j.maxRuns) return null;
  if (j.runAtMs != null) return j.lastAttemptMs == null && j.runAtMs > afterMs ? j.runAtMs : null;
  if (j.interval) return nextIntervalMs(j.interval, afterMs);
  return nextCronMs(j.cron, afterMs);
}

export function dueJobs(jobs, now = new Date()) {
  const nowMs = now.getTime();
  return jobs.filter(j => {
    if (j.enabled === false || j.status === 'completed') return false;
    if (j.maxRuns != null && (j.runCount ?? 0) >= j.maxRuns) return false;
    const scheduled = lastScheduledMs(j, nowMs);
    return scheduled != null &&
      (j.lastAttemptMs == null || j.lastAttemptMs < scheduled) &&
      // failedAtMs: an occurrence whose minute had already passed while the failed
      // run was still going is NOT the next occurrence — the next one is.
      (j.failedAtMs == null || scheduled > j.failedAtMs);
  });
}

// Use inside mutateJobs: recheck the scheduled minute while holding the lock.
// Stale claims (>10min, crashed mid-run) can run on a later scheduled occurrence.
export function claimJob(jobs, id, { nowMs = Date.now(), scheduledAtMs = nowMs, staleAfterMs = 10 * 60_000 } = {}) {
  const j = jobs.find(x => x.id === id);
  if (!j) return null;
  if (j.status === 'running' && nowMs - (j.claimedAtMs ?? 0) < staleAfterMs) return null; // live elsewhere
  // A stale 'running' is a crashed attempt — void it before the due recheck,
  // else a one-shot runAtMs job can never re-due (lastAttemptMs >= its fixed
  // occurrence) and stays 'running'/bound forever.
  if (j.status === 'running') j.lastAttemptMs = null;
  if (!dueJobs([j], new Date(scheduledAtMs)).length) return null;
  j.status = 'running'; j.claimedAtMs = nowMs; j.lastAttemptMs = scheduledAtMs;
  j.claimToken = randomUUID();
  return j;
}

export function completeJob(jobs, id, { ok, error = null, nowMs = Date.now(), claimToken } = {}) {
  const j = jobs.find(x => x.id === id);
  if (!j || (claimToken !== undefined && j.claimToken !== claimToken)) return null;
  if (ok) {
    j.lastSuccessMs = nowMs; j.runCount = (j.runCount ?? 0) + 1; j.error = null; j.failedAtMs = null;
    // Finite automations (maxRuns counts successful dispatches; a recurring=false
    // job carries maxRuns=1) retire into 'completed' — dueJobs never fires them.
    j.status = j.maxRuns != null && j.runCount >= j.maxRuns ? 'completed' : 'idle';
  }
  else { j.status = 'failed'; j.error = String(error).slice(0, 200); j.failedAtMs = nowMs; }
  j.claimToken = undefined; // a replayed completion with the spent token no-ops
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
