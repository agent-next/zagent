// The desktop app's host bundle (app.asar — NOT the kernel zagent drives)
// runs RepoSnapshotSidecarService: on every GUI prompt it packs the workspace
// — the whole .git directory included, plus the prompt text and global config
// manifests — under ~/.zcode/v2/checkpoints/<workspaceKey>/, encrypts it with
// a server-issued RSA public key (AES-256-CTR + RSA-OAEP-SHA256 wrap; the
// private key never leaves the cloud) and posts it to Aliyun OSS. No settings
// toggle gates the capture; a valid login JWT is the only precondition.
//
// zagent cannot remove that code, but the pipeline must stage its artifact on
// disk before it can upload, so denying writes to this one directory disables
// the upload end to end while leaving chat/tools (and zagent's own rewind,
// which lives in ~/.zcode/cli/artifacts) untouched. Verified against the
// 3.12.1 host bundle: capture and the pending-upload worker both swallow
// write failures — the GUI keeps working.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Same root rule as the host: ZCODE_DATA_BASE_DIR replaces HOME, then /.zcode. */
const dataRoot = ({ env = process.env, home = os.homedir() } = {}) =>
  path.join(env.ZCODE_DATA_BASE_DIR?.trim() || home, '.zcode');

export function snapshotRoot(opts = {}) {
  return path.join(dataRoot(opts), 'v2', 'checkpoints');
}

// `zagent snapshot unlock` records an explicit opt-out so the dispatcher's
// auto-guard does not silently re-lock next run; `lock` deletes it (opt back
// in). The marker lives in zagent's own cli dir, never inside the locked dir.
const markerPath = (opts) => path.join(dataRoot(opts), 'cli', 'snapshot-guard.json');
const optedOut = (opts) => {
  try { return JSON.parse(readFileSync(markerPath(opts), 'utf8'))?.autoLock === false; }
  catch { return false; }
};
const marker = {
  set: (opts) => { // best-effort: the dir state itself is authoritative
    try {
      const m = markerPath(opts);
      mkdirSync(path.dirname(m), { recursive: true });
      writeFileSync(m, `${JSON.stringify({ autoLock: false })}\n`, { mode: 0o600 });
    } catch { /* marker is advisory; never break the verb */ }
  },
  clear: (opts) => { try { rmSync(markerPath(opts), { force: true }); } catch { /* same */ } },
};

// The staging dir's pre-lock mode, recorded beside it (under v2/, which stays
// writable while checkpoints/ itself is locked) so `unlock` restores the
// desktop's original permissions instead of a hard-coded 0o755. A re-lock of
// an already-locked dir reports mode 0 — never overwrite a real record with
// the degenerate value.
const lockStatePath = (opts) => path.join(dataRoot(opts), 'v2', '.checkpoints-lock-mode.json');
const lockState = {
  set: (mode, opts) => {
    if (!Number.isInteger(mode) || (mode & 0o700) === 0) return;
    try {
      writeFileSync(lockStatePath(opts), `${JSON.stringify({ mode })}\n`, { mode: 0o600 });
    } catch { /* advisory */ }
  },
  take: (opts) => {
    try {
      const mode = JSON.parse(readFileSync(lockStatePath(opts), 'utf8'))?.mode;
      return Number.isInteger(mode) ? mode : null;
    } catch { return null; }
  },
  clear: (opts) => { try { rmSync(lockStatePath(opts), { force: true }); } catch { /* advisory */ } },
};

// A real write probe: mode bits alone cannot see chattr +i / chflags uchg.
// Random name + finally-unlink: a predictable name can be pre-created to
// fake a 'locked' status, and a crash between open/unlink must not litter.
function dirWritable(dir) {
  const probe = path.join(dir, `.zagent-guard-${randomUUID()}`);
  try {
    const fd = openSync(probe, 'wx');
    closeSync(fd);
    return true;
  } catch { return false; }
  finally { try { unlinkSync(probe); } catch { /* never created or already gone */ } }
}

const list = (dir) => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
const stat = (p) => { try { return lstatSync(p); } catch { return null; } };

// A bare empty dir is still replaceable: the desktop can rmdir it or
// rename(2) the legacy repo-snapshots dir over it — both only need write on
// the parent, which the user always has. One sentinel file makes the locked
// dir non-empty: rmdir fails ENOTEMPTY, rename-over fails ENOTEMPTY, and
// rm -rf cannot descend a mode-0000 dir. Written BEFORE the wipe so the dir
// is never empty mid-lock; skipped (not trusted) during the wipe itself.
const SENTINEL = '.zagent-guard-lock';

/**
 * Staged upload payload = files under each workspace's pending/ (encrypted
 * .tar.gz.enc + .envelope.json) and tmp/ (the plaintext tar, transient).
 * states: absent | empty | pending | locked.
 */
export function snapshotStatus({ root = snapshotRoot() } = {}) {
  const base = { root, uploads: 0, stagedFiles: 0, stagedBytes: 0 };
  const st = stat(root);
  if (!st) return { state: 'absent', ...base };
  if (!st.isDirectory()) return { state: 'locked', method: 'not-a-directory', ...base };
  if (!dirWritable(root)) return { state: 'locked', method: 'unwritable', ...base };
  for (const ws of list(root)) {
    if (!ws.isDirectory()) continue;
    for (const sub of ['pending', 'tmp']) {
      for (const f of list(path.join(root, ws.name, sub))) {
        const s = stat(path.join(root, ws.name, sub, f.name));
        if (!s?.isFile()) continue;
        base.stagedFiles += 1;
        base.stagedBytes += s.size;
        if (sub === 'pending' && f.name.endsWith('.tar.gz.enc')) base.uploads += 1;
      }
    }
  }
  // Any staged file counts: a tmp/ plaintext tar mid-capture or an orphan
  // .envelope.json has no .enc yet, but 'empty' would lie about stagedFiles.
  return { state: base.stagedFiles ? 'pending' : 'empty', ...base };
}

const tryImmutable = (root, on, platform) => {
  const cmd = platform === 'darwin' ? 'chflags' : 'chattr';
  const flag = platform === 'darwin' ? (on ? 'uchg' : 'nouchg') : (on ? '+i' : '-i');
  try { return spawnSync(cmd, [flag, root], { stdio: 'ignore' }).status === 0; } catch { return false; }
};

/**
 * Wipe staged artifacts and make the staging dir unwritable: chattr +i /
 * chflags uchg when permitted, else mode 0000 — the desktop's capture dies on
 * EACCES and its error is swallowed. Verified by a real write probe.
 */
export function lockSnapshots({ root = snapshotRoot(), platform = process.platform, ...opts } = {}) {
  if (platform === 'win32') return { ok: false, reason: 'unsupported-platform' };
  marker.clear(opts); // explicit lock opts back into the auto-guard
  const st = stat(root);
  if (st && !st.isDirectory()) return { ok: true, method: 'not-a-directory', removedFiles: 0, removedBytes: 0 };
  // Already unwritable (locked earlier or by the user): re-wiping an immutable
  // dir would fail on the sentinel it now contains — the lock stands, so the
  // goal is already met.
  if (st && !dirWritable(root)) return { ok: true, method: 'already-locked', removedFiles: 0, removedBytes: 0 };
  let removedFiles = 0, removedBytes = 0;
  // A wipe must never be silent: failure returns carry the removal tally so
  // the dispatcher can still report what was deleted.
  const fail = (reason) => ({ ok: false, reason, removedFiles, removedBytes });
  if (!st) {
    try { mkdirSync(root, { recursive: true }); } catch { return fail('io-error'); }
  }
  lockState.set((stat(root)?.mode ?? 0o755) & 0o777, opts);
  try {
    writeFileSync(path.join(root, SENTINEL), 'zagent snapshot guard — intentionally non-empty + unwritable\n');
  } catch { return fail('io-error'); }
  const tally = (p) => {
    const s = stat(p);
    if (s?.isFile()) { removedFiles += 1; removedBytes += s.size; }
  };
  try {
    for (const e of list(root)) {
      if (e.name === SENTINEL) continue;
      const p = path.join(root, e.name);
      if (e.isDirectory()) {
        // Fresh lstat before descending: a dirent can be swapped for a symlink
        // between readdir and the walk. rmSync never follows symlinks, but the
        // tally should not either.
        const walk = (d) => { for (const c of list(d)) { const cp = path.join(d, c.name); c.isDirectory() && stat(cp)?.isDirectory() ? walk(cp) : tally(cp); } };
        walk(p);
      } else tally(p);
      rmSync(p, { recursive: true, force: true });
    }
  } catch { return fail('io-error'); }
  // Immutable flag first: a later chmod on an immutable dir would just fail.
  const method = tryImmutable(root, true, platform) ? 'immutable' : 'mode';
  if (method === 'mode') {
    try { chmodSync(root, 0); } catch { return fail('io-error'); }
  }
  return dirWritable(root) ? fail('still-writable') : { ok: true, method, removedFiles, removedBytes };
}

export function unlockSnapshots({ root = snapshotRoot(), platform = process.platform, ...opts } = {}) {
  const st = stat(root);
  if (st && !st.isDirectory()) return { ok: false, reason: 'not-a-directory' }; // not ours — never rm a foreign file
  const wasLocked = !!st && !dirWritable(root);
  if (st) {
    tryImmutable(root, false, platform);
    // Read, don't consume: if the restore fails the recorded mode must survive
    // for the next unlock attempt.
    const restore = lockState.take(opts) ?? 0o755;
    try { chmodSync(root, restore); } catch { return { ok: false, reason: 'io-error' }; }
    if (!dirWritable(root)) return { ok: false, reason: 'still-unwritable' };
    lockState.clear(opts);
    try { unlinkSync(path.join(root, SENTINEL)); } catch { /* absent or foreign — harmless */ }
  }
  // Record the opt-out even when nothing was locked: the dispatcher's
  // auto-guard would otherwise re-lock on the next run.
  marker.set(opts);
  return { ok: true, changed: wasLocked };
}

/**
 * The dispatcher calls this on every run: unless the user opted out with
 * `zagent snapshot unlock`, keep the staging dir locked — wiping any staged
 * payload first. Silent and idempotent; returns what it did for the caller
 * to report.
 */
export function autoGuard(opts = {}) {
  // Test-harness escape hatch: fixture homes are rmSync'd on cleanup, and a
  // sentinel-locked dir is unremovable by design — a guard that survives its
  // fixture breaks the suite. Explicit `snapshot` verbs still lock; only the
  // automatic dispatcher path reads this (same convention as update-check).
  const env = opts.env ?? process.env;
  if (env.ZAGENT_TEST_SANDBOX) return { applied: false, reason: 'test-sandbox' };
  if (optedOut(opts)) return { applied: false, reason: 'opted-out' };
  const root = opts.root ?? snapshotRoot(opts);
  const s = snapshotStatus({ root });
  if (s.state === 'locked') return { applied: false, reason: 'already-locked' };
  // Never create ~/.zcode on a machine the desktop ecosystem has not
  // touched — staging can only appear once the runtime's data root does,
  // and a bare home must stay bare (the publish smoke asserts it).
  if (!stat(dataRoot(opts))?.isDirectory()) return { applied: false, reason: 'no-data-root' };
  const r = lockSnapshots({ root, ...opts });
  return r.ok
    ? { applied: true, method: r.method, removedFiles: r.removedFiles, removedBytes: r.removedBytes }
    : { applied: false, reason: r.reason, removedFiles: r.removedFiles, removedBytes: r.removedBytes };
}

export const humanBytes = (n) => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
};

/** One doctor line; never throws — the caller wraps the status probe anyway. */
export function snapshotLine(s) {
  switch (s.state) {
    case 'locked':
      // 'not-a-directory' = a foreign entry (file/symlink/…) occupies the
      // path — lstat sees it as non-dir whether or not the upload is really
      // blocked; unlock refuses it, so the remedy is manual removal.
      if (s.method === 'not-a-directory')
        return "snapshot: staging locked — a non-directory entry sits at the staging path (remove it manually — 'zagent snapshot unlock' refuses foreign files)";
      // 'unwritable' (or a method-less status) = the guarded posture.
      return "snapshot: staging locked — desktop workspace upload is disabled (ok — run 'zagent snapshot unlock' to re-enable)";
    case 'pending': return s.uploads
      ? `snapshot: ${s.uploads} encrypted workspace snapshot${s.uploads === 1 ? '' : 's'} staged for upload (${humanBytes(s.stagedBytes)}) — run 'zagent snapshot lock'`
      : `snapshot: ${s.stagedFiles} file${s.stagedFiles === 1 ? '' : 's'} staged mid-pipeline (${humanBytes(s.stagedBytes)}) — run 'zagent snapshot lock'`;
    case 'empty': return "snapshot: staging dir present, nothing staged (unlocked — 'zagent snapshot lock' to disable)";
    default: return "snapshot: no staging dir yet (unlocked — 'zagent snapshot lock' to disable)";
  }
}
