#!/usr/bin/env node
// Behaviour of the bench shell drivers and process helpers: resume semantics,
// credentialed temp-home cleanup, kill fallback, shell quoting, grading copy.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFrameDetector } from './proc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const posix = process.platform !== 'win32';
const hasTimeout = posix && spawnSync('timeout', ['1', 'true']).status === 0;
const tests = [];
const test = (n, f) => tests.push([n, f]);
const scratch = mkdtempSync(path.join(os.tmpdir(), 'bench-probes-'));
const src = (f) => readFileSync(path.join(here, f), 'utf8');

test('killChild falls back to child.kill() when the process group kill throws', async () => {
  const { killChild } = await import('./proc.mjs');
  const calls = [];
  // Not a live pid: process.kill(-pid) throws, as it does for any pid on Windows.
  killChild({ pid: 2147483000, kill: (sig) => calls.push(sig) });
  assert.deepEqual(calls, ['SIGKILL']);
  killChild(undefined);
  killChild({ kill: () => calls.push('no-pid') });
  assert.deepEqual(calls, ['SIGKILL']);
});

test('every bench process killer goes through killChild', () => {
  for (const f of ['quota-probe.mjs', 'team-probe.mjs', 'paired-release.mjs']) {
    assert.match(src(f), /killChild\(/, `${f} must use killChild`);
    assert.doesNotMatch(src(f), /process\.kill\(-/, `${f} must not kill a group without a fallback`);
  }
});

test('shQuote keeps hostile paths literal under sh -c', async () => {
  if (!posix) return;
  const { shQuote } = await import('./proc.mjs');
  for (const v of ['plain', 'with space', "it's", 'a;touch pwned', '$(echo x)', '`echo x`', 'a"b']) {
    const r = spawnSync('sh', ['-c', `printf %s ${shQuote(v)}`], { encoding: 'utf8' });
    assert.equal(r.stdout, v);
  }
  for (const f of ['slash-probe.mjs', 'client-perf.mjs', 'tui-boot-probe.mjs']) {
    assert.match(src(f), /shQuote\(/, `${f} must quote its script -c paths`);
  }
});

test('PTY probes write under a private temp dir with no stray fixed names or dead args', () => {
  assert.doesNotMatch(src('tui-boot-probe.mjs'), /['"`]\/tmp\//);
  assert.match(src('tui-boot-probe.mjs'), /mkdtempSync\(/);
  assert.doesNotMatch(src('slash-probe.mjs'), /replayScreen\(raw, /);
});

test('slash-probe runs through its PTY launch without a ReferenceError', () => {
  if (!posix || spawnSync('script', ['--version']).error) return;
  const fx = path.join(scratch, 'slash');
  mkdirSync(path.join(fx, 'packages/tui'), { recursive: true });
  mkdirSync(path.join(fx, 'packages/cli'), { recursive: true });
  writeFileSync(path.join(fx, 'packages/tui/screen-replay.mjs'), 'export const replayTerminal = () => ({ scrollback: [], screen: [] });\n');
  writeFileSync(path.join(fx, 'packages/cli/zagent.mjs'), 'process.exit(0);\n');
  const r = spawnSync(process.execPath, [path.join(here, 'slash-probe.mjs'), '--repo', fx, '--cwd', fx, '--out', path.join(fx, 'raw')], { encoding: 'utf8', timeout: 30000 });
  assert.doesNotMatch(r.stderr, /ReferenceError/);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /banner never rendered/);
});

test('frontierharness quotes operator models and rejects a non-numeric timeout', () => {
  if (!posix) return;
  const py = spawnSync('python3', ['-c',
    'import sys; sys.path.insert(0, sys.argv[1]); from zagent_common import install_script; print(install_script("b", "a b;touch x", "c$(id)"))',
    path.join(here, 'frontierharness')], { encoding: 'utf8' });
  if (py.error) return;
  assert.equal(py.status, 0, py.stderr);
  assert.ok(py.stdout.includes("'a b;touch x' 'c$(id)'"), py.stdout);
  const tasks = path.join(scratch, 'fh-tasks.txt');
  writeFileSync(tasks, '');
  for (const bad of ['5400s', '0', '00']) {
    const r = spawnSync('bash', [path.join(here, 'frontierharness/run-local-trials.sh'), '--run-id', 'x', '--tasks', tasks, '--timeout', bad], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${bad}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--timeout must be a positive integer/);
  }
});

test('first-frame detection survives a multi-byte box char split across chunks', () => {
  const box = Buffer.from('╭', 'utf8');
  assert.equal(box.length, 3);
  const detect = createFrameDetector();
  assert.equal(detect(Buffer.concat([Buffer.from('boot '), box.subarray(0, 2)])), false);
  assert.equal(detect(Buffer.concat([box.subarray(2), Buffer.from('──╮')])), true);
  assert.equal(createFrameDetector()(Buffer.from('plain boot noise')), false);
  assert.match(src('client-perf.mjs'), /createFrameDetector\(\)/);
});

test('multi-matrix re-runs an invalid receipt and skips valid ones', () => {
  if (!hasTimeout) return;
  const fx = path.join(scratch, 'mm');
  mkdirSync(path.join(fx, 'bench/results'), { recursive: true });
  writeFileSync(path.join(fx, 'bench/run-multi.mjs'), `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(path.join(fx, 'ran.log'))}, process.argv.slice(2,5).join(' ') + '\\n');\nconsole.log('ok');\n`);
  const tasks = 't1_rot13 t5_json t6_regex t9_sql t2_fixbug t3_toposort t7_cli t8_apiclient t4_multifile t10_refactor'.split(' ');
  for (const t of tasks) for (const h of ['claude_code', 'zcode', 'zcode-app-cli', 'zcode-official']) {
    const invalid = h === 'zcode' && t === 't5_json' ? { invalid: 'rate-limited' } : {};
    writeFileSync(path.join(fx, `bench/results/mh_${h}_${t}_m1.json`), JSON.stringify({ pass: true, ...invalid }));
  }
  const r = spawnSync('bash', [path.join(here, 'multi-matrix.sh')], { env: { ...process.env, BENCH_ROOT: fx }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(path.join(fx, 'ran.log'), 'utf8').trim(), `zcode ${path.join('bench/tasks/t5_json')} m1`);
});

test('offpeak-matrix removes its credentialed temp HOME on exit', () => {
  if (!posix) return;
  const fx = path.join(scratch, 'op');
  const home = path.join(fx, 'home'), tmp = path.join(fx, 'tmp'), fakeRoot = path.join(fx, 'root');
  mkdirSync(path.join(home, '.zcode/cli'), { recursive: true });
  mkdirSync(tmp, { recursive: true });
  mkdirSync(path.join(fakeRoot, 'packages/cli'), { recursive: true });
  writeFileSync(path.join(home, '.zcode/cli/config.json'), JSON.stringify({ provider: { zai: { options: { apiKey: 'SECRET' } } } }));
  writeFileSync(path.join(fakeRoot, 'packages/cli/zagent-offpeak.mjs'), 'process.exit(3);\n');
  const r = spawnSync('bash', [path.join(here, 'offpeak-matrix.sh')], {
    env: { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home, TMPDIR: tmp, BENCH_ROOT: fakeRoot }, encoding: 'utf8' });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /flash-pinned HOME/, 'the credentialed home must have been created');
  const created = r.stdout.match(/flash-pinned HOME: (.+)/)[1];
  assert.ok(!existsSync(created), `the temp HOME holding the provider key must be removed: ${created}`);
  assert.deepEqual(readdirSync(tmp), []);

  const mine = path.join(fx, 'mine');
  mkdirSync(mine, { mode: 0o755 });
  chmodSync(mine, 0o755);
  const r2 = spawnSync('bash', [path.join(here, 'offpeak-matrix.sh')], {
    env: { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home, TMPDIR: tmp, BENCH_ROOT: fakeRoot, FLASH_HOME: mine }, encoding: 'utf8' });
  assert.equal(r2.status, 3, r2.stdout + r2.stderr);
  assert.ok(existsSync(mine), 'a caller-supplied FLASH_HOME is left in place');
  assert.equal(statSync(mine).mode & 0o777, 0o755, 'a caller-supplied FLASH_HOME keeps its mode');
});

test('run-multi grades the agent-edited file, not the pristine task copy', () => {
  if (!posix) return;
  const fx = path.join(scratch, 'rm');
  const bins = path.join(fx, 'bin'), task = path.join(fx, `task_${path.basename(scratch)}`);
  mkdirSync(bins, { recursive: true }); mkdirSync(task);
  writeFileSync(path.join(task, 'task.md'), 'Fix buggy.py in place.');
  writeFileSync(path.join(task, 'agent_graded'), '');
  writeFileSync(path.join(task, 'buggy.py'), 'def f():\n    return 1\n');
  writeFileSync(path.join(task, 'test.py'), 'from buggy import f\nassert f() == 2\n');
  writeFileSync(path.join(bins, 'claude'), `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync('buggy.py', 'def f():\\n    return 2\\n');\nprocess.stdout.write('done');\n`, { mode: 0o700 });
  const runId = 'agentfix';
  const receipt = path.join(root, 'bench/results', `mh_claude_code_${path.basename(task)}_${runId}.json`);
  try {
    const r = spawnSync(process.execPath, [path.join(here, 'run-multi.mjs'), 'claude_code', task, runId], {
      env: { ...process.env, PATH: `${bins}:${process.env.PATH}`, BENCH_CLAUDE_CODE_BIN: 'claude' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(readFileSync(receipt)).pass, true);
  } finally { rmSync(receipt, { force: true }); }
});

let pass = 0, fail = 0;
try {
  for (const [n, f] of tests) {
    try { await f(); pass++; } catch (e) { fail++; console.error(`FAIL ${n}\n  ${e.message}`); }
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
console.log(`${pass}/${tests.length} bench probe tests passed`);
process.exit(fail ? 1 : 0);
