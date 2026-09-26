#!/usr/bin/env node
// First-run sign-in card under a real PTY: EOF/decline must exit quietly —
// never an uncaught TypeError stack on screen. Reproduces the installed
// 0.0.215 defect: rl.question resolves undefined on early close and a bare
// .trim() crashed the card. POSIX-only (script(1) pty), like the TUI journeys.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') { console.log('SKIP sign-in card: needs a POSIX pty (script(1))'); process.exit(0); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(root, 'bin', 'zagent');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const ok = (cond, name) => { cond ? passed++ : failed++; console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`); };

async function cardRun({ keys = [], env = {} } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'zagent-signin-'));
  // The card sits behind the runtime gate (no runtime → doctor report, not the
  // card). findRuntime only checks the file exists, so a stub reaches it.
  const stubRuntime = path.join(home, 'stub-runtime.cjs');
  writeFileSync(stubRuntime, '// test stub: existence is all the gate checks\n');
  const quote = (v) => `'${v.replaceAll("'", "'\\''")}'`;
  const cmd = `${quote(process.execPath)} ${quote(BIN)}`;
  // util-linux script(1): `-qfec` propagates the child's exit status. BSD
  // script(1) on macOS knows neither flag — it execvp's the command words and
  // always exits 0, so the child reports its own status over the pty instead.
  const darwin = process.platform === 'darwin';
  const child = spawn('script',
    darwin ? ['-q', '/dev/null', '/bin/sh', '-c', `${cmd}; printf '\\nSGNEXIT:%d\\n' "$?"`]
           : ['-qfec', cmd, '/dev/null'], {
    env: { ...process.env, ...env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home,
           ZCODE_RUNTIME: stubRuntime, TERM: 'xterm-256color', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let raw = '';
  child.stdout.on('data', (d) => { raw += d; });
  child.stderr.on('data', (d) => { raw += d; });
  // A leg that exits early (Esc-cancel) leaves later keys writing to a dead
  // pty — EPIPE is expected there, not a test fault.
  child.stdin.on('error', () => {});
  const exit = new Promise((r) => child.on('exit', (code) => r(code)));
  await sleep(2500);                       // let the card paint + the question bind
  for (const k of keys) {
    if (child.exitCode !== null) break;    // already exited — don't poke a corpse
    child.stdin.write(k);
    await sleep(700);
  }
  let code = await Promise.race([exit, sleep(8000).then(() => 'timeout')]);
  if (code === 'timeout') child.kill('SIGKILL');
  // BSD script exits 0 regardless — the real status is the marker the
  // command printed; a missing marker means the leg died before exiting.
  if (darwin && code !== 'timeout')
    code = Number(/SGNEXIT:(\d+)/.exec(raw)?.[1] ?? NaN);
  rmSync(home, { recursive: true, force: true });
  return { raw, code, home };
}

// EOF (ctrl+D) at the pick prompt — the 0.0.215 crash: rl.question resolves
// undefined, bare .trim() threw an uncaught TypeError with a stack on screen.
{
  const r = await cardRun({ keys: ['\x04'] });
  ok(r.raw.includes('choose a sign-in path'), 'the card renders on a credential-less home');
  ok(!/TypeError|Cannot read prop/.test(r.raw), 'ctrl+D at the card prints no stack (was the 0.0.215 crash)');
  ok(r.code === 2, `declining via EOF exits 2, quietly (got ${r.code})`);
}

// An unrecognized pick leaves quietly the same way.
{
  const r = await cardRun({ keys: ['9\r'] });
  ok(!/TypeError|Cannot read prop/.test(r.raw), 'an unrecognized pick prints no stack');
  ok(r.code === 2, `unrecognized pick exits 2 (got ${r.code})`);
}

// Picking quit (3) leaves quietly.
{
  const r = await cardRun({ keys: ['3\r'] });
  ok(!/TypeError|Cannot read prop/.test(r.raw), 'pick 3 prints no stack');
  ok(r.code === 2, `pick 3 exits 2 (got ${r.code})`);
}

// Pick 2 asks for a key; an empty paste declines and leaves quietly — and the
// prompt never echoes the pasted secret back.
{
  const r = await cardRun({ keys: ['2\r', 'sk-card-secret-xyz\r'] });
  ok(r.raw.includes('paste ZAI_API_KEY:'), 'pick 2 prompts for the key');
  ok(!/TypeError|Cannot read prop/.test(r.raw), 'pick 2 + pasted key prints no stack');
  ok(!r.raw.includes('sk-card-secret-xyz'), 'the pasted key is not echoed to the terminal');
}

// Esc is the chooser's cancel
// affordance — same quiet decline as EOF/pick-3. Pre-fix the 'escape'
// keypress had no listener and the screen sat identical until timeout.
{
  const r = await cardRun({ keys: ['\x1b'] });
  ok(r.raw.includes('choose a sign-in path'), 'the card rendered before Esc');
  ok(!/TypeError|Cannot read prop/.test(r.raw), 'Esc at the pick prompt prints no stack');
  ok(r.code === 2, `Esc at the pick prompt exits 2, quietly (got ${r.code})`);
}

// The escape parser also merges Esc+NAMED-KEY into one meta keypress
// (Esc+Enter → {name:'return',meta:true}, Esc+Space → {name:'space',meta:true}).
// readline swallows those — without the meta clause the screen goes dead. The
// cancel is the same quiet exit.
{
  const r = await cardRun({ keys: ['\x1b\r', 'x'] });
  ok(!/TypeError|Cannot read prop/.test(r.raw), 'Esc+Enter burst prints no stack');
  ok(r.code === 2, `Esc+Enter burst exits 2 (got ${r.code})`);
}
{
  const r = await cardRun({ keys: ['\x1b ', 'x'] });
  ok(r.code === 2, `Esc+Space burst exits 2 (got ${r.code})`);
}

// A same-burst '2\r\x1bw' closes rl between the '2' pick resolving
// and the second ask() binding — meta+w fires synchronously in the chunk (a
// trailing lone ESC would instead sit pending in the escape parser), so
// question() on the closed interface throws ERR_USE_AFTER_CLOSE; the ask
// guard resolves undefined instead. One write = one PTY read = the hazard.
{
  const r = await cardRun({ keys: ['2\r\x1bw'] });
  ok(!/USE_AFTER_CLOSE|TypeError|Cannot read prop/.test(r.raw), 'same-burst 2+Esc+char prints no stack');
  ok(r.code === 2, `same-burst 2+Esc+char exits 2 (got ${r.code})`);
}

// Esc+char struck inside node:readline's escape window arrives
// as ONE meta+char keypress — the 'w' never lands (pre-fix a fast 'world'
// after Esc left 'orld' on screen, answered as an unrecognized pick). The
// chooser treats the meta keypress as the same Esc-cancel: the process is
// already gone when the rest of the burst arrives, so 'orld' never echoes.
{
  const r = await cardRun({ keys: ['\x1bw', 'orld\r'] });
  ok(!/TypeError|Cannot read prop/.test(r.raw), 'Esc then fast input prints no stack');
  ok(!r.raw.includes('orld'), `Esc eats the burst — no 'orld' left on screen (raw has: ${r.raw.includes('orld')})`);
  ok(r.code === 2, `Esc+char exits 2 — the answer can never become 'orld' (got ${r.code})`);
}

// At the masked key paste: same cancel, still quiet.
{
  const r = await cardRun({ keys: ['2\r', '\x1b'] });
  ok(r.raw.includes('paste ZAI_API_KEY:'), 'pick 2 prompts for the key (Esc-cancel leg)');
  ok(!/TypeError|Cannot read prop/.test(r.raw), 'Esc at the key paste prints no stack');
  ok(r.code === 2, `Esc at the key paste exits 2, quietly (got ${r.code})`);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
