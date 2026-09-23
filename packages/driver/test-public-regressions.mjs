// Offline release regressions: isolate all state and never contact the relay.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'zagent-public-regressions-'));
const originalHome = process.env.HOME;
const originalProfile = process.env.USERPROFILE;
const originalMid = process.env.ZCODE_DEVICE_MID;
const originalBase = process.env.ZCODE_BASE_URL;
const originalFetch = globalThis.fetch;
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.ZCODE_BASE_URL = 'https://release-fixture.invalid';
delete process.env.ZCODE_DEVICE_MID;

try {
  // Fail before importing modules that capture user-state paths at module load.
  assert.equal(homedir(), sandbox, 'user state must resolve inside the test sandbox');
  const { fetchWindow, cachedWindow, defaultWindow } = await import('./offpeak.mjs');
  const { ensureDeviceSid } = await import('./relay.mjs');
  const cliDir = join(sandbox, '.zcode', 'cli');
  mkdirSync(cliDir, { recursive: true });

  await test('default device resolution reuses cached SID without connecting', async () => {
    writeFileSync(join(cliDir, 'device.json'), JSON.stringify({ deviceMid: 'fixture-device' }));
    writeFileSync(join(cliDir, 'relay-state.json'), JSON.stringify({ deviceMid: 'fixture-device', deviceSid: 'fixture-sid' }));
    assert.equal(await ensureDeviceSid(), 'fixture-sid');
    assert.equal(await ensureDeviceSid({ deviceMid: 'fixture-device' }), 'fixture-sid');
    process.env.ZCODE_DEVICE_MID = 'fixture-env-device';
    writeFileSync(join(cliDir, 'relay-state.json'), JSON.stringify({ deviceMid: 'fixture-env-device', deviceSid: 'fixture-env-sid' }));
    assert.equal(await ensureDeviceSid(), 'fixture-env-sid');
  });

  await test('off-peak window fetch reaches server and persists allowed models', async () => {
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(new URL(url).origin, 'https://release-fixture.invalid');
      assert.equal(new URL(url).pathname, '/api/v1/client/configs');
      assert.ok(options.signal instanceof AbortSignal);
      return { json: async () => ({ data: { configs: { offPeak: {
        enable_offpeak_task: true, allowed_models: ['fixture-flash'],
      } } } }) };
    };
    const win = await fetchWindow();
    assert.equal(calls, 1);
    assert.equal(win.source, 'server');
    assert.deepEqual(win.allowedModels, ['fixture-flash']);
    assert.deepEqual(JSON.parse(readFileSync(join(cliDir, 'offpeak-cache.json'), 'utf8')).allowedModels, ['fixture-flash']);
    assert.deepEqual(cachedWindow().allowedModels, ['fixture-flash']);
    globalThis.fetch = async () => { throw new Error('offline fixture'); };
    assert.deepEqual(await fetchWindow(), defaultWindow());
  });

  await test('registerDevice rejects when relay secrets are unreadable', async () => {
    // The sandbox has no ~/.zcode/v2/credentials.json, so relaySecrets() throws
    // inside the ws 'open' handler. The contract: the promise REJECTS — the error
    // must never escape the EventEmitter callback as an uncaughtException, which
    // kills the host while the register promise stays pending forever.
    const { EventEmitter } = await import('node:events');
    const { registerDevice } = await import('./relay.mjs');
    class FakeSocket extends EventEmitter {
      constructor() { super(); queueMicrotask(() => this.emit('open')); }
      send() {}
      close() {}
    }
    const crashes = [];
    const onCrash = (e) => crashes.push(e);
    process.on('uncaughtException', onCrash);
    try {
      const outcome = await Promise.race([
        registerDevice({ deviceMid: 'fixture-device', WebSocketImpl: FakeSocket })
          .then(() => 'resolved', (e) => `rejected: ${e.message}`),
        new Promise(r => setTimeout(() => r('still pending'), 1000)),
      ]);
      assert.match(outcome, /^rejected: /, 'registerDevice must reject');
      assert.equal(crashes.length, 0, 'credential failure must not escape as uncaughtException');
    } finally {
      process.off('uncaughtException', onCrash);
    }
  });

  await test('credential store is owner-only on write and self-heals on load', async () => {
    // ~/.zcode/v2/credentials.json holds the zcode JWT and the coding-plan key;
    // a group/world-readable store (observed 0664) leaks them to other users.
    const { saveCredentialStore, loadCredentialStore } = await import('./credentials.mjs');
    const credFile = join(sandbox, '.zcode', 'v2', 'credentials.json');
    saveCredentialStore({ 'fixture-key': 'fixture-secret' });
    if (process.platform !== 'win32') {
      assert.equal(statSync(credFile).mode & 0o777, 0o600, 'store written mode 0600');
      // An older/foreign writer left the store permissive: a successful load heals it.
      // (writeFileSync mode is ignored on an existing file — chmod is what actually
      // makes the fixture permissive, so this pins the heal for real.)
      writeFileSync(credFile, JSON.stringify({ healed: 'yes' }));
      chmodSync(credFile, 0o644);
      loadCredentialStore();
      assert.equal(statSync(credFile).mode & 0o777, 0o600, 'load tightens a permissive store to 0600');
    }
  });

  await test('off-peak suite executes its eligibility assertions before exit', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./test-offpeak.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, ZAGENT_TEST_SANDBOX: sandbox },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ok - gate: 200 with EMPTY data/);
    assert.match(result.stdout, /ok - gate: one reason when failing/);
    assert.equal(result.stdout.match(/PASS offpeak-full/g)?.length, 1);
  });
} finally {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalProfile;
  if (originalMid === undefined) delete process.env.ZCODE_DEVICE_MID;
  else process.env.ZCODE_DEVICE_MID = originalMid;
  if (originalBase === undefined) delete process.env.ZCODE_BASE_URL;
  else process.env.ZCODE_BASE_URL = originalBase;
  rmSync(sandbox, { recursive: true, force: true });
}
