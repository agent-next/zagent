#!/usr/bin/env node
// zagent automation — manage the scheduled-prompts store that zagent serves to
// the kernel over automation/* (the GUI "Automations" panel parity, F4).
// During a model turn the kernel calls INTO the client (host-served surface);
// this command manages the same local store directly, so what you see here is
// exactly what CronList/CronCreate see mid-turn. `zagent cron` remains the
// crontab-facing twin (add|list|remove|tick) over the same store.
//
//   zagent automation list [--json]
//   zagent automation create --prompt TEXT [--title T] (--cron EXPR | --every "N UNIT")
//        [--delay-minutes N] [--once] [--max-runs N] [--mode M] [--model P/M]
//        [--task TASK_ID] [--json]
//   zagent automation update ID [--title T] [--prompt P] [--cron EXPR]
//        [--max-runs N|none] [--every "N UNIT"] [--once|--recurring] [--json]
//   zagent automation delete ID [--json]
//   zagent automation check-binding TASK_ID [--json]
//
// Store contract (the same validation the host handlers apply to kernel
// requests, schema-verified against the installed kernel zcode.cjs):
//   create {title?,cronExpr,relativeDelayMinutes?,prompt,modelSelection?,mode?,
//           targetTaskId?,botDeliveryTarget?,recurring?,maxRuns?,intervalUnit?,interval?}
//   update {automationId, title?,cronExpr?,prompt?,recurring?,maxRuns?(nullable),
//           intervalUnit?,interval?}  (at least one patch field)
//   list   -> [automations]   delete {automationId}   checkTaskBinding {targetTaskId}
// Refines enforced: intervalUnit⇔interval paired, and intervalUnit combines
// with neither relativeDelayMinutes, recurring=false, nor maxRuns.

const USAGE = `usage: zagent automation <command> [--json]

  list                              all automations (the store the kernel sees)
  create --prompt TEXT --cron EXPR  schedule a prompt (or --every "N UNIT")
  update ID [flags]                 patch title/prompt/cron/schedule fields
  delete ID                         remove an automation
  check-binding TASK_ID             is a task already bound to an automation

create/update flags: --title T --prompt P --cron EXPR --every "N UNIT"
  --delay-minutes N --once --recurring --max-runs N|none --model P/M --task ID
  --mode M (create only)
  UNIT: minute|hourly|daily|weekly|monthly|yearly  (interval 1..200)
  MODE: default|yolo|plan|edit|acceptEdits|auto|dontAsk|bypassPermissions|autoEdit|build`;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const VALUE_FLAGS = new Set(['--title', '--prompt', '--cron', '--every', '--delay-minutes',
  '--max-runs', '--mode', '--model', '--task']);
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('-')) { if (VALUE_FLAGS.has(a)) i++; continue; }
  positional.push(a);
}

const fail = (msg, code = 2) => { console.error(msg); process.exit(code); };
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('-')) fail(`${name} needs a value\n${USAGE}`);
  return v;
};

const INTERVAL_UNITS = ['minute', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'];
const UNIT_ALIASES = { minute: 'minute', minutes: 'minute',
  hourly: 'hourly', hour: 'hourly', hours: 'hourly',
  daily: 'daily', day: 'daily', days: 'daily',
  weekly: 'weekly', week: 'weekly', weeks: 'weekly',
  monthly: 'monthly', month: 'monthly', months: 'monthly',
  yearly: 'yearly', year: 'yearly', years: 'yearly' };
// The kernel's intervalUnit/interval pair is the real carrier; cronExpr is
// still required and "stays compatible" — so --every generates the closest
// standard cron (weekly/yearly N>1 cannot be expressed, the interval wins).
const compatibleCron = (unit, n) => ({
  minute: n === 1 ? '* * * * *' : `*/${n} * * * *`,
  hourly: n === 1 ? '0 * * * *' : `0 */${n} * * *`,
  daily: n === 1 ? '0 0 * * *' : `0 0 */${n} * *`,
  weekly: '0 0 * * 0',
  monthly: n === 1 ? '0 0 1 * *' : `0 0 1 */${n} *`,
  yearly: '0 0 1 1 *',
}[unit]);

const parseEvery = () => {
  const raw = flag('--every');
  if (raw === undefined) return null;
  const m = String(raw).trim().match(/^(\d+)\s+([a-z]+)$/i);
  const unit = m && UNIT_ALIASES[m[2].toLowerCase()];
  const interval = m && +m[1];
  if (!unit || !Number.isInteger(interval) || interval < 1 || interval > 200)
    fail(`--every wants "<n> <unit>" (${INTERVAL_UNITS.join('|')}, n 1..200)\n${USAGE}`);
  return { intervalUnit: unit, interval };
};

// Official client mapping (kernel zcode.cjs): plan/edit/yolo/build pass through;
// dontAsk/bypassPermissions -> yolo; default/auto/acceptEdits/autoEdit -> build.
const MODES = { plan: 'plan', edit: 'edit', yolo: 'yolo', build: 'build',
  dontAsk: 'yolo', bypassPermissions: 'yolo',
  default: 'build', auto: 'build', acceptEdits: 'build', autoEdit: 'build' };

const parseModel = () => {
  const raw = flag('--model');
  if (raw === undefined) return undefined;
  const i = raw.lastIndexOf('/');
  if (i < 1 || i === raw.length - 1) fail('--model wants provider/model\n' + USAGE);
  return { providerId: raw.slice(0, i), modelId: raw.slice(i + 1) };
};

const intFlag = (name, { min = 1, max = Number.MAX_SAFE_INTEGER, none = false } = {}) => {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  if (none && raw === 'none') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name} wants an integer ${min}..${max}\n${USAGE}`);
  return n;
};

const scheduleParams = ({ forUpdate = false } = {}) => {
  const every = parseEvery();
  const cron = flag('--cron');
  const delay = intFlag('--delay-minutes', { max: 525600 });
  const once = args.includes('--once');
  const recurringFlag = args.includes('--recurring');
  const maxRuns = intFlag('--max-runs', { none: true });
  if (once && recurringFlag) fail('--once and --recurring conflict\n' + USAGE);
  if (delay !== undefined && cron !== undefined)
    fail('--delay-minutes cannot combine with --cron (a relative delay omits cron)\n' + USAGE);
  if (every && cron !== undefined)
    fail('--every cannot combine with --cron (the interval is the carrier)\n' + USAGE);
  if (delay !== undefined && once) fail('--delay-minutes is already a one-shot\n' + USAGE);
  if (once && maxRuns !== undefined)
    fail('--once already runs once; --max-runs is contradictory\n' + USAGE);
  if (delay !== undefined && recurringFlag)
    fail('--delay-minutes creates a one-shot and cannot use --recurring\n' + USAGE);
  if (delay !== undefined && maxRuns !== undefined)
    fail('--delay-minutes runs once and cannot use --max-runs\n' + USAGE);
  if (every) {
    if (delay !== undefined) fail('--every cannot combine with --delay-minutes\n' + USAGE);
    if (once) fail('--every cannot combine with --once (interval schedules recur)\n' + USAGE);
    if (maxRuns !== undefined) fail('--every cannot combine with --max-runs\n' + USAGE);
  }
  const out = {};
  if (cron !== undefined) {
    if (!cron.trim() || cron.trim().split(/\s+/).length !== 5)
      fail('--cron wants a 5-field expression\n' + USAGE);
    out.cronExpr = cron;
  } else if (every) {
    out.cronExpr = compatibleCron(every.intervalUnit, every.interval);
  } else if (!forUpdate && delay === undefined) {
    fail('a schedule is required: --cron EXPR, --every "N UNIT", or --delay-minutes N\n' + USAGE);
  }
  if (delay !== undefined) out.relativeDelayMinutes = delay;
  if (every) { out.intervalUnit = every.intervalUnit; out.interval = every.interval; out.recurring = true; }
  if (once) out.recurring = false;
  else if (recurringFlag) out.recurring = true;
  if (maxRuns !== undefined) out.maxRuns = maxRuns;
  return out;
};

const printAutomation = (a) => {
  const next = a.nextRunAt ? ` next=${new Date(a.nextRunAt).toLocaleString()}` : '';
  const runs = a.runCount != null ? ` runs=${a.runCount}` : '';
  console.log(`${a.automationId}  ${a.title || '(untitled)'}  [${a.lifecycleStatus}${a.enabled ? '' : ',disabled'}]  cron=${a.cronExpr}${runs}${next}`);
};

const sub = positional[0];
const needsId = { update: true, delete: true };
if (!sub || !['list', 'create', 'update', 'delete', 'check-binding'].includes(sub) ||
    (needsId[sub] && !positional[1]) || (sub === 'check-binding' && !positional[1]) ||
    positional.length > (needsId[sub] || sub === 'check-binding' ? 2 : 1) ||
    flag('--help') !== undefined || args.includes('-h'))
  fail(USAGE);

const { createJob, patchJob, toKernelAutomation } = await import('../driver/automation-host.mjs');
const { loadJobs, mutateJobs, PRIVILEGED_JOB_MODES } = await import('../driver/automation.mjs');

let code = 0;
const die = e => { code = 1; console.error(`automation ${sub} failed: ${e?.message ?? e}`); };
try {
  if (sub === 'list') {
    const automations = loadJobs().map(j => toKernelAutomation(j));
    if (asJson) console.log(JSON.stringify({ automations }, null, 2));
    else if (!automations.length) console.log('no automations');
    else automations.forEach(printAutomation);
  } else if (sub === 'create') {
    const prompt = flag('--prompt');
    if (!prompt?.trim()) fail('create needs --prompt TEXT\n' + USAGE);
    const mode = flag('--mode');
    if (mode !== undefined && !(mode in MODES)) fail(`--mode must be one of ${Object.keys(MODES).join('|')}\n` + USAGE);
    const params = { prompt, ...scheduleParams() };
    const title = flag('--title');
    if (title !== undefined) params.title = title;
    if (mode !== undefined) params.mode = MODES[mode];
    const model = parseModel();
    if (model) params.modelSelection = model;
    const task = flag('--task');
    if (task !== undefined) params.targetTaskId = task;
    const job = createJob(params);
    // The job fires unattended — a bypassing mode never asks permissions at
    // fire time. The explicit flag is the host confirmation (the kernel path
    // downgrades these to build): mark the job so loadJobs' unmarked-mode sweep
    // keeps it, and say so out loud.
    if (PRIVILEGED_JOB_MODES.has(job.mode)) job.modeConfirmed = true;
    mutateJobs(jobs => { jobs.push(job); });
    if (job.modeConfirmed)
      console.error(`note: --mode ${mode} fires unattended as --mode ${MODES[mode]} — the job will not ask for permissions`);
    const a = toKernelAutomation(job);
    if (asJson) console.log(JSON.stringify(a, null, 2));
    else console.log(`created ${a.automationId}: ${a.title || '(untitled)'}  cron=${a.cronExpr}`);
  } else if (sub === 'update') {
    if (flag('--mode') !== undefined) fail('update cannot change mode (the kernel update schema has no mode field)\n' + USAGE);
    const patch = scheduleParams({ forUpdate: true });
    const title = flag('--title'), prompt = flag('--prompt');
    if (title !== undefined) patch.title = title;
    if (prompt !== undefined) patch.prompt = prompt;
    if (Object.keys(patch).length === 0) fail('update needs at least one field\n' + USAGE);
    const id = positional[1];
    const job = mutateJobs(jobs => {
      const j = jobs.find(x => x.id === id);
      if (!j) throw new Error(`automation not found: ${id}`);
      // `--max-runs none` needs recurring=true in the same patch; a job that is
      // already recurring shouldn't make the user say so again.
      if (patch.maxRuns === null && patch.recurring === undefined && j.recurring !== false)
        patch.recurring = true;
      return patchJob(j, { automationId: id, ...patch });
    });
    const a = toKernelAutomation(job);
    if (asJson) console.log(JSON.stringify(a, null, 2));
    else printAutomation(a);
  } else if (sub === 'delete') {
    const id = positional[1];
    const deleted = mutateJobs(jobs => {
      const i = jobs.findIndex(x => x.id === id);
      if (i < 0) return false;
      jobs.splice(i, 1);
      return true;
    });
    if (asJson) console.log(JSON.stringify({ deleted }));
    else console.log(deleted ? `deleted ${id}` : `nothing deleted: ${id} not found`);
    if (!deleted) code = 1;
  } else {
    const bound = loadJobs().some(
      j => j.status !== 'completed' && j.targetTaskId === positional[1]);
    if (asJson) console.log(JSON.stringify({ bound }));
    else console.log(bound ? `bound: ${positional[1]}` : `not bound: ${positional[1]}`);
  }
} catch (e) { die(e); }
process.exit(code);
