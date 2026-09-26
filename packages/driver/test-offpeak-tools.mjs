// `zagent offpeak tools` contract — the 3.12.x workspace/updateOffPeakToolPolicy
// RPC plus the persisted store that session/create applies.
//
// The kernel keeps offPeakToolEnabled in app-server memory; zagent's store
// (~/.zcode/cli/offpeak-tools.json) is what makes a toggle survive the next
// invocation. These tests drive a fake app-server over NDJSON stdio so every
// claim — payload shape, echo handling, capability refusal, session/create
// application — is verified against the wire, not against prose.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(root, 'packages', 'cli', 'zagent-offpeak.mjs');
const home = mkdtempSync(path.join(tmpdir(), 'zagent-offpeak-tools-'));

// A minimal NDJSON app-server: answers session/list (the client's ready probe),
// echoes workspace/updateOffPeakToolPolicy, accepts session/create, and logs
// every request to FAKE_LOG. FAKE_DENY=1 makes the update RPC fail -32601 like
// a pre-3.12.x runtime; FAKE_STRICT=1 makes session/create reject the
// offPeakToolEnabled field -32602 like a strict old schema.
const runtime = path.join(home, 'fake-runtime.cjs');
const logFile = path.join(home, 'fake.log');
writeFileSync(runtime, `
const fs = require('fs'), rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', l => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id === undefined || !m.method) return;
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(m) + '\\n');
  const reply = o => process.stdout.write(JSON.stringify({ id: m.id, ...o }) + '\\n');
  if (m.method === 'session/list') return reply({ result: { sessions: [] } });
  if (m.method === 'workspace/updateOffPeakToolPolicy') {
    if (process.env.FAKE_DENY === '1') return reply({ error: { code: -32601, message: 'method not found' } });
    return reply({ result: { workspace: m.params.workspace, enabled: m.params.enabled } });
  }
  if (m.method === 'session/create') {
    if (process.env.FAKE_STRICT === '1' && 'offPeakToolEnabled' in (m.params ?? {}))
      return reply({ error: { code: -32602, message: 'invalid params: unrecognized key offPeakToolEnabled' } });
    return reply({ result: { sessionId: 'sess_fake' } });
  }
  reply({ error: { code: -32601, message: 'method not found' } });
});`);

const env = extra => ({
  ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home,
  ZCODE_RUNTIME: runtime, FAKE_LOG: logFile, ...extra,
});
const run = (args, extra) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30000, env: env(extra) });
const requests = () => existsSync(logFile)
  ? readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
const store = () => path.join(home, '.zcode', 'cli', 'offpeak-tools.json');

try {
  // --- tools on: the RPC is sent with the verified {workspace, enabled} shape -
  let r = run(['tools', 'on', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const on = JSON.parse(r.stdout);
  assert.equal(on.enabled, true);
  const upd = requests().find(m => m.method === 'workspace/updateOffPeakToolPolicy');
  assert.ok(upd, 'the RPC reached the runtime');
  assert.equal(upd.params.enabled, true);
  assert.equal(upd.params.workspace.workspaceKey, path.normalize(process.cwd()));
  assert.equal(upd.params.workspace.workspacePath, path.normalize(process.cwd()));
  assert.deepEqual(JSON.parse(readFileSync(store(), 'utf8')).enabled, true,
    'the store persisted the toggle for future session/create calls');

  // --- tools off / bare tools -------------------------------------------------
  r = run(['tools', 'off']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(store(), 'utf8')).enabled, false);
  const before = requests().filter(m => m.method === 'workspace/updateOffPeakToolPolicy').length;
  r = run(['tools']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /off-peak tool: off/);
  assert.equal(requests().filter(m => m.method === 'workspace/updateOffPeakToolPolicy').length,
    before, 'a bare status read must not mutate the runtime');

  // --- flag order is free: --json may lead, and bare `tools --json` reads -----
  r = run(['--json', 'tools', 'on']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).enabled, true);
  r = run(['tools', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).enabled, true);

  // --- usage errors -------------------------------------------------------------
  for (const bad of [['tools', 'bogus'], ['tools', 'on', 'extra']]) {
    r = run(bad);
    assert.equal(r.status, 2, `${bad.join(' ')} should be a usage error`);
    assert.match(r.stderr, /usage: zagent offpeak tools/);
  }

  // --- capability refusal: -32601 (pre-3.12.x runtime) fails closed ------------
  rmSync(store(), { force: true });
  r = run(['tools', 'on'], { FAKE_DENY: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /3\.12/);
  assert.equal(existsSync(store()), false,
    'a runtime that cannot honor the toggle must not leave a stored policy behind');

  // --- session/create applies the stored flag — and sheds it for old runtimes --
  const drive = extra => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { ZCodeProtocolClient } from '${pathToFileURL(path.join(root, 'packages/driver/zcode-protocol.mjs')).href}';
    const c = new ZCodeProtocolClient({ cwd: process.cwd() });
    await c.ready;
    const res = await c.createSession(process.cwd());
    console.log('SID:' + (res.sessionId ?? res.session?.sessionId));
    c.close();
  `], { encoding: 'utf8', timeout: 30000, env: env(extra) });

  writeFileSync(store(), JSON.stringify({ enabled: true }));
  rmSync(logFile, { force: true });
  r = drive();
  assert.match(r.stdout, /SID:sess_fake/, r.stderr);
  let creates = requests().filter(m => m.method === 'session/create');
  assert.equal(creates.at(-1).params.offPeakToolEnabled, true,
    'stored policy=on must reach session/create');

  writeFileSync(store(), JSON.stringify({ enabled: false }));
  rmSync(logFile, { force: true });
  r = drive();
  creates = requests().filter(m => m.method === 'session/create');
  assert.ok(!('offPeakToolEnabled' in creates.at(-1).params),
    'policy=off sends nothing — the field is absent pre-3.12.x');

  // strict old runtime rejects the field: client retries without it and succeeds
  writeFileSync(store(), JSON.stringify({ enabled: true }));
  rmSync(logFile, { force: true });
  r = drive({ FAKE_STRICT: '1' });
  assert.match(r.stdout, /SID:sess_fake/, r.stderr);
  creates = requests().filter(m => m.method === 'session/create');
  assert.equal(creates.length, 2, 'one retry after the -32602');
  assert.equal(creates[0].params.offPeakToolEnabled, true);
  assert.ok(!('offPeakToolEnabled' in creates[1].params), 'the retry drops the field');

  console.log('ALL PASS');
} finally {
  rmSync(home, { recursive: true, force: true });
}
