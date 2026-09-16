#!/usr/bin/env node
// zagent update — self-update from npm. A new user should not have to know the
// package name or the global-install flags; this is the same `npm i -g` the
// README's install line runs, driven from inside the tool.
//
//   zagent update            check the registry, install when newer
//   zagent update --check    report only, change nothing
//   zagent update --json     machine-readable result
//
// Exit 0 = up to date (or updated); 1 = could not check, or install failed;
// 2 = usage error.
import { spawnSync } from 'node:child_process';
import { checkLatest, compareVersions, installedVersion, npmInvocation, PACKAGE_NAME } from '../driver/update-check.mjs';

const args = process.argv.slice(2);
const check = args.includes('--check');
const asJson = args.includes('--json');
if (args.some(a => a !== '--check' && a !== '--json')) {
  console.error('usage: zagent update [--check] [--json]');
  process.exit(2);
}

const installed = installedVersion();
const res = checkLatest({ fresh: true, timeoutMs: 20000 });

if (!res.latest) {
  if (asJson) console.log(JSON.stringify({ installed, latest: null, updateAvailable: null, ok: false, error: res.error }));
  else console.error(`zagent: cannot check the npm registry (${res.error}) — try: npm view ${PACKAGE_NAME} version`);
  process.exit(1);
}

const cmp = compareVersions(res.latest, installed);
const updateAvailable = cmp === 1;

if (check || !updateAvailable) {
  if (asJson) console.log(JSON.stringify({ installed, latest: res.latest, updateAvailable, ok: true }));
  else if (updateAvailable) console.log(`update available: zagent ${installed} -> ${res.latest} (run 'zagent update')`);
  else if (cmp === 0) console.log(`zagent is up to date (${installed})`);
  else console.log(`zagent ${installed} is newer than the npm release (${res.latest}) — nothing to do`);
  process.exit(0);
}

if (!asJson) console.log(`updating zagent ${installed} -> ${res.latest}`);
// Install the version we just saw, not a moving @latest — the report names what
// was installed. Captured, not inherited: EACCES on the global prefix is the
// common failure and deserves the sudo suggestion instead of a bare npm exit.
// Output is replayed so the user still sees npm's own messages.
const npm = npmInvocation();
const r = spawnSync(npm.command, [...npm.args, 'install', '-g', `${PACKAGE_NAME}@${res.latest}`],
  { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
if (!asJson) {
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
}
if (r.error) {
  const msg = r.error.code === 'ENOENT' ? 'npm not found on PATH' : String(r.error.message ?? r.error);
  if (asJson) console.log(JSON.stringify({ installed, latest: res.latest, updateAvailable, attempted: true, ok: false, error: msg }));
  else console.error(`zagent: update failed (${msg}) — run it yourself: npm install -g ${PACKAGE_NAME}@${res.latest}`);
  process.exit(1);
}
if (r.status !== 0) {
  const eacces = /EACCES|EPERM|EACCESS|permission denied/i.test(`${r.stderr ?? ''}${r.stdout ?? ''}`);
  const hint = eacces
    ? `npm could not write the global prefix — retry with: sudo npm install -g ${PACKAGE_NAME}@${res.latest}`
    : `npm install failed (exit ${r.status ?? `signal ${r.signal}`}) — run it yourself: npm install -g ${PACKAGE_NAME}@${res.latest}`;
  if (asJson) console.log(JSON.stringify({ installed, latest: res.latest, updateAvailable, attempted: true, ok: false, exitCode: r.status, error: hint }));
  else console.error(`zagent: ${hint}`);
  process.exit(1);
}
if (asJson) console.log(JSON.stringify({ installed, latest: res.latest, updateAvailable, attempted: true, ok: true }));
else console.log(`updated: zagent ${installed} -> ${res.latest} (verify with 'zagent --version')`);
