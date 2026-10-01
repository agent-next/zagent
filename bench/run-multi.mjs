#!/usr/bin/env node
// bench/run-multi.mjs — multi-harness benchmark: zcode | claude_code | grok-cli | opencode
// Same tasks, same oracles, same deduped usage recording as run.mjs.
// Usage: node bench/run-multi.mjs <harness> <taskDir> <runId>
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareRun } from './run-safety.mjs';
import { extractResponse } from './paired-core.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [harness, taskDir, runId] = process.argv.slice(2);
// Validate receipt identifiers before preparing an owned run fixture.
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
for (const [name, v] of [['harness', harness], ['runId', runId]])
  if (!SLUG.test(String(v ?? ''))) { console.error(`run-multi: ${name} must be a slug (got '${v}')`); process.exit(2); }
const prompt = readFileSync(path.join(taskDir, 'task.md'), 'utf8');
const run = prepareRun({ lane: harness, task: path.basename(taskDir), runId, results: `${ROOT}/bench/results`, prefix: 'mh_' });
const ws = run.workspace, grade = run.grade;
try {
// copy EVERY task .py (except the hidden test oracle) — tasks vary: t1 uses buggy.py,
// t10 uses messy.py; copying only buggy.py starved the agent of the very file to edit
// (t10 failed 3 lanes identically on 2026-09-06 before this fix).
for (const f of readdirSync(taskDir)) if (f.endsWith('.py') && f !== 'test.py')
  try { writeFileSync(`${ws}/${f}`, readFileSync(`${taskDir}/${f}`)); } catch {}
try { writeFileSync(`${grade}/test.py`, readFileSync(`${taskDir}/test.py`)); } catch {}

const agentic = existsSync(path.join(taskDir, 'agent_graded'));
const t0 = Date.now();
let answer = '', spawnFail = null;

// Where the harnesses are INSTALLED, which is not where the run reads its config.
// The flash pin works by overriding HOME, so os.homedir() points at a throwaway
// temp dir — and the one lane that located its entry that way stopped resolving
// at all, scoring 0/3 for a reason that had nothing to do with the model. Config
// isolation must not move the binaries.
const REAL_HOME = process.env.BENCH_REAL_HOME || os.homedir();

const HARNESS_CMDS = {
  zcode: { cmd: ['node', `${ROOT}/packages/cli/zagent.mjs`, '-p', prompt, '--json'], env: {}, timeout: agentic ? 300000 : 120000 },
  'zcode-app-cli': { cmd: ['node', `${REAL_HOME}/.local/opt/zcode-app-cli/node_modules/zcode-app-cli/bin/zcode.js`, '-p', prompt, '--json'], env: {}, timeout: agentic ? 300000 : 120000 },
  // The official product's own engine, driven with no client of ours in the path.
  // The desktop GUI is Electron and cannot be benchmarked headlessly, but the GUI
  // and this kernel are the same binary — /opt/ZCode/resources/glm/zcode.cjs is
  // what the .deb installs and what the GUI runs. This lane is therefore the
  // honest stand-in for "official ZCode", and the control for our own overhead.
  'zcode-official': { cmd: ['node', process.env.ZCODE_OFFICIAL_KERNEL ?? '/opt/ZCode/resources/glm/zcode.cjs', '-p', prompt, '--json'], env: {}, timeout: agentic ? 300000 : 120000 },
  // Claude Code routed to the same GLM model by the caller's environment (ANTHROPIC_* / ZAI_AUTH_TOKEN,
  // or a wrapper named by BENCH_CLAUDE_CODE_BIN). Plain text: --output-format json dumps session JSON the extractor misreads.
  // Timeout stays below the matrix scripts' outer 400s shell timeout.
  claude_code: { cmd: [process.env.BENCH_CLAUDE_CODE_BIN ?? 'claude', '-p', prompt], env: {}, timeout: agentic ? 360000 : 180000 },
  'grok-cli': { cmd: [process.env.BENCH_GROK_CLI_BIN ?? 'grok', '-p', prompt], env: {}, timeout: agentic ? 300000 : 150000 },
  // opencode can be blocked by a host's plugin stack (an agent preset pinning a deprecated
  // model that --pure/-m/-c/OPENCODE_CONFIG/--agent do not override). Kept here so an
  // unblocked host can run the lane.
  opencode: { cmd: ['opencode', 'run', prompt], env: { OPENCODE_CONFIG: '/dev/null' }, timeout: agentic ? 300000 : 150000 }, // r3 #4: NEVER pass keys via argv (visible in ps); auth must come from the host's opencode auth store
};

const hc = HARNESS_CMDS[harness];
if (!hc) throw new Error(`unknown harness: ${harness}`);
const tSend = Date.now();
const r = spawnSync(hc.cmd[0], hc.cmd.slice(1), { cwd: ws, encoding: 'utf8', timeout: hc.timeout, maxBuffer: 64e6, env: { ...process.env, ...hc.env } });
const turnMs = Date.now() - tSend;
answer = r.stdout ?? '';
if (r.error) spawnFail = String(r.error.code ?? r.error.message);
else if (r.status !== 0) spawnFail = `exit:${r.status}`;

const wall = +((Date.now() - t0) / 1000).toFixed(1);
// --json harnesses: parse the JSON envelope, extract the response field, then find code blocks
let text = '';
try { text = extractResponse(answer); } catch { spawnFail ??= 'invalid response'; }
if (!agentic) {
  writeFileSync(`${grade}/solution.py`, text);
  try { writeFileSync(`${grade}/buggy.py`, readFileSync(`${taskDir}/buggy.py`)); } catch {}
} else for (const f of readdirSync(ws)) if (f.endsWith('.py') && f !== 'test.py') try { copyFileSync(`${ws}/${f}`, `${grade}/${f}`); } catch {}
const t = spawnSync('python3', ['test.py'], { cwd: grade, encoding: 'utf8', timeout: 30000 });
// The first matrix recorded no model, so afterwards nobody could tell which model
// each lane had actually used — the conditions of the experiment were unknowable
// from its own output. Every record now carries them.
const conditions = {
  model: process.env.BENCH_MODEL ?? 'default',
  home: process.env.HOME,
  runtimeEntry: process.env.ZCODE_RUNTIME ?? null,
  node: process.version,
  startedAt: new Date().toISOString(),
};
// A cell that never got an answer out of the provider is NOT a failed cell — it is
// a cell with no measurement in it. z.ai throttles with `[1302] Rate limit reached`
// (no retry-after) and the harness then exits with an empty answer, which grades as
// pass:false and is indistinguishable from the model getting the task wrong. Scoring
// those as failures silently biases whichever lane happened to be throttled, so they
// are marked invalid instead and re-run.
const errText = `${r.stderr ?? ''}`;
const PROVIDER_FAIL = [
  // 1308 first: it also arrives as HTTP 429, but it is the plan's usage WINDOW,
  // not a concurrency limit. Backing off seconds and retrying — correct for 1302 —
  // just burns the rest of the run against a wall that lasts hours. The 2026-09-07
  // matrix mislabelled 4 cells "rate-limited" that were really the usage window.
  [/\[1308\]|Usage limit reached/i, 'usage-limit'],
  [/\[1302\]|Rate limit reached|RateLimit|429/i, 'rate-limited'],
  [/ProviderBusinessError/i, 'provider-error'],
  [/ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up/i, 'network'],
  [/unauthor|forbidden|invalid api key|401|403/i, 'auth'],
];
// An ANSWER is the discriminator, not the exit code. A harness that ran and exited
// non-zero WITH output produced a real measurement — the agent failed the task —
// and marking that invalid would hide genuine failures, the opposite of the point.
// No answer means no measurement: the provider refused, or the lane never started
// (zcode-app-cli died with MODULE_NOT_FOUND under the flash-pinned HOME and scored
// 0/3 for a reason that had nothing to do with the model).
let invalid = null;
if (r.error) invalid = `spawn:${String(r.error.code ?? r.error.message)}`;
else if (!answer.trim()) {
  invalid = PROVIDER_FAIL.find(([re]) => re.test(errText))?.[1]
    ?? (r.status !== 0 ? 'no-output' : null);
}

const rec = { harness, task: path.basename(taskDir), runId, ...conditions, wall_s: wall, turn_s: +(turnMs / 1000).toFixed(1),
  // Two independent questions, kept separate:
  //   invalid — was there a measurement at all? (no answer => no)
  //   pass    — did the measured run succeed? A harness that exited non-zero did
  //             not, even if the file it happened to leave behind grades clean.
  pass: invalid ? null : (!spawnFail && t.status === 0), invalid, outLen: answer.length, spawn_error: spawnFail,
  // The provider error line appears near the START of stderr; a plain tail caught
  // only HTTP headers and threw away the code, so 4 receipts could not afterwards
  // be told apart as 1302 or 1308. Keep the matched line, and a tail as context.
  errLine: invalid ? (/\[\d{3,6}\]\[[^\]]*\]/.exec(errText)?.[0]
    ?? errText.split('\n').find(l => /error|fail/i.test(l))?.trim().slice(0, 200) ?? null) : undefined,
  errTail: invalid ? errText.slice(-300) : undefined,
  testOut: `${t.stdout ?? ''}${t.stderr ?? ''}`.slice(-160) };
run.write(rec);
console.log(JSON.stringify(rec));
if (!rec.pass) process.exitCode = 1;
} finally { run.cleanup(); }
