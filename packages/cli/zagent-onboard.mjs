#!/usr/bin/env node
// zagent onboard — E8 first-run UX: one command that proves the whole chain works.
// doctor-style checks + ONE live smoke turn (runtime -> config -> API key -> answer) with
// elapsed time, then next-step guidance. Exit 0 only if the chain is proven.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { codingPlanStatus } from '../driver/quota.mjs';
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))); // file -> cli -> packages -> repo

export function smokeSucceeded(s) {
  if (s?.error || s?.status !== 0) return false;
  try { return String(JSON.parse(s.stdout ?? '').response ?? '').trim() === 'OK'; }
  catch { return false; }
}

// `zagent login` (kernel OAuth) keeps its credential in the v2 store — the
// kernel authenticates from it directly, so an OAuth'd user can pass the
// smoke turn even when no Coding Plan key resolves. Same predicate as
// zagent.mjs's oauthSignedIn.
export function oauthSignedIn(home = os.homedir()) {
  try {
    const s = JSON.parse(readFileSync(`${home}/.zcode/v2/credentials.json`, 'utf8'));
    return typeof s['oauth:zai:access_token'] === 'string' && s['oauth:zai:access_token'] !== '';
  } catch { return false; }
}

// A rejected key makes the kernel burn the whole smoke turn (tens of seconds,
// up to the timeout) before failing with an opaque Turn-execution-failed.
// The monitor probe classifies the failure fast (15s bound), so a bad or
// missing key fails with sign-in guidance instead of a stall. Fatality is
// conservative: auth is certain-fail only with no OAuth credential behind it
// (the kernel may authenticate from its own store), and limit only on the
// provider's business codes — a bare HTTP 429 on the read-only monitor can be
// request rate-limiting while inference still works.
export async function preflightCredential({ probe = codingPlanStatus, oauth = oauthSignedIn } = {}) {
  let status;
  try {
    status = await probe();
  } catch (e) {
    const cls = e?.quotaClass;
    const fatal = (cls === 'auth' && !oauth())
      || (cls === 'limit' && (e?.quotaCode === 1308 || e?.quotaCode === 1113));
    return { ok: false, fatal, message: e?.message ?? String(e) };
  }
  if (!status || typeof status !== 'object')
    return { ok: false, fatal: false, message: 'credential probe returned no status' };
  return { ok: true, keySource: status.keySource ?? null, plan: status.plan?.name ?? null };
}

export async function runOnboard({ spawnImpl = spawnSync, probeImpl, oauthImpl } = {}) {
  const t0 = Date.now();
  const d = spawnImpl(process.execPath, [`${ROOT}/packages/cli/zagent.mjs`, 'doctor'], { encoding: 'utf8', timeout: 30000 });
  const doctorOut = (d.stdout ?? '') + (d.stderr ?? '');
  console.log(doctorOut.trim());
  if (d.status !== 0) { console.error('\nonboard: fix the doctor findings above first (runtime install or API key).'); return 1; }
  if (/warn:/.test(doctorOut)) console.error('onboard: warning above — config may be degraded (see doctor).');

  const pre = await preflightCredential({ probe: probeImpl, oauth: oauthImpl });
  if (pre.fatal) { console.error(`\nonboard: ${pre.message}`); return 1; }
  if (pre.ok) console.log(`\nonboard: credential accepted${pre.keySource ? ` (key source: ${pre.keySource}${pre.plan ? `, plan "${pre.plan}"` : ''})` : ''}.`);
  else console.error(`\nonboard: credential probe inconclusive (${pre.message}) — continuing to the live smoke turn.`);

  console.log('\nonboard: running one live smoke turn (expects the single word OK)...');
  const t1 = Date.now();
  const s = spawnImpl(process.execPath, [`${ROOT}/packages/cli/zagent.mjs`, '-p', 'Reply with exactly: OK', '--json'], { encoding: 'utf8', timeout: 200000, maxBuffer: 64e6 });
  const smokeMs = Date.now() - t1;
  if (!smokeSucceeded(s)) {
    console.error(`onboard: smoke turn FAILED after ${(smokeMs / 1000).toFixed(1)}s (rc ${s.status})${(s.stderr ?? '').trim() ? ' — ' + String(s.stderr).trim().slice(-160) : ''}`);
    return 1;
  }
  console.log(`onboard: smoke turn answered OK in ${(smokeMs / 1000).toFixed(1)}s (total ${( (Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log('\nYou are set up:\n  zagent          interactive TUI\n  zagent -p "…"   headless one-shot\n  zagent diff     file-change history\n  zagent quota    balance / resets');
  return 0;
}

const isMain = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(path.resolve(process.argv[1] ?? ''))).href; }
  catch { return false; }
})();
// Any arg is a typo — 'onboard bogus' used to run the live smoke turn anyway.
if (isMain && process.argv.length > 2) {
  console.error('usage: zagent onboard');
  process.exit(2);
}
if (isMain) runOnboard()
  .then(code => process.exit(code))
  .catch(e => { console.error(`onboard: ${e?.message ?? e}`); process.exit(1); });
