#!/usr/bin/env node
// TUI boot probe (W1e): does the zagent TUI boot past the 3.12.1 app-server
// credential/provider gate? Captures the boot screen, then submits one trivial
// turn and classifies the outcome. A quota-class error is UNBLOCKED — it proves
// the provider resolved and authenticated; provider_not_found or a sign-in
// wall is the credential-gate defect. Quota-free at boot level, so it is the
// reusable check for the 3.12.x sign-in gate even when the 5h window is full.
// Exits 0 on GREEN/UNBLOCKED, 1 on FAIL/STALL/UNCLEAR.
//
//   node bench/tui-boot-probe.mjs                 # installed runtime
//   ZCODE_RUNTIME=/path/to/zcode.cjs node bench/tui-boot-probe.mjs   # explicit kernel
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayTerminal } from '../packages/tui/screen-replay.mjs';
import { shQuote } from './proc.mjs';
import { findRuntime } from '../packages/driver/runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = findRuntime();
console.log('runtime:', runtime ? `${runtime.kind} ${runtime.version ?? '?'} -> ${runtime.entry}` : 'NONE');
const outDir = mkdtempSync(path.join(os.tmpdir(), 'zagent-tui-boot-'));
console.log('screens:', outDir);
const entry = path.join(root, 'packages', 'cli', 'zagent.mjs');
const child = spawn('script', ['-qfec', `stty rows 24 cols 80; node ${shQuote(entry)}`, '/dev/null'], {
  env: { ...process.env, TERM: 'xterm-256color' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let raw = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', d => { raw += d; });
child.stderr.on('data', d => { raw += d; });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// scrollback + visible screen is what a person sees; the bounded model parses
// the DECSTBM stream the pinned writer emits (this pty is 0x0 under script(1),
// so the app clamps to 80x24 — the geometry modeled here).
const view = (text) => {
  const t = replayTerminal(text, { columns: 80, rows: 24 });
  return [...t.scrollback, ...t.screen].join('\n').replace(/\s+$/, '');
};

const promptText = 'reply with the single word PONG';
let boot = '', after = '';
try {
  await sleep(12000);
  boot = view(raw);
  writeFileSync(path.join(outDir, 'boot.txt'), boot);
  console.log('=== BOOT SCREEN (12s) ==='); console.log(boot);

  // submit one trivial turn — classify the error (quota-class = provider resolved)
  child.stdin.write(promptText);
  await sleep(600);
  child.stdin.write('\r');
  await sleep(45000);
  after = view(raw);
  writeFileSync(path.join(outDir, 'turn.txt'), after);
  console.log('=== SCREEN AFTER TURN (45s) ==='); console.log(after);

  child.stdin.write('\x03'); await sleep(400); child.stdin.write('\x03'); await sleep(800);
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(r => child.once('exit', r)),
    sleep(1500).then(() => child.kill('SIGKILL')),
  ]);
} finally {
  try { child.kill('SIGKILL'); } catch {}
}

// The echoed prompt itself contains "PONG", so classify on the body with the
// echo stripped: an echo starts on a `> ` (or boxed `│ > `) line whose text is
// prompt text, and continues while following lines are still prompt text —
// bounded to the echo's wrap count so a bare "PONG" reply right after the echo
// is not itself stripped.
let echoing = 0;
const body = after.split('\n').filter((l) => {
  const text = l.replace(/^[^>]*>\s*/, '').trim();
  const echoText = text !== '' && promptText.includes(text);
  if (/>\s/.test(l.slice(0, 4)) && echoText) { echoing = 3; return false; }
  if (echoing-- > 0 && echoText) return false;
  echoing = 0;
  return true;
}).join('\n');
const verdict =
  /provider_not_found|provider not found/i.test(after) ? 'FAIL: provider_not_found (registry still empty — credential gate not resolved)'
  : /No model access configured|Run \/login to sign in/i.test(after) ? 'STALL: sign-in wall (account-provider credential gate)'
  : /error: Turn execution failed|quota|exhausted|rate.?limit|1308|1113|1302|limit reached|try again/i.test(body) ? 'UNBLOCKED: provider resolved; turn failed on quota/runtime, not the credential gate'
  : /\bPONG\b/.test(body) ? 'GREEN: turn completed'
  : /error|failed/i.test(body) ? 'UNBLOCKED? (non-provider error — inspect screen)'
  : `UNCLEAR — inspect ${outDir}/*.txt`;
console.log('VERDICT:', verdict);
process.exit(/^(GREEN|UNBLOCKED)/.test(verdict) ? 0 : 1);
