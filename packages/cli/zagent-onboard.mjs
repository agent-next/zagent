#!/usr/bin/env node
// zagent onboard — first-run UX: one command that proves the whole chain works.
// doctor-style checks + ONE live smoke turn (runtime -> config -> API key -> answer) with
// elapsed time, then next-step guidance. Exit 0 only if the chain is proven.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { codingPlanStatus } from '../driver/quota.mjs';
import { MODES, MODE_NOTES } from '../driver/session-control.mjs';
import { explainProviderError, formatProviderError } from '../driver/provider-errors.mjs';
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

// The smoke child reports failure three ways, in decreasing usefulness: a
// KNOWN provider business-error signature in stderr/stdout (classify it — an
// unknown [code][text] pair in a dump is not proof of a provider failure), the
// JSON envelope's `error` on stdout (print it), or kernel diagnostics on
// stderr — where a raw byte-tail lands mid-object ('e: false,\n  reason:
// undefined,…' read as garbage), so name an Error line instead. The kernel's
// opaque 'Error: Turn execution failed' wrapper yields to a real cause when
// one is present; it is used only when nothing better exists (its traceId is
// still the only supportable reference then).
export function smokeFailureDetail(s) {
  // A spawn failure or signal kill is the cause itself — classifying partial
  // output first would dress up a progress line as the reason. The header line
  // already names the mechanism; this adds the human explanation + next step.
  if (s?.error) return `the smoke turn could not start: ${s.error.message ?? s.error}`;
  if (s != null && s.status == null)
    return `the smoke turn was stopped by ${s.signal ?? 'a signal'} (timeout or provider/network stall) — retry, or check connectivity and sign-in state`;
  // Exit 0 without the exact 'OK' answer is a malformed-output failure — the
  // model replied but not as asked (e.g. '{"response":"OK."}'); say so.
  if (s?.status === 0) {
    let got;
    try { got = JSON.parse(s.stdout ?? '')?.response; } catch {}
    const shown = (got == null ? String(s.stdout ?? '').trim()
      : (typeof got === 'object' ? JSON.stringify(got) : String(got)))
      .slice(0, 120).replace(/\s+/g, ' ');
    return `the smoke turn exited 0 but did not answer exactly 'OK' (got: ${shown || 'empty output'})`;
  }
  // An 'unknown' verdict must not preempt the other stream — a dump fragment
  // like '[404][Not Found]' on stderr is not proof against a known 1308 on
  // stdout. Prefer the first KNOWN signature in stderr-then-stdout order.
  const explained = [s?.stderr, s?.stdout].map(explainProviderError).find(e => e && e.kind !== 'unknown');
  if (explained) return formatProviderError(explained);
  // Bound the input before splitting so a pathological stdout cannot amplify
  // into a giant array; drop a possibly-bisected first line — the envelope is
  // the last line anyway.
  const cut = String(s?.stdout ?? '').slice(-65536);
  const lines = cut.trim().split(/\r?\n/);
  if (cut.length === 65536 && lines.length > 1) lines.shift();
  for (const line of lines.reverse()) {
    try {
      const err = JSON.parse(line)?.error;
      // Only strings and objects carry a cause — 'false'/0 is a flag, and a
      // bare '{}' object would print as punctuation, not an explanation.
      if (err == null || (typeof err !== 'string' && typeof err !== 'object')) continue;
      const msg = String(typeof err === 'object' ? (err.message ?? JSON.stringify(err)) : err).trim();
      if (msg && msg !== '{}') return msg.slice(0, 300);
    } catch {}
  }
  const tail = String(s?.stderr ?? '').trim();
  if (!tail) return '';
  const GENERIC = /^Error: Turn execution failed\b/;
  const errLines = tail.match(/^[ \t]*[\w$.]*(?:Error|Exception)(?::| \[[\w$]+\]:)[^\n]*$/gm) ?? [];
  const errLine = errLines.map(l => l.trim()).filter(l => !GENERIC.test(l)).at(-1) ?? errLines.at(-1)?.trim();
  if (errLine) return errLine.slice(0, 300);
  // Last resort: the last substantive line — never a bare brace, stack frame,
  // or scalar dump fragment ('key: undefined,', 'e: false,', "kind: 'x'," —
  // the T9 garbage class). A prose value like 'warn: low disk space' survives.
  const JUNK = /^(?:at\s|[{}\]),;]*$|.*:\s*(?:undefined|null|true|false|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"),?$)/;
  return (tail.split('\n').map(l => l.trim()).filter(l => l && !JUNK.test(l)).at(-1) ?? '').slice(0, 300);
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
    console.error(`onboard: smoke turn FAILED after ${(smokeMs / 1000).toFixed(1)}s (${s?.error ? 'could not start' : s.status == null ? `signal ${s.signal ?? '?'}` : `rc ${s.status}`})`);
    const detail = smokeFailureDetail(s);
    if (detail) console.error(detail);
    return 1;
  }
  console.log(`onboard: smoke turn answered OK in ${(smokeMs / 1000).toFixed(1)}s (total ${( (Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log('\nYou are set up:\n  zagent          interactive TUI\n  zagent -p "…"   headless one-shot\n  zagent diff     file-change history\n  zagent quota    balance / resets');
  // F14c: mode setup was flag-only knowledge — teach the choice at the moment
  // a new user finishes setup. Only the --mode-launchable modes are listed
  // ('auto' is a session/setMode-only value the runtime still denies).
  const modeLines = MODES.filter(m => m !== 'auto')
    .map(m => `  ${m.padEnd(6)} ${MODE_NOTES[m]}${m === 'yolo' ? ' (the -p default)' : ''}`);
  console.log(`\nPermission modes — pick inside the TUI with /mode, or launch with zagent --mode <name>:\n${modeLines.join('\n')}`);
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
