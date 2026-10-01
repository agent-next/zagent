import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, runProcess, gradeTask, nativeUsage, plan, parseOptions, writeReport, finalizeSummary } from './paired-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = mkdtempSync(path.join(os.tmpdir(), 'paired-runner-test-'));
try {
  const home = path.join(fixture, 'home'); mkdirSync(home);
  const env = isolatedEnv(home, fixture);
  assert.equal(env.HOME, home); assert.equal(env.USERPROFILE, home);
  for (const name of ['ZAI_API_KEY', 'ZAI_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OP_SERVICE_ACCOUNT_TOKEN', 'NODE_OPTIONS'])
    assert(!Object.hasOwn(env, name), `inherited environment must exclude ${name}`);
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'));
  assert.equal(parseOptions([]).live, false);
  assert.equal(parseOptions(['--acknowledge-host-access']).acknowledgeHostAccess, true);
  assert.equal(parseOptions(['--model', 'glm-5.3-flash']).model, 'glm-5.3-flash');
  assert.throws(() => parseOptions(['--model', 'unknown']));
  assert.throws(() => parseOptions(['--dry-run', '--live']));
  assert.throws(() => parseOptions(['--cooldown-ms', '0']));
  assert.throws(() => parseOptions(['--output']));
  assert.throws(() => parseOptions(['--unknown']));
  const protocol = plan();
  assert.equal(protocol.expectedCells, 60);
  // Not a literal: the harness reports whatever package.json says, and this repo's
  // package has been renamed once already. Assert the two agree instead.
  assert.equal(protocol.package,
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name,
    'the plan reports the package under test by its real name');
  assert.equal(protocol.modelCalls, false);
  assert.equal(plan(3, 'glm-5.3-flash').expectedCells, 60);
  assert.equal(plan(3, 'glm-5.3-flash').billing.freeTokenEntitlement, 'unverified');
  assert.equal(Object.keys(protocol.inputs).length, 10);
  for (const input of Object.values(protocol.inputs)) {
    assert.match(input['test.py'], /^[a-f0-9]{64}$/);
    assert.match(input['task.md'], /^[a-f0-9]{64}$/);
  }
  const completeRecords = protocol.matrix.map(cell => ({ ...cell, pass: true, failureCategory: null, wallMs: 1 }));
  const validSummary = finalizeSummary(completeRecords, protocol.expectedCells,
    { protectedUnchanged: true, fixtureRemoved: true });
  assert.equal(validSummary.measurementValid, true);
  assert.equal(validSummary.acceptancePassed, true);
  const uncleanSummary = finalizeSummary(completeRecords, protocol.expectedCells,
    { protectedUnchanged: true, fixtureRemoved: false });
  assert.equal(uncleanSummary.measurementValid, false);
  assert.equal(uncleanSummary.acceptancePassed, false);
  const malformed = completeRecords.slice(0, 59).concat({ ...completeRecords[0] });
  const malformedSummary = finalizeSummary(malformed, protocol.expectedCells,
    { protectedUnchanged: true, fixtureRemoved: true });
  assert.equal(malformedSummary.complete, false);
  assert.equal(malformedSummary.measurementValid, false);
  assert.equal(malformedSummary.acceptancePassed, false);
  const correctnessFailure = completeRecords.map(record => ({ ...record }));
  correctnessFailure[0] = { ...correctnessFailure[0], pass: false, failureCategory: 'incorrect' };
  const correctnessSummary = finalizeSummary(correctnessFailure, protocol.expectedCells,
    { protectedUnchanged: true, fixtureRemoved: true });
  assert.equal(correctnessSummary.complete, true);
  assert.equal(correctnessSummary.measurementValid, true);
  assert.equal(correctnessSummary.acceptancePassed, false);
  const dry = await runProcess(process.execPath, ['bench/paired-release.mjs', '--dry-run'], { cwd: root, env });
  assert.equal(dry.status, 0);
  assert.equal(JSON.parse(dry.stdout).expectedCells, 60);
  assert(!existsSync(path.join(home, '.zcode')));
  assert(!existsSync(path.join(home, '.claude')));
  const denied = await runProcess(process.execPath, ['bench/paired-release.mjs', '--live', '--dry-run'], { cwd: root, env });
  assert.equal(denied.status, 1);
  const unacknowledged = await runProcess(process.execPath, ['bench/paired-release.mjs', '--live'], { cwd: root, env });
  assert.equal(unacknowledged.status, 1);
  assert(!existsSync(path.join(home, '.zcode')));
  const output = await runProcess(process.execPath, ['-e', 'process.stdout.write("answer"); process.stderr.write("diagnostic")'], { cwd: fixture, env });
  assert.equal(output.status, 0); assert.equal(output.stdout, 'answer');
  assert.equal(output.stderr, 'diagnostic'); assert(output.wallMs >= 0);
  const timeout = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { cwd: fixture, env, timeoutMs: 100 });
  assert(timeout.timedOut); assert.notEqual(timeout.status, 0);
  const missing = await runProcess(path.join(fixture, 'absent'), [], { cwd: fixture, env });
  assert.equal(missing.status, 1);
  const overflow = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], { cwd: fixture, env, maxBytes: 16 });
  assert.equal(overflow.status, 1);
  assert(overflow.stdout.length <= 16);
  assert.equal(nativeUsage('{"usage":{"input_tokens":123,"secret":"never export","output_tokens":-1}}').input_tokens, 123);
  assert.deepEqual(nativeUsage('{"usage":{"input_tokens":123,"secret":"never export","output_tokens":-1}}'), { input_tokens: 123 });
  assert.equal(nativeUsage('not json'), null);
  const report = writeReport(protocol, [], { measurementValid: false, acceptancePassed: false, protectedUnchanged: true, stopReason: 'rate_limit' });
  assert.match(report, /Observed: 0\/60/);
  assert.match(report, /rate_limit/);
  assert.match(report, /unknown, never zero/);
  const workspace = path.join(fixture, 'workspace'); mkdirSync(workspace);
  const oracle = Buffer.from('from solution import add\nassert add(2, 3) == 5\n');
  const files = [{ name: 'test.py', bytes: oracle }];
  writeFileSync(path.join(workspace, 'test.py'), 'raise Exception("must not use agent oracle")');
  assert(await gradeTask({ files, workspace, grade: path.join(fixture, 'grade-pass'), response: 'def add(a,b): return a+b', env }));
  assert.deepEqual(readFileSync(path.join(fixture, 'grade-pass/test.py')), oracle);
  assert.equal(await gradeTask({ files, workspace, grade: path.join(fixture, 'grade-fail'), response: 'def add(a,b): return a-b', env }), false);
  const agentic = [{ name: 'agent_graded', bytes: Buffer.alloc(0) },
    { name: 'calc.py', bytes: Buffer.from('def add(a,b): return a-b') },
    { name: 'test.py', bytes: Buffer.from('from calc import add\nassert add(2,3)==5\n') }];
  writeFileSync(path.join(workspace, 'calc.py'), 'def add(a,b): return a+b');
  assert(await gradeTask({ files: agentic, workspace, grade: path.join(fixture, 'grade-agentic'), response: '', env }));
  console.log('PASS paired release: plan, isolation, process failures, hidden oracle, agentic grading');
} finally { rmSync(fixture, { recursive: true, force: true }); }
