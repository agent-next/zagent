#!/usr/bin/env node
// zagent onboard — E8 first-run UX: one command that proves the whole chain works.
// doctor-style checks + ONE live smoke turn (runtime -> config -> API key -> answer) with
// elapsed time, then next-step guidance. Exit 0 only if the chain is proven.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))); // file -> cli -> packages -> repo

const t0 = Date.now();
const d = spawnSync(process.execPath, [`${ROOT}/packages/cli/zmax.mjs`, 'doctor'], { encoding: 'utf8', timeout: 30000 });
const doctorOut = (d.stdout ?? '') + (d.stderr ?? '');
console.log(doctorOut.trim());
if (d.status !== 0) { console.error('\nonboard: fix the doctor findings above first (runtime install or API key).'); process.exit(1); }
if (/warn:/.test(doctorOut)) console.error('onboard: warning above — config may be degraded (see doctor).');

console.log('\nonboard: running one live smoke turn (expects the single word OK)...');
const t1 = Date.now();
const s = spawnSync(process.execPath, [`${ROOT}/packages/cli/zmax.mjs`, '-p', 'Reply with exactly: OK', '--json'], { encoding: 'utf8', timeout: 200000, maxBuffer: 64e6 });
const smokeMs = Date.now() - t1;
let answered = false;
try { answered = JSON.parse(s.stdout ?? '').response?.includes('OK') ?? false; } catch {}
if (!answered) {
  console.error(`onboard: smoke turn FAILED after ${(smokeMs / 1000).toFixed(1)}s (rc ${s.status})${(s.stderr ?? '').trim() ? ' — ' + String(s.stderr).trim().slice(-160) : ''}`);
  process.exit(1);
}
console.log(`onboard: smoke turn answered OK in ${(smokeMs / 1000).toFixed(1)}s (total ${( (Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log('\nYou are set up:\n  zagent          interactive TUI\n  zagent -p "…"   headless one-shot\n  zagent diff     file-change history\n  zagent quota    balance / resets');
process.exit(0);
