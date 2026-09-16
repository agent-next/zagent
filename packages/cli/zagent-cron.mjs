#!/usr/bin/env node
// zagent cron — D7 scheduled prompts. No daemon: crontab calls `zagent cron tick`; every
// tick heartbeats + exits nonzero on failures. Per-job claim/complete persists between
// jobs (interrupted ticks never replay successes; overlapping ticks never double-fire).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJobs, mutateJobs, dueJobs, jobsLine, parseCron, claimJob, completeJob, runTimedProcess, logAutomation } from '../driver/automation.mjs';
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const USAGE = 'usage: zagent cron add <id> <5-field-cron> <prompt...> [--json] | list [--json] | remove <id> [--json] | tick';
const [cmd, ...rest] = process.argv.slice(2);
const asJson = rest.includes('--json');
const positional = rest.filter(a => !a.startsWith('-'));
const unknownFlags = rest.some(a => a.startsWith('-') && a !== '--json');
const usage = () => { console.error(USAGE); process.exit(2); };
const beat = line => logAutomation(line);

if (cmd === 'add') {
  // A trailing --json is the output flag — anywhere else it stays prompt text:
  // the positional prompt is free text and interior dash words are legal.
  const addJson = rest[rest.length - 1] === '--json';
  const addArgs = addJson ? rest.slice(0, -1) : rest;
  const [id, cron, ...prompt] = addArgs;
  // A dash-prefixed id would be unremovable (remove parses it as a flag).
  if (!id || id.startsWith('-') || !cron || !prompt.join(' ').trim() || !parseCron(cron)) { // strict shared parser (r7 #4)
    console.error('usage: zagent cron add <id> <5-field-cron> <prompt...> [--json]  (cron: m h dom mon dow — *, lists a,b, ranges a-b, steps */n or a-b/n, names JAN..DEC SUN..SAT; bounds 0-59 0-23 1-31 1-12 0-7)');
    process.exit(2);
  }
  const job = { id, cron, prompt: prompt.join(' '), workspace: process.cwd(), lastAttemptMs: null, lastSuccessMs: null, status: 'idle', createdAtMs: Date.now() };
  const added = mutateJobs(jobs => {
    if (jobs.some(j => j.id === id)) return false;
    jobs.push(job);
    return true;
  });
  if (addJson) console.log(JSON.stringify({ id, added }));
  if (!added) { if (!addJson) console.error(`id '${id}' exists`); process.exit(2); }
  if (!addJson)
    console.log(`added ${id}: '${cron}' → ${prompt.join(' ').slice(0, 60)}\nschedule in crontab: * * * * * zagent cron tick`);
} else if (cmd === 'list') {
  if (unknownFlags || positional.length) usage();
  const jobs = loadJobs();
  if (asJson) console.log(JSON.stringify({ count: jobs.length, jobs }, null, 2));
  else console.log(jobsLine(jobs));
} else if (cmd === 'remove') {
  if (unknownFlags || positional.length !== 1 || !positional[0].trim()) usage();
  const id = positional[0];
  const removed = mutateJobs(jobs => {
    let n = 0;
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].id === id) { jobs.splice(i, 1); n++; }
    return n;
  });
  if (asJson) console.log(JSON.stringify({ id, deleted: removed > 0 }));
  else console.log(removed ? `removed ${id}` : `nothing deleted: ${id} not found`);
  if (!removed) process.exit(1);
} else if (cmd === 'tick') {
  if (rest.length) usage();
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
      [`${ROOT}/packages/cli/zagent.mjs`, '-p', j.prompt, '--json', ...(mode ? ['--mode', mode] : [])],
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
} else usage();
