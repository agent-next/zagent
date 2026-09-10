// Coding Plan monitor plus legacy desktop billing/reset readers.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { decryptCredential, loadCredentialStore, deviceMid } from './credentials.mjs';

export const BASE = process.env.ZCODE_BASE_URL ?? 'https://zcode.z.ai';

export function quotaError({ status, body }) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length)
    return `HTTP ${status}: invalid quota response`;
  if (status >= 200 && status < 300 && body.success !== false && !body.error &&
      (body.code === undefined || [0, '0', 200, '200'].includes(body.code))) return null;
  const message = body.message ?? body.msg ?? body.error?.message ?? 'quota request failed';
  return `HTTP ${status}${body.code === undefined ? '' : ` (code ${body.code})`}: ${String(message)}`;
}

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

// ZAI_API_KEY explicitly overrides account selection. Otherwise use the CLI's
// selected provider (desktop OAuth can belong to a different account).
function validateCodingPlanKey(value) {
  const key = value.trim();
  // Reject malformed header values before fetch can include credentials in its
  // validation error. Coding Plan keys are nonempty printable ASCII tokens.
  if (!/^[\x21-\x7e]+$/.test(key)) throw new Error('Invalid Coding Plan key format');
  return key;
}
export function codingPlanKey({ env = process.env, home = os.homedir() } = {}) {
  if (env.ZAI_API_KEY?.trim()) return validateCodingPlanKey(env.ZAI_API_KEY);
  let config;
  try { config = JSON.parse(readFileSync(`${home}/.zcode/cli/config.json`, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('Cannot read CLI provider config; repair it or set ZAI_API_KEY'); }
  if (config !== undefined) {
    const id = typeof config?.model?.main === 'string' ? config.model.main.split('/')[0] : undefined;
    const options = config?.provider?.[id]?.options;
    if (typeof options?.baseURL !== 'string' || options.baseURL.replace(/\/$/, '') !== 'https://api.z.ai/api/anthropic' ||
        typeof options.apiKey !== 'string' || !options.apiKey.trim())
      throw new Error('Selected CLI provider is not a configured Z.ai Coding Plan; set ZAI_API_KEY explicitly');
    return validateCodingPlanKey(options.apiKey);
  }
  try {
    const key = readFileSync(`${home}/.config/ccz/.api_key`, 'utf8').trim();
    if (key) return validateCodingPlanKey(key);
  } catch (e) { if (e.code !== 'ENOENT') throw new Error('Cannot read Coding Plan key'); }
  throw new Error('No Coding Plan key; configure the CLI or set ZAI_API_KEY');
}

async function monitor(endpoint, params, { fetchImpl = fetch, env = process.env, home = os.homedir() } = {}) {
  const url = new URL(`/api/monitor/usage/${endpoint}`, 'https://api.z.ai');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const key = codingPlanKey({ env, home });
  let response;
  try {
    response = await fetchImpl(url.href, { headers: { authorization: key },
      redirect: 'error', signal: AbortSignal.timeout(15000) });
  } catch {
    // Transport errors may contain request headers; never expose their text.
    throw new Error('Coding Plan transport failed; usage and quota are unknown');
  }
  let body;
  try { body = await response.json(); } catch { throw new Error('Invalid Coding Plan JSON response'); }
  if (quotaError({ status: response.status, body }) || !body?.data)
    throw new Error(`Coding Plan request failed (HTTP ${response.status}); quota is unknown`);
  return { data: body.data, observedAt: new Date().toISOString() };
}

const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function optionalCount(value) {
  if (value == null) return null;
  if (!count(value)) throw new Error('Invalid numeric Coding Plan field');
  return value;
}

export function normalizeQuota(data) {
  if (!Array.isArray(data?.limits) || !data.limits.length) throw new Error('No quota pools returned; quota is unknown');
  const pools = data.limits.map(pool => {
    if (!pool || typeof pool.type !== 'string') throw new Error('Invalid quota pool');
    const usedPercent = optionalCount(pool.percentage);
    if (usedPercent !== null && usedPercent > 100) throw new Error('Invalid quota percentage');
    const limit = optionalCount(pool.usage), used = optionalCount(pool.currentValue), remaining = optionalCount(pool.remaining);
    if (usedPercent === null && remaining === null) throw new Error('Quota pool has no remaining usage information');
    const reset = optionalCount(pool.nextResetTime);
    return { type: pool.type, unit: optionalCount(pool.unit), number: optionalCount(pool.number),
      usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent,
      limit, used, remaining, nextResetAt: reset === null ? null : new Date(reset).toISOString() };
  });
  return { level: typeof data.level === 'string' ? data.level : null, pools };
}

export async function codingPlanStatus(options) {
  const { data, observedAt } = await monitor('quota/limit', {}, options);
  return { source: 'Z.ai Coding Plan monitor', observedAt, scope: 'account', ...normalizeQuota(data) };
}

export function usageRange(days = 7, now = new Date()) {
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('--days must be an integer from 1 to 30');
  const end = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const start = new Date(`${end}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { startTime: `${start.toISOString().slice(0, 10)} 00:00:00`, endTime: `${end} 23:59:59` };
}

export function normalizeUsage(data) {
  const total = data?.totalUsage;
  if (!count(total?.totalModelCallCount) || !count(total?.totalTokensUsage))
    throw new Error('Missing or invalid usage totals; usage is unknown');
  // An absent breakdown is unknown, not an empty (zero-usage) list.
  const rows = total.modelSummaryList ?? data.modelSummaryList;
  if (rows != null && !Array.isArray(rows)) throw new Error('Invalid model usage breakdown');
  const models = rows == null ? null : rows.map(row => {
    if (typeof row?.modelName !== 'string' || !count(row.totalTokens)) throw new Error('Invalid model usage row');
    return { model: row.modelName, reportedTokens: row.totalTokens };
  });
  return { calls: total.totalModelCallCount, reportedTokens: total.totalTokensUsage, models,
    attribution: 'Account aggregate; cannot attribute usage to ccz or zagent.',
    billing: 'Reported tokens are not credits or an independently measured charge.' };
}

export async function codingPlanUsage({ days = 7, now = new Date(), ...options } = {}) {
  const range = usageRange(days, now);
  const { data, observedAt } = await monitor('model-usage', range, options);
  return { source: 'Z.ai Coding Plan monitor', observedAt, scope: 'account',
    timeZone: 'Asia/Singapore', requestedRange: range, ...normalizeUsage(data) };
}
