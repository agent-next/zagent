// D7 automation — CLI-side scheduled prompts (upstream automations are GUI-only).
// r7-hardened: strict cron grammar with STANDARD dom/dow OR semantics, dow 7→0,
// 1-based step anchoring, atomic (tmp+rename) state writes, ENOENT-only empty read,
// per-job claim/complete lifecycle (no batch replay, no silent double-fire).
// No daemon: the user's crontab calls `zmax cron tick`; every tick appends a heartbeat
// receipt and exits nonzero on failures (no-bare-cron rule).

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';

const BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]; // m h dom mon dow (dow 7 == 0 == Sunday)

export function jobsPath({ home = os.homedir() } = {}) { return `${home}/.zcode/cli/automations.json`; }

// Strict single-field parser -> predicate, or null when malformed (r7 #4).
function fieldMatcher(field, i) {
  const [lo, hi] = BOUNDS[i];
  const norm = v => (i === 4 && v === 7) ? 0 : v; // dow 7 == Sunday (r7 #2)
  if (field === '*') return () => true;
  const step = field.match(/^\*\/(\d+)$/);
  if (step) { const n = +step[1]; if (n <= 0) return null;
    return v => (v - lo) % n === 0; } // anchor at the field's own lower bound (r7 #3)
  if (/^\d+(,\d+)*$/.test(field)) {
    const lits = field.split(',').map(Number);
    if (lits.some(v => v < lo || v > hi)) return null;
    const set = new Set(lits.map(norm));
    return v => set.has(norm(v));
  }
  return null;
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
  const domR = String(cron).trim().split(/\s+/)[2] !== '*';
  const dowR = String(cron).trim().split(/\s+/)[4] !== '*';
  const domOk = dom(d.getDate()), dowOk = dow(d.getDay());
  // Standard cron: both restricted -> OR; one restricted -> that one (r7 #1)
  if (domR && dowR) return domOk || dowOk;
  if (domR) return domOk;
  if (dowR) return dowOk;
  return true;
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
    (j.lastAttemptMs == null || minuteOf(j.lastAttemptMs) < minuteOf(now.getTime())));
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
  if (ok) { j.lastSuccessMs = nowMs; j.status = 'idle'; j.error = null; }
  else { j.status = 'failed'; j.error = String(error).slice(0, 200); }
  return j;
}

export function jobsLine(jobs) {
  if (!jobs.length) return 'no automations';
  return jobs.map(j => `${j.id}: '${j.cron}' → ${String(j.prompt).slice(0, 40)}` +
    (j.status === 'failed' ? ` FAILED(${j.error ?? '?'})` : j.status === 'running' ? ' [running]' : '') +
    (j.lastSuccessMs ? ` (ok ${new Date(j.lastSuccessMs).toISOString().slice(0, 16).replace('T', ' ')}Z)` : ' (never succeeded)')).join('\n');
}
