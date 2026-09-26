// zagentd surface: usage errors exit nonzero, the socket/pid live in a private
// per-user runtime dir, and `stop` verifies the recorded pid is really zagentd
// before signalling it. POSIX-only: the daemon is a unix socket + getuid model.
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonRuntimeDir, daemonPaths, pidIsZagentd } from './zagentd-paths.mjs';

if (process.platform === 'win32' || typeof process.getuid !== 'function') {
  console.log('SKIP zagentd (POSIX daemon surface)');
  process.exit(0);
}

const root = fileURLToPath(new URL('../..', import.meta.url));
const zagentd = path.join(root, 'packages/cli/zagentd.mjs');
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zagentd-test-'));
const temp = path.join(sandbox, 'tmp');
mkdirSync(temp);
const XDG = path.join(sandbox, 'xdg');

const baseEnv = () => Object.assign(
  Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
  { HOME: sandbox, USERPROFILE: sandbox, TMPDIR: temp, TMP: temp, TEMP: temp,
    XDG_RUNTIME_DIR: XDG, ZAGENT_TEST_SANDBOX: sandbox });
const cli = args => spawnSync(process.execPath, [zagentd, ...args], { cwd: root, env: baseEnv(), encoding: 'utf8', timeout: 15000 });
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, ms);
const waitFor = (fn, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; sleep(50)) {
    try { const v = fn(); if (v) return v; } catch {}
  }
  return null;
};

let daemonPid = null;
const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
try {
  // unknown or absent command prints usage and exits nonzero
  for (const args of [[], ['bogus'], ['--help-ish']]) {
    const r = cli(args);
    assert.equal(r.status, 2, `zagentd ${args.join(' ') || '(none)'} must exit 2`);
    assert.match(r.stderr, /usage: zagentd/, 'usage printed to stderr');
  }

  // private runtime dir: XDG_RUNTIME_DIR preferred, tmpdir fallback, both 0700
  const dir = daemonRuntimeDir({ env: { XDG_RUNTIME_DIR: XDG } });
  assert.equal(dir, path.join(XDG, `zagent-${process.getuid()}`), 'XDG runtime dir preferred');
  assert.equal(statSync(dir).mode & 0o777, 0o700, 'runtime dir is 0700');
  const fallback = daemonRuntimeDir({ env: {}, tmpdir: temp });
  assert.equal(fallback, path.join(temp, `zagent-${process.getuid()}`), 'tmpdir fallback is uid-keyed');
  assert.equal(statSync(fallback).mode & 0o777, 0o700, 'fallback dir is 0700');
  const loose = path.join(sandbox, 'loose');
  mkdirSync(loose);
  daemonRuntimeDir({ env: { XDG_RUNTIME_DIR: loose } });
  assert.equal(statSync(path.join(loose, `zagent-${process.getuid()}`)).mode & 0o777, 0o700, 'a dir we own is tightened to 0700');
  const blockedBase = path.join(sandbox, 'blocked');
  mkdirSync(blockedBase);
  writeFileSync(path.join(blockedBase, `zagent-${process.getuid()}`), 'squatter');
  assert.throws(() => daemonRuntimeDir({ env: { XDG_RUNTIME_DIR: blockedBase } }), 'a file squatting the dir path refuses');

  // pid identity: our own process is not a daemon; a dead pid is not a daemon
  assert.equal(pidIsZagentd(process.pid), false, 'test process is not zagentd');
  assert.equal(pidIsZagentd(foreign.pid), false, 'foreign node process is not zagentd');
  assert.equal(pidIsZagentd(2 ** 22), false, 'nonexistent pid is not zagentd');

  // planted pid file naming a live foreign process: stop must NOT signal it
  const { pid: PID_FILE } = daemonPaths({ env: baseEnv() });
  writeFileSync(PID_FILE, `${foreign.pid}\n`);
  let r = cli(['stop']);
  assert.equal(r.status, 1, 'stop refuses a non-zagentd pid');
  assert.match(r.stderr, /non-zagentd/, 'stop explains the refusal');
  assert.equal(existsSync(PID_FILE), false, 'foreign pid file removed');
  process.kill(foreign.pid, 0); // would throw if stop had killed it
  assert.equal(pidIsZagentd(foreign.pid), false);

  // stop with no daemon at all: clean "not running"
  r = cli(['stop']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /daemon not running/);

  // real lifecycle: start -> private sock+pid -> pid verifies as zagentd -> stop
  assert.equal(cli(['start']).status, 0, 'daemon starts');
  const paths = daemonPaths({ env: baseEnv() });
  const sock = waitFor(() => existsSync(paths.sock) && paths.sock);
  assert(sock, 'daemon socket appears inside the private runtime dir');
  daemonPid = Number(readFileSync(paths.pid, 'utf8').trim());
  assert(pidIsZagentd(daemonPid), 'recorded pid is really a zagentd process');
  assert.equal(paths.pid.startsWith(dir + path.sep), true, 'pid file lives under the private dir');
  r = cli(['stop']);
  assert.equal(r.status, 0, `stop exits 0: ${r.stderr}`);
  assert.match(r.stdout, /daemon stopped/);
  const gone = waitFor(() => { try { process.kill(daemonPid, 0); return null; } catch { return true; } });
  assert(gone, 'daemon process is gone after stop');
  daemonPid = null;

  // start while a foreign pid file exists: not "already running" — it starts
  writeFileSync(paths.pid, `${foreign.pid}\n`);
  assert.equal(cli(['start']).status, 0, 'start ignores a foreign pid file');
  const sock2 = waitFor(() => existsSync(paths.sock) && paths.sock);
  assert(sock2, 'daemon comes up after clearing the stale pid file');
  daemonPid = Number(readFileSync(paths.pid, 'utf8').trim());
  assert(pidIsZagentd(daemonPid));
  assert.equal(cli(['stop']).status, 0);
  daemonPid = null;
  console.log('PASS zagentd');
} finally {
  try { foreign.kill('SIGKILL'); } catch {}
  if (daemonPid != null) try { process.kill(daemonPid, 'SIGKILL'); } catch {}
  rmSync(sandbox, { recursive: true, force: true });
}
