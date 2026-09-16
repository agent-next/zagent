// Host-side automation/* serving — F4 (desktop "Automations" parity).
// The kernel wires automationPort unconditionally: during a turn the model's
// CronCreate/CronList/CronUpdate/CronDelete tools emit automation/* as INCOMING
// JSON-RPC requests on the stdio channel (Fjn = createProtocolAutomationPort).
// zagent is the host: these handlers back the surface onto the local cron
// store (~/.zcode/cli/automations.json, fired by `zagent cron tick`), so
// model-initiated scheduled prompts work headlessly.
// Wire shapes verified verbatim against installed 3.12.1 zcode.cjs:
//   create  wIs -> {automation:kHe}   update SIs -> {automation:kHe}
//   list    kIs -> {automations:[kHe]} delete TIs -> {deleted}  checkTaskBinding IIs -> {bound}
// kHe (strict — no extra keys): {automationId,title,cronExpr,prompt,modelSelection?,
//   mode?,targetTaskId?,enabled,lifecycleStatus:active|completed|failed|paused,
//   nextRunAt?,lastRunAt?,runCount,recurring,maxRuns?,scheduleRule?}

import { randomUUID } from 'node:crypto';
import { loadJobs, mutateJobs, parseCron, nextRunMs, logAutomation, PRIVILEGED_JOB_MODES } from './automation.mjs';

const MODES = new Set(['default', 'yolo', 'plan', 'edit', 'acceptEdits', 'auto',
  'dontAsk', 'bypassPermissions', 'autoEdit', 'build']);
const UNITS = new Set(['minute', 'hourly', 'daily', 'weekly', 'monthly', 'yearly']);

const fail = msg => { throw new Error(`automation: ${msg}`); };
const fe = (v, name) => {
  if (typeof v !== 'string' || !v.trim()) fail(`${name} must be a non-empty string`);
  return v;
};
const optFe = (v, name) => v === undefined ? undefined : fe(v, name);
const strictKeys = (params, allowed, name) => {
  for (const k of Object.keys(params ?? {})) if (!allowed.has(k)) fail(`${name}: unknown field '${k}'`);
};
const intIn = (v, lo, hi, name) => {
  if (!Number.isInteger(v) || v < lo || v > hi) fail(`${name} must be an integer ${lo}..${hi}`);
  return v;
};
const modelSel = v => {
  if (v == null) return undefined;
  strictKeys(v, new Set(['providerId', 'modelId', 'options']), 'modelSelection');
  const out = { providerId: fe(v.providerId, 'modelSelection.providerId'),
    modelId: fe(v.modelId, 'modelSelection.modelId') };
  if (v.options !== undefined) {
    strictKeys(v.options, new Set(['reasoningLevel']), 'modelSelection.options');
    out.options = { reasoningLevel: fe(v.options.reasoningLevel, 'modelSelection.options.reasoningLevel') };
  }
  return out;
};
const botTarget = v => {
  if (v == null) return undefined;
  strictKeys(v, new Set(['provider', 'botId', 'providerUserId', 'chatType']), 'botDeliveryTarget');
  if (!['feishu', 'lark', 'weixin'].includes(v.provider)) fail('botDeliveryTarget.provider must be feishu|lark|weixin');
  if (!['private', 'group'].includes(v.chatType)) fail('botDeliveryTarget.chatType must be private|group');
  return { provider: v.provider, botId: fe(v.botId, 'botDeliveryTarget.botId'),
    providerUserId: fe(v.providerUserId, 'botDeliveryTarget.providerUserId'), chatType: v.chatType };
};
// intervalUnit/interval are the scheduleRule carrier: paired, recurring-only,
// and combinable with neither a relative delay nor maxRuns.
const checkInterval = (p, forUpdate = false) => {
  if (p.intervalUnit === undefined && p.interval === undefined) return;
  if (p.intervalUnit === undefined || p.interval === undefined)
    fail('intervalUnit and interval must be set together');
  if (!UNITS.has(p.intervalUnit)) fail(`intervalUnit must be ${[...UNITS].join('|')}`);
  intIn(p.interval, 1, 200, 'interval');
  if (!forUpdate && p.relativeDelayMinutes !== undefined)
    fail('intervalUnit cannot combine with a relative delayMinutes');
  if (p.recurring === false) fail('intervalUnit is a recurring carrier and cannot combine with recurring=false');
  if (!forUpdate && p.maxRuns !== undefined)
    fail('intervalUnit is a recurring carrier and cannot combine with maxRuns');
  if (forUpdate && p.maxRuns !== undefined && !(p.maxRuns === null && p.recurring === true))
    fail('intervalUnit only allows maxRuns=null with recurring=true');
};

// Strict kHe projection — exactly the kernel's automation fields, nothing else.
export function toKernelAutomation(j, nowMs = Date.now()) {
  const next = nextRunMs(j, nowMs);
  const a = {
    automationId: j.id,
    title: j.title ?? '',
    cronExpr: j.cron,
    prompt: j.prompt,
    enabled: j.enabled !== false,
    // 'failed' is per-attempt: a job with a future occurrence still fires, so
    // it reports 'active' — only a terminal failure (nothing left to run) maps
    // to the kernel's 'failed' lifecycle.
    lifecycleStatus: j.status === 'completed' ? 'completed'
      : j.enabled === false ? 'paused'
      : j.status === 'failed' && next == null ? 'failed' : 'active',
    runCount: j.runCount ?? 0,
    recurring: j.recurring !== false,
  };
  if (j.modelSelection) a.modelSelection = j.modelSelection;
  if (j.mode) a.mode = j.mode;
  if (j.targetTaskId) a.targetTaskId = j.targetTaskId;
  if (next != null) a.nextRunAt = next;
  const last = j.lastSuccessMs ?? j.lastAttemptMs;
  if (last != null) a.lastRunAt = last;
  if (j.maxRuns != null) a.maxRuns = j.maxRuns;
  if (j.interval) {
    const anchor = new Date(j.interval.anchorAtMs);
    a.scheduleRule = { unit: j.interval.unit, interval: j.interval.n,
      hour: anchor.getHours(), minute: anchor.getMinutes(), anchorAt: j.interval.anchorAtMs };
  } else if (j.runAtMs != null && j.createdAtMs != null) {
    // The kernel's buildRelativeDelaySchedule: minute-unit rule whose
    // hour/minute describe the FIRE time, anchored at create time.
    const fire = new Date(j.runAtMs);
    a.scheduleRule = { unit: 'minute', interval: Math.round((j.runAtMs - j.createdAtMs) / 60_000),
      hour: fire.getHours(), minute: fire.getMinutes(), anchorAt: j.createdAtMs };
  }
  return a;
}

// A one-shot relative delay has no cron on the wire (the kernel fills "* * * * *"
// as a placeholder) — display the real fire minute instead.
const oneShotCron = runAtMs => {
  const d = new Date(runAtMs);
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
};

const CREATE_KEYS = new Set(['title', 'cronExpr', 'relativeDelayMinutes', 'prompt',
  'modelSelection', 'mode', 'targetTaskId', 'botDeliveryTarget', 'recurring',
  'maxRuns', 'intervalUnit', 'interval']);
export function createJob(params, { cwd = process.cwd(), nowMs = Date.now() } = {}) {
  strictKeys(params ?? {}, CREATE_KEYS, 'create');
  const p = params ?? {};
  checkInterval(p);
  const prompt = fe(p.prompt, 'prompt');
  const delayed = p.relativeDelayMinutes !== undefined;
  if (delayed) {
    intIn(p.relativeDelayMinutes, 1, 525600, 'relativeDelayMinutes');
    if (p.recurring === true) fail('a relative delay creates a one-shot automation and cannot use recurring=true');
    if (p.maxRuns !== undefined) fail('a relative delay runs once and cannot use maxRuns');
  } else {
    fe(p.cronExpr, 'cronExpr');
    if (!parseCron(p.cronExpr)) fail(`cronExpr is not a valid 5-field cron: ${p.cronExpr}`);
  }
  if (p.mode !== undefined && !MODES.has(p.mode)) fail(`mode must be ${[...MODES].join('|')}`);
  if (p.recurring !== undefined && typeof p.recurring !== 'boolean') fail('recurring must be boolean');
  if (p.maxRuns !== undefined) intIn(p.maxRuns, 1, Number.MAX_SAFE_INTEGER, 'maxRuns');
  if (p.title !== undefined && typeof p.title !== 'string') fail('title must be a string');
  const recurring = delayed ? false : (p.intervalUnit !== undefined ? true : p.recurring ?? true);
  const job = {
    id: `auto_${randomUUID()}`,
    title: p.title ?? prompt.slice(0, 40),
    cron: delayed ? oneShotCron(nowMs + p.relativeDelayMinutes * 60_000) : p.cronExpr,
    prompt,
    workspace: cwd,
    enabled: true,
    recurring,
    maxRuns: delayed || recurring === false ? (p.maxRuns ?? 1) : p.maxRuns,
    runCount: 0,
    status: 'idle',
    createdAtMs: nowMs,
    lastAttemptMs: null, lastSuccessMs: null,
  };
  if (delayed) job.runAtMs = nowMs + p.relativeDelayMinutes * 60_000;
  if (p.intervalUnit !== undefined) job.interval = { unit: p.intervalUnit, n: p.interval, anchorAtMs: nowMs };
  const ms = modelSel(p.modelSelection); if (ms) job.modelSelection = ms;
  if (p.mode !== undefined) job.mode = p.mode;
  const task = optFe(p.targetTaskId, 'targetTaskId'); if (task) job.targetTaskId = task;
  const bot = botTarget(p.botDeliveryTarget); if (bot) job.botDeliveryTarget = bot;
  return job;
}

const UPDATE_KEYS = new Set(['automationId', 'title', 'cronExpr', 'prompt',
  'recurring', 'maxRuns', 'intervalUnit', 'interval']);
export function patchJob(j, params, { nowMs = Date.now() } = {}) {
  strictKeys(params ?? {}, UPDATE_KEYS, 'update');
  const p = params ?? {};
  fe(p.automationId, 'automationId');
  const patchKeys = [...UPDATE_KEYS].filter(k => k !== 'automationId' && p[k] !== undefined);
  if (!patchKeys.length) fail('automation update requires at least one field');
  // Validate everything before mutating — a throwing patch must leave the job whole.
  checkInterval(p, true);
  if (p.maxRuns === null && p.recurring !== true) fail('clearing maxRuns requires recurring=true');
  if (p.recurring === true && typeof p.maxRuns === 'number')
    fail('recurring=true cannot be combined with a numeric maxRuns');
  if (p.title !== undefined) fe(p.title, 'title');
  if (p.prompt !== undefined) fe(p.prompt, 'prompt');
  if (p.cronExpr !== undefined && (fe(p.cronExpr, 'cronExpr'), !parseCron(p.cronExpr)))
    fail(`cronExpr is not a valid 5-field cron: ${p.cronExpr}`);
  if (typeof p.maxRuns === 'number') intIn(p.maxRuns, 1, Number.MAX_SAFE_INTEGER, 'maxRuns');
  // A runAtMs one-shot carries no schedule to re-arm: recurring=true or a
  // maxRuns change would report 'active' yet never fire. Only a cronExpr or
  // intervalUnit patch (which replace the carrier) may revive it.
  if (j.runAtMs != null && p.cronExpr === undefined && p.intervalUnit === undefined &&
      (p.recurring === true || p.maxRuns !== undefined))
    fail('a one-shot delay automation has no schedule to re-arm — set cronExpr or intervalUnit first');
  if (p.title !== undefined) j.title = p.title;
  if (p.prompt !== undefined) j.prompt = p.prompt;
  if (p.cronExpr !== undefined) {
    j.cron = p.cronExpr;
    delete j.interval; delete j.runAtMs; // an explicit cron replaces the carrier
  }
  if (p.intervalUnit !== undefined) {
    j.interval = { unit: p.intervalUnit, n: p.interval, anchorAtMs: nowMs };
    delete j.runAtMs;
    j.recurring = true; j.maxRuns = undefined;
  }
  if (p.recurring === true) { j.recurring = true; j.maxRuns = undefined; }
  else if (p.recurring === false) {
    j.recurring = false;
    delete j.interval; // an interval is a recurring carrier; finite jobs fire on cron
    if (p.maxRuns === undefined && j.maxRuns == null) j.maxRuns = 1;
  }
  if (typeof p.maxRuns === 'number') {
    j.maxRuns = p.maxRuns;
    if (p.recurring === undefined) {
      j.recurring = false; // a finite limit implies finite
      delete j.interval; // intervals are recurring-only
    }
  } else if (p.maxRuns === null) j.maxRuns = undefined; // allowed only with recurring=true (checked)
  // Reconcile lifecycle: a completed job re-armed by the patch resumes.
  if (j.maxRuns != null && (j.runCount ?? 0) >= j.maxRuns) j.status = 'completed';
  else if (j.status === 'completed') j.status = 'idle';
  return j;
}

// requestHandlers entries for ZCodeProtocolClient: every method the kernel's
// automationPort can emit. Errors thrown here surface to the kernel as -32000,
// which its CronCreate path wraps into a tool-call failure for the model.
//
// Unattended-escalation guard: a MODEL-initiated CronCreate naming a
// permission-bypassing mode would fire `--mode yolo` later with no human
// present. Host-served creates downgrade those modes to 'build' (audit-logged;
// the kernel sees the effective mode in the returned automation). A human who
// wants a permissive scheduled job passes --mode to `zagent automation create`
// themselves — that explicit flag is the host confirmation. Every write also
// appends to the audit log so kernel-initiated mutations are user-visible.
const PRIVILEGED_MODES = PRIVILEGED_JOB_MODES;
export function automationHostHandlers({ home, cwd = process.cwd() } = {}) {
  const opts = home === undefined ? {} : { home };
  return {
    'automation/create': params => {
      const demoted = PRIVILEGED_MODES.has(params?.mode);
      const job = createJob(demoted ? { ...params, mode: 'build' } : params, { cwd });
      mutateJobs(jobs => { jobs.push(job); }, opts);
      logAutomation(`automation/create ${job.id} title=${JSON.stringify(job.title)} mode=${job.mode ?? 'default'}` +
        (demoted ? ` (downgraded from '${params.mode}' — unattended jobs may not bypass permissions)` : ''), opts);
      return { automation: toKernelAutomation(job) };
    },
    'automation/update': params => {
      const id = fe(params?.automationId, 'automationId');
      const automation = toKernelAutomation(mutateJobs(jobs => {
        const j = jobs.find(x => x.id === id);
        if (!j) fail(`automation not found: ${id}`);
        return patchJob(j, params);
      }, opts));
      // id is model-controlled (a newline would forge log lines) — quote it.
      // The patched keys make the trail meaningful: a prompt patch redirects
      // what fires unattended, indistinguishable from a title tweak otherwise.
      const keys = Object.keys(params ?? {}).filter(k => k !== 'automationId');
      logAutomation(`automation/update ${JSON.stringify(id)} keys=${JSON.stringify(keys)}`, opts);
      return { automation };
    },
    'automation/list': () => ({
      automations: loadJobs(opts).map(j => toKernelAutomation(j)),
    }),
    'automation/delete': params => {
      const id = fe(params?.automationId, 'automationId');
      const deleted = mutateJobs(jobs => {
        const i = jobs.findIndex(x => x.id === id);
        if (i < 0) return false;
        jobs.splice(i, 1);
        return true;
      }, opts);
      // id is model-controlled and this line is emitted even when nothing was
      // deleted — quote it so a newline id cannot forge `deleted=true` lines.
      logAutomation(`automation/delete ${JSON.stringify(id)} deleted=${deleted}`, opts);
      return { deleted };
    },
    'automation/checkTaskBinding': params => {
      const id = fe(params?.targetTaskId, 'targetTaskId');
      // A completed automation can never fire again — it no longer binds the
      // session for CronCreate's create-inside-a-scheduled-task check.
      return { bound: loadJobs(opts).some(j => j.status !== 'completed' && j.targetTaskId === id) };
    },
  };
}
