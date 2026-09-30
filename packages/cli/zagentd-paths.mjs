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

// AF_UNIX sun_path is a fixed-size field — 104 bytes on macOS, 108 on Linux —
// and the kernel SILENTLY TRUNCATES a longer bind instead of failing it
// (verified on Linux: listen() at a 130-char path reported success with the
// socket created at 108 chars). A daemon bound on a truncated name listens
// where no client will ever compute, so the runtime dir must keep the socket
// path inside the limit by construction. win32 never binds a unix socket
// through this module's outputs, so it imposes no room.
export const SOCKET_PATH_ROOM = process.platform === 'linux' ? 108
  : process.platform === 'darwin' ? 104 : Number.POSITIVE_INFINITY;

// $XDG_RUNTIME_DIR is already a per-user private base; absent that, fall back
// to a uid-keyed dir under the shared tmpdir. Either way the leaf is created
// 0700 and then VERIFIED — a squatter-owned or world-accessible dir is refused
// outright rather than trusted. Bases are tried in a fixed order and skipped
// only when the socket path they imply would not fit sun_path — every caller
// (start, --serve, stop, ask, the compact clients) runs the same walk on the
// same env, so all of them resolve the same dir.
export function daemonRuntimeDir({ env = process.env, tmpdir = os.tmpdir(), home = os.homedir() } = {}) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouser';
  const leaf = `zagent-${uid}`;
  const socketBytes = (base) => path.join(base, leaf, 'zagentd.sock').length + 1; // + NUL terminator
  const bases = [];
  const preferred = env.XDG_RUNTIME_DIR?.trim();
  if (preferred) bases.push(preferred);
  bases.push(tmpdir, path.join(home, '.zagentd'));
  const tried = [];
  for (const base of bases) {
    tried.push(base);
    if (socketBytes(base) > SOCKET_PATH_ROOM) continue; // would truncate — never bind here
    const dir = path.join(base, leaf);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (typeof process.getuid !== 'function') return dir; // no uid concept to verify
    const st = statSync(dir);
    if (st.isDirectory() && st.uid === process.getuid()) chmodSync(dir, 0o700); // tighten a dir we own
    const final = statSync(dir);
    if (!final.isDirectory() || final.uid !== process.getuid() || (final.mode & 0o077) !== 0)
      throw new Error(`unsafe daemon runtime dir ${dir}: must be a directory owned by uid ${process.getuid()} with mode 0700`);
    return dir;
  }
  throw new Error(`no private runtime base keeps zagentd.sock within the AF_UNIX sun_path room (${SOCKET_PATH_ROOM} bytes); tried: ${tried.join(', ')}`);
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
