#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, runBehavior, summarizeBehaviors } from '../usertest/random-user.mjs';
import { findRuntime } from '../packages/driver/runtime.mjs';
import { reproduces } from './journey-fuzz.mjs';
import { verifyFinding } from './verify-finding.mjs';
import { checkInvariants } from '../packages/tui/journey.mjs';
import { runTui } from '../packages/tui/index.mjs';
import { createFakeHost } from '../packages/tui/fake-host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
let sandbox;
try {
  const source = path.join(fixture, 'source');
  mkdirSync(path.join(source, '.zcode/cli'), { recursive: true });
  const config = path.join(source, '.zcode/cli/config.json');
  writeFileSync(config, '{"synthetic":true}');
  const sourceData = path.join(source, '.local/share');
  mkdirSync(sourceData, { recursive: true });
  writeFileSync(path.join(sourceData, 'sentinel'), 'source profile');
  const runtime = path.join(source, '.local/opt/zcode-app-cli/node_modules/zcode-app-cli/bin/zcode.js');
  mkdirSync(path.dirname(runtime), { recursive: true });
  writeFileSync(runtime, '// synthetic runtime; never executed');
  sandbox = createSandbox({ sourceHome: source, env: { PATH: process.env.PATH } });
  // The sandbox pins whatever discovery yields: the fixture app-cli, or the
  // host's official desktop bundle when one is installed (it ranks first).
  if (process.platform !== 'win32') {
    const discovered = findRuntime({ home: source, env: { PATH: process.env.PATH } });
    assert.equal(sandbox.env.ZCODE_RUNTIME, discovered && path.resolve(discovered.entry));
  }
  mkdirSync(sandbox.env.XDG_DATA_HOME, { recursive: true });
  writeFileSync(path.join(sandbox.env.XDG_DATA_HOME, 'sentinel'), 'sandbox profile');
  writeFileSync(path.join(sandbox.env.XDG_DATA_HOME, 'sandbox-only'), 'isolated');
  assert.equal(readFileSync(path.join(sourceData, 'sentinel'), 'utf8'), 'source profile');
  assert(!existsSync(path.join(sourceData, 'sandbox-only')));
  const copied = path.join(sandbox.home, '.zcode/cli/config.json');
  assert.equal(readFileSync(copied, 'utf8'), readFileSync(config, 'utf8'));
  if (process.platform !== 'win32') assert.equal(statSync(copied).mode & 0o777, 0o600);
  writeFileSync(config, '{broken');
  assert.throws(() => createSandbox({ sourceHome: source, env: {} }));

  const base = { env: sandbox.env, emit() {} };
  const headless = { name: 'headless_json', prompts: ['synthetic'] };
  const failed = runBehavior(headless, { ...base, spawn: () => ({ status: 1, stdout: '' }) });
  assert.equal(failed.pass, false);
  assert.equal(runBehavior(headless, { ...base, spawn: () => ({ status: null, error: { code: 'ETIMEDOUT' } }) }).pass, false);
  assert.equal(runBehavior(headless, { ...base, spawn: () => ({ status: 0, stdout: '{"error":"provider failed"}' }) }).pass, false);
  const environments = [];
  const spawn = (_cmd, _args, options) => {
    environments.push(options.env);
    return { status: 0, stdout: '{"response":"blue"}' };
  };
  const passed = runBehavior(headless, { ...base, spawn });
  assert.equal(passed.pass, true);
  assert.equal(runBehavior({ name: 'exit_and_resume' }, { ...base, spawn }).pass, true);
  let pasteInput;
  assert.equal(runBehavior({ name: 'paste_multiline' }, { ...base, pty: (_cmd, inputs, _cwd, _timeout, env) => {
    environments.push(env); pasteInput = inputs;
    return { exitCode: 0, output: 'zagent line one line two' };
  } }).pass, true);
  assert(pasteInput.some(step => step.text.includes('\x1b[200~line one\nline two\x1b[201~')));
  assert(environments.length === 4 && environments.every(env => env === sandbox.env));
  assert.equal(runBehavior({ name: 'not-implemented' }, base).pass, false);
  assert.equal(runBehavior({ name: 'idle_session' }, { ...base, pty: () => ({ exitCode: 127, output: 'node: missing' }) }).pass, false);
  assert.deepEqual(summarizeBehaviors([failed, passed]), { rounds: 2, survived: 1, crashed: 1, rate: 50 });
  assert.equal(summarizeBehaviors([]).rate, 0);

  // Capture the real TUI: current answers use transcript markers, not legacy
  // session counters. A completed turn with no assistant text must still fail.
  for (const reply of ['2', '']) {
    const stdin = new EventEmitter(), stdout = new EventEmitter(), chunks = [];
    Object.assign(stdin, { setRawMode() {}, resume() {}, pause() {}, setEncoding() {} });
    Object.assign(stdout, { isTTY: true, columns: 100, rows: 30,
      write(chunk) { chunks.push(String(chunk)); return true; } });
    // home isolates input-history persistence from the developer's real file.
    const { host, submitted } = createFakeHost({ stdin, stdout, reply, home: sandbox.home });
    // The startup quota probe must not reach the real monitor endpoint.
    // flushMs 0 is the in-process test seam: a burst flushes at the emit's end
    // instead of after the real 60 ms quiet window, so the scripted emits below
    // stay deterministic (a 40 ms gap would otherwise keep the flood open).
    const done = runTui(host, { deps: {
      codingPlanStatus: async () => { throw new Error('test: no quota fixture'); },
      pasteBurst: { flushMs: 0 },
      frameMs: 0,                    // same seam: synchronous paints, not real timers
    } });
    const pause = () => new Promise(resolve => setTimeout(resolve, 40));
    await pause(); stdin.emit('data', '1+1');
    await pause(); stdin.emit('data', '\r');
    await pause(); stdin.emit('data', '/exit');
    await pause(); stdin.emit('data', '\r');
    await done;
    assert.deepEqual(submitted, ['1+1']);
    const result = runBehavior({ name: 'type_and_enter', prompts: ['1+1'] }, {
      ...base, pty: () => ({ output: chunks.join(''), exitCode: 0 }),
    });
    assert.equal(result.pass, reply !== '', `actual TUI capture with reply ${JSON.stringify(reply)}`);
  }

  const problem = [{ id: 'crash' }];
  let calls = 0;
  const checked = await reproduces({}, problem, 2, async () => {
    calls++; return { invariants: calls < 3 ? problem : [] };
  });
  assert.equal(calls, 2); assert.deepEqual(checked.invariants, problem);
  assert.equal(await reproduces({}, problem, 2, async () => ({ invariants: [{ id: 'different' }] })), null);
  assert.equal(await reproduces({}, problem, 2, async () => ({ invariants: [] })), null);
  await assert.rejects(reproduces({}, problem, 2, async () => { throw Error('harness unavailable'); }));
  const finding = { script: ['"hi"', 1], spec: {}, invariants: problem };
  await assert.rejects(verifyFinding({}));
  await assert.rejects(verifyFinding({ ...finding, script: ['null'] }));
  assert.equal((await verifyFinding(finding, async () => ({ invariants: [] }))).stillBroken, false);
  assert.equal((await verifyFinding(finding, async () => ({ invariants: problem }))).stillBroken, true);
  await assert.rejects(verifyFinding(finding, async () => { throw Error('unavailable'); }));

  const clean = { raw: '[JOURNEY-EXITED]', screen: '', screenAtRest: '', exitCode: 0, timedOut: false };
  assert.deepEqual(checkInvariants(clean), []);
  assert(checkInvariants({ ...clean, exitCode: 127, raw: 'node: command not found' }).some(p => p.id === 'unexpected-exit'));
  assert(checkInvariants({ ...clean, raw: '' }).some(p => p.id === 'incomplete-journey'));

  // Triage's exit-class routing moved to scripts/loop/test-triage-once.mjs, which
  // drives the real script end to end instead of slicing shell text out of it and
  // re-declaring its variables by hand — a copy that had to be re-indexed on every
  // edit to the file it was quoting.
  console.log('PASS evidence: process failures, assertions, profile isolation, replay confirmation, startup invariants');
} finally { sandbox?.cleanup(); rmSync(fixture, { recursive: true, force: true }); }
