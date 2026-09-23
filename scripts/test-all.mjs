#!/usr/bin/env node
// Repo test gate — discovers and runs every hermetic test file, so adding a test
// file is enough to have it gated. Previously `test:all` named 4 of 24 files by
// hand and the rest were only ever run ad hoc.
//
// Excluded on purpose:
//   test-util.mjs        shared assert helpers, not a test
//   test-user-flow.mjs   needs a live ZCode runtime
//   interactive harnesses run by hand, not part of the gate
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRuntime } from '../packages/driver/runtime.mjs';
// What counts as a gated test file lives in one module, shared with the
// cross-platform ledger, which used to keep its own copy of the answer.
import { discoverTests } from './discover-tests.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// These drive a real ZCode runtime process; they are real tests, not hermetic
// ones. Where the runtime is absent they are SKIPPED LOUDLY rather than failed
// (a missing proprietary desktop install is not a code defect) and never
// silently counted as passing.
const NEEDS_RUNTIME = new Set(['test.mjs', 'test-a2.mjs', 'test-permission-live.mjs', 'test-journeys-live.mjs']);
const live = process.argv.includes('--live') || process.env.ZAGENT_LIVE === '1';
const runtime = live ? findRuntime()?.entry : null;
// Why a runtime test was skipped. Without --live it is policy, not a missing
// install: saying "needs ZCode runtime" on a machine that HAS the runtime
// installed is simply false, and a gate that misreports its own skips is the
// same class of defect as one that hides them.
const skipReason = live ? 'no ZCode runtime found' : 'live runtime test; opt in with --live';

const files = discoverTests(root);
if (files.length === 0) {
  console.error('FAIL: no test files discovered — the gate would pass vacuously');
  process.exit(1);
}

const failures = [];
const skipped = [];
for (const file of files) {
  const rel = path.relative(root, file);
  const needsRuntime = NEEDS_RUNTIME.has(path.basename(file));
  if (needsRuntime && !runtime) {
    skipped.push(rel);
    console.log(`skip ${rel} (${skipReason})`);
    continue;
  }
  const sandbox = mkdtempSync(path.join(tmpdir(), 'zagent-test-'));
  let res;
  try {
    const temp = path.join(sandbox, 'tmp');
    mkdirSync(temp);
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    Object.assign(env, { HOME: sandbox, USERPROFILE: sandbox, TMPDIR: temp, TEMP: temp, TMP: temp,
      XDG_CONFIG_HOME: path.join(sandbox, '.config'), ZAGENT_TEST_SANDBOX: sandbox,
      ZCODE_RUNTIME: needsRuntime ? runtime : path.join(sandbox, 'no-runtime'),
      NODE_OPTIONS: needsRuntime ? '' : `--import=${path.join(root, 'scripts/offline-test-preload.mjs')}` });
    if (live) {
      env.ZAGENT_LIVE = '1'; // self-gating live tests (test-journeys-live.mjs) see the opt-in
      // Live journeys seed a throwaway HOME from the real config — the sandbox
      // hides it, so forward the real home + any explicit credential.
      env.ZAGENT_SEED_HOME = homedir();
      if (process.env.ZAI_API_KEY) env.ZAI_API_KEY = process.env.ZAI_API_KEY;
    }
    res = spawnSync(process.execPath, [file], { cwd: root, env, encoding: 'utf8', timeout: 300000 });
  } finally {
    // Tests may leave deliberately-unwritable fixtures (e.g. a snapshot-guard
    // locked dir is non-empty + mode 0000 / chattr +i by design) — rimraf
    // cannot descend those, so restore traversability best-effort first.
    if (process.platform !== 'win32') {
      spawnSync('chattr', ['-R', '-i', sandbox], { stdio: 'ignore' });
      spawnSync('chmod', ['-R', 'u+rwX', sandbox], { stdio: 'ignore' });
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
  const bad = res.status !== 0 || res.error;
  if (bad) {
    failures.push(rel);
    console.log(`FAIL ${rel}${res.error ? ` (${res.error.message})` : ` (exit ${res.status})`}`);
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trimEnd();
    if (out) console.log(out.split('\n').map((l) => `     ${l}`).join('\n'));
  } else {
    console.log(`ok   ${rel}`);
  }
}

const ran = files.length - skipped.length;
console.log(`\n${ran - failures.length}/${ran} test files passed` +
  (skipped.length ? ` (${skipped.length} skipped — ${skipReason}: ${skipped.join(', ')})` : ''));
if (failures.length) {
  console.log(`FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
