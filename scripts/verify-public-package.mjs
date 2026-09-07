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
const fixture = mkdtempSync(path.join(os.tmpdir(), 'zagent-package-'));
const profile = path.join(fixture, 'home');
mkdirSync(profile);
const env = {
  PATH: process.env.PATH, HOME: profile, USERPROFILE: profile,
  TMPDIR: fixture, XDG_CONFIG_HOME: path.join(profile, '.config'),
  ZCODE_RUNTIME: path.join(fixture, 'missing-runtime.cjs'),
  npm_config_cache: path.join(fixture, 'npm-cache'),
  npm_config_userconfig: path.join(fixture, 'absent-npmrc'),
  npm_config_registry: 'https://registry.npmjs.org/',
};
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
  || /^packages\/(driver|cli|tui)\/[\w-]+\.mjs$/.test(file);

// These name the INTERNAL filenames (zmax-*, zmaxd*), which were deliberately not
// renamed when the product became zagent. A rename-time find/replace turned them
// into zagent-*, which matches nothing on disk — so the block was dead for
// zmax-wechat, zmax-compact, zmaxd and zmaxd-compact.
export const forbidden = /(?:^|\/)(?:test[^/]*|node_modules|\.env[^/]*|\.git|artifacts|docs)(?:\/|$)|(?:telegram|feishu|attachments|mentions|relay|controller-router|rpc-frame|rpc-bridge|daemon-request|zmax-(?:telegram|feishu|wechat|compact)|zmaxd[^/]*)\.mjs$/;

// Importing this module must not pack and install anything; only running it does.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isMain) { /* imported for its predicates */ }

const run = (cmd, args, cwd = fixture, expected = 0) => {
  const result = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 120000 });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${cmd} ${args.join(' ')}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
};
if (isMain) try {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', fixture], root));
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
  run('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball]);
  const entry = path.join(prefix, 'bin', 'zagent');
  assert.equal(run(entry, ['--version']).trim(), pkg.version);
  assert.match(run(entry, ['--help']), /headless/);
  assert.match(run(path.join(prefix, 'bin', 'za'), ['help']), /doctor/);
  assert.match(run(entry, ['doctor'], fixture, 1), /NOT FOUND/);
  for (const command of ['telegram', 'feishu', 'wechat', 'compact', 'dcompact', 'plugin-validate'])
    run(entry, [command], fixture, 2);
  assert(!existsSync(path.join(profile, '.zcode')), 'offline smoke must not create a user runtime profile');
  const installed = path.join(prefix, 'lib', 'node_modules', pkg.name);
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
