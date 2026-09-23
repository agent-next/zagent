#!/usr/bin/env node
// `zagent snapshot` guards the desktop app's workspace-upload staging dir
// (~/.zcode/v2/checkpoints): status reports staged payloads, lock wipes and
// makes it unwritable, unlock restores. Seeded-HOME fixtures; POSIX only —
// win32 chmod cannot lock a directory (the verb reports unsupported there).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'packages/cli/zagent-snapshot.mjs');
const { autoGuard } = await import('../driver/snapshot-guard.mjs');
const guardEnv = (h) => ({ ZCODE_DATA_BASE_DIR: h }); // same rule as HOME for marker+root
const home = mkdtempSync(path.join(os.tmpdir(), 'zagent-snapshot-'));

const run = (args, h = home) => spawnSync(process.execPath, [script, ...args], {
  encoding: 'utf8', timeout: 20000,
  env: { PATH: process.env.PATH, HOME: h, USERPROFILE: h, LANG: 'C' },
});
const dir = () => path.join(home, '.zcode', 'v2', 'checkpoints');
const seedPending = (ws, name, bytes) => {
  const p = path.join(dir(), ws, 'pending', name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, Buffer.alloc(bytes));
};

// argv validation: unknown verbs and flags are usage errors, not silent status.
for (const bad of [['bogus'], ['status', 'extra'], ['--bogus'], ['lock', '--yes']]) {
  const r = run(bad);
  assert.equal(r.status, 2, `${bad.join(' ')}: expected exit 2, stderr: ${r.stderr}`);
  assert.match(r.stderr, /usage: zagent snapshot/, `${bad}: must print usage`);
}

// absent dir -> state absent, exit 0.
let r = run(['status', '--json']);
assert.equal(r.status, 0, r.stderr);
let s = JSON.parse(r.stdout);
assert.equal(s.state, 'absent');
assert.equal(s.root, dir());
assert.equal(s.uploads, 0);

// staged .enc payloads -> pending, human line names the count, exit 1.
seedPending('ab12cd34ef56', 'g1.tar.gz.enc', 1000);
seedPending('ab12cd34ef56', 'g1.envelope.json', 200);
seedPending('ff00ff00ff00', 'g2.tar.gz.enc', 500);
writeFileSync(path.join(dir(), 'ff00ff00ff00', 'state.json'), '{}');
r = run(['status']);
assert.equal(r.status, 1, 'pending must exit 1 so the verb works as a check');
assert.match(r.stdout, /2 encrypted workspace snapshots staged for upload/);
r = run(['status', '--json']);
assert.equal(r.status, 1);
s = JSON.parse(r.stdout);
assert.equal(s.state, 'pending');
assert.equal(s.uploads, 2);
assert.equal(s.stagedFiles, 3); // enc x2 + envelope; state.json is metadata, not staging
assert.equal(s.stagedBytes, 1700);

// A mid-pipeline tmp/ payload (plaintext tar, no .enc yet) is still 'pending'
// — 'empty' would lie about stagedFiles while the most sensitive artifact
// sits on disk.
{
  const hTmp = mkdtempSync(path.join(os.tmpdir(), 'zagent-snapshot-tmp-'));
  const tdir = path.join(hTmp, '.zcode', 'v2', 'checkpoints', 'w1', 'tmp');
  mkdirSync(tdir, { recursive: true });
  writeFileSync(path.join(tdir, 'g.tar.gz'), Buffer.alloc(64));
  const rt = run(['status', '--json'], hTmp);
  assert.equal(rt.status, 1, 'a staged tmp/ payload must still exit 1');
  const st = JSON.parse(rt.stdout);
  assert.equal(st.state, 'pending');
  assert.equal(st.uploads, 0);
  assert.equal(st.stagedFiles, 1);
}

// lock wipes staging and blocks writes (skipped on win32: no dir lock there;
// and as root: chmod-based locking cannot block root writes, so the EACCES
// premise is void in root containers - CI runner caveat 2026-09-21).
if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
  const preLockMode = lstatSync(dir()).mode & 0o777;
  r = run(['lock', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const lr = JSON.parse(r.stdout);
  assert.equal(lr.ok, true);
  assert.ok(['immutable', 'mode'].includes(lr.method), `method: ${lr.method}`);
  assert.equal(lr.removedBytes, 1700 + '{}'.length);
  assert.equal(lr.removedFiles, 4);
  assert.ok(existsSync(dir()), 'lock creates the dir when absent — here it existed');
  assert.throws(() => writeFileSync(path.join(dir(), 'probe'), 'x'), /EACCES|EPERM/,
    'a locked dir must refuse writes');
  // The sentinel makes the locked dir non-empty, closing the replace window:
  // rmdir and rename(2)-over both fail ENOTEMPTY even without the immutable
  // flag (the legacy repo-snapshots dir is migrated by rename — an empty
  // locked dir could be swapped for a writable one).
  assert.throws(() => rmdirSync(dir()), /ENOTEMPTY|EPERM|EACCES|EBUSY/,
    'a locked dir must resist rmdir');
  const impostor = path.join(home, '.zcode', 'v2', 'repo-snapshots');
  mkdirSync(impostor, { recursive: true });
  writeFileSync(path.join(impostor, 'g.tar.gz.enc'), 'staged');
  assert.throws(() => renameSync(impostor, dir()), /ENOTEMPTY|EPERM|EACCES|EBUSY/,
    'rename must not be able to replace the locked dir');
  rmSync(impostor, { recursive: true, force: true });
  r = run(['status', '--json']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).state, 'locked');

  // The human line names severity + remedy — locked is the guarded
  // posture (the upload is disabled, nothing is broken), and the remedy
  // verb is 'snapshot unlock'. The old copy read like a failure and named
  // neither.
  r = run(['status']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /staging locked — desktop workspace upload is disabled/);
  assert.match(r.stdout, /\(ok — run 'zagent snapshot unlock' to re-enable\)/,
    'locked must name severity and the remedy verb');
  assert.doesNotMatch(r.stdout, /cannot write here/,
    'the old copy sounded like an error with no severity or remedy');

  // lock again is idempotent; unlock restores writability.
  r = run(['lock']);
  assert.equal(r.status, 0, `re-lock must be idempotent: ${r.stderr}`);
  assert.match(r.stdout, /already locked/);
  r = run(['unlock']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lstatSync(dir()).mode & 0o777, preLockMode, 'unlock restores the pre-lock mode');
  assert.equal(existsSync(path.join(dir(), '.zagent-guard-lock')), false, 'unlock removes the sentinel');
  writeFileSync(path.join(dir(), 'writable-again'), 'x'); // must not throw

  // unlock restores the mode the dir had before lock (not a fixed 0o755).
  {
    const h7 = mkdtempSync(path.join(os.tmpdir(), 'zagent-snapshot-mode-'));
    const d7 = path.join(h7, '.zcode', 'v2', 'checkpoints');
    mkdirSync(d7, { recursive: true });
    chmodSync(d7, 0o700);
    r = run(['lock'], h7);
    assert.equal(r.status, 0, r.stderr);
    r = run(['unlock'], h7);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lstatSync(d7).mode & 0o777, 0o700, 'unlock must restore the pre-lock mode');
  }

  // A foreign plain file at the path is reported, never deleted by unlock.
  const h2 = mkdtempSync(path.join(os.tmpdir(), 'zagent-snapshot-file-'));
  const f = path.join(h2, '.zcode', 'v2', 'checkpoints');
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, 'user file');
  r = run(['status', '--json'], h2);
  assert.equal(JSON.parse(r.stdout).state, 'locked');
  // A foreign entry also reports 'locked' — but 'unlock' refuses it,
  // so the line must name a different remedy (manual removal), not the
  // guarded-dir one. The copy must not overclaim 'plain file' or 'cannot
  // stage' either — a symlink-to-dir is reachable and stages fine.
  r = run(['status'], h2);
  assert.match(r.stdout, /staging locked — a non-directory entry sits at the staging path/,
    'must say what actually occupies the staging path');
  assert.match(r.stdout, /remove it manually/, 'unlock refuses foreign files — the remedy is manual');
  assert.doesNotMatch(r.stdout, /'zagent snapshot unlock' to re-enable/,
    'a foreign file must not name unlock as the remedy');
  // `lock` on the same state must not prescribe the refusing remedy either.
  r = run(['lock'], h2);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /remove it manually/, 'lock must name the manual remedy for a foreign entry');
  assert.doesNotMatch(r.stdout, /unlock' restores/, 'unlock refuses foreign files — never prescribe it');
  r = run(['unlock'], h2);
  assert.equal(r.status, 1, 'unlock must refuse to remove a foreign file');
  assert.match(r.stderr, /plain file/);
  assert.ok(existsSync(f));

  // Dispatcher auto-guard (runs on every zagent invocation): leaves a bare
  // home untouched, but once the desktop data root exists it locks the
  // staging dir preemptively, is idempotent, and honors the persistent
  // opt-out `unlock` records — `lock` opts back in.
  const h3 = mkdtempSync(path.join(os.tmpdir(), 'zagent-snapshot-auto-'));
  const g = () => autoGuard({ env: guardEnv(h3), home: h3 });
  const mustRefuse = (d) => assert.throws(() => writeFileSync(path.join(d, 'probe'), 'x'), /EACCES|EPERM/);
  // The test-harness env hatch: fixture homes are rmSync'd on cleanup, so
  // the automatic guard must not create an unremovable locked dir there.
  assert.equal(autoGuard({ env: { ...guardEnv(h3), ZAGENT_TEST_SANDBOX: h3 }, home: h3 }).reason,
    'test-sandbox', 'ZAGENT_TEST_SANDBOX must disable only the automatic guard');
  let a = g();
  assert.equal(a.reason, 'no-data-root', 'a bare home must stay bare');
  mkdirSync(path.join(h3, '.zcode'));
  a = g();
  assert.equal(a.applied, true, 'auto-guard must lock even before the first capture');
  mustRefuse(path.join(h3, '.zcode', 'v2', 'checkpoints'));
  a = g();
  assert.equal(a.applied, false, 'auto-guard on a locked dir must be a no-op');
  assert.equal(a.reason, 'already-locked');

  // unlock opts out persistently: a later auto-guard run leaves it open.
  r = run(['unlock'], h3);
  assert.equal(r.status, 0, r.stderr);
  a = g();
  assert.equal(a.applied, false);
  assert.equal(a.reason, 'opted-out');
  // The guard-created dir restores to its creation mode (0777 & ~umask).
  assert.equal(lstatSync(path.join(h3, '.zcode', 'v2', 'checkpoints')).mode & 0o777, 0o777 & ~process.umask());

  // lock opts back in and removes the marker.
  r = run(['lock'], h3);
  assert.equal(r.status, 0, r.stderr);
  a = g();
  assert.equal(a.reason, 'already-locked', 'explicit lock removed the opt-out marker');
  // Explicit `lock` opts back in even when it early-returns on a
  // foreign entry at the path — the not-a-directory branch must not skip
  // the opt-out marker clear.
  const h8 = mkdtempSync(path.join(os.tmpdir(), 'zagent-snapshot-marker-'));
  mkdirSync(path.join(h8, '.zcode'));
  assert.equal(autoGuard({ env: guardEnv(h8), home: h8 }).applied, true);
  r = run(['unlock'], h8); // opts out
  assert.equal(r.status, 0, r.stderr);
  const f8 = path.join(h8, '.zcode', 'v2', 'checkpoints');
  rmSync(f8, { recursive: true, force: true });
  writeFileSync(f8, 'foreign');
  r = run(['lock'], h8);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(autoGuard({ env: guardEnv(h8), home: h8 }).reason, 'already-locked',
    'explicit lock on a foreign entry must still clear the opt-out marker');
  rmSync(f8); // plain file — cleanup stays possible

  // Leave the home writable for cleanup — a still-locked dir breaks the outer
  // rmSync (EACCES) exactly like the concurrency-test leak fixed in a previous
  // review round. The unlock VERB (not chmod) so the immutable method is
  // cleared too.
  r = run(['unlock'], h3);
  assert.equal(r.status, 0, r.stderr);

  // A staged payload under a still-writable dir is wiped + locked in one run.
  const h4 = mkdtempSync(path.join(os.tmpdir(), 'zagent-snapshot-pending-'));
  const p4 = path.join(h4, '.zcode', 'v2', 'checkpoints', 'ab12cd34ef56', 'pending');
  mkdirSync(p4, { recursive: true });
  writeFileSync(path.join(p4, 'g1.tar.gz.enc'), Buffer.alloc(1000));
  a = autoGuard({ env: guardEnv(h4), home: h4 });
  assert.equal(a.applied, true);
  assert.equal(a.removedFiles, 1);
  assert.equal(a.removedBytes, 1000);
  mustRefuse(path.dirname(path.dirname(p4)));
  r = run(['unlock'], h4); // verb, not chmod — clears the immutable method too
  assert.equal(r.status, 0, r.stderr);
} else {
  const lr = run(['lock', '--json']);
  assert.equal(lr.status, 1);
  // A loud refusal is the contract; the reason names why the FS cannot lock:
  // win32 → unsupported-platform, container overlayfs → still-writable.
  assert.ok(
    ['unsupported-platform', 'still-writable'].includes(JSON.parse(lr.stdout).reason),
    `unexpected lock refusal reason: ${JSON.parse(lr.stdout).reason}`
  );
}

// At the dispatcher (bin/zagent) level: `snapshot` itself skips the guard so
// status sees the true state; other commands lock silently and report to
// stderr only when staged payloads were actually removed (POSIX only).
if (process.platform !== 'win32') {
const bin = path.join(root, 'bin', 'zagent');
const h5 = mkdtempSync(path.join(os.tmpdir(), 'zagent-snapshot-disp-'));
const genv = { PATH: process.env.PATH, HOME: h5, USERPROFILE: h5, LANG: 'C',
  ZCODE_RUNTIME: path.join(h5, 'missing.cjs'), ZAGENT_UPDATE_CHECK: '0' };
// `snapshot status` skips the guard: absent is reported, not locked first.
let g = spawnSync(process.execPath, [bin, 'snapshot', 'status', '--json'], { encoding: 'utf8', timeout: 20000, env: genv });
assert.equal(JSON.parse(g.stdout).state, 'absent');
assert.ok(!existsSync(path.join(h5, '.zcode')), 'snapshot verbs never run the guard');
// A staged payload is wiped + locked by the next ordinary command, and the
// removal is reported on stderr.
const pend5 = path.join(h5, '.zcode', 'v2', 'checkpoints', 'ws1', 'pending');
mkdirSync(pend5, { recursive: true });
writeFileSync(path.join(pend5, 'g.tar.gz.enc'), 'x');
g = spawnSync(process.execPath, [bin, 'doctor'], { encoding: 'utf8', timeout: 20000, env: genv });
// overlayfs (CI containers) cannot lock; the wipe must still be REPORTED -
// either the locked happy path or the loud still-writable degradation.
assert.match(g.stderr, /(locked the desktop app's workspace-upload staging dir and removed 1 staged file|removed 1 staged file from the desktop app's workspace-upload staging dir but could not lock it \(still-writable\))/,
  `the wipe must be reported: ${g.stderr}`);
const overlayFs = /still-writable/.test(g.stderr);
if (!overlayFs) {
  assert.throws(() => writeFileSync(path.join(h5, '.zcode', 'v2', 'checkpoints', 'probe'), 'x'), /EACCES|EPERM/);
}
if (!overlayFs) {
  // Once locked, later runs are silent; a bare home gains ONLY the guard dir.
  // doctor's own stdout carries the severity+remedy line, not just
  // `snapshot status` — the reported surface is the finding's actual site.
  g = spawnSync(process.execPath, [bin, 'doctor'], { encoding: 'utf8', timeout: 20000, env: genv });
  assert.doesNotMatch(g.stderr, /workspace-upload staging/, 'already-locked runs stay silent');
  assert.match(g.stdout, /staging locked — desktop workspace upload is disabled \(ok — run 'zagent snapshot unlock' to re-enable\)/,
    `doctor must print the severity+remedy line: ${g.stdout}`);
  assert.deepEqual(readdirSync(path.join(h5, '.zcode')), ['v2']);
  // Restore write access — a leftover locked dir breaks the gate's tmp rimraf.
  // The unlock verb also clears chattr +i / chflags uchg (chmod cannot).
  g = spawnSync(process.execPath, [bin, 'snapshot', 'unlock'], { encoding: 'utf8', timeout: 20000, env: genv });
  assert.equal(g.status, 0, g.stderr);
}
}

console.log('ok - snapshot status/lock/unlock guard the desktop upload staging dir');
process.exit(0);
