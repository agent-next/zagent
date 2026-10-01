// ZCODE_BUILTIN_PROVIDER_CONFIG_FILE passthrough. Desktop 3.12.1's kernel
// exits "无法定位 CLI ZCode Built-in Provider Config" without it; zagent must set
// it at every kernel spawn when the bundled config exists beside the runtime.
// Fixture = a fake resources tree whose glm/zcode.cjs stub echoes the env back.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kernelEnv } from './runtime.mjs';
import { ZCodeProtocolClient } from './zcode-protocol.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'zagent-builtin-provider-'));
let preset; // ambient ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, saved for restore
try {
  // --- unit: the helper itself ---
  const entry = path.join(tmp, 'resources', 'glm', 'zcode.cjs');
  const cfg = path.join(tmp, 'resources', 'config', 'provider', 'zcode-builtin.json');
  mkdirSync(path.dirname(entry), { recursive: true });
  const exists = p => p === entry || p === cfg;
  assert.equal(kernelEnv(entry, {}, () => false).ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, undefined,
    'no config file -> variable not set');
  assert.equal(kernelEnv(entry, { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '/preset' }, exists)
    .ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, '/preset', 'caller value is never overridden');
  assert.equal(kernelEnv(entry, {}, exists).ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, cfg,
    'bundled config beside the runtime is passed through');

  // --- fixture kernel: echoes the variable for -p, answers NDJSON for app-server ---
  writeFileSync(entry, `const fs = require('node:fs');
if (process.env.STUB_ENV_OUT) { try { fs.writeFileSync(process.env.STUB_ENV_OUT, process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? ''); } catch {} }
if (process.argv[2] === 'app-server') {
  let buf = '';
  process.stdin.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\\r$/, ''); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m && m.id !== undefined && m.method) process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\\n');
    }
  });
  process.stdin.resume();
} else {
  process.stdout.write(JSON.stringify({ response: 'pong', cfg: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? null }));
}
`);
  mkdirSync(path.dirname(cfg), { recursive: true });
  writeFileSync(cfg, '{"schemaVersion":1}');

  const zagent = fileURLToPath(new URL('../cli/zagent.mjs', import.meta.url));
  const fakeHome = path.join(tmp, 'home'); // ensureConfig writes ~/.zcode/cli here, never the real one
  const baseEnv = { PATH: process.env.PATH, HOME: fakeHome, USERPROFILE: fakeHome,
    TMPDIR: process.env.TMPDIR, ZCODE_RUNTIME: entry, ZAI_API_KEY: 'fixture-key' };
  const headless = (extra = {}) =>
    spawnSync(process.execPath, [zagent, '-p', 'hi', '--json'], { env: { ...baseEnv, ...extra }, encoding: 'utf8', timeout: 30000 });

  // headless -p --json child gets the bundled config path
  let r = headless();
  assert.equal(r.status, 0, `fixture headless run failed: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).cfg, cfg, 'headless child did not receive the bundled provider config');

  // an explicit caller value survives end-to-end
  r = headless({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '/preset/zcode-builtin.json' });
  assert.equal(r.status, 0, `preset headless run failed: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).cfg, '/preset/zcode-builtin.json', 'caller-set variable was overridden');

  // no bundled config -> nothing is invented
  rmSync(cfg);
  r = headless();
  assert.equal(r.status, 0, `no-config headless run failed: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).cfg, null, 'variable was set without a config file');
  writeFileSync(cfg, '{"schemaVersion":1}');

  // app-server path (ZCodeProtocolClient) gets it too — proven via the stub's env dump
  const dump = path.join(tmp, 'stub-env.out');
  preset = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE; // isolate from the ambient env
  delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  process.env.STUB_ENV_OUT = dump;
  const client = new ZCodeProtocolClient({ runtime: entry });
  await client.ready;
  assert.deepEqual(await client.listSessions(), {});
  client.close();
  await client.exited;
  assert.equal(readFileSync(dump, 'utf8'), cfg, 'app-server spawn did not receive the provider config');

  console.log('PASS builtin provider config env passthrough (headless + app-server)');
} finally {
  delete process.env.STUB_ENV_OUT;
  if (preset === undefined) delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  else process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = preset;
  rmSync(tmp, { recursive: true, force: true });
}
