#!/usr/bin/env node
// usertest/random-user.mjs — random human behavior simulator.
// Unlike emulator.mjs (deterministic protocol), this one picks RANDOM actions a real
// human might do: typos, cancels, rapid-fire, idle, wrong commands, pasting, etc.
// Each run generates a different sequence — it's fuzzing for UX.
// Usage: node usertest/random-user.mjs [--rounds N] [--seed S]
// Output: usertest/results/random-<timestamp>.jsonl

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, mkdtempSync, copyFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { findRuntime } from '../packages/driver/runtime.mjs';
import { replayTerminal } from '../packages/tui/screen-replay.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RESULTS_DIR = path.join(ROOT, 'usertest', 'results');

export function createSandbox({ sourceHome = os.homedir(), env = process.env } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'zrand-home-'));
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  try {
    // Locate executable code before changing HOME; writable profile directories
    // stay inside the sandbox rather than following links into the source HOME.
    const runtime = findRuntime({ home: sourceHome, env });
    const source = path.join(sourceHome, '.zcode/cli/config.json');
    if (existsSync(source)) {
      mkdirSync(path.join(home, '.zcode/cli'), { recursive: true });
      const config = path.join(home, '.zcode/cli/config.json');
      copyFileSync(source, config);
      chmodSync(config, 0o600);
      JSON.parse(readFileSync(config, 'utf8')); // unusable setup must stop the run
    }
    return { home, cleanup, env: { ...env, ...(runtime ? { ZCODE_RUNTIME: path.resolve(runtime.entry) } : {}), HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local/share') } };
  } catch (error) { cleanup(); throw error; }
}

const rounds = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--rounds') ?? '10', 10);
const seedStr = process.argv.find((a, i) => process.argv[i - 1] === '--seed');
let seed = seedStr ? parseInt(seedStr, 10) : Date.now() % 2147483647;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const pick = arr => arr[Math.floor(rand() * arr.length)];
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;

function hasReply(output, prompt) {
  // scrollback + visible screen is what a person sees; the bounded model
  // parses the DECSTBM stream the pinned writer emits (its pty is 0x0 under
  // script(1), so the app clamps to 80x24 — the geometry modeled here).
  const t = replayTerminal(output, { columns: 80, rows: 24 });
  const lines = [...t.scrollback, ...t.screen].join('\n').split('\n');
  const question = lines.findIndex(line => line.trim() === `> ${prompt}`);
  return question >= 0 && lines.slice(question + 1).some(line => /^\s*[⏺*] \S/.test(line));
}

const events = [];
const log = (type, data) => {
  const ev = { t: Date.now(), type, seed, ...data };
  events.push(ev);
  console.error(JSON.stringify(ev));
};

// --- Human behaviors to simulate ---
const BEHAVIORS = [
  { name: 'type_and_enter', desc: 'Type a prompt, press Enter, wait for answer',
    prompts: ['hello', 'what is 2+2', 'list files in this dir', 'explain recursion briefly', 'write a haiku', 'what time is it', '1+1', 'tell me a joke', 'summarize README', 'help me debug'] },
  { name: 'typo_then_correct', desc: 'Type with typos, then retype correctly',
    typos: ['helo', 'waht is', 'plese help', 'can yuo', 'recursionn'] },
  { name: 'ctrl_c_interrupt', desc: 'Send a prompt then Ctrl+C mid-response' },
  { name: 'rapid_fire', desc: 'Send 3 prompts quickly without waiting' },
  { name: 'wrong_command', desc: 'Type an invalid slash command',
    cmds: ['/foobar', '/quit-now', '/??', '/model xyz', '/set foo=bar'] },
  { name: 'paste_multiline', desc: 'Paste a multi-line code block' },
  { name: 'idle_session', desc: 'Open TUI, do nothing, close after 20s' },
  { name: 'slash_commands', desc: 'Try various slash commands',
    cmds: ['/help', '/status', '/model', '/compact', '/new'] },
  { name: 'headless_json', desc: 'Run headless with --json flag',
    prompts: ['count to 5', 'what is pi', 'name 3 colors'] },
  { name: 'quota_and_sessions', desc: 'Run zz quota and zz sessions' },
  { name: 'exit_and_resume', desc: 'Start, type, exit, resume with -c' },
  { name: 'corrupt_input', desc: 'Send binary/unicode garbage' },
];

export function runBehavior(b, { env, spawn = spawnSync, pty = ptyCmd, emit = log } = {}) {
  assert(env?.HOME, 'an isolated environment is required');
  const ws = mkdtempSync(path.join(os.tmpdir(), 'rand-user-'));
  let observed = false;
  const observe = data => {
    observed = true;
    emit('behavior', data);
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'boolean') assert(key === 'crashed' ? !value : value, `${key} assertion failed`);
    }
  };
  const checkedSpawn = (cmd, args, options) => {
    const result = spawn(cmd, args, { ...options, env });
    assert(!result.error && result.status === 0, `child failed: ${result.error?.code ?? result.status}`);
    return result;
  };
  const checkedPty = (...args) => {
    const result = pty(...args, env);
    assert(!result.error && [0, 130].includes(result.exitCode), `PTY failed: ${result.error?.code ?? result.exitCode}`);
    assert(/zagent|Ask a task|ZCODE/.test(result.output), 'TUI did not start');
    return result;
  };
  const t0 = Date.now();
  const response = result => {
    const value = JSON.parse(result.stdout);
    assert(value && !value.error && !value.isError && !value.is_error &&
      typeof value.response === 'string' && value.response.trim(), 'missing successful JSON response');
    return value.response;
  };
  let crash = false;

  try {
    switch (b.name) {
      case 'type_and_enter': {
        const prompt = pick(b.prompts);
        const r = checkedPty(`${ROOT}/bin/zagent --cwd ${ws}`, [
          { delay: 10, text: prompt }, { delay: 12, text: '\r' }, { delay: 35, text: '' },
        ], ws, 50000);
        observe({ name: b.name, prompt, answered: hasReply(r.output, prompt), crashed: false });
        break;
      }
      case 'typo_then_correct': {
        const typo = pick(b.typos);
        const correct = typo.replace(/helo|waht|plese|yuo|recursionn/, m =>
          ({ helo: 'hello', waht: 'what', plese: 'please', yuo: 'you', recursionn: 'recursion' }[m] || m));
        const r = checkedPty(`${ROOT}/bin/zagent --cwd ${ws}`, [
          { delay: 10, text: typo }, { delay: 11, text: '\x15' }, // Ctrl+U clears line
          { delay: 12, text: correct }, { delay: 14, text: '\r' }, { delay: 35, text: '' },
        ], ws, 50000);
        observe({ name: b.name, typo, correct, survived: !/error|crash/i.test(r.output) });
        break;
      }
      case 'ctrl_c_interrupt': {
        const r = checkedPty(`${ROOT}/bin/zagent --cwd ${ws}`, [
          { delay: 10, text: 'write a long essay about AI' }, { delay: 12, text: '\r' },
          { delay: 18, text: '\x03' }, // Ctrl+C
          { delay: 25, text: '' },
        ], ws, 40000);
        const alive = /zagent|Ask a task|ZCODE|zai\//.test(r.output.slice(-500)); // TUI still alive after interrupt
        observe({ name: b.name, survived: alive, cleanInterrupt: !/panic|fatal|uncaught/i.test(r.output) });
        break;
      }
      case 'rapid_fire': {
        const prompts = ['1+1', '2+2', '3+3'];
        const inputs = prompts.map((p, i) => ({ delay: 10 + i * 3, text: p }));
        inputs.push({ delay: 10 + prompts.length * 3, text: '\r' });
        inputs.push({ delay: 40, text: '' });
        const r = checkedPty(`${ROOT}/bin/zagent --cwd ${ws}`, inputs, ws, 55000);
        observe({ name: b.name, survived: !/crash|fatal|panic/i.test(r.output) });
        break;
      }
      case 'wrong_command': {
        const cmd = pick(b.cmds);
        const r = checkedPty(`${ROOT}/bin/zagent --cwd ${ws}`, [
          { delay: 10, text: cmd }, { delay: 12, text: '\r' }, { delay: 20, text: '' },
        ], ws, 35000);
        observe({ name: b.name, cmd, survived: /zagent|Ask a task|ZCODE|zai\//.test(r.output.slice(-300)) });
        break;
      }
      case 'slash_commands': {
        const cmd = pick(b.cmds);
        const r = checkedPty(`${ROOT}/bin/zagent --cwd ${ws}`, [
          { delay: 10, text: cmd }, { delay: 13, text: '\r' }, { delay: 20, text: '' },
        ], ws, 35000);
        observe({ name: b.name, cmd, survived: /zagent|Ask a task|ZCODE|zai\//.test(r.output.slice(-300)) });
        break;
      }
      case 'paste_multiline': {
        const r = checkedPty(`${ROOT}/bin/zagent --cwd ${ws}`, [
          { delay: 10, text: '\x1b[200~line one\nline two\x1b[201~' },
          { delay: 12, text: '\x15' }, { delay: 14, text: '/help\r' },
        ], ws, 30000);
        observe({ name: b.name, survived: /line one|line two/.test(r.output) });
        break;
      }
      case 'idle_session': {
        const r = checkedPty(`${ROOT}/bin/zagent --cwd ${ws}`, [{ delay: 25, text: '' }], ws, 35000);
        observe({ name: b.name, idleOk: /zagent|Ask a task|ZCODE/.test(r.output) });
        break;
      }
      case 'headless_json': {
        const prompt = pick(b.prompts);
        const r = checkedSpawn('node', [`${ROOT}/packages/cli/zagent.mjs`, '-p', prompt, '--json'],
          { cwd: ws, encoding: 'utf8', timeout: 60000, maxBuffer: 32e6 });
        observe({ name: b.name, prompt, gotOutput: !!response(r), exitCode: r.status });
        break;
      }
      case 'quota_and_sessions': {
        const q = checkedSpawn('node', [`${ROOT}/bin/zagent-quota`, 'reset'], { encoding: 'utf8', timeout: 30000 });
        observe({ name: 'zz quota', worked: /200|code.*0/.test(q.stdout ?? '') });
        break;
      }
      case 'corrupt_input': {
        const garbage = String.fromCharCode(...Array.from({ length: 20 }, () => randInt(0x80, 0xFF)));
        const r = checkedPty(`${ROOT}/bin/zagent --cwd ${ws}`, [
          { delay: 10, text: garbage }, { delay: 12, text: '\r' }, { delay: 20, text: '' },
        ], ws, 35000);
        observe({ name: b.name, survived: !/panic|fatal|uncaught/i.test(r.output) });
        break;
      }
      case 'exit_and_resume': {
        const r1 = checkedSpawn('node', [`${ROOT}/packages/cli/zagent.mjs`, '-p', 'Remember: color=blue', '--json'],
          { cwd: ws, encoding: 'utf8', timeout: 60000, maxBuffer: 32e6 });
        const r2 = checkedSpawn('node', [`${ROOT}/packages/cli/zagent.mjs`, '-p', 'What color?', '-c', '--json'],
          { cwd: ws, encoding: 'utf8', timeout: 60000, maxBuffer: 32e6 });
        observe({ name: b.name, first: !!response(r1), resumed: /blue/i.test(response(r2)) });
        break;
      }
      default: throw new Error(`unimplemented behavior: ${b.name}`);
    }
    assert(observed, 'behavior had no assertions');
  } catch (e) {
    crash = true;
    emit('behavior', { name: b.name, crashed: true, error: e.message?.slice(0, 100) });
  }
  rmSync(ws, { recursive: true, force: true });
  return { name: b.name, wallMs: Date.now() - t0, crash, pass: !crash };
}

function ptyCmd(cmd, inputs, cwd, timeoutMs, env) {
  let prev = 0;
  const seq = inputs.map(({ delay, text }) => {
    const gap = Math.max(0, Math.round(delay - prev)); prev = delay;
    const esc = text.replace(/'/g, "'\\''").replace(/\r/g, '\\r').replace(/\x03/g, '\\x03').replace(/\x15/g, '\\x15');
    return `sleep ${gap}; printf '%b' '${esc}'`;
  }).join('; ');
  const full = `(${seq}; printf '\\003'; sleep 1; printf '\\003') | timeout ${Math.floor(timeoutMs / 1000)} script -qefc "${cmd}" /dev/null`;
  const r = spawnSync('bash', ['-c', full], { cwd, env, encoding: 'utf8', timeout: timeoutMs + 5000, maxBuffer: 64e6 });
  return { output: r.stdout ?? '', exitCode: r.status, error: r.error };
}

// --- Main: run N random behaviors ---
export function summarizeBehaviors(results) {
  const survived = results.filter(r => r.pass === true).length;
  return { rounds: results.length, survived, crashed: results.length - survived,
    rate: results.length ? Math.round(survived / results.length * 100) : 0 };
}

function main() {
  assert(Number.isInteger(rounds) && rounds > 0, '--rounds must be a positive integer');
  const sandbox = createSandbox();
  const cleanup = () => sandbox.cleanup();
  const interrupt = () => { cleanup(); process.exit(130); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const results = [];
    for (let i = 0; i < rounds; i++) {
      const b = pick(BEHAVIORS);
      log('round', { i: i + 1, total: rounds, behavior: b.name });
      results.push(runBehavior(b, { env: sandbox.env }));
    }
    const summary = summarizeBehaviors(results);
    log('final', summary);
    const outPath = path.join(RESULTS_DIR, `random-${Date.now()}.jsonl`);
    writeFileSync(outPath, events.map(e => JSON.stringify(e)).join('\n') + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ ...summary, resultsFile: outPath }));
    process.exitCode = summary.crashed ? 1 : 0;
  } finally {
    cleanup();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(`random-user failed: ${error.message}`); process.exitCode = 1; }
}
