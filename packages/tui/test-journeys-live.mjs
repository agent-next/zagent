#!/usr/bin/env node
// J3 / J4 / J7 — the LIVE halves of the human-journey suite
// (the journey contract, §10). Real binary, real PTY, real
// model turns: a runtime, a credential, and quota are all required, so these
// NEVER run in the commit gate. Opt in:
//
//   ZAGENT_LIVE=1 node packages/tui/test-journeys-live.mjs
//
// Quota guard: the suite first asks `zagent quota --json` and SKIPS LOUDLY when
// the 5-hour window is above 90% — a saturated plan window is exactly the case
// this exists for. Each live turn is account spend.
//
// HOME is a throwaway seeded from the real config (the seeded-sandbox contract
// shared by the live checks): a journey may answer a /model prompt and must never
// mutate the developer's real ~/.zcode.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, copyFileSync, chmodSync, existsSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runJourney, KEY } from './journey.mjs';
import { defaultCredentialSecret } from '../driver/credentials.mjs';

if (process.platform === 'win32') { console.log('SKIP live journeys: needs a POSIX pty (script(1))'); process.exit(0); }
if (process.env.ZAGENT_LIVE !== '1') { console.log('SKIP live journeys: opt in with ZAGENT_LIVE=1 (they spend real quota)'); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ZAGENT = path.join(ROOT, 'bin', 'zagent');
const quote = v => "'" + v.replaceAll("'", "'\\''") + "'";
const TUI_CMD = `${quote(process.execPath)} ${quote(ZAGENT)}`;

// The sandbox seeds from the real config; test-all.mjs --live sandboxes HOME,
// so it forwards the real home as ZAGENT_SEED_HOME.
const SEED_HOME = process.env.ZAGENT_SEED_HOME ?? os.homedir();
// The kernel's store root is ZCODE_DATA_BASE_DIR || HOME — seed from wherever
// the real store actually lives, not always <home>/.zcode.
const SEED_ROOT = process.env.ZCODE_DATA_BASE_DIR?.trim() || SEED_HOME;
const SANDBOX_HOME = mkdtempSync(path.join(os.tmpdir(), 'zjourney-home-'));
try { symlinkSync(`${SEED_HOME}/.local`, `${SANDBOX_HOME}/.local`); } catch {}
try {
  mkdirSync(`${SANDBOX_HOME}/.zcode/cli`, { recursive: true });
  // device.json too: the kernel resolves machine identity from it (or
  // ZCODE_DEVICE_MID) and a sandbox without one is a stranger device.
  for (const f of ['config.json', 'device.json']) {
    const src = `${SEED_ROOT}/.zcode/cli/${f}`;
    if (existsSync(src)) {
      copyFileSync(src, `${SANDBOX_HOME}/.zcode/cli/${f}`);
      chmodSync(`${SANDBOX_HOME}/.zcode/cli/${f}`, 0o600);
    }
  }
} catch { /* no real config — a live suite without a credential fails its oracles, loudly */ }
// 3.12.x kernels gate the TUI on the v2 credential store (the account-provider:*
// records the provisioner writes). A sandbox holding only cli/config.json hits
// the sign-in wall — J3/J4 fail on "No model access configured" while the
// headless journeys pass on the cli key alone. Seed the v2 identity files too;
// copies, never symlinks, so a journey can never write back into the real store.
try {
  mkdirSync(`${SANDBOX_HOME}/.zcode/v2`, { recursive: true });
  for (const f of ['config.json', 'credentials.json', 'provider_config.json']) {
    const src = `${SEED_ROOT}/.zcode/v2/${f}`;
    try {
      if (existsSync(src)) {
        copyFileSync(src, `${SANDBOX_HOME}/.zcode/v2/${f}`);
        chmodSync(`${SANDBOX_HOME}/.zcode/v2/${f}`, 0o600);
      }
    } catch { /* a partial seed fails the oracles loudly — same as no store */ }
  }
} catch { /* older hosts have no v2 store — pre-3.12 kernels never needed one */ }
// The kernel's store root is ZCODE_DATA_BASE_DIR || HOME (then /.zcode), so an
// ambient ZCODE_DATA_BASE_DIR would bypass the sandboxed HOME entirely — the
// kernel would read AND write the real ~/.zcode/v2. Pin it into the sandbox.
// ZCODE_CREDENTIAL_SECRET must be pinned to the SEED's secret too: the enc:v1
// fallback is platform:homedir:user, and inside the sandbox homedir is the tmp
// dir — an unpinned child cannot decrypt the copied credentials.json (the wall
// returns on hosts whose v2 authority is that store rather than the plaintext
// keys in v2/config.json). defaultCredentialSecret() runs in THIS process, so
// os.homedir() is the real home the store was encrypted under.
// SIGKILL leaves the mkdtemp dir behind (exit handler can't run); 0600 copies
// bound the residue to same-uid reads, as with cli/config.json above.
const LIVE_ENV = {
  HOME: SANDBOX_HOME,
  ZCODE_DATA_BASE_DIR: SANDBOX_HOME,
  ZCODE_CREDENTIAL_SECRET: process.env.ZCODE_CREDENTIAL_SECRET ?? defaultCredentialSecret(),
};
process.on('exit', () => { try { rmSync(SANDBOX_HOME, { recursive: true, force: true }); } catch {} });

// No reachable credential means every oracle below can only fail — skip loudly,
// like the gate's other live-runtime tests do on a machine without the install.
// 3.12.x kernels gate the TUI on the v2 store, so a v2-only credential counts.
if (!existsSync(`${SANDBOX_HOME}/.zcode/cli/config.json`)
    && !existsSync(`${SANDBOX_HOME}/.zcode/v2/credentials.json`)
    && !process.env.ZAI_API_KEY) {
  console.log('SKIP live journeys: no credential (no ~/.zcode cli/config.json or v2/credentials.json, no ZAI_API_KEY)');
  process.exit(0);
}

// -- quota guard -------------------------------------------------------------
const q = spawnSync(process.execPath, [ZAGENT, 'quota', '--json'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...LIVE_ENV } });
try {
  const report = JSON.parse(q.stdout);
  const pools = Array.isArray(report?.pools) ? report.pools : [];
  // Same predicate bin/zagent-quota uses for the rolling 5-hour window.
  const window = pools.find(p => (p?.type === 'TOKENS_LIMIT' || p?.type === 'CREDIT_LIMIT') && p?.unit === 3 && p?.number === 5);
  if (Number.isFinite(window?.usedPercent) && window.usedPercent > 90) {
    console.log(`SKIP live journeys: 5-hour window at ${window.usedPercent}% (>90%) — do not spend a congested window on tests`);
    process.exit(0);
  }
} catch {
  console.log('warn: quota --json unreadable — running anyway (ZAGENT_LIVE was explicit)');
}

let pass = 0, fail = 0;
function ok(cond, msg) { if (!cond) throw new Error(msg); }
async function journey(name, fn) {
  try { await fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).slice(0, 300).replace(/\n/g, ' | ')); }
}
const headless = (args, opts = {}) =>
  spawnSync(process.execPath, [ZAGENT, ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 64e6, env: { ...process.env, ...LIVE_ENV }, ...opts });

// -- J3: ask a question -------------------------------------------------------
await journey('J3 TUI: a typed question gets a real answer', async () => {
  const r = await runJourney({
    command: TUI_CMD, entryMatch: 'bin/zagent', marker: null, env: LIVE_ENV, timeoutMs: 120000,
    // The answer must not be a substring of the prompt — the echoed keystrokes
    // and the committed user entry both land in the raw stream.
    script: ['What is the capital of France? One word.', KEY.enter, 45000, '/exit', KEY.enter],
  });
  for (const p of r.invariants) throw new Error(`invariant ${p.id}: ${p.detail}`);
  ok(/Paris/i.test(r.raw), 'the model answer never reached the screen');
  ok(r.exitCode === 0 && !r.forced, `did not leave cleanly (code ${r.exitCode}, forced=${r.forced})`);
});

await journey('J3 headless: -p --json prints a parseable envelope', async () => {
  const r = headless(['-p', 'Reply with exactly: pong', '--json']);
  ok(r.status === 0, `exit ${r.status}: ${(r.stderr ?? '').slice(0, 160)}`);
  const env = JSON.parse(r.stdout); // a parse failure is the finding
  ok(env && typeof env === 'object', 'stdout was not a JSON object');
});

// -- J4: edit -> diff -> undo --------------------------------------------------
await journey('J4 edit, /diff, /undo restores the workspace', async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'zjourney-j4-'));
  try {
    const r = await runJourney({
      command: TUI_CMD, entryMatch: 'bin/zagent', marker: null, env: LIVE_ENV, cwd: ws, timeoutMs: 300000,
      // Sync on screen content, not the clock: a congested turn can retry for
      // minutes, and fixed sleeps used to end the script mid-turn (stuck-activity
      // flake). `raw` is cumulative, so a waitFor must name a marker that cannot
      // already be in the stream: the card's `needs permission` title for the
      // prompt (the typed echo never contains it), then the rendered `+hi` hunk
      // for the landed edit. Each Enter answers a showing card or no-ops on an
      // empty input — the second one covers a possible follow-up card.
      script: ['Create hello.txt containing exactly: hi', KEY.enter,
               { waitFor: /needs permission/, timeoutMs: 150000 }, KEY.enter,
               KEY.enter, { waitFor: /\+hi\b/, timeoutMs: 90000 }, 15000,
               '/diff', KEY.enter, 8000, '/undo', KEY.enter, 3000, 'y', KEY.enter, 3000, '/exit', KEY.enter],
    });
    for (const p of r.invariants) throw new Error(`invariant ${p.id}: ${p.detail}`);
    // The card rendering alone must NOT satisfy this journey: on the options-less
    // 3.12.1 shape a Deny-only card paints `needs permission` and the edit never
    // happens — exactly the regression this oracle exists to catch. Require the
    // `+hi` hunk (edit landed) plus a clean, unforced exit.
    ok(/needs permission|\+hi\b/.test(r.raw), 'no permission card or edit render — the edit likely never happened');
    ok(/\+hi\b/.test(r.raw), 'the edit never landed (no +hi hunk) — denied tool or a permission regression');
    ok(r.exitCode === 0 && !r.forced, `did not leave cleanly (code ${r.exitCode}, forced=${r.forced})`);
    ok(!existsSync(path.join(ws, 'hello.txt')), 'hello.txt survived /undo');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// -- J4b: the 'Allow always' reply shape ----------------------------------------
// A fix synthesized a second option on the options-less 3.12.1 card whose
// response is {decision:'allow', permissionUpdates:<host suggestions>} — never
// exercised live before. Digit '2' picks it; the kernel accepting the
// shape is proven by the edit actually landing, same oracle as J4.
await journey("J4b permission: 'Allow always' reply shape is accepted", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'zjourney-j4b-'));
  try {
    // Selection attribution is scoped to THIS journey: snapshot the grant store
    // before the run so an allow_always record left by an earlier journey (J4
    // shares this SANDBOX_HOME) cannot satisfy the delta assertion below.
    const grantsPath = `${SANDBOX_HOME}/.zcode/cli/grants.json`;
    const readGrants = () => {
      try { return JSON.parse(readFileSync(grantsPath, 'utf8'))?.grants ?? {}; }
      catch { return {}; }
    };
    const grantsBefore = new Set(Object.keys(readGrants()));
    const r = await runJourney({
      command: TUI_CMD, entryMatch: 'bin/zagent', marker: null, env: LIVE_ENV, cwd: ws, timeoutMs: 300000,
      // '2' selects the second option — the synthesized 'Allow always' — whose
      // reply carries permissionUpdates. Gate the digit on the label itself:
      // a card without suggestedPermissionUpdates renders [Allow once, Deny]
      // where '2' denies — the correct loud fail for a missing always-option.
      // The card title localizes (需要授权), so the label is the only wait —
      // 'Allow always' is hardcoded English in the synthesized options.
      // A Write-for-new-file renders 'File created successfully', NOT a diff
      // hunk (J4 sees +hi only because its /diff step paints it); a Bash-side
      // create renders differently again, so the waitFor only paces — the
      // landed-oracle is the file on disk.
      script: ['Create hello.txt containing exactly: hi', KEY.enter,
               { waitFor: /Allow always/, timeoutMs: 150000 }, '2',
               KEY.enter, { waitFor: /File created successfully|\+hi\b/, timeoutMs: 90000 }, 10000,
               '/exit', KEY.enter],
    });
    for (const p of r.invariants) throw new Error(`invariant ${p.id}: ${p.detail}`);
    ok(r.exitCode === 0 && !r.forced, `did not leave cleanly (code ${r.exitCode}, forced=${r.forced})`);
    ok(existsSync(path.join(ws, 'hello.txt')), 'hello.txt missing — the allow reply did not run the tool');
    // Selection attribution: '2' resolving silently + the covering Enter would
    // otherwise pass this journey on the options[0] allow_once reply — never
    // sending the shape under test. rememberGrant persists ONLY always-style
    // option ids, so a NEW allow_always record in the sandbox store proves the
    // always option was picked; file-on-disk proves its reply was accepted.
    // The grant is keyed by tool+fingerprint of THIS ws path — it cannot
    // auto-answer a later journey's request.
    const picked = Object.entries(readGrants()).some(([k, g]) => !grantsBefore.has(k) && g?.optionId === 'allow_always');
    ok(picked, "no allow_always grant recorded — '2' did not pick the always option (reply shape never sent)");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// -- J7: headless ergonomics ---------------------------------------------------
await journey('J7 -p --json, stdin prompt, and -c continuation', async () => {
  // `-c` continues the MOST RECENT session in the cwd-keyed project — with every
  // journey sharing the suite's cwd it used to land on a J3 session, and recall
  // could also false-pass through the global memory index. A fresh project dir
  // plus a per-run codeword plus sessionId equality make the oracle exact:
  // continuation must land IN the codeword session and remember it.
  const ws = mkdtempSync(path.join(os.tmpdir(), 'zjourney-j7-'));
  try {
    const b = headless(['-p', 'Reply with exactly: pong'], { cwd: ws });
    ok(b.status === 0, `headless turn exit ${b.status}: ${(b.stderr ?? '').slice(0, 160)}`);

    const word = `wobble${Math.random().toString(36).slice(2, 8)}`;
    const a = headless(['-p', `Remember this codeword: ${word}. Reply with exactly: ok`, '--json'], { cwd: ws });
    ok(a.status === 0, `first turn exit ${a.status}: ${(a.stderr ?? '').slice(0, 160)}`);
    const sa = JSON.parse(a.stdout).sessionId;
    ok(typeof sa === 'string' && sa.startsWith('sess_'), 'no sessionId in the -p --json envelope');

    const c = headless(['-p', 'What codeword did I ask you to remember? One word.', '-c', '--json'], { cwd: ws });
    ok(c.status === 0, `continuation exit ${c.status}: ${(c.stderr ?? '').slice(0, 160)}`);
    const ce = JSON.parse(c.stdout);
    ok(ce.sessionId === sa, `-c continued ${ce.sessionId}, expected ${sa}`);
    ok(new RegExp(word, 'i').test(String(ce.response ?? '')), 'the continued session did not remember the codeword');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

console.log('\n' + pass + '/' + (pass + fail) + ' live journeys passed');
process.exit(fail ? 1 : 0);
