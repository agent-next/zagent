import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareVersions } from '../driver/update-check.mjs';

// `zagent update` is the self-update path a new user is expected to find —
// a user typed it on a live install and got "unknown command". It checks
// `npm view zagent version`, installs `npm i -g zagent@<resolved latest>` when newer,
// and on EACCES prints the manual command instead of dying silent. doctor's
// passive hint shares the same registry answer through a TTL cache so it
// costs at most one npm round-trip per window and stays out of the offline
// test sandbox entirely.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bin = path.join(root, 'bin/zagent');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const home = mkdtempSync(path.join(os.tmpdir(), 'zagent-update-'));

// A stand-in npm on PATH: `view` answers FAKE_NPM_VIEW_VERSION (or fails),
// `install` records its argv and can be made to fail EACCES-style. The child
// env carries no ZAGENT_TEST_SANDBOX on purpose — the update paths under test
// are the ones a real user hits; sandboxed children skip only the PASSIVE
// (doctor) check, which is itself asserted below.
const fakebin = path.join(home, 'fakebin');
mkdirSync(fakebin, { recursive: true });
const npmLog = path.join(home, 'npm-install.log');
writeFileSync(path.join(fakebin, 'npm'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
if (process.env.FAKE_NPM_VIEW_FAIL) { console.error('npm ERR! network EAI_AGAIN registry.npmjs.org'); process.exit(1); }
if (a[0] === 'view') { console.log(process.env.FAKE_NPM_VIEW_VERSION || '0.0.0'); process.exit(0); }
if (a[0] === 'install') {
  fs.appendFileSync(process.env.FAKE_NPM_LOG, a.join(' ') + '\\n');
  if (process.env.FAKE_NPM_INSTALL_EACCES) { console.error('npm ERR! code EACCES'); process.exit(1); }
  if (process.env.FAKE_NPM_INSTALL_FAIL) { console.error('npm ERR! unexpected'); process.exit(7); }
  console.log('added 1 package'); process.exit(0);
}
process.exit(0);
`);
chmodSync(path.join(fakebin, 'npm'), 0o755);

// A runtime stub so `doctor` reaches the healthy path; it must never run.
const runtime = path.join(home, 'runtime.cjs');
writeFileSync(runtime, 'throw new Error("tests must not start the runtime");');
mkdirSync(path.join(home, '.zcode/cli'), { recursive: true });
writeFileSync(path.join(home, '.zcode/cli/config.json'),
  JSON.stringify({ model: { main: 'zai/model' }, provider: { zai: { options: { apiKey: 'fixture' } } } }));

const env = (extra = {}) => ({
  PATH: `${fakebin}${path.delimiter}${process.env.PATH}`,
  HOME: home, USERPROFILE: home, ZCODE_RUNTIME: runtime, ZAI_API_KEY: 'fixture',
  FAKE_NPM_LOG: npmLog, ...extra,
});
const run = (args, extra = {}) =>
  spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 20000, env: env(extra) });
const installs = () => (existsSync(npmLog) ? readFileSync(npmLog, 'utf8') : '');
// These envs deliberately omit ZAGENT_TEST_SANDBOX, so the dispatcher's
// snapshot auto-guard really runs and leaves a non-empty mode-0000
// checkpoints dir — rimraf cannot descend that; restore traversability first.
const rmTree = (d) => {
  if (process.platform !== 'win32') {
    spawnSync('chattr', ['-R', '-i', d], { stdio: 'ignore' });
    spawnSync('chmod', ['-R', 'u+rwX', d], { stdio: 'ignore' });
  }
  rmSync(d, { recursive: true, force: true });
};

try {
  // --- version comparison (dotted numeric triple; junk is incomparable) ---
  assert.equal(compareVersions('0.0.212', '0.0.213'), -1);
  assert.equal(compareVersions('0.0.213', '0.0.212'), 1);
  assert.equal(compareVersions('0.0.212', '0.0.212'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('v0.0.3', '0.0.3'), 0);
  assert.equal(compareVersions('garbage', '0.0.1'), null);
  assert.equal(compareVersions('0.0.1', ''), null);

  // --- update --check: report only, never installs ---
  let r = run(['update', '--check'], { FAKE_NPM_VIEW_VERSION: pkg.version });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /up to date/);
  r = run(['update', '--check'], { FAKE_NPM_VIEW_VERSION: '9.9.9' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /9\.9\.9/);
  assert.equal(installs(), '', '--check must not install');
  r = run(['update', '--check', '--json'], { FAKE_NPM_VIEW_VERSION: '9.9.9' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.installed, pkg.version);
  assert.equal(j.latest, '9.9.9');
  assert.equal(j.updateAvailable, true);
  assert.equal(j.newerThanRegistry, false);

  // --- update: installs the version it saw, reports the transition ---
  r = run(['update'], { FAKE_NPM_VIEW_VERSION: '9.9.9' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /9\.9\.9/);
  assert.match(installs(), /install -g zagent@9\.9\.9/, 'self-update installs the version it reported');
  // --json on the install path must stay parseable — no prose before the object
  r = run(['update', '--json'], { FAKE_NPM_VIEW_VERSION: '9.9.9' });
  assert.equal(r.status, 0, r.stderr);
  const jr = JSON.parse(r.stdout);
  assert.equal(jr.ok, true);
  assert.equal(jr.attempted, true);
  assert.equal(jr.latest, '9.9.9');

  // --- installed newer than the registry is "nothing to do", not a downgrade ---
  r = run(['update'], { FAKE_NPM_VIEW_VERSION: '0.0.1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /newer than the npm release/);
  // --json must carry the same fact the text path prints (a bare
  // updateAvailable:false+ok:true reads as "up to date" to a consumer).
  r = run(['update', '--check', '--json'], { FAKE_NPM_VIEW_VERSION: '0.0.1' });
  assert.equal(r.status, 0, r.stderr);
  const jn = JSON.parse(r.stdout);
  assert.equal(jn.updateAvailable, false);
  assert.equal(jn.newerThanRegistry, true);
  assert.equal(jn.ok, true);
  r = run(['update', '--check', '--json'], { FAKE_NPM_VIEW_VERSION: pkg.version });
  assert.equal(JSON.parse(r.stdout).newerThanRegistry, false);

  // --- install failures surface the manual command; EACCES gets sudo ---
  r = run(['update'], { FAKE_NPM_VIEW_VERSION: '9.9.9', FAKE_NPM_INSTALL_EACCES: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm install -g zagent@9\.9\.9/);
  assert.match(r.stderr, /sudo|permission/i);
  r = run(['update'], { FAKE_NPM_VIEW_VERSION: '9.9.9', FAKE_NPM_INSTALL_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm install -g zagent@9\.9\.9/);

  // --- registry unreachable is a clean failure, not a stack ---
  r = run(['update', '--check'], { FAKE_NPM_VIEW_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /registry|npm view/);
  // npm unresolvable at all (PATH without it, no co-located npm-cli.js) fails
  // closed with the same honesty — never a stack or a silent zero. Skipped on
  // win32: the CI image always has an npm-cli.js beside node.exe, so the
  // co-located arm answers no matter what PATH says.
  if (process.platform !== 'win32') {
    r = spawnSync(process.execPath, [bin, 'update', '--check'], {
      encoding: 'utf8', timeout: 20000,
      env: { ...env(), PATH: '/nonexistent', npm_execpath: '' },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot check|not found/);
  }

  // --- usage errors exit 2 like the other subcommands ---
  r = run(['update', '--bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);

  // --- doctor prints the outdated hint off the same registry answer ---
  r = run(['doctor'], { FAKE_NPM_VIEW_VERSION: '9.9.9' });
  assert.match(r.stdout, /warn:.*9\.9\.9.*zagent update|warn:.*outdated/s);

  // --- the hint survives a dead registry through the TTL cache ---
  r = run(['doctor'], { FAKE_NPM_VIEW_FAIL: '1' });
  assert.match(r.stdout, /9\.9\.9/, 'a cached answer still warns when the registry is unreachable');

  // --- the passive check stays out of the test sandbox and honors the opt-out ---
  r = run(['doctor'], { FAKE_NPM_VIEW_VERSION: '8.8.8', ZAGENT_TEST_SANDBOX: home });
  assert.doesNotMatch(r.stdout, /warn:.*outdated|npm has/, 'sandboxed doctor must not spawn npm');
  r = run(['doctor'], { FAKE_NPM_VIEW_VERSION: '8.8.8', ZAGENT_UPDATE_CHECK: '0' });
  assert.doesNotMatch(r.stdout, /warn:.*outdated|npm has/, 'ZAGENT_UPDATE_CHECK=0 opts out');

  // --- the cache never CREATES ~/.zcode on a profile-less home ---
  // verify-public-package.mjs asserts the offline smoke leaves no runtime
  // profile behind; the first shipped build failed exactly here.
  const bare = mkdtempSync(path.join(os.tmpdir(), 'zagent-update-bare-'));
  try {
    r = spawnSync(process.execPath, [bin, 'update', '--check'], {
      encoding: 'utf8', timeout: 20000,
      env: { ...env(), HOME: bare, USERPROFILE: bare, FAKE_NPM_VIEW_VERSION: '9.9.9' },
    });
    assert.equal(r.status, 0, r.stderr);
    r = spawnSync(process.execPath, [bin, 'doctor'], {
      encoding: 'utf8', timeout: 20000,
      env: { ...env(), HOME: bare, USERPROFILE: bare, ZCODE_RUNTIME: path.join(bare, 'missing.cjs'), FAKE_NPM_VIEW_VERSION: '9.9.9' },
    });
    assert.equal(existsSync(path.join(bare, '.zcode')), false,
      'update-check cache must not create ~/.zcode on a profile-less home');
  } finally { rmTree(bare); }

  console.log('PASS update command + doctor self-update hint');
} finally { rmTree(home); }
