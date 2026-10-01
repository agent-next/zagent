#!/usr/bin/env node
// Offline oracle for sandbox-teardown resilience — the ENOTEMPTY crash class.
// Incident 2026-09-18 17:15Z: the claude-lane flock's SIGTERM cleanup ran rmSandbox
// while a sandboxed process was still writing into the bound dir; rmSync
// threw ENOTEMPTY, the process.on handler had no guard, the throw became
// exit 1, and systemd restart-looped into start-limit — the lane sat dead
// ~13h. Two independent defects, two oracle families:
//   1. rmSync ran without maxRetries/retryDelay — the exact transient class
//      that option exists for (entries appearing between readdir and rmdir).
//   2. The signal handlers + oneRound's finally called rmSandbox unguarded —
//      one stubborn dir converted a clean stop (143/round record) into a
//      process crash (exit 1 / unhandled rejection).
// The e2e legs replay the incident for real: a stub claude-lane whose child churns
// files inside the bound sandbox while the flock's SIGTERM handler tears it
// down. The writer lives inside the bwrap pid-ns so it dies with the flock —
// a leaked churn dir is the test's own post-mortem rm, never a stray process.
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, chmodSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

// Lane-runtime suite: full flock rounds shell out to the real `opencode`
// worker runtime (usertest/swarm/opencode-flock.mjs -> `which opencode`).
// Skip loudly where it is not installed (CI containers), like the --live
// suites - the pure code-shape assertions return when the runner image
// gains the runtime (CI runner images lack the runtime today).
const lacks = (bin) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).status !== 0;
if (lacks('opencode') || lacks('bwrap')) {
  console.log(`skip (${lacks('opencode') ? 'lane runtime `opencode`' : 'bubblewrap `bwrap`'} not installed - flock rounds cannot run)`);
  process.exit(0);
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLOCK = path.join(root, 'usertest', 'swarm', 'opencode-flock.mjs');
const SRC = readFileSync(FLOCK, 'utf8');
const work = mkdtempSync(path.join(tmpdir(), 'flock-teardown-'));

const tests = [];
const test = (n, f) => tests.push([n, f]);

// A dependency-free npm package as the SUT — `npm install -g` of a local
// tarball is fully offline (same shape as test-flock-claude-lane.mjs).
const pkgDir = path.join(work, 'stub-pkg');
mkdirSync(pkgDir);
writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
  name: 'stub-sut', version: '0.0.0', bin: { zagent: 'zagent.js' },
}));
writeFileSync(path.join(pkgDir, 'zagent.js'), '#!/usr/bin/env node\nconsole.log("stub zagent");\n');
const tarball = path.join(work,
  execFileSync('npm', ['pack', '--quiet', '--pack-destination', work], { cwd: pkgDir, encoding: 'utf8' }).trim().split('\n').pop());

/** A claude-lane stub whose child churns NEW entries inside the bound sandbox (cwd
 *  === sbx) while the stub "works". burstMs 0 = churn until the wall dies
 *  (the incident shape: teardown races a live writer); >0 = the writer stops
 *  on its own so rmSync retries can recover mid-handler. New names on every
 *  write — rewrites of existing entries would leave rmdir's listing valid. */
function churnStub(burstMs) {
  const f = path.join(work, `claude-lane-churn-${tests.length}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(f, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'churning' }] } }));
const code = "const fs=require('fs'),p=require('path');" +
  "const d=p.join(process.cwd(),'churn');" +
  "const end=${burstMs ? `Date.now()+${burstMs}` : 'Infinity'};let i=0;" +
  "while(Date.now()<end){fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'n'+i),'x');" +
  "if(i%40===0)fs.mkdirSync(p.join(d,'sub'+(i%29)),{recursive:true});i++;}";
spawn(process.execPath, ['-e', code], { cwd: process.cwd(), stdio: 'ignore' });
setInterval(() => {}, 30000); // stay alive: the round must be in-flight at SIGTERM
`);
  chmodSync(f, 0o755);
  return f;
}

function spawnFlock(args, claudeLaneBin, extraEnv) {
  const flockDir = mkdtempSync(path.join(work, 'flockdir-'));
  const home = mkdtempSync(path.join(work, 'home-'));
  // A private TMPDIR namespaces this run's flock-* sandboxes — the standing
  // systemd flock is live on this host and names its dirs identically.
  const tmp = mkdtempSync(path.join(work, 'tmp-'));
  const env = { ...process.env, NODE_OPTIONS: '', TMPDIR: tmp, FLOCK_DIR: flockDir, HOME: home, USERPROFILE: home, ...extraEnv };
  if (claudeLaneBin) env.FLOCK_LANE_BIN = claudeLaneBin; // absent = production path (fail-closed)
  else delete env.FLOCK_LANE_BIN;
  for (const k of ['FLOCK_LANE_API_KEY', 'FLOCK_LANE_API_KEYS', 'FLOCK_LANE_KEY_CACHE', 'FLOCK_LANE_UPSTREAM', 'FLOCK_CLAUDE']) {
    if (!(extraEnv && k in extraEnv)) delete env[k];
  }
  const proc = spawn(process.execPath, [FLOCK, '--tarball', tarball, '--seed', '7', '--max-hours', '0.02', ...args], { env });
  let out = '', err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  return { proc, tmp, flockDir, out: () => out, err: () => err };
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

const close = (proc) => new Promise((r) => proc.on('close', r));
// SIGTERM once the in-wall churn is actually writing — the incident window.
// The 90s bound covers makeSandboxIn (npm install -g of the tarball inside
// bwrap) and is the dominant flake source on a loaded host — a timeout here
// is harness latency, not a product defect.
async function sigtermAtChurn(h) {
  const sbx = await waitFor(() =>
    readdirSync(h.tmp).find((d) => d.startsWith('flock-') && existsSync(path.join(h.tmp, d, 'churn'))), 90_000);
  assert.ok(sbx, `sandbox churn never appeared: out=${h.out()} err=${h.err()}`);
  h.proc.kill('SIGTERM');
  return path.join(h.tmp, sbx);
}
const leftoverRm = (dir) => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch {} };

// ---------- shape oracles (deterministic pre-fix discrimination) ----------

test('rmSandbox retries the WHOLE rm — rmSync maxRetries alone is proven insufficient', () => {
  // Verified empirically 2026-09-19: fs.rmSync's own maxRetries retries only
  // the failing rmdir syscall — entries a live writer creates during the
  // descent are never re-unlinked, so ENOTEMPTY survives all 8 native
  // retries (5.6s, 90k files left). The fix must re-run the whole rmSync.
  const body = SRC.match(/function rmSandbox\([^)]*\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(body, 'rmSandbox function not found');
  assert.match(body, /rmSync\(dir,\s*\{[^}]*recursive/, 'rmSandbox must keep the recursive rm');
  assert.match(body, /for \(|while \(/,
    'the rmSync call must sit inside a retry loop — the native maxRetries rmdir-only retry cannot clear a live writer');
  // The retry must key on the transient class (the codes const may live
  // above the function) — a blanket retry would spin on real errors.
  const window = SRC.slice(Math.max(0, SRC.indexOf('function rmSandbox') - 600));
  assert.match(window, /RM_RETRY_CODES\s*=\s*new Set\([^)]*ENOTEMPTY/,
    'the retry loop must key on a named transient-code set containing ENOTEMPTY (comment text must not satisfy this)');
  assert.match(body, /RM_RETRY_CODES\.has\(e\.code\)/, 'the loop must gate retries on the transient-code set');
});

test('signal-handler teardown is guarded and keeps the signal exit code', () => {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    // Bounded window, not [^;]*; — a block-bodied handler (`=> { f(130); }`)
    // must not break the extraction.
    const at = SRC.indexOf(`process.on('${sig}'`);
    assert.ok(at >= 0, `${sig} handler not found`);
    const m = SRC.slice(at, at + 400);
    // The handler may guard inline or delegate to a guarded helper — follow
    // one call deep so the oracle binds the BEHAVIOR, not the structure.
    const call = m.match(/=>\s*\{?\s*(\w+)\(/)?.[1];
    const body = call ? (SRC.match(new RegExp(`function ${call}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '') : m;
    assert.match(body, /try\s*\{[^}]*rmSandbox/,
      `${sig} teardown must try/catch each rmSandbox — an unguarded throw exits 1 and trips systemd start-limit`);
    assert.match(m, new RegExp(`process\\.exit\\(${code}\\)|${call}\\(${code}\\)`),
      `${sig} must still exit ${code}`);
  }
});

test('retry tuning is clamped finite — bogus env can never hang the signal handler', () => {
  // The review-caught class: FLOCK_RM_ATTEMPTS=abc/Infinity makes the bound
  // check never fire (unbounded retry); FLOCK_RM_RETRY_MS=NaN makes
  // Atomics.wait block forever. Assert a finite-clamp guard exists AND a
  // dwell budget caps total handler time under TimeoutStopSec.
  const head = SRC.slice(Math.max(0, SRC.indexOf('RM_ATTEMPTS') - 600), SRC.indexOf('function rmSandbox'));
  assert.match(head, /Number\.isFinite/, 'env tuning must reject non-finite values (NaN/Infinity retry = unbounded hang)');
  const loop = SRC.match(/function rmSandbox\([^)]*\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(loop, /Date\.now\(\)/, 'the retry loop must carry a dwell budget — N stubborn dirs under systemd TimeoutStopSec get SIGKILLed mid-cleanup');
});

test("oneRound's finally teardown is guarded and still unregisters the sandbox", () => {
  const m = SRC.match(/finally\s*\{([\s\S]*?)\n  \}/);
  assert.ok(m && m[1].includes('liveSandboxes.delete'), 'oneRound finally block not found');
  assert.match(m[1], /try\s*\{[^}]*rmSandbox/,
    'a finally teardown throw propagates into the worker loop — the same process-kill class as the signal path');
});

test('makeSandbox cleanup never masks the real install error', () => {
  const m = SRC.match(/function makeSandbox[\s\S]*?catch \(e\) \{([\s\S]*?)throw e;/);
  assert.ok(m, 'makeSandbox catch not found');
  assert.match(m[1], /try\s*\{[^}]*rmSandbox/, 'a teardown throw inside catch would replace the real error');
});

// ---------- e2e: the incident replayed against the real flock ----------

test('SIGTERM under persistent sandbox churn exits 143 with a logged teardown, not a crash', async () => {
  const h = spawnFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], churnStub(0));
  const sbx = await sigtermAtChurn(h);
  const code = await close(h.proc);
  assert.equal(code, 143, `SIGTERM must exit 143 — got ${code}: ${h.out()}${h.err()}`);
  assert.doesNotMatch(h.err(), /ENOTEMPTY/, `the crash class reached stderr: ${h.err()}`);
  // A writer that outlives the retry window still throws — the guard owns it.
  assert.match(h.out(), /teardown flock-/, `stubborn teardown must be logged, not thrown: ${h.out()}`);
  leftoverRm(sbx);
});

test('SIGTERM under brief churn recovers through retries — dir fully removed, no teardown note', async () => {
  const h = spawnFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], churnStub(1500));
  const sbx = await sigtermAtChurn(h);
  const code = await close(h.proc);
  assert.equal(code, 143, `SIGTERM must exit 143 — got ${code}: ${h.out()}${h.err()}`);
  assert.doesNotMatch(h.out() + h.err(), /teardown flock-|ENOTEMPTY/,
    `transient churn should be absorbed by retries: ${h.out()}${h.err()}`);
  // Tolerate a churn-only remnant: a winning rmSync attempt during a write
  // gap returns while the still-alive writer recreates sbx/churn by absolute
  // path. The writer is dead by close (die-with-parent), so a real teardown
  // failure would leave more than `churn`.
  const remnant = existsSync(sbx) ? readdirSync(sbx) : [];
  assert.ok(remnant.every((n) => n === 'churn'), `sandbox dir survived a successful teardown: ${sbx} -> ${remnant}`);
  leftoverRm(sbx);
});

test('bogus retry env (NaN) still exits 143 in bounded time — no unbounded handler hang', async () => {
  const h = spawnFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], churnStub(0),
    { FLOCK_RM_ATTEMPTS: 'abc', FLOCK_RM_RETRY_MS: 'abc' });
  const sbx = await sigtermAtChurn(h);
  // If the env clamp regressed (NaN attempts/delay), the handler retries or
  // sleeps forever — the deadline, not close(), must end this test.
  const code = await Promise.race([close(h.proc), new Promise((r) => setTimeout(() => r('HANG'), 120_000))]);
  if (code === 'HANG') h.proc.kill('SIGKILL'); // never leave a regressed flock + its churn writer running
  assert.notEqual(code, 'HANG', 'NaN retry env hung the SIGTERM teardown — unbounded retry regression');
  assert.equal(code, 143, `SIGTERM must exit 143 — got ${code}: ${h.out()}${h.err()}`);
  leftoverRm(sbx);
});

test('with retries pinned off (FLOCK_RM_ATTEMPTS=1) the same brief churn hits the guard', async () => {
  const h = spawnFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], churnStub(1500), { FLOCK_RM_ATTEMPTS: '1' });
  const sbx = await sigtermAtChurn(h);
  const code = await close(h.proc);
  assert.equal(code, 143, `guarded teardown must still exit 143 — got ${code}: ${h.out()}${h.err()}`);
  assert.match(h.out(), /teardown flock-/,
    `the guard must log the stubborn dir — silent catch would hide a real leak: ${h.out()}`);
  leftoverRm(sbx);
});

test('a normal round still records and exits clean (no regression on the happy path)', async () => {
  const stub = path.join(work, 'claude-lane-plain.mjs');
  writeFileSync(stub, `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'zagent --version' } }, { type: 'text', text: 'FLOCK-VERDICT: OK' }] } }));
`);
  chmodSync(stub, 0o755);
  const h = spawnFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], stub);
  const code = await close(h.proc);
  assert.equal(code, 0, `clean run must exit 0 — got ${code}: ${h.out()}${h.err()}`);
  const runs = readFileSync(path.join(h.flockDir, 'runs.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(runs.length, 1, `expected 1 record: ${JSON.stringify(runs)}`);
});

// ---------- runner ----------
let fails = 0;
for (const [n, f] of tests) {
  try { await f(); console.log(`PASS ${n}`); }
  catch (e) { fails++; console.log(`FAIL ${n}: ${e.message}`); }
}
leftoverRm(work); // the scratch root — in-wall writers are dead (die-with-parent)
process.exit(fails ? 1 : 0);
