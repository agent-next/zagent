// Quota/entitlement reader — mirrors desktop usage-stats (billing/balance + preview),
// authenticated with our own zcodejwttoken decrypted from ~/.zcode/v2/credentials.json.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { decryptCredential, loadCredentialStore, deviceMid } from './credentials.mjs';

export const BASE = process.env.ZCODE_BASE_URL ?? 'https://zcode.z.ai';

export function getZcodeJwt() {
  return decryptCredential(loadCredentialStore()['zcodejwttoken']);
}
// Redact anything token-shaped before printing/logging.
export function redactDeep(v) {
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 6)}…(len ${v.length})` : v;
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = /key|token|secret|authorization|bearer|password|credential|jwt|cookie/i.test(k) ? '(redacted)' : redactDeep(x); return o; }
  return v;
}
// Desktop-compatible identity headers, observed from the officially installed desktop app for
// interoperability (see NOTICE). platform must be linux-x64 (not "linux"); these headers are required.
export function identityHeaders(appVersion) {
  return {
    'user-agent': `ZCode/${appVersion}`, 'x-zcode-app-version': appVersion,
    'x-title': 'Z Code@electron', 'http-referer': 'https://zcode.z.ai',
    'x-platform': `${process.platform}-${process.arch}`, 'x-os-category': process.platform,
    'x-release-channel': 'production', 'x-client-language': 'en-US',
    'x-client-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
export async function billing(path, { jwt, appVersion = '3.10.2' } = {}) {
  const plat = `${process.platform}-${process.arch}`;
  // Query shapes as used by the desktop: balance takes ONLY app_version; preview adds platform.
  const qs = path.startsWith('balance') ? `?app_version=${appVersion}`
    : path.startsWith('preview') ? `?app_version=${appVersion}&platform=${plat}` : '';
  const r = await fetch(`${BASE}/api/v1/zcode-plan/billing/${path}${qs}`, {
    headers: {
      Authorization: `Bearer ${jwt ?? getZcodeJwt()}`, ...identityHeaders(appVersion),
      'x-device-mid': deviceMid(), 'x-request-id': crypto.randomUUID(),
      'x-os-version': os.release(),
    },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body: redactDeep(body) };
}

// Coding-plan reset oracle (B2b, verified 2026-09-04): dual-token auth — zcode JWT in
// Authorization + oauth access token in x-bigmodel-authorization + bigmodel-target-type.
export async function resetStatus({ appVersion = '3.10.2' } = {}) {
  const store = loadCredentialStore();
  const oauth = decryptCredential(store['oauth:zai:access_token']);
  const r = await fetch(`${BASE}/api/v1/coding-plan/reset/status`, {
    headers: { Authorization: `Bearer ${getZcodeJwt()}`, 'x-bigmodel-authorization': oauth,
      'bigmodel-target-type': 'PERSONAL', ...identityHeaders(appVersion),
      'x-device-mid': deviceMid(), 'x-request-id': crypto.randomUUID(), 'x-os-version': os.release() },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body: redactDeep(body) };
}
