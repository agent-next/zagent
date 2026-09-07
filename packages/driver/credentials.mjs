// enc:v1 credential decryption — mirrors ZCode desktop's own scheme (host bundle, 3.10.2):
//   blob = "enc:v1:" + b64url(IV 12B) + "." + b64url(GCM tag 16B) + "." + b64url(ciphertext)
//   key = sha256(secret), AES-256-GCM
//   secret = env ZCODE_CREDENTIAL_SECRET, else `zcode-credential-fallback:${platform}:${homedir}:${username}`
// READ-ONLY use only: this module never writes credentials.
import { createHash, createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';

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
export function loadCredentialStore() {
  return JSON.parse(readFileSync(`${os.homedir()}/.zcode/v2/credentials.json`, 'utf8'));
}
