// Real CLI processes share an isolated state store. Agent execution is stubbed;
// delayed reads exercise interprocess claims and read/modify/write contention.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJobs, saveJobs, mutateJobs } from '../driver/automation.mjs';

const home = mkdtempSync(path.join(tmpdir(), 'zcron-concurrency-'));
try {
  mkdirSync(path.join(home, 'tmp'));
  const preload = path.join(home, 'fixture-preload.mjs');
  writeFileSync(preload, `import fs from 'node:fs';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-09-07T12:00:00Z'])); }
};
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const read = fs.readFileSync;
fs.readFileSync = (...args) => {
  const data = read(...args);
  if (String(args[0]).endsWith('/automations.json')) pause(25);
  return data;
};
// The tick runs the job through a detached spawn (process-group kill on
// timeout), so the fixture stubs spawn with a fake EventEmitter child.
cp.spawn = (_command, args) => {
  if (!String(args[0]).endsWith('/packages/cli/zagent.mjs')) throw new Error('unexpected fixture subprocess');
  fs.appendFileSync(process.env.CRON_TEST_HOME + '/executions', args[2] + '\\n');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 424242;
  const finish = () => {
    child.stdout.emit('data', '{"response":"synthetic answer"}');
    child.emit('close', 0, null);
  };
  if (args[2] === 'hold') {
    fs.writeFileSync(process.env.CRON_TEST_HOME + '/started', '');
    const deadline = RealDate.now() + 5000;
    const iv = setInterval(() => {
      if (fs.existsSync(process.env.CRON_TEST_HOME + '/release') || RealDate.now() > deadline) {
        clearInterval(iv);
        finish();
      }
    }, 10);
  } else setTimeout(finish, 100);
  return child;
};
syncBuiltinESMExports();
`);
  const cli = fileURLToPath(new URL('./zagent-cron.mjs', import.meta.url));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home, TMPDIR: path.join(home, 'tmp'), TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'), CRON_TEST_HOME: home };
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', preload, cli, ...args], {
      cwd: home, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }));
  });

  const additions = await Promise.all(Array.from({ length: 8 }, (_, i) => run(['add', `job-${i}`, '* * * * *', `prompt-${i}`])));
  assert.ok(additions.every(r => r.status === 0), JSON.stringify(additions));
  assert.equal(loadJobs({ home }).length, 8);
  console.log('ok - eight concurrent CLI additions retain every job');
  const removals = await Promise.all(Array.from({ length: 8 }, (_, i) => run(['remove', `job-${i}`])));
  assert.ok(removals.every(r => r.status === 0), JSON.stringify(removals));
  assert.equal(loadJobs({ home }).length, 0);
  console.log('ok - eight concurrent CLI removals do not resurrect other jobs');

  saveJobs([{ id: 'one', cron: '* * * * *', prompt: 'once', workspace: home, status: 'idle' }], { home });
  const ticks = await Promise.all([run(['tick']), run(['tick'])]);
  assert.ok(ticks.every(r => r.status === 0), JSON.stringify(ticks));
  assert.equal(readFileSync(path.join(home, 'executions'), 'utf8'), 'once\n');
  assert.equal(loadJobs({ home })[0].status, 'idle');
  assert.equal((await run(['tick'])).status, 0);
  assert.equal(readFileSync(path.join(home, 'executions'), 'utf8'), 'once\n');
  console.log('ok - overlapping ticks and repeated same-minute ticks execute one occurrence once');

  saveJobs([{ id: 'held', cron: '* * * * *', prompt: 'hold', workspace: home, status: 'idle' }], { home });
  const heldTick = run(['tick']);
  let heldResult;
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(path.join(home, 'started')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(path.join(home, 'started')), 'agent fixture started');
    assert.equal((await run(['add', 'during-run', '* * * * *', 'saved'])).status, 0);
  } finally {
    writeFileSync(path.join(home, 'release'), '');
    heldResult = await heldTick;
  }
  assert.equal(heldResult.status, 0);
  const after = loadJobs({ home });
  assert.equal(after.length, 2);
  assert.equal(after.find(j => j.id === 'held').status, 'idle');
  assert.equal(after.find(j => j.id === 'during-run').prompt, 'saved');
  console.log('ok - job completion preserves an addition made while the agent runs');

  // Kill a process inside the state transaction. The coordination database must
  // release its OS lock; the uncommitted in-memory job must never reach JSON.
  const driverUrl = new URL('../driver/automation.mjs', import.meta.url).href;
  const lockHolder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    import { mutateJobs } from ${JSON.stringify(driverUrl)};
    mutateJobs(jobs => {
      jobs.push({ id: 'uncommitted-owner' });
      writeFileSync(process.env.CRON_TEST_HOME + '/owner-ready', '');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });
  `], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  lockHolder.stderr.resume();
  const holderClosed = new Promise((resolve, reject) => { lockHolder.on('error', reject); lockHolder.on('close', resolve); });
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(path.join(home, 'owner-ready')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(path.join(home, 'owner-ready')), 'lock owner entered transaction');
    assert.throws(() => mutateJobs(() => {}, { home, lockTimeoutMs: 20 }), /locked/, 'live owner excludes another writer');
  } finally {
    lockHolder.kill('SIGKILL');
    await holderClosed;
  }
  assert.equal((await run(['add', 'after-owner-death', '* * * * *', 'recovered'])).status, 0);
  const recovered = loadJobs({ home });
  assert.ok(recovered.some(j => j.id === 'after-owner-death'));
  assert.ok(!recovered.some(j => j.id === 'uncommitted-owner'));
  console.log('ok - killed transaction owner releases the lock without persisting its unfinished update');

  const bin = fileURLToPath(new URL('../../bin/zagent', import.meta.url));
  const publicList = spawnSync(process.execPath, [bin, 'cron', 'list'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(publicList.status, 0, publicList.stderr);
  assert.equal(publicList.stderr, '', 'normal public cron output has no SQLite warning');
  console.log('ok - public cron listing suppresses experimental SQLite warnings');
  assert.ok(!readdirSync(path.join(home, '.zcode/cli')).some(name => name.endsWith('.lock') || name.includes('.tmp-')));
  console.log('PASS automation concurrency (6 cases)');
} finally { rmSync(home, { recursive: true, force: true }); }
