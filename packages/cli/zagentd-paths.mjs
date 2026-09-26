// Per-user private location for the zagentd socket + pid file, shared by the
// daemon and its compact clients so all of them resolve the same paths.
//
// The old layout put predictable names ($TMPDIR/zagentd-<uid>.{sock,pid}) in a
// world-shared /tmp: any local user could squat the socket (the sticky bit makes
// our rmSync EPERM, crashing the daemon) or plant a pid file so `stop` signalled
// a recycled pid. The socket accepts agent prompts unauthenticated, so the
// directory holding it must be private — the filename being unguessable is not
// what protects it.
import { mkdirSync, statSync, chmodSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// $XDG_RUNTIME_DIR is already a per-user private base; absent that, fall back
// to a uid-keyed dir under the shared tmpdir. Either way the leaf is created
// 0700 and then VERIFIED — a squatter-owned or world-accessible dir is refused
// outright rather than trusted.
export function daemonRuntimeDir({ env = process.env, tmpdir = os.tmpdir() } = {}) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouser';
  const dir = path.join(env.XDG_RUNTIME_DIR?.trim() || tmpdir, `zagent-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (typeof process.getuid !== 'function') return dir; // no uid concept to verify
  const st = statSync(dir);
  if (st.isDirectory() && st.uid === process.getuid()) chmodSync(dir, 0o700); // tighten a dir we own
  const final = statSync(dir);
  if (!final.isDirectory() || final.uid !== process.getuid() || (final.mode & 0o077) !== 0)
    throw new Error(`unsafe daemon runtime dir ${dir}: must be a directory owned by uid ${process.getuid()} with mode 0700`);
  return dir;
}

export function daemonPaths(opts) {
  const dir = daemonRuntimeDir(opts);
  return { dir, sock: path.join(dir, 'zagentd.sock'), pid: path.join(dir, 'zagentd.pid') };
}

// Identity check before `stop` signals a pid: /proc on Linux, ps elsewhere.
// Anything we cannot positively identify as this daemon's serving process is
// left alone — pid reuse makes a bare kill(pid, 0) meaningless.
export function pidIsZagentd(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const daemonArgv = argv => argv.some(a => a.endsWith('zagentd.mjs'))
    && argv.some(a => a === '--serve' || a === 'serve');
  try {
    return daemonArgv(readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'));
  } catch { /* pid gone, or no /proc (macOS/BSD) — fall back to ps */ }
  const r = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 && daemonArgv(r.stdout.trim().split(/\s+/));
}
