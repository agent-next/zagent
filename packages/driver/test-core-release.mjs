import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRuntime, DEFAULT_RUNTIME } from './runtime.mjs';
import { ZCodeProtocolClient } from './zcode-protocol.mjs';
import { acceptRequest, currentAnswer, isolatedTurn, serializeWorkspaces, DAEMON_TURN_TIMEOUT_MS, DAEMON_RESPONSE_TIMEOUT_MS } from '../cli/daemon-request.mjs';
import { installPlugin } from './plugins.mjs';

const home = mkdtempSync(path.join(os.tmpdir(), 'zcore-'));
try {
  // The per-user app-cli root differs per OS: ~/.local/opt on POSIX,
  // %APPDATA%\npm on win32 — feed the matching env so the probe path is real.
  const roaming = path.join(home, 'app-roaming');
  const appEnv = process.platform === 'win32' ? { APPDATA: roaming } : {};
  const userRoot = process.platform === 'win32'
    ? path.join(roaming, 'npm')
    : `${home}/.local/opt/zcode-app-cli`;
  const local = path.join(userRoot, 'node_modules', 'zcode-app-cli', 'bin', 'zcode.js');
  const cwdEntry = path.join(home, 'workspace', 'node_modules', 'zcode-app-cli', 'bin', 'zcode.js');
  const choose = available => findRuntime({ env: appEnv, home, cwd: path.join(home, 'workspace'), exists: p => available.includes(p) });
  // the official desktop bundle is probed from the per-OS table — the win32
  // table never contains the linux deb literal, so name the matching root
  const desktopEntry = process.platform === 'win32'
    ? 'C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs' : DEFAULT_RUNTIME;
  assert.equal(choose([local, cwdEntry, desktopEntry]).entry, desktopEntry); // official desktop first
  assert.equal(choose([local, cwdEntry]).entry, local); // app-cli install root before cwd
  assert.equal(choose([cwdEntry, desktopEntry]).entry, desktopEntry);
  assert.equal(choose([desktopEntry]).entry, desktopEntry);
  assert.equal(choose([]), null);
  assert.equal(findRuntime({ env: { ZCODE_RUNTIME: 'override' }, cwd: home, exists: () => true }).entry, path.resolve(home, 'override'));
  assert.equal(findRuntime({ env: { ZCODE_RUNTIME: 'missing' }, exists: p => p === DEFAULT_RUNTIME }), null);
  const runtime = path.join(home, 'runtime.cjs');
  writeFileSync(runtime, `if (process.argv.includes('app-server')) {
    process.stdin.on('data', d => { for (const line of String(d).trim().split('\\n')) {
      const m = JSON.parse(line); if (m.id) process.stdout.write(JSON.stringify({id:m.id,result:{sessions:[]}})+'\\n');
    }});
  } else console.log('fixture-runtime');`);
  const oldRuntime = process.env.ZCODE_RUNTIME;
  process.env.ZCODE_RUNTIME = runtime;
  try {
    const client = new ZCodeProtocolClient({ cwd: home });
    try { await client.ready; assert.deepEqual(await client.call('session/list'), { sessions: [] }); }
    finally { client.close(); }
    mkdirSync(`${home}/.zcode/cli`, { recursive: true });
    writeFileSync(`${home}/.zcode/cli/config.json`, '{}');
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../cli/zagent.mjs', import.meta.url)), '-p', 'fixture'], {
      env: { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /fixture-runtime/);
  } finally { if (oldRuntime === undefined) delete process.env.ZCODE_RUNTIME; else process.env.ZCODE_RUNTIME = oldRuntime; }

  class Socket extends EventEmitter {
    setEncoding() {}
    end(value) { this.responses.push(JSON.parse(value)); }
    responses = [];
  }
  for (const input of ['{\n', 'null\n', '[]\n', '{"cwd":"relative","prompt":"x"}\n', '{"cwd":"/tmp","prompt":5}\n', '{"cwd":"/tmp","op":"unknown"}\n']) {
    const sock = new Socket();
    acceptRequest(sock, () => { throw new Error('must not execute'); });
    sock.emit('data', input);
    assert.equal(sock.responses.length, 1);
    assert.ok(sock.responses[0].error);
  }
  const oversized = new Socket();
  acceptRequest(oversized, () => {}, { maxBytes: 4 });
  oversized.emit('data', '12345');
  assert.equal(oversized.responses[0].error, 'request too large');
  const sock = new Socket();
  let calls = 0, finish;
  acceptRequest(sock, async () => { calls++; await new Promise(r => finish = r); return { answer: 'ok' }; });
  sock.emit('data', '{"cwd":"/tmp",');
  assert.equal(calls, 0);
  sock.emit('data', '"prompt":"x"}\n{"cwd":"/tmp","prompt":"duplicate"}\n');
  sock.emit('data', '{"cwd":"/tmp","prompt":"race"}\n');
  assert.equal(calls, 1);
  finish(); await new Promise(r => setImmediate(r));
  assert.deepEqual(sock.responses, [{ answer: 'ok' }]);
  let release;
  const serial = serializeWorkspaces(async req => {
    if (req.wait) await new Promise(r => release = r);
    if (req.fail) throw new Error('fixture failure');
    return req.cwd;
  });
  const active = serial({ cwd: '/one', wait: true });
  await assert.rejects(serial({ cwd: '/one' }), /workspace busy/);
  assert.equal(await serial({ cwd: '/two' }), '/two');
  release(); await active;
  await assert.rejects(serial({ cwd: '/one', fail: true }), /fixture failure/);
  assert.equal(await serial({ cwd: '/one' }), '/one');
  const msg = (id, text) => ({ info: { id, role: 'assistant' }, parts: [{ type: 'text', text }] });
  const previous = msg('old', 'previous answer'), next = msg('new', 'current answer');
  assert.equal(currentAnswer([previous], [previous, next]), 'current answer');
  assert.equal(currentAnswer([previous], [previous]), '');
  let closed = 0, reads = 0;
  const cached = { sessionId: 's', client: { readSession: async () => ({ messages: reads++ ? [previous, next] : [previous] }), close: () => closed++ } };
  assert.equal(DAEMON_TURN_TIMEOUT_MS, 120_000);
  assert.ok(DAEMON_RESPONSE_TIMEOUT_MS >= DAEMON_TURN_TIMEOUT_MS + 30_000 + 4 * 20_000 + 10_000,
    'client deadline covers turn, cold readiness, pre/post RPCs and response transport');
  assert.equal((await isolatedTurn(cached, 'x', async (_client, _sid, _prompt, options) => {
    assert.equal(options.timeoutMs, DAEMON_TURN_TIMEOUT_MS);
    return { end: { ended: 'turn-completed' }, events: [] };
  })).answer, 'current answer');
  reads = 0;
  await assert.rejects(isolatedTurn(cached, 'x', async () => ({ end: { ended: 'timeout' } })), /session discarded/);
  assert.equal(closed, 1);
  assert.equal(reads, 1, 'timeout never reads or returns old session text');

  const bytes = Buffer.from('fixture archive'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const options = { home, name: 'demo', allowedHosts: ['fixture.invalid'], marketplaceJson: { plugins: [{ name: 'demo', source: { url: 'https://fixture.invalid/plugins/demo/1.0.0/plugin.zip', sha256 } }] },
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => bytes }),
    unzipCmd: (_, dir) => { mkdirSync(`${dir}/.zcode-plugin`); writeFileSync(`${dir}/.zcode-plugin/plugin.json`, JSON.stringify({ name: 'demo', version: '1.0.0' })); writeFileSync(`${dir}/content`, 'new'); return { status: 0 }; } };
  const installed = await installPlugin(options);
  for (const invalid of ['', '.', '..', '../escape', '/absolute', 'back\\slash', 'nul\0byte', 'C:drive']) {
    const noFetch = async () => { assert.fail('invalid identity must be rejected before download'); };
    await assert.rejects(installPlugin({ ...options, name: invalid, fetchImpl: noFetch }), /invalid plugin or marketplace/);
    await assert.rejects(installPlugin({ ...options, marketplaceId: invalid, fetchImpl: noFetch }), /invalid plugin or marketplace/);
    await assert.rejects(installPlugin({ ...options, marketplaceJson: { plugins: [{ name: 'demo', source: {
      url: `https://fixture.invalid/plugins/demo/${invalid}/plugin.zip`, sha256,
    } }] }, fetchImpl: noFetch }), /invalid marketplace version/);
  }
  writeFileSync(`${installed.path}/content`, 'old');
  await assert.rejects(installPlugin({ ...options, unzipCmd: () => ({ status: 1 }) }), /unzip failed/);
  assert.equal(readFileSync(`${installed.path}/content`, 'utf8'), 'old');
  await assert.rejects(installPlugin({ ...options, renameImpl: (from, to) => {
    if (path.basename(from).startsWith('.staging-')) throw new Error('fixture publication failure');
    renameSync(from, to);
  } }), /publication failure/);
  assert.equal(readFileSync(`${installed.path}/content`, 'utf8'), 'old');
  assert.deepEqual(readdirSync(path.dirname(installed.path)), ['1.0.0']);
  const originalManifest = readFileSync(`${installed.path}/.zcode-plugin/plugin.json`);
  const publicationError = new Error('fixture publication denied');
  const rollbackError = new Error('fixture rollback denied');
  let recovery;
  await assert.rejects(installPlugin({ ...options, renameImpl: (from, to) => {
    if (path.basename(from).startsWith('.staging-')) throw publicationError;
    if (path.basename(from).startsWith('.backup-')) throw rollbackError;
    renameSync(from, to);
  } }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.code, 'E_PLUGIN_ROLLBACK_FAILED');
    assert.equal(error.cause, publicationError);
    assert.deepEqual(error.errors, [publicationError, rollbackError]);
    assert.equal(error.destinationPath, installed.path);
    assert.ok(error.message.includes(error.backupPath));
    assert.match(error.message, /publication denied.*rollback denied/);
    recovery = error.backupPath;
    return true;
  });
  assert.equal(readFileSync(`${recovery}/content`, 'utf8'), 'old');
  assert.deepEqual(readFileSync(`${recovery}/.zcode-plugin/plugin.json`), originalManifest);
  assert.deepEqual(readdirSync(path.dirname(installed.path)), [path.basename(recovery)],
    'failed rollback retains only recoverable old plugin, with no staging or lock');
  renameSync(recovery, installed.path); // Exercise the disclosed manual recovery path in this fixture.
  await Promise.all([installPlugin(options), installPlugin(options)]);
  assert.equal(readFileSync(`${installed.path}/content`, 'utf8'), 'new');
  assert.deepEqual(readdirSync(path.dirname(installed.path)), ['1.0.0']);
  console.log('PASS core release: runtime discovery/CLI/driver, malformed/fragmented/duplicate requests, current answer/timeout disposal, plugin rollback/replacement');
} finally { rmSync(home, { recursive: true, force: true }); }
