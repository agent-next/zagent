import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installationPaths, npmInvocation, installedInvocation, forbidden, inspectReport } from './verify-public-package.mjs';

assert(forbidden.test('packages/driver/chat-turns.mjs'), 'preview bot helper must not ship to npm');

const pkg = { name: 'zagent', bin: { zagent: 'bin/zagent', za: 'bin/zagent' } };
for (const platform of ['linux', 'darwin']) {
  assert.deepEqual(installationPaths('/install', pkg, platform), {
    installed: '/install/lib/node_modules/zagent',
    bins: { zagent: '/install/bin/zagent', za: '/install/bin/za' },
  });
}
assert.deepEqual(installationPaths('C:\\install', pkg, 'win32'), {
  installed: 'C:\\install\\node_modules\\zagent',
  bins: { zagent: 'C:\\install\\zagent.cmd', za: 'C:\\install\\za.cmd' },
});
const windowsNode = 'C:\\Program Files\\nodejs\\node.exe';
const windowsNpm = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
assert.deepEqual(npmInvocation({ platform: 'win32', env: {}, execPath: windowsNode,
  exists: file => file === windowsNpm }), { command: windowsNode, args: [windowsNpm] });
assert.throws(() => npmInvocation({ platform: 'win32', env: {}, exists: () => false }), /npm-cli/);
const entry = 'C:\\Temp\\A&B%PATH%!\\install\\zagent.cmd';
const invocation = installedInvocation(entry, ['--version'], 'win32', { SystemRoot: 'C:\\Windows' });
assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
assert.deepEqual(invocation.args, ['/d', '/v:off', '/s', '/c', '""%ZAGENT_VERIFY_ENTRY%" --version"']);
assert.deepEqual(invocation.env, { ZAGENT_VERIFY_ENTRY: entry });
assert.equal(invocation.windowsVerbatimArguments, true, 'cmd.exe must receive its quoted command without CRT escaping');
assert.throws(() => installedInvocation(entry, ['--version & unwanted'], 'win32'), /unsafe/);

assert.equal(inspectReport({ runtime: null, config: {}, skills: [] }).runtime, null);
assert.throws(() => inspectReport({ runtime: null, config: {} }), /missing key: skills/);
assert.throws(() => inspectReport([]), /JSON object/);
assert.throws(() => inspectReport(null), /JSON object/);

const fixture = mkdtempSync(path.join(os.tmpdir(), 'zagent-verifier-test-'));
try {
  // Importing the actual verifier must not allocate a fixture, even when nobody
  // is present to clean up an outer test sandbox.
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    fs.mkdtempSync = () => { throw new Error('import allocated a fixture'); };
    syncBuiltinESMExports();
    await import(${JSON.stringify(new URL('./verify-public-package.mjs', import.meta.url).href)});
  `], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);

  // A failed pack must also clean the fixture. Mock only the subprocess boundary
  // so this never installs a package, contacts a registry, or reads credentials.
  const mock = `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
    cp.spawnSync = () => ({ status: 1, stdout: '', stderr: 'synthetic pack failure' });
    syncBuiltinESMExports();`;
  const failed = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(mock)}`,
    fileURLToPath(new URL('./verify-public-package.mjs', import.meta.url))], {
    env: { ...process.env, TMPDIR: fixture, TMP: fixture, TEMP: fixture }, encoding: 'utf8',
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /synthetic pack failure/);
  assert.deepEqual(readdirSync(fixture), [], 'failed verification must remove its fixture');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
console.log('PASS public verifier platform commands and cleanup');
