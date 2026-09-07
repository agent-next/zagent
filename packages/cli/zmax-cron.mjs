#!/usr/bin/env node
// zagent cron — D7 scheduled prompts. No daemon: crontab calls `zagent cron tick`; every
// tick heartbeats + exits nonzero on failures. Per-job claim/complete persists between
// jobs (interrupted ticks never replay successes; overlapping ticks never double-fire).
import { appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJobs, saveJobs, dueJobs, jobsLine, parseCron, claimJob, completeJob } from '../driver/automation.mjs';
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const [cmd, ...rest] = process.argv.slice(2);
const HEARTBEAT = `${os.homedir()}/.zcode/cli/automation-heartbeat.log`;
const beat = line => { try { appendFileSync(HEARTBEAT, `${new Date().toISOString()} ${line}\n`); } catch {} };

if (cmd === 'add') {
  const [id, cron, ...prompt] = rest;
  if (!id || !cron || !prompt.length || !parseCron(cron)) { // strict shared parser (r7 #4)
    console.error('usage: zagent cron add <id> <5-field-cron> <prompt...>  (cron: m h dom mon dow; *, */n, lists; ranges 0-59 0-23 1-31 1-12 0-7)');
    process.exit(2);
  }
  const jobs = loadJobs();
  if (jobs.some(j => j.id === id)) { console.error(`id '${id}' exists`); process.exit(2); }
  jobs.push({ id, cron, prompt: prompt.join(' '), workspace: process.cwd(), lastAttemptMs: null, lastSuccessMs: null, status: 'idle', createdAtMs: Date.now() });
  saveJobs(jobs);
  console.log(`added ${id}: '${cron}' → ${prompt.join(' ').slice(0, 60)}\nschedule in crontab: * * * * * zagent cron tick`);
} else if (cmd === 'list') {
  console.log(jobsLine(loadJobs()));
} else if (cmd === 'remove') {
  saveJobs(loadJobs().filter(j => j.id !== rest[0]));
  console.log(`removed ${rest[0]}`);
} else if (cmd === 'tick') {
  saveJobs(loadJobs()); // r7 #9 side effect: guarantees the state dir exists before the heartbeat
  const due = dueJobs(loadJobs());
  beat(`tick due=${due.length}`);
  if (!due.length) { console.log('no due jobs'); process.exit(0); }
  let failed = 0;
  const { spawnSync } = await import('node:child_process');
  for (const d of due) {
    const jobs = loadJobs(); // reload fresh each job: per-job persistence (r7 #7)
    const j = claimJob(jobs, d.id);
    if (!j) { console.log(`skip ${d.id} (claimed elsewhere or stale)`); continue; }
    saveJobs(jobs); // claim persisted BEFORE spawn (r7 #6)
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [`${ROOT}/packages/cli/zmax.mjs`, '-p', j.prompt, '--json'],
      { cwd: j.workspace, encoding: 'utf8', timeout: 200000, maxBuffer: 64e6 });
    const ok = r.status === 0 && (() => { try { return !!JSON.parse(r.stdout ?? '').response; } catch { return false; } })();
    const err = ok ? null : `rc=${r.status} ${String(r.stderr ?? '').slice(-120)}`;
    if (!ok) failed++;
    const after = loadJobs();
    completeJob(after, d.id, { ok, error: err }); // lastAttempt ALWAYS; lastSuccess only on ok (r7 #5)
    saveJobs(after);
    beat(`${ok ? 'ok' : 'FAIL'} ${d.id} ${Date.now() - t0}ms${err ? ' ' + err.slice(0, 80) : ''}`);
    console.log(`${ok ? 'ok' : 'FAIL'} ${d.id} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  process.exit(failed ? 1 : 0);
} else {
  console.error('usage: zagent cron add|list|remove|tick'); process.exit(2);
}
