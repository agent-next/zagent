// zagentd surface: usage errors exit nonzero, the socket/pid live in a private
// per-user runtime dir, and `stop` verifies the recorded pid is really zagentd
// before signalling it. POSIX-only: the daemon is a unix socket + getuid model.
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonRuntimeDir, daemonPaths, pidIsZagentd, SOCKET_PATH_ROOM } from './zagentd-paths.mjs';

if (process.platform === 'win32' || typeof process.getuid !== 'function') {
  console.log('SKIP zagentd (POSIX daemon surface)');
  process.exit(0);
}

const root = fileURLToPath(new URL('../..', import.meta.url));
const zagentd = path.join(root, 'packages/cli/zagentd.mjs');
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zagentd-test-'));
const temp = path.join(sandbox, 'tmp');
mkdirSync(temp);
// The XDG base the preference legs run against must keep zagentd.sock inside
// the AF_UNIX sun_path room on every host — the sandbox tmpdir is long enough
// on macOS to overflow it, and an over-long XDG is (correctly) skipped for a
// shorter base rather than preferred. /tmp is short everywhere POSIX.
// mkdirSync, not mkdtempSync: the offline test preload re-roots every
// mkdtemp prefix under TMPDIR, which is the long sandbox path again.
const XDG = `/tmp/zagentd-xdg-${randomBytes(6).toString('hex')}`;
mkdirSync(XDG, { mode: 0o700 });
// Same reason for the tmpdir base the fallback/relocation legs expect to win.
const SHORT = `/tmp/zagentd-tmp-${randomBytes(6).toString('hex')}`;
mkdirSync(SHORT, { mode: 0o700 });

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
  const fallback = daemonRuntimeDir({ env: {}, tmpdir: SHORT });
  assert.equal(fallback, path.join(SHORT, `zagent-${process.getuid()}`), 'tmpdir fallback is uid-keyed');
  assert.equal(statSync(fallback).mode & 0o777, 0o700, 'fallback dir is 0700');
  const loose = path.join(XDG, 'loose');
  mkdirSync(loose);
  daemonRuntimeDir({ env: { XDG_RUNTIME_DIR: loose } });
  assert.equal(statSync(path.join(loose, `zagent-${process.getuid()}`)).mode & 0o777, 0o700, 'a dir we own is tightened to 0700');
  const blockedBase = path.join(XDG, 'blocked');
  mkdirSync(blockedBase);
  writeFileSync(path.join(blockedBase, `zagent-${process.getuid()}`), 'squatter');
  assert.throws(() => daemonRuntimeDir({ env: { XDG_RUNTIME_DIR: blockedBase } }), 'a file squatting the dir path refuses');

  // AF_UNIX sun_path is a fixed field (104 darwin / 108 linux) and the kernel
  // SILENTLY TRUNCATES a longer bind instead of failing it — verified on
  // Linux: listen() at a 130-char path reported success with the socket
  // created at 108 chars, i.e. a daemon no client can compute the name of.
  // A base whose socket path would not fit must be skipped for the next
  // shorter private base, keep the 0700/owner guarantees, and actually serve.
  const deep = path.join(temp, 'd'.repeat(100)); // deep enough to overflow the room on every POSIX CI host
  mkdirSync(deep, { recursive: true });
  const deepEnv = { ...baseEnv(), XDG_RUNTIME_DIR: deep, TMPDIR: SHORT, TMP: SHORT, TEMP: SHORT };
  const relocated = daemonRuntimeDir({ env: deepEnv, tmpdir: SHORT });
  assert.notEqual(relocated, path.join(deep, `zagent-${process.getuid()}`), 'an over-long XDG base is not used');
  assert.equal(relocated, path.join(SHORT, `zagent-${process.getuid()}`), 'relocation lands on the tmpdir base');
  assert.ok(daemonPaths({ env: deepEnv, tmpdir: SHORT }).sock.length + 1 <= SOCKET_PATH_ROOM, 'relocated socket path fits sun_path');
  assert.equal(statSync(relocated).mode & 0o777, 0o700, 'relocated dir keeps 0700');
  assert.equal(existsSync(path.join(deep, `zagent-${process.getuid()}`)), false, 'the length-skipped base is left untouched');
  const deepRun = spawnSync(process.execPath, [zagentd, 'start'], { cwd: root, env: deepEnv, encoding: 'utf8', timeout: 15000 });
  assert.equal(deepRun.status, 0, `daemon starts from a deep XDG: ${deepRun.stderr}`);
  const deepPaths = daemonPaths({ env: deepEnv, tmpdir: SHORT });
  assert(waitFor(() => existsSync(deepPaths.sock) && deepPaths.sock), 'daemon binds at the relocated socket path');
  daemonPid = Number(readFileSync(deepPaths.pid, 'utf8').trim());
  assert(pidIsZagentd(daemonPid), 'relocated pid file names the daemon');
  assert.equal(spawnSync(process.execPath, [zagentd, 'stop'], { cwd: root, env: deepEnv, encoding: 'utf8' }).status, 0, 'stop reaches the relocated daemon');
  daemonPid = null;
  rmSync(deep, { recursive: true, force: true });

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

  // real lifecycle: start -> private sock+pid -> pid verifies as zagentd -> stop.
  // `start` itself polls for the bind, so by exit 0 the socket exists; the wait
  // below is belt-and-braces and its failure message carries the serve log the
  // daemon now writes beside the socket (boot crashes used to vanish into
  // /dev/null, leaving only "socket never appeared").
  assert.equal(cli(['start']).status, 0, 'daemon starts');
  const paths = daemonPaths({ env: baseEnv() });
  const sock = waitFor(() => existsSync(paths.sock) && paths.sock);
  let serveLog = '';
  try { serveLog = readFileSync(path.join(paths.dir, 'zagentd.log'), 'utf8').trimEnd().split('\n').slice(-20).join('\n'); } catch {}
  assert(sock, `daemon socket appears inside the private runtime dir (serve log: ${serveLog || 'none'})`);
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

  // single-instance: two concurrent `start`s must produce exactly ONE daemon.
  // Without the pre-spawn lock both find no pid file and each fork a server
  // that unlinks the other's socket path. (spawnSync serializes the callers,
  // so the race needs real concurrent child processes.)
  const startAsync = () => new Promise((res, rej) => {
    const c = spawn(process.execPath, [zagentd, 'start'], { cwd: root, env: baseEnv() });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('exit', (status, signal) => res({ status, signal, stdout: out, stderr: err }));
    c.on('error', rej);
  });
  const [s1, s2] = await Promise.all([startAsync(), startAsync()]);
  assert.equal(s1.status, 0, `first concurrent start exits clean: ${s1.stderr}`);
  assert.equal(s2.status, 0, `second concurrent start exits clean: ${s2.stderr}`);
  const started = [s1, s2].filter(r => /daemon started/.test(r.stdout));
  const already = [s1, s2].filter(r => /daemon already running/.test(r.stdout));
  assert.equal(started.length, 1, `exactly one start spawned a daemon: ${s1.stdout} | ${s2.stdout}`);
  assert.equal(already.length, 1, `the loser exits with "already running": ${s1.stdout} | ${s2.stdout}`);
  const sock3 = waitFor(() => existsSync(paths.sock) && paths.sock);
  assert(sock3, 'the single daemon socket appears');
  daemonPid = Number(readFileSync(paths.pid, 'utf8').trim());
  assert(pidIsZagentd(daemonPid), 'pid file names the one live daemon');
  const pgrep = spawnSync('pgrep', ['-f', 'zagentd.mjs --serve'], { encoding: 'utf8' });
  if (pgrep.status === 0) {
    // scope to THIS test's daemons — another sandbox's daemon is not our leak
    const ours = pgrep.stdout.trim().split('\n').map(Number).filter(p => {
      try { return readFileSync(`/proc/${p}/environ`, 'utf8').includes(`ZAGENT_TEST_SANDBOX=${sandbox}`); }
      catch { return false; }
    });
    assert.equal(ours.length, 1, `exactly one serve process: ${pgrep.stdout}`);
  }
  assert.equal(cli(['stop']).status, 0);
  daemonPid = null;
  console.log('PASS zagentd');
} finally {
  try { foreign.kill('SIGKILL'); } catch {}
  if (daemonPid != null) try { process.kill(daemonPid, 'SIGKILL'); } catch {}
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(XDG, { recursive: true, force: true });
  rmSync(SHORT, { recursive: true, force: true });
}
