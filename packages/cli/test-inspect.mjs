#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', path.join(root, 'packages/cli/zagent-inspect.mjs'), '--json'], {
  encoding: 'utf8',
  timeout: 15000,
  env: { ...process.env },
});
assert.equal(r.error, undefined, r.error?.message);
const report = JSON.parse(r.stdout);
assert.ok(report && typeof report === 'object');
assert.ok(Array.isArray(report.skills));
// runtime.version flows through from the driver: the key is always present,
// a string when the install carries one, null when it does not.
assert.ok(report.runtime === null || Object.hasOwn(report.runtime, 'version'),
  'runtime report must carry a version key');
if (report.runtime?.version != null) assert.equal(typeof report.runtime.version, 'string');
assert.ok(Array.isArray(report.conversations));
assert.ok(Array.isArray(report.plugins));
const blob = JSON.stringify(report.config ?? {});
assert.equal(/sk-[A-Za-z0-9]{10,}/.test(blob), false, 'inspect JSON must not leak sk- keys');
assert.equal(/"apiKey":\s*"[^["]/.test(blob) && !blob.includes('[redacted]'), false,
  'apiKey values must be redacted when present');

// camelCase secret keys must be redacted too — a lowercase-to-capital boundary
// (accessToken, clientSecret, refreshToken) used to slip past the regex.
const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'zagent-inspect-'));
mkdirSync(path.join(fakeHome, '.zcode', 'cli'), { recursive: true });
writeFileSync(path.join(fakeHome, '.zcode', 'cli', 'config.json'), JSON.stringify({
  providers: { zai: { apiKey: 'dummy-key-0001' } },
  auth: { accessToken: 'accesstoken-aaaa1111', refreshToken: 'refreshtoken-bbbb2222', clientSecret: 'clientsecret-cccc3333' },
  note: { monkey: 'not-a-secret', keyboard: 'also-not' },
}));
// The plugin store is ~/.zcode/cli/plugins (THIRD layout) — reading the bare
// ~/.zcode/plugins dir instead used to leave this line permanently "(none)".
const pluginDir = path.join(fakeHome, '.zcode', 'cli', 'plugins', 'cache', 'mkt', 'demo', '1.2.3', '.zcode-plugin');
mkdirSync(pluginDir, { recursive: true });
writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.2.3' }));
const r2 = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', path.join(root, 'packages/cli/zagent-inspect.mjs'), '--json'], {
  encoding: 'utf8',
  timeout: 15000,
  env: {
    PATH: process.env.PATH,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    LANG: process.env.LANG ?? 'C',
  },
});
assert.equal(r2.error, undefined, r2.error?.message);
const blob2 = r2.stdout;
assert.ok(JSON.parse(blob2).plugins.includes('demo@1.2.3'), 'inspect must list installed plugins');
for (const leaked of ['dummy-key-0001', 'accesstoken-aaaa1111', 'refreshtoken-bbbb2222', 'clientsecret-cccc3333']) {
  assert.equal(blob2.includes(leaked), false, `inspect JSON leaked secret value: ${leaked}`);
}
assert.ok(blob2.includes('not-a-secret'), 'non-secret values must survive redaction');
// Paths under the user home render as ~/..., never absolute.
assert.equal(blob2.includes(fakeHome), false, 'inspect JSON must not print the absolute home path');
assert.ok(blob2.includes('~/.zcode/cli/config.json'), 'inspect renders the cli config path home-relative');
console.log('ok - inspect --json is parseable and redacts secrets');
process.exit(0);
