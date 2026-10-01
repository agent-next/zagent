#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRun } from './run-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = mkdtempSync(path.join(os.tmpdir(), 'bench-evidence-'));
const receipts = [];
try {
  const options = { lane: 'claude_code', task: 'fixture', runId: 'one', results: path.join(fixture, 'results') };
  for (const field of ['lane', 'task', 'runId']) {
    assert.throws(() => prepareRun({ ...options, [field]: '../../other-lane' }), /slug/);
  }
  const a = prepareRun(options), b = prepareRun(options);
  try {
    assert.notEqual(a.workspace, b.workspace);
    a.write({ pass: true });
    assert.throws(() => b.write({ pass: false }), /EEXIST/);
    assert.throws(() => prepareRun(options), /already exists/);
    assert.equal(JSON.parse(readFileSync(path.join(options.results, 'claude_code_fixture_one.json'))).pass, true);
  } finally { a.cleanup(); b.cleanup(); }
  assert(!existsSync(a.workspace) && !existsSync(b.workspace));

  if (process.platform !== 'win32') {
    const bins = path.join(fixture, 'bin'); mkdirSync(bins);
    writeFileSync(path.join(bins, 'claude'), `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.BENCH_TEST_CWD, process.cwd());\nprocess.stdout.write(JSON.stringify({response:'def identity(x):\\n    return x\\n'}));\nprocess.exit(Number(process.env.BENCH_TEST_EXIT));\n`, { mode: 0o700 });
    const task = `task_${path.basename(fixture)}`, taskDir = path.join(fixture, task); mkdirSync(taskDir);
    writeFileSync(path.join(taskDir, 'task.md'), 'Synthetic offline task; fake claude supplies the answer.');
    writeFileSync(path.join(taskDir, 'test.py'), 'from solution import identity\nassert identity(42) == 42\n');
    const cwdReceipt = path.join(fixture, 'cwd');
    for (const status of [0, 1]) {
      const runId = `exit${status}`;
      const receipt = path.join(root, 'bench/results', `mh_claude_code_${task}_${runId}.json`); receipts.push(receipt);
      assert(!existsSync(receipt));
      const env = { ...process.env, PATH: `${bins}:${process.env.PATH}`, BENCH_CLAUDE_CODE_BIN: 'claude', BENCH_TEST_CWD: cwdReceipt, BENCH_TEST_EXIT: String(status) };
      const args = [path.join(root, 'bench/run-multi.mjs'), 'claude_code', taskDir, runId];
      const result = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
      assert.equal(result.status, status, result.stderr);
      const record = JSON.parse(readFileSync(receipt));
      assert.equal(record.pass, status === 0, JSON.stringify(record));
      const workspace = readFileSync(cwdReceipt, 'utf8');
      assert(!existsSync(path.dirname(workspace)), 'owned workspace and grade must be removed');
      const before = readFileSync(receipt, 'utf8');
      const again = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
      assert.notEqual(again.status, 0);
      assert.match(again.stderr, /receipt already exists/);
      assert.equal(readFileSync(receipt, 'utf8'), before);
    }
  }
  console.log('PASS benchmark safety: path rejection, independent fixtures, immutable receipts, bare JSON code grading, nonzero process rejection, cleanup');
} finally {
  for (const receipt of receipts) rmSync(receipt, { force: true });
  rmSync(fixture, { recursive: true, force: true });
}
