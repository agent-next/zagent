// enc:v1 credential decryption — mirrors ZCode desktop's own scheme (host bundle, 3.10.2):
//   blob = "enc:v1:" + b64url(IV 12B) + "." + b64url(GCM tag 16B) + "." + b64url(ciphertext)
//   key = sha256(secret), AES-256-GCM
//   secret = env ZCODE_CREDENTIAL_SECRET, else `zcode-credential-fallback:${platform}:${homedir}:${username}`
// The store is owner-only: the desktop runtime is the production writer, so the
// load path self-heals a permissive file (the live guarantee); saveCredentialStore
// (mode 0600) exists for callers that write the store from this codebase.
import { createHash, createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statSync, chmodSync, renameSync, rmSync, readdirSync, rmdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const b64url = s => Buffer.from(s, 'base64url');

export function defaultCredentialSecret(env = process.env) {
  if (env.ZCODE_CREDENTIAL_SECRET) return env.ZCODE_CREDENTIAL_SECRET;
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`;
}
export function deriveKey(secret) { return createHash('sha256').update(secret).digest(); }
export function decryptCredential(blob, { env } = {}) {
  if (typeof blob !== 'string') throw new Error(`credential blob: ${blob === undefined ? 'missing' : 'not a string'}`);
  if (!blob.startsWith('enc:v1:')) return blob; // plaintext passthrough, same as desktop
  const parts = blob.slice('enc:v1:'.length).split('.');
  if (parts.length !== 3) throw new Error('credential blob: bad format');
  const [iv, tag, ct] = parts.map(b64url);
  if (iv.length !== 12) throw new Error('credential blob: IV length');
  if (tag.length !== 16) throw new Error('credential blob: tag length');
  const d = createDecipheriv('aes-256-gcm', deriveKey(defaultCredentialSecret(env)), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf-8');
}
export function encryptCredential(plain, { env } = {}) {
  if (typeof plain !== 'string' || plain.length === 0) throw new Error('credential value must not be empty');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', deriveKey(defaultCredentialSecret(env)), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc:v1:${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}
export function decryptCredentialStore(jsonObj, opts) {
  const out = {};
  for (const [k, v] of Object.entries(jsonObj)) { try { out[k] = decryptCredential(v, opts); } catch (e) { out[k] = null; } }
  return out;
}

// Machine identity, OUTSIDE the repo (owner directive: never commit the device MID).
// Resolution: env ZCODE_DEVICE_MID -> ~/.zcode/cli/device.json -> error with fix hint.
export function deviceMid(env = process.env) {
  if (env.ZCODE_DEVICE_MID) return env.ZCODE_DEVICE_MID;
  try {
    const d = JSON.parse(readFileSync(`${os.homedir()}/.zcode/cli/device.json`, 'utf8'));
    if (d.deviceMid) return d.deviceMid;
  } catch {}
  throw new Error('device mid unknown: set ZCODE_DEVICE_MID or write ~/.zcode/cli/device.json {"deviceMid": "..."}');
}

// One loader for the enc:v1 store — quota/relay must not re-implement this.
// The file holds the zcode JWT and the coding-plan key: a successful load also
// tightens group/other bits left by an older writer (self-heal, best-effort).
// A credential-free machine gets the sign-in remedy, not a raw ENOENT (the
// code is preserved for programmatic discrimination).
export const NO_DESKTOP_CREDENTIALS =
  'No ZCode credentials; run `zagent login` to sign in first';
export function loadCredentialStore() {
  const file = `${os.homedir()}/.zcode/v2/credentials.json`;
  let store;
  try { store = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) {
    if (e?.code === 'ENOENT')
      throw Object.assign(new Error(NO_DESKTOP_CREDENTIALS), { code: 'ENOENT' });
    throw e;
  }
  // Same shape check the provisioner applies: `null`/`true`/`[]` are parseable
  // but not a store — name it instead of a TypeError on key lookup.
  if (!store || typeof store !== 'object' || Array.isArray(store))
    throw new Error('credentials store is not a JSON object');
  try { if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600); } catch {}
  return store;
}

// --- kernel write-path parity (3.12.1) --------------------------------------
// The desktop runtime shares ~/.zcode/v2/credentials.json with us; its write
// path is: interprocess lock (fu -> bQ) around read-modify-write, atomic
// sibling-tmp commit (Jb), and a .corrupt-<hash>.bak aside on unreadable input
// (zKe). These are synchronous mirrors of that scheme so our writers
// (account provisioning) mutually exclude the GUI and never truncate the
// shared store on a crash.

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

// Jb parity: write `.<basename>.<pid>.<ts>.<rand>.tmp` (0600) then rename with
// the kernel's retry ladder; on failure the tmp is removed and the target is
// never touched.
export function atomicWriteFileSync(file, data, {
  retryDelaysMs = [50, 100, 200, 400, 800],
  io = { mkdir: mkdirSync, writeFile: writeFileSync, rename: renameSync, rm: rmSync },
} = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  io.mkdir(dir, { recursive: true });
  try {
    io.writeFile(tmp, data, { encoding: 'utf-8', mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      try { io.rename(tmp, file); break; }
      catch (e) {
        // bounded ladder like the kernel's: exhaust the delays, then give up
        if (!RETRYABLE_RENAME.has(e?.code) || attempt >= retryDelaysMs.length) throw e;
        sleepSync(retryDelaysMs[attempt]);
      }
    }
  } catch (e) {
    try { io.rm(tmp, { force: true }); } catch {}
    throw e;
  }
}

const pidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
};

// RQn parity: a lock dir is abandoned when it has no owner file past the grace
// window (the holder died between mkdir and the owner write) or every recorded
// owner pid is dead. Returns true when the lock was reclaimed.
function removeAbandonedLockSync(lockDir, ownerlessGraceMs, now = Date.now()) {
  let owners;
  try {
    owners = readdirSync(lockDir).filter(n => n.startsWith('owner-') && n.endsWith('.json'));
  } catch { return false; }
  if (!owners.length) {
    try {
      if (now - statSync(lockDir).mtimeMs < ownerlessGraceMs) return false;
      rmdirSync(lockDir);
      return true;
    } catch { return false; }
  }
  for (const name of owners) {
    let pid;
    try { pid = JSON.parse(readFileSync(path.join(lockDir, name), 'utf8'))?.pid; } catch {}
    if (pidAlive(pid)) return false;
  }
  try {
    for (const name of owners) rmSync(path.join(lockDir, name), { force: true });
    rmdirSync(lockDir);
    return true;
  } catch { return false; }
}

// bQ parity: mkdir `<file>.lock` then claim it with `owner-<token>.json`;
// verify sole ownership, reclaim abandoned locks, retry on EEXIST until
// maxWaitMs. Returns a release function.
export function acquireFileLockSync(file, {
  retryDelaysMs = [25, 50, 100, 200, 400],
  ownerlessGraceMs = 100,
  maxWaitMs = 8000,
} = {}) {
  const lockDir = `${file}.lock`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ownerName = `owner-${token}.json`;
  const ownerPath = path.join(lockDir, ownerName);
  const ownerBody = JSON.stringify({ pid: process.pid, createdAt: Date.now(), token });
  const grace = Math.min(Math.max(ownerlessGraceMs, 0), Math.max(Math.floor(maxWaitMs / 2), 0));
  const start = Date.now();
  let lastErr;
  for (let attempt = 0; ; attempt += 1) {
    let madeDir = false;
    try {
      mkdirSync(lockDir);
      madeDir = true;
      const before = statSync(lockDir);
      writeFileSync(ownerPath, ownerBody, { encoding: 'utf-8', flag: 'wx' });
      const after = statSync(lockDir);
      const owners = readdirSync(lockDir).filter(n => n.startsWith('owner-') && n.endsWith('.json'));
      if (after.dev !== before.dev || after.ino !== before.ino || owners.length !== 1 || owners[0] !== ownerName)
        throw Object.assign(new Error('file lock ownership changed during acquire'), { code: 'EEXIST' });
      return () => {
        try { rmSync(ownerPath, { force: true }); } catch {}
        try { rmdirSync(lockDir); } catch {}
      };
    } catch (e) {
      if (madeDir) {
        try { rmSync(ownerPath, { force: true }); } catch {}
        try { rmdirSync(lockDir); } catch {}
      }
      const raced = madeDir && e?.code === 'ENOENT'; // our dir was reclaimed mid-acquire
      if (e?.code !== 'EEXIST' && !raced) throw e;
      lastErr = e;
      const elapsed = Date.now() - start;
      if (elapsed >= maxWaitMs) break;
      if (removeAbandonedLockSync(lockDir, grace)) continue;
      const remaining = Math.max(maxWaitMs - elapsed, 0);
      if (!retryDelaysMs.length || remaining === 0) break;
      sleepSync(Math.min(retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)], remaining));
    }
  }
  const err = new Error(`file lock timed out after ${Date.now() - start}ms: ${lockDir}`);
  err.code = 'ELOCKTIMEOUT';
  err.cause = lastErr;
  throw err;
}

// fu parity: run fn() holding the interprocess lock on `file`. Same-process
// reentrancy is not supported (the kernel serializes via a promise chain;
// synchronous callers cannot interleave anyway).
export function withFileLockSync(file, fn, opts = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const release = acquireFileLockSync(file, opts);
  try { return fn(); } finally { release(); }
}

// zKe parity: copy the unreadable file aside as `<file>.corrupt-<sha256[:24]>.bak`
// (0600, 'wx' — an existing backup for the same content is kept). Returns the
// backup path.
export function backupCorruptFileSync(file) {
  const data = readFileSync(file);
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 24);
  const bak = `${file}.corrupt-${hash}.bak`;
  try { writeFileSync(bak, data, { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e?.code !== 'EEXIST') throw e; }
  chmodSync(bak, 0o600);
  return bak;
}

export function saveCredentialStore(store, file = `${os.homedir()}/.zcode/v2/credentials.json`) {
  atomicWriteFileSync(file, JSON.stringify(store));
  chmodSync(file, 0o600); // belt-and-suspenders where mode is advisory
  return file;
}
