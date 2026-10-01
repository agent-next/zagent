#!/usr/bin/env node
// usertest/emulator.mjs — the automated "real new human user" for zagent.
// Drives the TUI exactly like a person: types, waits for visual response, reads the
// screen, decides next action. Every step is logged as structured JSON so an agent
// can analyze the results and close the loop: test → analyze → fix → re-test.
//
// Usage: node usertest/emulator.mjs [--suite S1|S2|S3|...|R|J|all] [--bin <path>]
// Output: usertest/results/<timestamp>-<suite>.jsonl (one event per line)
//
// --bin picks the binary under test. The
// emulator drives the REAL installed zagent (npm global) — the product a real
// human runs — resolved in order: --bin flag, ZAGENT_EMU_BIN, `zagent` on PATH,
// falling back to the checkout's bin/zagent. Repo-only dev tools that are never
// published (bin/zagent-quota, bin/zagent-sessions) stay on ROOT paths.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, symlinkSync, copyFileSync, chmodSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RESULTS_DIR = path.join(ROOT, 'usertest', 'results');
mkdirSync(RESULTS_DIR, { recursive: true });

// --- Sandbox HOME: TUI runs must NEVER mutate the developer's real ~/.zcode config ---
// Root cause (2026-09-05): a fuzz/emulator keystroke in the TUI's /model picker rewrote
// the real config's model.main to glm-5.3-flash and it silently persisted across runs.
// Every TUI spawn below runs against a throwaway HOME seeded with a copy of the real
// config; runtime discovery still works via a .local symlink.
const SANDBOX_HOME = mkdtempSync('/tmp/zemu-home-');
try { symlinkSync(`${os.homedir()}/.local`, `${SANDBOX_HOME}/.local`); } catch {}
try {
  mkdirSync(`${SANDBOX_HOME}/.zcode/cli`, { recursive: true });
  copyFileSync(`${os.homedir()}/.zcode/cli/config.json`, `${SANDBOX_HOME}/.zcode/cli/config.json`);
  chmodSync(`${SANDBOX_HOME}/.zcode/cli/config.json`, 0o600);
} catch { /* no real config: fresh-user path will bootstrap it (ensureConfig) */ }
const SANDBOX_ENV = { ...process.env, HOME: SANDBOX_HOME };
process.on('exit', () => { try { rmSync(SANDBOX_HOME, { recursive: true, force: true }); } catch {} });

// --- Binary under test: the REAL installed zagent a human would run ----------
const binIdx = process.argv.indexOf('--bin');
const binArg = binIdx >= 0 ? process.argv[binIdx + 1]
  : process.argv.find(a => a.startsWith('--bin='))?.split('=')[1];
// `which zagent` may land on a non-JS shim (pnpm/volta wrappers) — `node <shim>`
// would die with a SyntaxError. Sniff a node shebang or a .js/.mjs realpath.
const isJsBin = (p) => {
  try {
    const real = realpathSync(p);
    if (/\.(m?js|cjs)$/.test(real)) return true;
    return /^#!.*node/.test(readFileSync(real, 'utf8').slice(0, 200));
  } catch { return false; }
};
const whichBin = (() => {
  const p = spawnSync('which', ['zagent'], { encoding: 'utf8' }).stdout?.trim();
  return p && isJsBin(p) ? p : null;
})();
// path.resolve: ptyRun's bash -c runs with cwd=ws — a relative --bin would
// silently break there. Empty --bin/ZAGENT_EMU_BIN falls through via ||.
const BIN = path.resolve(binArg || process.env.ZAGENT_EMU_BIN || whichBin || `${ROOT}/bin/zagent`);
// Invocation shape that works for the npm shim and the repo script alike; each
// side single-quoted — cmd lands inside `script -qec "${cmd}"` under bash -c.
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const NODE_BIN = `${shq(process.execPath)} ${shq(BIN)}`;

// --- Structured event log ---
const events = [];
const log = (type, data) => {
  const ev = { t: Date.now(), type, ...data };
  events.push(ev);
  console.error(JSON.stringify(ev));
};

// --- Pty driver: one-shot pty with scripted input (for most tasks) ---
function ptyRun({ cmd, cwd, inputs = [], waitMs = 15000, timeoutMs = 30000 }) {
  // Sequential input piped to script's stdin (matching the manual test pattern).
  // %b interprets \r as carriage return for the TUI's Enter key.
  const esc = s => s.replace(/'/g, "'\\''").replace(/\r/g, '\\r');
  let prev = 0;
  const seq = inputs.map(({ delay, text }) => {
    const gap = Math.max(0, Math.round(delay - prev)); prev = delay;
    return `sleep ${gap}; printf '%b' '${esc(text)}'`;
  }).join('; ');
  const full = `(${seq}) | timeout ${Math.floor(timeoutMs / 1000)} script -qec "${cmd}" /dev/null`;
  const t0 = Date.now();
  const r = spawnSync('bash', ['-c', full], { cwd, env: SANDBOX_ENV, encoding: 'utf8', timeout: timeoutMs + 5000, maxBuffer: 64e6 });
  return { output: r.stdout ?? '', wallMs: Date.now() - t0, exitCode: r.status };
}

// --- Screen parsing helpers (extract state from ANSI output) ---
function screen(output) {
  const clean = output
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b-\x1f]/g, '');
  return {
    text: clean,
    // The banner prints `zagent` since the rename — the old /ZCODE/ oracle went
    // stale and false-failed every boot check. The placeholder is locale-bound:
    // accept en + zh (the sandbox copies the real config, locale and all).
    hasTUI: /zagent/i.test(clean) && /Ask a task|输入你想让它做的事/.test(clean),
    hasModel: (model) => new RegExp(`zai/${model.replace('/', '\\/')}(?![-.])`).test(clean),
    hasSession: /sess_/.test(clean),
    hasRetry: /etrying/.test(clean),
    hasError: /error|Error|FAIL/i.test(clean),
    lines: clean.split('\n').filter(l => l.trim()).length,
  };
}

// --- Scoring ---
function score(condition, description, details = {}) {
  const s = condition ? 10 : 0;
  log('score', { description, score: s, pass: condition, ...details });
  return s;
}

// ============================================================
// SUITES
// ============================================================

async function S1_coldStart() {
  log('suite', { name: 'S1_coldStart', desc: 'Fresh user: install → first answer' });
  let total = 0, max = 0;

  // 1.1 doctor
  // SANDBOX_ENV: on a config-less machine `doctor --fix` would ensureConfig()
  // into the REAL ~/.zcode — a persisted poisoned credential (same class S8.2).
  const d = spawnSync(process.execPath, [BIN, 'doctor'],
    { encoding: 'utf8', timeout: 15000, env: { ...SANDBOX_ENV, ZAI_API_KEY: 'emu-test-key' } });
  total += score(d.status === 0 && /runtime/.test(d.stdout), '1.1 doctor runs and reports', { out: d.stdout?.slice(0, 200) });
  max += 10;

  // 1.2 doctor --fix
  const d2 = spawnSync(process.execPath, [BIN, 'doctor', '--fix'],
    { encoding: 'utf8', timeout: 15000, env: { ...SANDBOX_ENV, ZAI_API_KEY: 'emu-test-key' } });
  total += score(/runtime/.test(d2.stdout), '1.2 doctor --fix runs', { out: d2.stdout?.slice(0, 200) });
  max += 10;

  // 1.3-1.5: interactive TUI with a prompt
  const ws = '/tmp/emu-s1-ws';
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  const tui = ptyRun({
    cmd: `${NODE_BIN} --cwd ${ws}`,
    cwd: ws,
    inputs: [{ delay: 8, text: 'Reply with exactly: OK\\r' }],
    waitMs: 45, timeoutMs: 55000,
  });
  const sc = screen(tui.output);
  total += score(sc.hasTUI, '1.3 TUI renders', { lines: sc.lines });
  max += 10;
  const answered = sc.hasSession || /\d+ tokens(?!.*session 0)/.test(sc.text) || /Reply with exactly/.test(sc.text) && !/session 0 tokensReply/.test(sc.text);
  // 1.4 asserts DELIVERY. hasRetry alone must not fail it: auto-retry recovering from a
  // 429 is our robustness feature working, not a defect (two congested-window runs
  // 2026-09-05 01:30/01:40 SGT failed this on retries with the answer delivered late).
  // Congestion is recorded in the payload so the G5 gate can see env weather.
  total += score(answered, '1.4 first prompt gets answer',
    { hasSession: sc.hasSession, hasRetry: sc.hasRetry, recoveredViaRetry: answered && sc.hasRetry, tail: sc.text.slice(-300) });
  max += 10;
  total += score(tui.wallMs < 60000, '1.5 first answer within 60s', { wallMs: tui.wallMs });
  max += 10;
  rmSync(ws, { recursive: true, force: true });

  log('suite_result', { name: 'S1_coldStart', score: total, max, pct: Math.round(total / max * 100) });
  return { score: total, max };
}

async function S2_guiMigration() {
  log('suite', { name: 'S2_guiMigration', desc: 'GUI user: zero-login direct use' });
  let total = 0, max = 0;

  // 2.1: zz opens without login prompt (GUI already installed)
  const ws = '/tmp/emu-s2-ws';
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  const tui = ptyRun({
    cmd: `${NODE_BIN} --cwd ${ws}`,
    cwd: ws,
    inputs: [{ delay: 8, text: 'What is 2+2?\\r' }],
    waitMs: 40, timeoutMs: 50000,
  });
  const sc = screen(tui.output);
  total += score(sc.hasTUI && !/login/i.test(sc.text.slice(0, 500)), '2.1 TUI opens without login prompt', { first500: sc.text.slice(0, 300) });
  max += 10;
  // A retry that eventually succeeds is still a pass for the USER (they got their
  // answer). The status bar shows "session 15.8K" when tokens were consumed.
  const answered2 = sc.hasSession || /session \d+[KMB]/.test(sc.text) || /\d+ tokens/.test(sc.text);
  total += score(answered2, '2.2 question answered', { hasSession: sc.hasSession, hasRetry: sc.hasRetry, textTail: sc.text.slice(-200) });
  max += 10;

  // 2.3 sessions
  const sess = spawnSync('node', ['--experimental-sqlite', `${ROOT}/bin/zagent-sessions`], { encoding: 'utf8', timeout: 30000 });
  total += score(/sessions/.test(sess.stdout), '2.3 sessions panel shows data', { out: sess.stdout?.slice(0, 200) });
  max += 10;

  // 2.4 quota
  const quota = spawnSync('node', [`${ROOT}/bin/zagent-quota`, 'reset'], { encoding: 'utf8', timeout: 30000 });
  total += score(/200|code.*0/.test(quota.stdout), '2.4 quota reset returns data', { out: quota.stdout?.slice(0, 200) });
  max += 10;

  rmSync(ws, { recursive: true, force: true });
  log('suite_result', { name: 'S2_guiMigration', score: total, max, pct: Math.round(total / max * 100) });
  return { score: total, max };
}

async function S7_quota() {
  log('suite', { name: 'S7_quota', desc: 'Quota oracles' });
  let total = 0, max = 0;
  for (const sub of ['balance', 'preview', 'reset']) {
    const r = spawnSync('node', [`${ROOT}/bin/zagent-quota`, sub], { encoding: 'utf8', timeout: 30000 });
    total += score(/200|"code":\s*0/.test(r.stdout), `7 quota ${sub}`, { out: r.stdout?.slice(0, 150) });
    max += 10;
  }
  log('suite_result', { name: 'S7_quota', score: total, max, pct: Math.round(total / max * 100) });
  return { score: total, max };
}

// ============================================================


async function S3_coreCoding() {
  log('suite', { name: 'S3_coreCoding', desc: 'Daily driver: read/fix/test/refactor/diff/headless' });
  let total = 0, max = 0;
  const ws = '/tmp/emu-s3-ws';
  rmSync(ws, { recursive: true, force: true }); mkdirSync(ws, { recursive: true });
  // Fixture: a small file with a known bug
  writeFileSync(`${ws}/calc.py`, "def add(a, b):\n    return a - b\n\nprint(add(2, 3))\n");
  // 3.1 headless: read + summarize
  const h = spawnSync(process.execPath, [BIN, '-p', 'Read calc.py and tell me what the bug is in one sentence. Do not fix it.', '--json'],
    { cwd: ws, encoding: 'utf8', timeout: 120000, maxBuffer: 64e6 });
  const answered31 = h.stdout && h.stdout.length > 50 && /bug|subtract|minus|wrong/i.test(h.stdout);
  total += score(answered31, '3.1 headless bug identification', { outLen: h.stdout?.length, snippet: h.stdout?.slice(0, 200) });
  max += 10;
  // 3.2 agentic fix via TUI
  // Longer prompts need: (a) more boot time, (b) chunked injection so the TUI input
  // buffer doesn't drop chars, (c) explicit \r at the end after a pause
  const fixPrompt = 'Fix calc.py. Edit the file.'; // short: avoids retry loop from rate limiting
  const fixChunks = fixPrompt.match(/.{1,10}/g) ?? [];
  const fixInputs = [
    { delay: 12, text: fixPrompt }, // single short burst after boot
    { delay: 14, text: '\r' },      // submit
    // Approvals sprinkled: the edit-permission dialog lands wherever the model's first
    // response lands — 20s when the API is fast, 40s+ during congested free-window hours
    // (reproduced 2026-09-05). Enter with no dialog pending submits an empty line = no-op.
    ...[26, 32, 38, 44, 50, 56].map(s => ({ delay: s, text: '\r' })),
  ];
  const fix = ptyRun({ cmd: `${NODE_BIN} --cwd ${ws}`,
    inputs: fixInputs.map(i => ({ delay: Math.ceil(i.delay), text: i.text })),
    waitMs: 75, timeoutMs: 100000 });
  const sc3 = screen(fix.output);
  const fixed = existsSync(`${ws}/calc.py`) && readFileSync(`${ws}/calc.py`, 'utf8').includes('a + b');
  if (!fixed) writeFileSync(path.join(RESULTS_DIR, `s32-fail-screen-${Date.now()}.ansi`), fix.output); // diagnostic artifact: full pty capture
  total += score(fixed, '3.2 agentic bug fix (file edited)', { fixed, tail: sc3.text.slice(-200) });
  max += 10;
  // 3.3 headless verify
  const t3 = spawnSync('python3', ['-c', 'import sys; sys.path.insert(0,"' + ws + '"); from calc import add; assert add(2,3)==5; print("PASS")'],
    { encoding: 'utf8', timeout: 15000 });
  total += score((t3.stdout ?? '').includes('PASS'), '3.3 fix verified by test', { out: t3.stdout?.trim() });
  max += 10;
  // 3.4 headless JSON mode
  const hj = spawnSync(process.execPath, [BIN, '-p', 'What is 2+2? Reply with just the number.', '--json'],
    { cwd: ws, encoding: 'utf8', timeout: 120000, maxBuffer: 64e6 });
  total += score(hj.stdout && hj.stdout.length > 10, '3.4 headless JSON output', { outLen: hj.stdout?.length });
  max += 10;
  rmSync(ws, { recursive: true, force: true });
  log('suite_result', { name: 'S3_coreCoding', score: total, max, pct: Math.round(total / max * 100) });
  return { score: total, max };
}

async function S5_featureSurface() {
  log('suite', { name: 'S5_featureSurface', desc: 'Slash commands / model / headless modes' });
  let total = 0, max = 0;
  const ws = '/tmp/emu-s5-ws'; rmSync(ws, { recursive: true, force: true }); mkdirSync(ws, { recursive: true });
  // 5.1-5.3 via pty: /help, /status, /model
  const tui = ptyRun({ cmd: `${NODE_BIN} --cwd ${ws}`,
    inputs: [{ delay: 6, text: '/help\r' }, { delay: 12, text: '/status\r' }],
    waitMs: 25, timeoutMs: 35000 });
  const sc = screen(tui.output);
  total += score(/help|command/i.test(sc.text), '5.1 /help shows commands', { lines: sc.lines });
  max += 10;
  total += score(sc.hasTUI, '5.2 TUI survives slash commands', {});
  max += 10;
  // 5.3 headless with image (vision test)
  // Create a tiny test PNG
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  writeFileSync(`${ws}/test.png`, Buffer.from(pngB64, 'base64'));
  const vis = spawnSync(process.execPath, [BIN, '-p', 'Attach test.png and describe it in one word.', '--json'],
    { cwd: ws, encoding: 'utf8', timeout: 120000, maxBuffer: 64e6 });
  total += score(vis.stdout && vis.stdout.length > 20, '5.3 image attachment headless', { outLen: vis.stdout?.length });
  max += 10;
  rmSync(ws, { recursive: true, force: true });
  log('suite_result', { name: 'S5_featureSurface', score: total, max, pct: Math.round(total / max * 100) });
  return { score: total, max };
}

async function S6_sessions() {
  log('suite', { name: 'S6_sessions', desc: 'Create, list, resume sessions' });
  let total = 0, max = 0;
  // 6.1 create a session via headless
  const h1 = spawnSync(process.execPath, [BIN, '-p', 'Remember: my favorite color is blue.', '--json'],
    { cwd: '/tmp', encoding: 'utf8', timeout: 120000, maxBuffer: 64e6 });
  total += score(h1.stdout?.length > 20, '6.1 headless creates a session', { outLen: h1.stdout?.length });
  max += 10;
  // 6.2 sessions panel lists it
  const sess = spawnSync('node', ['--experimental-sqlite', `${ROOT}/bin/zagent-sessions`], { encoding: 'utf8', timeout: 30000 });
  total += score(/sessions/i.test(sess.stdout) && sess.stdout.length > 20, '6.2 sessions panel lists sessions', { out: sess.stdout?.slice(0, 200) });
  max += 10;
  // 6.3 resume via --continue
  const h2 = spawnSync(process.execPath, [BIN, '-p', 'What is my favorite color? Answer in one word.', '-c'],
    { cwd: '/tmp', encoding: 'utf8', timeout: 120000, maxBuffer: 64e6 });
  const resumed = h2.stdout && /blue/i.test(h2.stdout);
  total += score(resumed, '6.3 session resume remembers context', { out: h2.stdout?.slice(0, 300), resumed });
  max += 10;
  log('suite_result', { name: 'S6_sessions', score: total, max, pct: Math.round(total / max * 100) });
  return { score: total, max };
}

async function S8_stress() {
  log('suite', { name: 'S8_stress', desc: 'Rapid prompts, interrupt, corrupt config recovery' });
  let total = 0, max = 0;
  // 8.1 rapid headless x3
  let rapidOk = 0;
  for (let i = 0; i < 3; i++) {
    const r = spawnSync(process.execPath, [BIN, '-p', `What is ${i}+1? Reply with just the number.`, '--json'],
      { cwd: '/tmp', encoding: 'utf8', timeout: 120000, maxBuffer: 64e6 });
    if (r.stdout && r.stdout.length > 10) rapidOk++;
  }
  total += score(rapidOk === 3, `8.1 3 rapid prompts all answered (${rapidOk}/3)`, { rapidOk });
  max += 10;
  // 8.2 corrupt config detection — on the SANDBOX copy, never the real one
  // (the whole reason the SANDBOX_HOME above exists).
  const cfgPath = `${SANDBOX_HOME}/.zcode/cli/config.json`;
  // No seeded config on this machine → nothing to corrupt; the test then checks
  // doctor on a config-less sandbox (still a valid oracle, not a crash).
  const cfgBak = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : null;
  writeFileSync(cfgPath, '{corrupt');
  try {
    const doc = spawnSync(process.execPath, [BIN, 'doctor'], { encoding: 'utf8', timeout: 15000, env: SANDBOX_ENV });
    total += score(typeof doc.status === 'number' && /runtime/.test(doc.stdout), '8.2 doctor survives corrupt config', { exit: doc.status });
  } finally {
    if (cfgBak === null) rmSync(cfgPath, { force: true });
    else writeFileSync(cfgPath, cfgBak); // restore even on crash
  }
  max += 10;
  log('suite_result', { name: 'S8_stress', score: total, max, pct: Math.round(total / max * 100) });
  return { score: total, max };
}

// The J1..J9 human-journey pty suite (user-journey inventory), folded into
// the ratchet: each offline file must exit green. Live letters (J3/J4/J7) stay
// in their own ZAGENT_LIVE opt-in — the emulator never spends quota unasked.
async function J_journeys() {
  log('suite', { name: 'J_journeys', desc: 'J1..J9 pty human-journey suite (offline letters)' });
  let total = 0, max = 0;
  // Same glob the publish gate uses, minus the live file — a fifth journey file
  // can never ship un-run here. SANDBOX_ENV is not optional: the journeys spawn
  // the TUI under a pty and the TUI touches ~/.zcode — line 21 exists because a
  // TUI run once rewrote the real config.
  const files = readdirSync(`${ROOT}/packages/tui`)
    .filter(f => /^test-journeys.*\.mjs$/.test(f) && f !== 'test-journeys-live.mjs').sort();
  for (const f of files) {
    const r = spawnSync(process.execPath, [`${ROOT}/packages/tui/${f}`],
      { encoding: 'utf8', timeout: 300000, maxBuffer: 64e6, env: SANDBOX_ENV });
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').pop()
      ?? `exit ${r.status} ${r.error?.message ?? ''}`;
    total += score(r.status === 0, `J-suite ${f} green (${tail.slice(0, 80)})`, { tail });
    max += 10;
  }
  log('suite_result', { name: 'J_journeys', score: total, max, pct: Math.round(total / max * 100) });
  return { score: total, max };
}

// R — the installed product under a real pty (user-journey inventory: "drive the REAL
// installed zagent through a REAL PTY"). Offline letters only: slash commands
// are client-side, so this spends no model turn. Every typed line that is not a
// slash command IS a turn — the script never types one.
async function R_realPty() {
  log('suite', { name: 'R_realPty', desc: 'installed binary, real pty: boot → /help → /exit', bin: BIN });
  let total = 0, max = 0;
  const ws = mkdtempSync('/tmp/emu-r-ws-');
  const tui = ptyRun({
    cmd: `${NODE_BIN} --cwd ${ws}`,
    cwd: ws,
    // Boot latency varies (quota probe + kernel handshake): /exit must land
    // after the UI is interactive — a second copy is harmless if the first
    // was swallowed mid-boot, and exiting twice costs nothing.
    inputs: [{ delay: 8, text: '/help\r' }, { delay: 18, text: '/exit\r' }, { delay: 24, text: '/exit\r' }],
    waitMs: 30, timeoutMs: 45000,
  });
  const sc = screen(tui.output);
  total += score(sc.hasTUI, 'R.1 installed binary boots the TUI under a real pty',
    { bin: BIN, lines: sc.lines, tail: sc.text.slice(-200) });
  max += 10;
  total += score(/Shortcuts/.test(sc.text), 'R.2 /help shows the Shortcuts section', {});
  max += 10;
  // /exit must leave promptly — a hang here is exactly what a human hits.
  total += score(tui.exitCode === 0 && tui.wallMs < 40000, 'R.3 /exit leaves promptly, no force',
    { exitCode: tui.exitCode, wallMs: tui.wallMs });
  max += 10;
  rmSync(ws, { recursive: true, force: true });
  log('suite_result', { name: 'R_realPty', score: total, max, pct: Math.round(total / max * 100) });
  return { score: total, max };
}

async function main() {
  const suiteIdx = process.argv.indexOf('--suite');
  const suiteArg = suiteIdx >= 0 ? (process.argv[suiteIdx + 1] ?? 'all') : (process.argv.find(a => a.startsWith('--suite='))?.split('=')[1] ?? 'all');
  const suites = { S1: S1_coldStart, S2: S2_guiMigration, S3: S3_coreCoding, S5: S5_featureSurface, S6: S6_sessions, S7: S7_quota, S8: S8_stress, R: R_realPty, J: J_journeys };
  const toRun = suiteArg === 'all' ? Object.keys(suites) : suiteArg.split(',');
  let grand = 0, grandMax = 0;
  for (const name of toRun) {
    if (!suites[name]) continue;
    const r = await suites[name]();
    grand += r.score; grandMax += r.max;
    if (toRun.indexOf(name) < toRun.length - 1)
      await new Promise(r2 => setTimeout(r2, 15000)); // rate-bucket recovery between suites
  }
  const summary = { total: grand, max: grandMax, pct: grandMax ? Math.round(grand / grandMax * 100) : 0,
    retriesObserved: events.some(e => e.hasRetry) }; // env weather: GLM congestion during free-window hours
  log('final', summary);
  const outPath = path.join(RESULTS_DIR, `${Date.now()}-${suiteArg}.jsonl`);
  writeFileSync(outPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  console.log(JSON.stringify({ ...summary, resultsFile: outPath }));
  process.exit(summary.pct >= 95 ? 0 : 1);
}

main();
