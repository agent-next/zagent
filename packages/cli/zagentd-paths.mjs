// Per-user private location for the zagentd socket + pid file, shared by the
// daemon and its compact clients so all of them resolve the same paths.
//
// The old layout put predictable names ($TMPDIR/zagentd-<uid>.{sock,pid}) in a
// world-shared /tmp: any local user could squat the socket (the sticky bit makes
// our rmSync EPERM, crashing the daemon) or plant a pid file so `stop` signalled
// a recycled pid. The socket accepts agent prompts unauthenticated, so the
// directory holding it must be private — the filename being unguessable is not
// what protects it.
import { mkdirSync, lstatSync, openSync, fstatSync, fchmodSync, closeSync, constants, readFileSync } from 'node:fs';
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
export function daemonRuntimeDir({ env = process.env, tmpdir = os.tmpdir(), home = os.homedir(), getuid = process.getuid?.bind(process) } = {}) {
  const uid = typeof getuid === 'function' ? getuid() : 'nouser';
  const leaf = `zagent-${uid}`;
  // Candidate dirs, most-preferred first. The first three nest under
  // caller-controlled roots; the last is short BY CONSTRUCTION (29-36 bytes
  // for the socket on any POSIX host) so the walk always has somewhere to
  // land — a machine whose XDG, tmpdir AND home are all too long must still
  // get a working daemon, not an error. Every candidate is created 0700 and
  // owner-verified on the same terms, /tmp's sticky bit giving the last one
  // the same protection the shared-tmpdir fallback always relied on.
  const candidates = [];
  const preferred = env.XDG_RUNTIME_DIR?.trim();
  if (preferred) candidates.push(path.join(preferred, leaf));
  candidates.push(path.join(tmpdir, leaf), path.join(home, '.zagentd', leaf), path.join('/tmp', `zagentd-${uid}`));
  const fits = (dir) => Buffer.byteLength(path.join(dir, 'zagentd.sock')) + 1 <= SOCKET_PATH_ROOM; // + NUL terminator
  const tried = [];
  for (const dir of candidates) {
    tried.push(dir);
    if (!fits(dir)) continue; // would truncate the bind — never use this dir
    // A base we cannot even create (unwritable XDG, a file in the way) falls
    // through to the next candidate; one that exists but is unsafe still throws.
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { if (e?.code !== 'EEXIST') continue; }
    if (typeof getuid !== 'function') {
      // No uid concept to verify, but an existing file or link at the path is not a runtime dir.
      let st;
      try { st = lstatSync(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      return dir;
    }
    // Open the leaf itself, never through a symlink: stat/chmod by path would
    // follow a planted link and tighten (and bind inside) someone else's dir.
    const unsafe = () => new Error(`unsafe daemon runtime dir ${dir}: must be a directory (not a symlink) owned by uid ${uid} with mode 0700`);
    let fd;
    try { fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch { throw unsafe(); }
    try {
      if (fstatSync(fd).uid === uid) fchmodSync(fd, 0o700); // tighten a dir we own
      const final = fstatSync(fd);
      if (final.uid !== uid || (final.mode & 0o077) !== 0) throw unsafe();
    } finally { closeSync(fd); }
    return dir;
  }
  throw new Error(`no private runtime dir keeps zagentd.sock within the AF_UNIX sun_path room (${SOCKET_PATH_ROOM} bytes); tried: ${tried.join(', ')}`);
}

// True when the serve child's own "listening on <sock> (pid <pid>)" line is in
// the log bytes appended after `start` (the pre-spawn size); a line left by an
// earlier daemon, even one with a recycled pid, is not proof of life.
export function logShowsListening(logBytes, start, sock, pid) {
  return logBytes.subarray(start).toString('utf8').includes(`listening on ${sock} (pid ${pid})`);
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
  const r = spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 && daemonArgv(r.stdout.trim().split(/\s+/));
}
