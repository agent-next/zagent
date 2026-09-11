#!/usr/bin/env node
// Exercise what consumers install, with no account profile or runtime access.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * What the published payload may and may not contain. Exported so the repo's
 * drift test can assert against the REAL predicates — it used to scrape them out
 * of this file with a regex, which broke on Windows the moment the checkout used
 * CRLF line endings.
 */
export const allowed = file => ['package.json', 'package-lock.json', 'VERSION', 'README.md', 'LICENSE', 'NOTICE',
  'bin/zmax', 'bin/zcodes', 'bin/zquota',
  // This script itself: the exported package's `npm test` runs it, so it ships.
  'scripts/verify-public-package.mjs'].includes(file)
  || /^packages\/(driver|cli|tui)\/[\w-]+\.mjs$/.test(file)
  || /^skills\/[\w-]+\/SKILL\.md$/.test(file);

// These name the INTERNAL filenames (zmax-*, zmaxd*), which were deliberately not
// renamed when the product became zagent. A rename-time find/replace turned them
// into zagent-*, which matches nothing on disk — so the block was dead for
// zmax-wechat, zmax-compact, zmaxd and zmaxd-compact.
// fake-host / journey / journey-entry / screen-replay are the hermetic PTY test
// harness. They are dev infrastructure — a published CLI has no business shipping
// a scriptable fake of its own runtime — but they do not start with "test", so the
// release gate would otherwise demand they be added to files[].
export const forbidden = /(?:^|\/)(?:test[^/]*|node_modules|\.env[^/]*|\.git|artifacts|docs)(?:\/|$)|(?:telegram|feishu|attachments|mentions|relay|controller-router|rpc-frame|rpc-bridge|chat-turns|daemon-request|zmax-(?:telegram|feishu|wechat|compact)|zmaxd[^/]*|fake-host|journey|journey-entry|screen-replay)\.mjs$/;

export function installationPaths(prefix, pkg, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const windows = platform === 'win32';
  return {
    installed: paths.join(prefix, ...(windows ? [] : ['lib']), 'node_modules', pkg.name),
    bins: Object.fromEntries(Object.keys(pkg.bin ?? {}).map(name =>
      [name, paths.join(prefix, ...(windows ? [] : ['bin']), `${name}${windows ? '.cmd' : ''}`)])),
  };
}

// Node cannot spawn npm.cmd directly. Invoke npm's JS entry with the current
// Node; npm test supplies npm_execpath, and standalone Windows Node installs
// place npm beside node.exe.
export function npmInvocation({ platform = process.platform, env = process.env,
  execPath = process.execPath, exists = existsSync } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const cli = [env.npm_execpath, paths.join(paths.dirname(execPath), 'node_modules/npm/bin/npm-cli.js')]
    .find(file => file && /\.js$/i.test(file) && exists(file));
  if (cli) return { command: execPath, args: [cli] };
  if (platform === 'win32') throw new Error('Cannot locate npm-cli.js; run this verifier with npm test');
  return { command: 'npm', args: [] };
}

export function installedInvocation(entry, args, platform = process.platform, env = process.env) {
  if (platform !== 'win32') return { command: entry, args, env: {} };
  // Only fixed smoke-test verbs/flags enter cmd.exe. Pass the path through an
  // environment variable so spaces, &, %, and ! in the install prefix remain
  // literal, with delayed expansion disabled.
  assert(args.every(arg => /^[\w-]+$/.test(arg)), 'unsafe Windows smoke-test argument');
  return { command: env.ComSpec || path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32/cmd.exe'),
    args: ['/d', '/v:off', '/s', '/c', `""%ZAGENT_VERIFY_ENTRY%" ${args.join(' ')}"`],
    env: { ZAGENT_VERIFY_ENTRY: entry }, windowsVerbatimArguments: true };
}

function main() {
const fixture = mkdtempSync(path.join(os.tmpdir(), 'zagent-package-'));
try {
const profile = path.join(fixture, 'home');
mkdirSync(profile);
const env = {
  ...Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']
    .filter(key => process.env[key]).map(key => [key, process.env[key]])),
  HOME: profile, USERPROFILE: profile, TMPDIR: fixture, TMP: fixture, TEMP: fixture,
  APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'),
  XDG_CONFIG_HOME: path.join(profile, '.config'),
  ZCODE_RUNTIME: path.join(fixture, 'missing-runtime.cjs'),
  npm_config_cache: path.join(fixture, 'npm-cache'),
  npm_config_userconfig: path.join(fixture, 'absent-npmrc'),
  npm_config_registry: 'https://registry.npmjs.org/',
};

const run = (cmd, args, cwd = fixture, expected = 0, invocation = {}) => {
  const result = spawnSync(cmd, args, { cwd, env: { ...env, ...invocation.env },
    windowsVerbatimArguments: invocation.windowsVerbatimArguments, encoding: 'utf8', timeout: 120000 });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${cmd} ${args.join(' ')}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
};
  const npm = npmInvocation();
  const runNpm = (args, cwd) => run(npm.command, [...npm.args, ...args], cwd);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const [packed] = JSON.parse(runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', fixture], root));
  const files = packed.files.map(f => f.path);
  assert(files.length > 10, 'payload must contain actual runtime modules');
  for (const file of files) {
    assert(allowed(file), `unexpected npm payload: ${file}`);
    assert(!forbidden.test(file), `private/test/experimental payload: ${file}`);
  }
  for (const file of ['bin/zmax', 'VERSION', 'packages/cli/zmax.mjs', 'packages/driver/zcode-protocol.mjs'])
    assert(files.includes(file), `required package file missing: ${file}`);
  // Naming four paths is not enough: npm pack silently omits any listed file that
  // does not exist, so the payload must contain everything files[] promised.
  // Without this, deleting a module while leaving it listed ships a package that
  // fails with ERR_MODULE_NOT_FOUND on the headline command, with the gate green.
  for (const declared of pkg.files) {
    assert(files.includes(declared),
      `files[] declares ${declared} but npm pack did not ship it — does it exist on disk?`);
  }
  const tarball = path.join(fixture, packed.filename);
  const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  const prefix = path.join(fixture, 'install');
  runNpm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball]);
  const { bins, installed } = installationPaths(prefix, pkg);
  assert(bins.zagent && bins.za, 'manifest must install zagent and za');
  const cli = (name, args, expected = 0) => {
    assert(existsSync(bins[name]), `installed alias missing: ${name}`);
    const invocation = installedInvocation(bins[name], args);
    return run(invocation.command, invocation.args, fixture, expected, invocation);
  };
  for (const name of Object.keys(bins)) assert.equal(cli(name, ['--version']).trim(), pkg.version);
  assert.match(cli('zagent', ['--help']), /headless/);
  assert.match(cli('za', ['help']), /doctor/);
  assert.match(cli('zagent', ['doctor'], 1), /NOT FOUND/);
  for (const command of ['telegram', 'feishu', 'wechat', 'compact', 'dcompact', 'plugin-validate'])
    cli('zagent', [command], 2);
  assert(!existsSync(path.join(profile, '.zcode')), 'offline smoke must not create a user runtime profile');
  run(process.execPath, ['--input-type=module', '-e', "await import('./packages/driver/runtime.mjs'); console.log('driver import OK')"], installed);
  for (const file of files.filter(f => f.endsWith('.mjs')))
    run(process.execPath, ['--check', path.join(installed, file)]);
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  console.log(JSON.stringify({ status: 'PASS', version: pkg.version,
    sourceCommit: commit.status === 0 ? commit.stdout.trim() : null,
    sourceDirty: status.status === 0 ? Boolean(status.stdout.trim()) : null,
    sha256, integrity: packed.integrity, fileCount: files.length,
    checks: ['payload allowlist', 'real tarball installation', 'version', 'help aliases',
      'missing runtime fails closed', 'preview commands unavailable', 'no runtime profile writes',
      'supported driver import', 'shipped module syntax'],
    liveRuntimeTested: false, files }, null, 2));
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
}

// Imports expose only pure predicates/path helpers and allocate no fixtures.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
