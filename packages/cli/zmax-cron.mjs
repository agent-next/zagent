#!/usr/bin/env node
// zagent cron — D7 scheduled prompts. No daemon: crontab calls `zagent cron tick`; every
// tick heartbeats + exits nonzero on failures. Per-job claim/complete persists between
// jobs (interrupted ticks never replay successes; overlapping ticks never double-fire).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJobs, mutateJobs, dueJobs, jobsLine, parseCron, claimJob, completeJob, runTimedProcess, logAutomation } from '../driver/automation.mjs';
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const [cmd, ...rest] = process.argv.slice(2);
const beat = line => logAutomation(line);

if (cmd === 'add') {
  const [id, cron, ...prompt] = rest;
  if (!id || !cron || !prompt.length || !parseCron(cron)) { // strict shared parser (r7 #4)
    console.error('usage: zagent cron add <id> <5-field-cron> <prompt...>  (cron: m h dom mon dow — *, lists a,b, ranges a-b, steps */n or a-b/n, names JAN..DEC SUN..SAT; bounds 0-59 0-23 1-31 1-12 0-7)');
    process.exit(2);
  }
  const added = mutateJobs(jobs => {
    if (jobs.some(j => j.id === id)) return false;
    jobs.push({ id, cron, prompt: prompt.join(' '), workspace: process.cwd(), lastAttemptMs: null, lastSuccessMs: null, status: 'idle', createdAtMs: Date.now() });
    return true;
  });
  if (!added) { console.error(`id '${id}' exists`); process.exit(2); }
  console.log(`added ${id}: '${cron}' → ${prompt.join(' ').slice(0, 60)}\nschedule in crontab: * * * * * zagent cron tick`);
} else if (cmd === 'list') {
  console.log(jobsLine(loadJobs()));
} else if (cmd === 'remove') {
  mutateJobs(jobs => {
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].id === rest[0]) jobs.splice(i, 1);
  });
  console.log(`removed ${rest[0]}`);
} else if (cmd === 'tick') {
  const tickAt = new Date();
  const due = dueJobs(loadJobs(), tickAt);
  beat(`tick due=${due.length}`);
  if (!due.length) { console.log('no due jobs'); process.exit(0); }
  let failed = 0;
  for (const d of due) {
    const j = mutateJobs(jobs => claimJob(jobs, d.id, { scheduledAtMs: tickAt.getTime() }));
    if (!j) { console.log(`skip ${d.id} (claimed elsewhere or stale)`); continue; }
    const t0 = Date.now();
    // Kernel-created automations carry a mode (CronCreate's mode param); honor
    // it like the official client mapping. modelSelection/botDeliveryTarget
    // have no headless carrier yet — stored for fidelity only.
    const mode = { plan: 'plan', edit: 'edit', yolo: 'yolo', build: 'build',
      dontAsk: 'yolo', bypassPermissions: 'yolo',
      default: 'build', auto: 'build', acceptEdits: 'build', autoEdit: 'build' }[j.mode];
    // Worst case inside the child: 2 runtime attempts (120s each) + 8s backoff;
    // 300s covers that plus margin. On timeout the whole process tree is killed.
    const r = await runTimedProcess(process.execPath,
      [`${ROOT}/packages/cli/zmax.mjs`, '-p', j.prompt, '--json', ...(mode ? ['--mode', mode] : [])],
      { cwd: j.workspace, timeoutMs: 300000 });
    const ok = r.status === 0 && (() => { try { return !!JSON.parse(r.stdout ?? '').response; } catch { return false; } })();
    const err = ok ? null : `rc=${r.status}${r.timedOut ? ' timed-out' : ''} ${String(r.stderr ?? '').slice(-120)}`;
    if (!ok) failed++;
    mutateJobs(jobs => completeJob(jobs, d.id, { ok, error: err, claimToken: j.claimToken }));
    // One audit line per attempt — a `cron add` id and child stderr can carry
    // newlines; quote them so neither forges audit lines in the same file.
    beat(`${ok ? 'ok' : 'FAIL'} ${JSON.stringify(d.id)} ${Date.now() - t0}ms${err ? ' ' + JSON.stringify(err.slice(0, 80)) : ''}`);
    console.log(`${ok ? 'ok' : 'FAIL'} ${d.id} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  process.exit(failed ? 1 : 0);
} else {
  console.error('usage: zagent cron add|list|remove|tick'); process.exit(2);
}
