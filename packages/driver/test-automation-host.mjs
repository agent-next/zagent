// F4 host-side automation/* serving — the kernel's automationPort emits
// automation/create|update|list|delete|checkTaskBinding as INCOMING requests
// during a turn (Cron* tools). These handlers back that surface onto the local
// `zagent cron` store; `zagent automation` manages the same store directly.
//
// Leg 1 (e2e): a fake kernel answers session/list then pushes automation/*
// requests at a real ZCodeProtocolClient — the client must reply with strict
// kHe-shaped results and persist jobs to ~/.zcode/cli/automations.json.
// Leg 2 (unit): validation refines, schedule engines, lifecycle transitions.
// Leg 3 (CLI): `zagent automation` against a sandboxed store.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(root, 'packages', 'cli', 'zagent-automation.mjs');
const home = mkdtempSync(path.join(tmpdir(), 'zagent-automation-host-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { createJob, patchJob, toKernelAutomation } =
  await import('./automation-host.mjs');
const { loadJobs, mutateJobs, dueJobs, nextRunMs, nextCronMs, completeJob, claimJob } =
  await import('./automation.mjs');

const KHE = new Set(['automationId', 'title', 'cronExpr', 'prompt', 'modelSelection',
  'mode', 'targetTaskId', 'enabled', 'lifecycleStatus', 'nextRunAt', 'lastRunAt',
  'runCount', 'recurring', 'maxRuns', 'scheduleRule']);
const KHE_REQUIRED = ['automationId', 'title', 'cronExpr', 'prompt', 'enabled',
  'lifecycleStatus', 'runCount', 'recurring'];
const assertKhe = a => {
  for (const k of Object.keys(a)) assert.ok(KHE.has(k), `extra key '${k}' breaks the strict kHe schema`);
  for (const k of KHE_REQUIRED) assert.ok(k in a, `missing required key '${k}'`);
  assert.ok(['active', 'completed', 'failed', 'paused'].includes(a.lifecycleStatus));
  assert.ok(Number.isInteger(a.runCount) && a.runCount >= 0);
  assert.equal(typeof a.enabled, 'boolean');
  assert.equal(typeof a.recurring, 'boolean');
};

const runtime = path.join(home, 'fake-kernel.cjs');
const respFile = path.join(home, 'resp.log');
writeFileSync(runtime, `
const fs = require('fs'), rl = require('readline').createInterface({ input: process.stdin });
let sent = false;
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', l => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.method === undefined) {
    if (m.id !== undefined) fs.appendFileSync(process.env.FAKE_RESP, JSON.stringify(m) + '\\n');
    return;
  }
  if (m.method === 'session/list') {
    out({ id: m.id, result: { sessions: [] } });
    if (!sent) { sent = true; for (const r of JSON.parse(process.env.FAKE_REQS)) out(r); }
    return;
  }
  out({ id: m.id, error: { code: -32601, message: 'method not found' } });
});`);

const env = extra => ({
  ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home,
  ZCODE_RUNTIME: runtime, FAKE_RESP: respFile, ...extra,
});
const run = (args, extra) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30000, env: env(extra) });
const jobs = () => JSON.parse(readFileSync(path.join(home, '.zcode', 'cli', 'automations.json'), 'utf8')).jobs;

try {
  // === Leg 1: the kernel calls INTO the client — real protocol direction ====
  const reqs = [
    { id: 901, method: 'automation/create', params: { cronExpr: '0 3 * * *',
      prompt: 'nightly rebuild', title: 'rebuild', recurring: true, maxRuns: 5,
      mode: 'build', targetTaskId: 'sess_1',
      modelSelection: { providerId: 'builtin:zai-coding-plan', modelId: 'GLM-5.3' } } },
    { id: 902, method: 'automation/create', params: { relativeDelayMinutes: 30,
      cronExpr: '* * * * *', prompt: 'one-shot ping' } }, // kernel fills cronExpr
    { id: 903, method: 'automation/create', params: { cronExpr: '0 4 * * *',
      prompt: 'every 2 days', intervalUnit: 'daily', interval: 2 } },
    { id: 904, method: 'automation/list', params: {} },
    { id: 905, method: 'automation/checkTaskBinding', params: { targetTaskId: 'sess_1' } },
    { id: 906, method: 'automation/create', params: { cronExpr: '0 3 * * *' } }, // no prompt
    { id: 907, method: 'automation/update', params: { automationId: 'auto_nope', title: 'x' } },
    { id: 908, method: 'automation/delete', params: { automationId: 'auto_nope' } },
    { id: 909, method: 'automation/create', params: { cronExpr: '0 6 * * *',
      prompt: 'quiet bypass attempt', mode: 'bypassPermissions' } },
  ];
  let r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { ZCodeProtocolClient } from '${pathToFileURL(path.join(root, 'packages/driver/zcode-protocol.mjs')).href}';
    import fs from 'node:fs';
    const c = new ZCodeProtocolClient({ cwd: process.cwd() });
    await c.ready;
    const want = ${reqs.length}, t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      try { if (fs.readFileSync(process.env.FAKE_RESP, 'utf8').trim().split('\\n').length >= want) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    c.close();
    console.log('E2E_DONE');
  `], { encoding: 'utf8', timeout: 30000, env: env({ FAKE_REQS: JSON.stringify(reqs) }) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /E2E_DONE/);
  const resp = Object.fromEntries(readFileSync(respFile, 'utf8').trim().split('\n')
    .map(JSON.parse).map(m => [m.id, m]));
  assert.equal(Object.keys(resp).length, reqs.length, 'every kernel request got a response');

  const a1 = resp[901].result.automation;
  assertKhe(a1);
  assert.match(a1.automationId, /^auto_/);
  assert.equal(a1.title, 'rebuild');
  assert.equal(a1.cronExpr, '0 3 * * *');
  assert.equal(a1.recurring, true);
  assert.equal(a1.maxRuns, 5);
  assert.equal(a1.mode, 'build');
  assert.equal(a1.targetTaskId, 'sess_1');
  assert.deepEqual(a1.modelSelection, { providerId: 'builtin:zai-coding-plan', modelId: 'GLM-5.3' });
  assert.ok(Number.isInteger(a1.nextRunAt) && a1.nextRunAt > Date.now(), 'nextRunAt is a future epoch ms');

  const a2 = resp[902].result.automation;
  assertKhe(a2);
  assert.equal(a2.recurring, false, 'a relative delay is a one-shot');
  assert.equal(a2.maxRuns, 1, 'one-shot defaults maxRuns=1 (kernel doc)');
  assert.notEqual(a2.cronExpr, '* * * * *', 'the placeholder cron becomes a real display expr');
  assert.ok(Math.abs(a2.nextRunAt - (Date.now() + 30 * 60_000)) < 60_000);
  // kernel buildRelativeDelaySchedule: minute-unit rule, hour/minute of the
  // FIRE time, anchored at create time
  assert.equal(a2.scheduleRule.unit, 'minute');
  assert.equal(a2.scheduleRule.interval, 30);
  assert.ok(Number.isInteger(a2.scheduleRule.anchorAt) && a2.scheduleRule.anchorAt > 0);

  const a3 = resp[903].result.automation;
  assertKhe(a3);
  assert.equal(a3.scheduleRule.unit, 'daily');
  assert.equal(a3.scheduleRule.interval, 2);
  assert.ok(Number.isInteger(a3.scheduleRule.anchorAt) && a3.scheduleRule.anchorAt > 0);
  assert.ok(Number.isInteger(a3.scheduleRule.hour) && Number.isInteger(a3.scheduleRule.minute));

  const listed = resp[904].result.automations;
  assert.equal(listed.length, 3);
  listed.forEach(assertKhe);
  assert.equal(resp[905].result.bound, true, 'sess_1 is bound via the first create');
  assert.equal(resp[906].error.code, -32000, 'invalid create surfaces as a JSON-RPC error');
  assert.match(resp[906].error.message, /prompt/);
  assert.equal(resp[907].error.code, -32000, 'update of a missing id errors');
  assert.equal(resp[908].result.deleted, false, 'delete of a missing id reports deleted:false');

  // F4a: a kernel-side permission-bypassing mode downgrades to 'build' — a
  // model must not mint a job that later fires `--mode yolo` unattended.
  const a9 = resp[909].result.automation;
  assertKhe(a9);
  assert.equal(a9.mode, 'build', 'bypassPermissions is downgraded at the host boundary');

  const stored = jobs();
  assert.equal(stored.length, 4, 'the failed create never touched the store');
  assert.equal(stored[3].mode, 'build', 'the stored job carries the downgraded mode');
  assert.ok(stored[1].runAtMs > Date.now(), 'the one-shot carries runAtMs');
  assert.deepEqual(stored[2].interval, { unit: 'daily', n: 2, anchorAtMs: stored[2].interval.anchorAtMs });
  assert.equal(stored[0].workspace, process.cwd(), 'jobs run in the client workspace');

  // === Leg 2: validation refines + schedule engines + lifecycle ==============
  for (const bad of [
    { prompt: 'x' },                                              // no schedule
    { cronExpr: 'bogus', prompt: 'x' },                           // invalid cron
    { cronExpr: '0 0 * * *', prompt: 'x', intervalUnit: 'daily' },// unpaired
    { cronExpr: '0 0 * * *', prompt: 'x', intervalUnit: 'daily', interval: 0 },
    { cronExpr: '0 0 * * *', prompt: 'x', intervalUnit: 'bogus', interval: 2 },
    { cronExpr: '0 0 * * *', prompt: 'x', intervalUnit: 'daily', interval: 2, maxRuns: 3 },
    { cronExpr: '0 0 * * *', prompt: 'x', intervalUnit: 'daily', interval: 2, recurring: false },
    { relativeDelayMinutes: 5, cronExpr: '* * * * *', prompt: 'x', recurring: true },
    { relativeDelayMinutes: 5, cronExpr: '* * * * *', prompt: 'x', maxRuns: 2 },
    { relativeDelayMinutes: 0, cronExpr: '* * * * *', prompt: 'x' },
    { cronExpr: '0 0 * * *', prompt: 'x', mode: 'bogus' },
    { cronExpr: '0 0 * * *', prompt: 'x', unknownField: 1 },      // strict keys
    { cronExpr: '0 0 * * *', prompt: 'x', modelSelection: { providerId: 'p' } },
  ]) assert.throws(() => createJob(bad), /automation:/, JSON.stringify(bad));

  // update refines
  const j = createJob({ cronExpr: '*/10 * * * *', prompt: 'p', maxRuns: 2, recurring: false });
  mutateJobs(js => { js.push(j); });
  assert.throws(() => patchJob(j, { automationId: j.id }), /at least one field/);
  assert.throws(() => patchJob(j, { automationId: j.id, maxRuns: null }), /recurring=true/);
  assert.throws(() => patchJob(j, { automationId: j.id, recurring: true, maxRuns: 7 }), /cannot be combined/);
  assert.throws(() => patchJob(j, { automationId: j.id, intervalUnit: 'hourly' }), /set together/);
  patchJob(j, { automationId: j.id, title: 'renamed', cronExpr: '15 6 * * *' });
  assert.equal(j.cron, '15 6 * * *');
  // numeric maxRuns implies finite; completing the limit retires the job
  assert.equal(j.recurring, false);
  completeJob([j], j.id, { ok: true });
  assert.equal(j.status, 'idle'); assert.equal(j.runCount, 1);
  completeJob([j], j.id, { ok: true });
  assert.equal(j.status, 'completed', 'maxRuns reached -> completed');
  assert.equal(dueJobs([j], new Date(Date.now() + 86400e3)).length, 0, 'completed never fires');
  // re-arm: recurring=true clears the limit and revives the job
  patchJob(j, { automationId: j.id, recurring: true });
  assert.equal(j.maxRuns, undefined);
  assert.equal(j.status, 'idle');
  assert.equal(j.recurring, true);

  // a one-shot runAtMs job has no schedule to re-arm — recurring/maxRuns
  // patches must fail honestly, not mint a zombie that reports 'active'
  const oneShot = createJob({ relativeDelayMinutes: 30, cronExpr: '* * * * *',
    prompt: 'ping' });
  assert.throws(() => patchJob(oneShot, { automationId: oneShot.id, recurring: true }),
    /no schedule to re-arm/);
  assert.throws(() => patchJob(oneShot, { automationId: oneShot.id, maxRuns: 3 }),
    /no schedule to re-arm/);
  assert.throws(() => patchJob(oneShot, { automationId: oneShot.id, recurring: true, maxRuns: null }),
    /no schedule to re-arm/);
  patchJob(oneShot, { automationId: oneShot.id, intervalUnit: 'hourly', interval: 2 });
  assert.equal(oneShot.runAtMs, undefined, 'intervalUnit replaces the one-shot carrier');
  assert.equal(oneShot.interval.unit, 'hourly');

  // schedule engines
  const T = new Date('2026-09-15T10:00:00').getTime();
  assert.equal(nextCronMs('0 3 * * *', T),
    new Date('2026-09-16T03:00:00').getTime());
  assert.equal(nextCronMs('*/20 * * * *', T), new Date('2026-09-15T10:20:00').getTime());
  assert.equal(nextCronMs('0 0 29 2 *', T) > T, true, 'yearly expr still resolves');
  assert.equal(nextCronMs('bogus', T), null);
  const intJob = { cron: '* * * * *', prompt: 'p', status: 'idle', enabled: true,
    recurring: true, interval: { unit: 'minute', n: 30, anchorAtMs: T } };
  assert.equal(dueJobs([intJob], new Date(T + 29 * 60_000)).length, 0, 'interval fires at anchor+n, not before');
  assert.equal(dueJobs([intJob], new Date(T + 30 * 60_000)).length, 1);
  intJob.lastAttemptMs = T + 30 * 60_000;
  assert.equal(dueJobs([intJob], new Date(T + 59 * 60_000)).length, 0);
  assert.equal(dueJobs([intJob], new Date(T + 61 * 60_000)).length, 1, 'next period is due');
  const shot = { cron: '0 0 * * *', prompt: 'p', status: 'idle', enabled: true,
    runAtMs: T + 5 * 60_000, maxRuns: 1 };
  assert.equal(dueJobs([shot], new Date(T + 4 * 60_000)).length, 0);
  assert.equal(dueJobs([shot], new Date(T + 6 * 60_000)).length, 1, 'a missed one-shot still fires late');
  shot.lastAttemptMs = T + 6 * 60_000;
  assert.equal(dueJobs([shot], new Date(T + 9 * 60_000)).length, 0, 'one-shot fires once');
  // a crashed tick leaves status:'running' + lastAttemptMs >= runAtMs — the
  // stale-claim path must void the dead attempt so the one-shot re-dues
  const crashed = { id: 'shot', cron: 'x', prompt: 'p', status: 'running', enabled: true,
    runAtMs: T + 5 * 60_000, maxRuns: 1, claimedAtMs: T + 6 * 60_000,
    lastAttemptMs: T + 6 * 60_000 };
  assert.equal(claimJob([crashed], 'shot', { nowMs: T + 6 * 60_000 + 60_000,
    scheduledAtMs: T + 6 * 60_000 + 60_000 }), null, 'a fresh claim is live elsewhere');
  assert.equal(claimJob([crashed], 'shot', { nowMs: T + 20 * 60_000,
    scheduledAtMs: T + 20 * 60_000 })?.id, 'shot', 'a stale (>10min) claim is reclaimed');
  assert.equal(crashed.status, 'running');
  assert.equal(crashed.lastAttemptMs, T + 20 * 60_000);
  // monthly interval steps the calendar with the day clamped, anchored fresh
  // each occurrence — no drift (Jan 31 -> Feb 28 -> Mar 31, NOT Mar 3 -> Apr 3)
  const mon = { cron: 'x', prompt: 'p', status: 'idle', enabled: true,
    interval: { unit: 'monthly', n: 1, anchorAtMs: new Date('2026-01-31T09:00:00').getTime() } };
  assert.equal(nextRunMs(mon, new Date('2026-01-31T09:00:00').getTime()),
    new Date('2026-02-28T09:00:00').getTime(), 'Jan 31 + 1mo clamps to Feb 28');
  assert.equal(nextRunMs(mon, new Date('2026-02-28T09:00:00').getTime()),
    new Date('2026-03-31T09:00:00').getTime(), 'the next occurrence re-anchors, no drift');

  // lifecycleStatus: a per-attempt failure with a future occurrence is still
  // 'active' (the tick retries it); only a terminal failure maps to 'failed'
  const failedCron = { id: 'x', cron: '* * * * *', prompt: 'p', status: 'failed',
    enabled: true, recurring: true, runCount: 0, failedAtMs: T,
    lastAttemptMs: T, lastSuccessMs: null };
  assert.equal(toKernelAutomation(failedCron, T + 60_000).lifecycleStatus, 'active',
    'a rescheduled failure is not terminal');
  const failedShot = { ...failedCron, runAtMs: T - 60_000 };
  assert.equal(toKernelAutomation(failedShot, T + 60_000).lifecycleStatus, 'failed',
    'a one-shot failure with no occurrence left is terminal');

  // checkTaskBinding: a completed automation no longer binds its session
  const { automationHostHandlers } = await import('./automation-host.mjs');
  const hh = automationHostHandlers({ home });
  mutateJobs(js => { js.push({ id: 'auto_b', cron: '0 0 * * *', prompt: 'p', status: 'idle',
    enabled: true, recurring: true, runCount: 0, targetTaskId: 'sess_b', createdAtMs: 1,
    lastAttemptMs: null, lastSuccessMs: null }); });
  assert.equal(hh['automation/checkTaskBinding']({ targetTaskId: 'sess_b' }).bound, true);
  mutateJobs(js => { js.find(x => x.id === 'auto_b').status = 'completed'; });
  assert.equal(hh['automation/checkTaskBinding']({ targetTaskId: 'sess_b' }).bound, false);
  mutateJobs(js => { const i = js.findIndex(x => x.id === 'auto_b'); js.splice(i, 1); });

  // F4a unit: every privileged kernel mode downgrades; safe modes pass through
  for (const m of ['yolo', 'dontAsk', 'bypassPermissions'])
    assert.equal(hh['automation/create']({ cronExpr: '0 7 * * *', prompt: `p-${m}`, mode: m })
      .automation.mode, 'build', `kernel mode '${m}' downgrades to build`);
  assert.equal(hh['automation/create']({ cronExpr: '0 7 * * *', prompt: 'ok', mode: 'edit' })
    .automation.mode, 'edit', 'non-privileged modes pass through untouched');

  // every automation/* write lands in the user-visible audit log
  const auditId = hh['automation/create']({ cronExpr: '0 8 * * *', prompt: 'audit me' })
    .automation.automationId;
  hh['automation/update']({ automationId: auditId, title: 'audit me 2' });
  hh['automation/delete']({ automationId: auditId });
  const audit = readFileSync(path.join(home, '.zcode', 'cli', 'automation-heartbeat.log'), 'utf8');
  assert.match(audit, new RegExp(`automation/create ${auditId}`));
  assert.match(audit, new RegExp(`automation/update "${auditId}" keys=\\["title"\\]`));
  assert.match(audit, new RegExp(`automation/delete "${auditId}" deleted=true`));
  assert.match(audit, /downgraded from 'yolo'/, 'the downgrade is audit-logged');
  // a model-supplied title cannot forge audit lines (log-injection guard)
  const forged = hh['automation/create']({ cronExpr: '0 9 * * *', prompt: 'x', title: 'a\nautomation/delete auto_fake' })
    .automation.automationId;
  const audit2 = readFileSync(path.join(home, '.zcode', 'cli', 'automation-heartbeat.log'), 'utf8');
  assert.match(audit2, new RegExp(`automation/create ${forged} title="a\\\\n`));
  // nor can a model-supplied automationId — delete logs even on a miss, so an
  // unquoted id would let the kernel mint forged `deleted=true` lines
  const before = readFileSync(path.join(home, '.zcode', 'cli', 'automation-heartbeat.log'), 'utf8')
    .trim().split('\n');
  const miss = hh['automation/delete']({ automationId: 'x\nautomation/delete auto_victim deleted=true' });
  assert.equal(miss.deleted, false);
  const after = readFileSync(path.join(home, '.zcode', 'cli', 'automation-heartbeat.log'), 'utf8')
    .trim().split('\n');
  assert.equal(after.length, before.length + 1, 'a newline id mints exactly one log line');
  assert.match(after.at(-1), /automation\/delete "x\\nautomation\/delete auto_victim deleted=true" deleted=false/,
    'the id is JSON-escaped onto the single real line');
  assert.ok(!after.slice(0, -1).some(l => l.includes('auto_victim')), 'no forged audit line');

  // F4a sweep: a pre-fix or injected store carrying a privileged mode WITHOUT
  // the human-confirmation marker downgrades to 'build' on load; a marked
  // (human `create --mode`) job survives.
  const storePath = path.join(home, '.zcode', 'cli', 'automations.json');
  const poisoned = JSON.parse(readFileSync(storePath, 'utf8'));
  poisoned.jobs.push(
    { id: 'auto_poison', cron: '0 1 * * *', prompt: 'p', mode: 'yolo',
      status: 'idle', enabled: true, recurring: true, runCount: 0 },
    { id: 'auto_human', cron: '0 1 * * *', prompt: 'p', mode: 'yolo',
      modeConfirmed: true, status: 'idle', enabled: true, recurring: true, runCount: 0 });
  writeFileSync(storePath, JSON.stringify(poisoned));
  const swept = Object.fromEntries(loadJobs({ home }).map(x => [x.id, x]));
  assert.equal(swept.auto_poison.mode, 'build', 'an unmarked privileged mode is swept to build');
  assert.equal(swept.auto_human.mode, 'yolo', 'a human-confirmed mode survives the sweep');
  mutateJobs(js => { // keep the store tidy for the Leg-3 count below
    for (const id of ['auto_poison', 'auto_human']) {
      const i = js.findIndex(x => x.id === id);
      if (i >= 0) js.splice(i, 1);
    }
  });

  // F4b: the store, its coordination db and the audit log are owner-only —
  // the kernel can persist arbitrary prompt text incl. observed secrets.
  // POSIX-only: win32 reports synthetic modes (0666) and chmod there only
  // toggles the read-only bit, so the repair leg cannot observe a 0600 drift.
  const cliDir = f => path.join(home, '.zcode', 'cli', f);
  if (process.platform !== 'win32') {
    for (const f of ['automations.json', 'automations.json.coordination.sqlite', 'automation-heartbeat.log'])
      assert.equal(statSync(cliDir(f)).mode & 0o777, 0o600, `${f} must be 0600`);
    chmodSync(cliDir('automations.json'), 0o664);
    loadJobs({ home });
    assert.equal(statSync(cliDir('automations.json')).mode & 0o777, 0o600,
      'a permissive pre-existing store is repaired on read');
  }

  // === Leg 3: `zagent automation` manages the same store =====================
  r = run(['create', '--prompt', 'nightly rebuild', '--title', 'rebuild',
    '--cron', '0 3 * * *', '--mode', 'auto', '--model', 'builtin:zai-coding-plan/GLM-5.3',
    '--max-runs', '5', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const created = JSON.parse(r.stdout);
  assertKhe(created);
  assert.equal(created.mode, 'build', 'CLI maps auto -> build like the official client');
  const cliId = created.automationId;

  r = run(['create', '--prompt', 'ping', '--every', '30 minute', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).scheduleRule.interval, 30);
  r = run(['create', '--prompt', 'once', '--cron', '0 5 * * *', '--delay-minutes', '10']);
  assert.equal(r.status, 2, '--cron with --delay-minutes is contradictory');
  r = run(['create', '--prompt', 'x', '--cron', '0 5 * * *', '--every', '2 daily']);
  assert.equal(r.status, 2, '--cron with --every is contradictory');
  r = run(['create', '--prompt', 'once', '--delay-minutes', '10', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).recurring, false);
  r = run(['create', '--prompt', 'p2', '--every', '2 hours', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).scheduleRule.unit, 'hourly', '"2 hours" pluralizes to hourly');
  for (const bad of [
    ['create', '--prompt', 'x'],
    ['create', '--prompt', 'x', '--every', '2 daily', '--max-runs', '3'],
    ['create', '--prompt', 'x', '--every', 'bogus'],
    ['create', '--cron', '0 0 * * *'],
  ]) assert.equal(run(bad).status, 2, bad.join(' '));

  r = run(['list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).automations.length, 14,
    'kernel-created + CLI-created + unit-created share the store');
  r = run(['update', cliId, '--title', 'renamed', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).title, 'renamed');
  r = run(['update', cliId]);
  assert.equal(r.status, 2, 'update with no fields is a usage error');
  r = run(['update', cliId, '--title', 'x', '--mode', 'yolo']);
  assert.equal(r.status, 2, 'update cannot silently drop --mode');
  // --max-runs none on an already-recurring job clears the limit without --recurring
  r = run(['create', '--prompt', 'clr', '--cron', '0 1 * * *', '--max-runs', '3', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const clrId = JSON.parse(r.stdout).automationId;
  assert.equal(JSON.parse(r.stdout).maxRuns, 3);
  r = run(['update', clrId, '--max-runs', 'none', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).maxRuns, undefined);
  // the human CLI path keeps the official mapping — the explicit flag is the
  // host confirmation, surfaced as a stderr note
  r = run(['create', '--prompt', 'human yolo', '--cron', '0 9 * * *', '--mode', 'bypassPermissions', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const humanId = JSON.parse(r.stdout).automationId;
  assert.equal(JSON.parse(r.stdout).mode, 'yolo', 'an explicit human --mode is honored');
  assert.match(r.stderr, /fires unattended as --mode yolo/);
  const humanJob = jobs().find(x => x.id === humanId);
  assert.equal(humanJob.mode, 'yolo');
  assert.equal(humanJob.modeConfirmed, true, 'the explicit flag is recorded as host confirmation');
  assert.equal(loadJobs({ home }).find(x => x.id === humanId).mode, 'yolo',
    'the confirmed mode survives the load-time sweep');
  r = run(['check-binding', 'sess_1', '--json']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).bound, true);
  r = run(['check-binding', 'sess_none']);
  assert.match(r.stdout, /not bound/);
  r = run(['delete', cliId, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).deleted, true);
  r = run(['delete', cliId]);
  assert.equal(r.status, 1, 'double delete reports not-found');
  for (const bad of [[], ['bogus'], ['update'], ['delete'], ['check-binding']]) {
    r = run(bad);
    assert.equal(r.status, 2, `${JSON.stringify(bad)} should be a usage error`);
    assert.match(r.stderr, /usage: zagent automation/);
  }

  console.log('ALL PASS');
} finally {
  rmSync(home, { recursive: true, force: true });
}
