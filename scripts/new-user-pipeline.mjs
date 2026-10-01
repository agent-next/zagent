#!/usr/bin/env node
// new-user-pipeline — the full first-user journey, from NOTHING to a working agent.
//
// The outsider smoke gate proves the shipped artifact parses and helps; this
// script proves the JOURNEY a brand-new user actually walks: a machine with
// no credential, no config, no history — install, first run, login, doctor,
// first turn, quota visibility. Stages are ordered exactly as the user meets
// them; each asserts the behavior a new user depends on (honest missing-state
// copy, guidance to the next step, working login paths, 0600 config, a real
// answer). Live stages (real inference) are quota-gated: mandatory when the
// 5h window is below the skip threshold, loud-skip only when it is not.
//
//   node scripts/new-user-pipeline.mjs              # full run (live if quota allows)
//   node scripts/new-user-pipeline.mjs --offline    # skip the live turn stage
//   node scripts/new-user-pipeline.mjs --keep       # keep the sandbox for inspection
//   FROM_TARBALL=./zagent-latest.tgz node scripts/new-user-pipeline.mjs
//
// Sandbox guarantees: throwaway HOME (empty), throwaway npm prefix, its own
// XDG/data dirs. The real ~/.zcode and the developer's config are never read
// or written. The only host state consumed is the ZCode runtime discovery
// (read-only) and, for the live stage, the credential the operator provides
// via ZAGENT_PIPELINE_KEY (never read from the real home).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const offline = process.argv.includes('--offline') || process.env.ZAGENT_LIVE === '0';
const tarball = process.env.FROM_TARBALL ?? '';
const liveKey = process.env.ZAGENT_PIPELINE_KEY ?? process.env.ZAI_API_KEY ?? '';
const version = readFileSync(path.join(root, 'VERSION'), 'utf8').trim();

// Every string this script prints flows through fail()/ok(); redact at the
// choke point so a diagnostic that happens to quote the live key (a verbose
// 401 from the subprocess, say) can never land in the receipt. Guards on the
// key exist on the success path only otherwise (r2).
const redact = (s) => (liveKey && typeof s === 'string' && s.includes(liveKey))
  ? s.split(liveKey).join('***redacted***') : s;

// A crash is not "honest guidance". V8 frames are `\n    at ...` in every
// module system (CJS `at Object.f`, ESM `at file:///...`, `at async ...`), and
// an uncaught error prints its class name at a line start — e.g. a regression
// `ReferenceError: loginCard is not defined` satisfies the /login/ guidance
// regex while carrying no indented `at Object|process` frame, which is exactly
// the enumerated-regex hole this closes (r1).
const STACKY = /\n[ \t]+at[ \t]+\S+|^[ \t]*(?:TypeError|ReferenceError|SyntaxError|RangeError|InternalError):/m;

const fails = [];
let stage = '';
const ok = (name) => console.log(`  ok   ${name}`);
const fail = (name, why) => {
  const line = String(why).split('\n')[0];
  fails.push(`${stage}: ${name}`); console.log(`  FAIL ${name}\n         ${redact(line)}`);
};
const check = (name, fn) => { try { fn(); ok(name); } catch (e) { fail(name, e.message); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

const work = mkdtempSync(path.join(tmpdir(), 'zagent-newuser-'));
const home = path.join(work, 'home');
const prefix = path.join(work, 'prefix');
mkdirSync(home, { recursive: true });
const bin = path.join(prefix, 'bin', 'zagent');

/** Run the INSTALLED binary with the sandbox HOME and nothing else. */
function zagent(args, opts = {}) {
  return spawnSync(bin, args, {
    encoding: 'utf8', timeout: opts.timeout ?? 120_000, cwd: opts.cwd ?? work,
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home,
      // isolation: no ambient credential, no ambient runtime override
      ...(opts.env ?? {}),
    },
  });
}
const outOf = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`;

try {
  // ---------------------------------------------------------------- stage 1
  stage = 'install';
  console.log(`\n[1] fresh-machine install (npm, empty HOME, no prior state)`);
  if (tarball) {
    execFileSync('npm', ['install', '-g', tarball, '--prefix', prefix], { encoding: 'utf8', timeout: 300_000, stdio: 'ignore' });
  } else {
    // Build the tarball from this source tree, then install THAT (a stranger
    // never installs the checkout; they install the packed artifact). The
    // cleanup runs even when install throws — a failed install used to leave
    // the packed tgz behind in the repo root.
    const packed = execFileSync('npm', ['pack', '--quiet'], { encoding: 'utf8', cwd: root }).trim().split('\n').pop();
    try {
      execFileSync('npm', ['install', '-g', path.join(root, packed), '--prefix', prefix], { encoding: 'utf8', timeout: 300_000, stdio: 'ignore' });
    } finally {
      rmSync(path.join(root, packed), { force: true });
    }
  }
  check('the binary is on PATH in the sandbox prefix', () => assert(existsSync(bin), bin));
  {
    const r = zagent(['--version']);
    check('--version reports the version and a discovered runtime', () => {
      assert(r.status === 0, outOf(r));
      assert(outOf(r).includes(version), `expected ${version} in: ${outOf(r).slice(0, 120)}`);
    });
  }

  // ---------------------------------------------------------------- stage 2
  stage = 'first-run-honesty';
  console.log(`\n[2] first run with NO credential — honest missing-state, guidance, no stack`);
  {
    const r = zagent(['doctor']);
    check('doctor explains the missing credential (not a stack trace)', () => {
      // exit 1 = the diagnosis "no credential" is unhealthy (zagent.mjs exit
      // table); exit 2 would mean we hit a usage error instead.
      assert(r.status === 1, `exit ${r.status} (want 1): ${outOf(r).slice(0, 200)}`);
      assert(!STACKY.test(outOf(r)), outOf(r).slice(0, 200));
      assert(/credential|api|login|key/i.test(outOf(r)), `no guidance in: ${outOf(r).slice(0, 200)}`);
    });
  }
  {
    const r = zagent(['-p', 'hi', '--json'], { timeout: 60_000 });
    check('a credential-less headless turn FAILS (never fake-success)', () => {
      // exit 2 = the fixable-usage sign-in path (a declined chooser), not a
      // crash and not fake success.
      assert(r.status === 2, `exit ${r.status} (want 2): ${outOf(r).slice(0, 200)}`);
      assert(!STACKY.test(outOf(r)), outOf(r).slice(0, 200));
      assert(/credential|login|key|config/i.test(outOf(r)), `no guidance: ${outOf(r).slice(0, 200)}`);
    });
  }
  {
    const r = zagent(['quota', '--json'], { timeout: 60_000 });
    check('quota refuses honestly without a credential (no fabricated pools)', () => {
      // exit 1 = honest refusal with a "configure the key" message; a crash
      // (STACKY) must not be recorded as an honest refusal.
      assert(r.status === 1, `exit ${r.status} (want 1): ${outOf(r).slice(0, 200)}`);
      assert(!STACKY.test(outOf(r)), outOf(r).slice(0, 200));
      assert(!/"usedPercent"/.test(r.stdout ?? ''), 'fabricated pool data');
      assert(/key|credential|login|config/i.test(outOf(r)), `refusal does not explain itself: ${outOf(r).slice(0, 200)}`);
    });
  }

  // ---------------------------------------------------------------- stage 3
  stage = 'login';
  console.log(`\n[3] login paths a new user can actually walk`);
  const key = liveKey;
  if (!key) {
    console.log('  SKIP live login (no ZAGENT_PIPELINE_KEY/ZAI_API_KEY in env) — env-key path not exercised');
  } else {
    check('env key + doctor --fix writes a 0600 config and a working provider', () => {
      const r = zagent(['doctor', '--fix'], { env: { ZAI_API_KEY: key }, timeout: 120_000 });
      assert(r.status === 0, outOf(r).slice(0, 300));
      const cfg = path.join(home, '.zcode', 'cli', 'config.json');
      assert(existsSync(cfg), 'config.json not written');
      const mode = statSync(cfg).mode & 0o777;
      assert(mode === 0o600, `config mode ${mode.toString(8)}, expected 600`);
      assert(!outOf(r).includes(key), 'the key echoed to output');
    });
    check('quota now answers (credential honored end-to-end)', () => {
      const r = zagent(['quota', '--json'], { timeout: 120_000 });
      assert(r.status === 0, outOf(r).slice(0, 300));
      JSON.parse(r.stdout); // parseable, no preamble noise
    });
  }

  // ---------------------------------------------------------------- stage 4
  stage = 'onboarding';
  console.log(`\n[4] onboarding guidance`);
  {
    const r = zagent(['--help']);
    check('help surfaces onboard/doctor as the first-run entry points', () => {
      assert(r.status === 0, outOf(r).slice(0, 120));
      assert(/onboard/.test(r.stdout) && /doctor/.test(r.stdout), 'onboard/doctor not discoverable');
    });
  }

  // ---------------------------------------------------------------- stage 5
  stage = 'live-turn';
  console.log(`\n[5] first real turn (the moment a new user decides it works)`);
  if (offline) {
    console.log('  SKIP live turn (--offline / ZAGENT_LIVE=0)');
  } else if (!key) {
    console.log('  SKIP live turn (no credential provided)');
  } else {
    const r = zagent(['-p', 'Reply with exactly: pong', '--json'], { timeout: 240_000, env: { ZAI_API_KEY: key } });
    check('a real answer comes back in a parseable envelope', () => {
      assert(r.status === 0, outOf(r).slice(0, 300));
      const env = JSON.parse(r.stdout);
      assert(/pong/i.test(String(env.response ?? '')), `response: ${String(env.response).slice(0, 80)}`);
      assert(env.usage?.modelRequestCount >= 1, 'no usage recorded');
    });
  }

  // ---------------------------------------------------------------- receipt
  console.log(`\n${fails.length ? 'NEW-USER PIPELINE FAILED' : 'NEW-USER PIPELINE PASSED'} (${fails.length} failure(s))${keep ? ` — sandbox kept: ${work} (a live run leaves the credential at home/.zcode/cli/config.json, mode 0600 — delete the sandbox when done)` : ''}`);
  if (fails.length) { console.error('  ' + fails.join('\n  ')); process.exitCode = 1; }
} finally {
  if (!keep) rmSync(work, { recursive: true, force: true });
}
