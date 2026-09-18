// Coding Plan monitor plus legacy desktop billing/reset readers.
import { readFileSync, writeFileSync, mkdirSync, renameSync, linkSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { decryptCredential, loadCredentialStore, deviceMid, NO_DESKTOP_CREDENTIALS } from './credentials.mjs';

export const BASE = process.env.ZCODE_BASE_URL ?? 'https://zcode.z.ai';

export function quotaError({ status, body }) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length)
    return `HTTP ${status}: invalid quota response`;
  if (status >= 200 && status < 300 && body.success !== false && !body.error &&
      (body.code === undefined || [0, '0', 200, '200'].includes(body.code))) return null;
  const message = body.message ?? body.msg ?? body.error?.message ?? 'quota request failed';
  return `HTTP ${status}${body.code === undefined ? '' : ` (code ${body.code})`}: ${String(message)}`;
}

// FLOCK-F11: a failing quota call must say WHICH problem it is — a rejected
// credential (sign-in), a real usage limit (quota window), or transport —
// because the fixes differ. The class is derived from the HTTP status and the
// numeric business code only; server-provided message text stays out of the
// error because it can carry anything.
export function quotaFailureClass({ status, body }) {
  const code = Number(body?.code);
  if (status === 401 || status === 403 || code === 401 || code === 403) return 'auth';
  if (status === 429 || code === 1308 || code === 1113) return 'limit';
  return null;
}
export const QUOTA_CLASS_HINT = {
  auth: 'a sign-in problem, not a quota limit — run `zagent login` to sign in',
  limit: 'a quota-window problem, not a sign-in problem — retry after the window resets (`zagent quota reset` lists reset tickets)',
};
// FLOCK-F15: the failure class rides the error as `quotaClass` so the --json
// error envelope emits it as a field, not only as stderr prose. Absent = the
// failure is unclassified (a service-shape problem, not auth/limit/network).
const classified = (message, cls) => Object.assign(new Error(message), { quotaClass: cls });
// Every credential-store failure on the quota path is a sign-in-class problem
// (no store, corrupt store, non-object store): the fix is always `zagent login`.
// A stray fs error inherits the label too — ??= keeps a more specific class
// when one was already attached.
function credentialStore() {
  try { return loadCredentialStore(); }
  catch (e) { e.quotaClass ??= 'auth'; throw e; }
}
// Device identity is provisioned at sign-in; an unknown mid is auth-class.
function deviceMidOrAuth() {
  try { return deviceMid(); }
  catch (e) { e.quotaClass ??= 'auth'; throw e; }
}

export function getZcodeJwt() {
  try {
    const blob = credentialStore()['zcodejwttoken'];
    // A store without the JWT is the same signed-out state as no store at all.
    if (typeof blob !== 'string' || !blob) throw new Error(NO_DESKTOP_CREDENTIALS);
    const jwt = decryptCredential(blob);
    if (!jwt) throw new Error(NO_DESKTOP_CREDENTIALS);
    return jwt;
  } catch (e) { e.quotaClass ??= 'auth'; throw e; }
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
// Desktop-credentialed calls refuse redirects (a cross-origin hop would carry the
// JWT/OAuth token and device MID) and are bounded like the monitor call.
async function desktopFetch(url, headers, { method, body } = {}) {
  try {
    return await fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(15000) });
  } catch {
    // Transport errors may contain request headers; never expose their text.
    throw classified('Desktop quota transport failed — a network problem, not a quota limit; the result is unknown', 'network');
  }
}
export async function billing(path, { jwt, appVersion = '3.10.2' } = {}) {
  const plat = `${process.platform}-${process.arch}`;
  // Query shapes as used by the desktop: balance takes ONLY app_version; preview adds platform.
  const qs = path.startsWith('balance') ? `?app_version=${appVersion}`
    : path.startsWith('preview') ? `?app_version=${appVersion}&platform=${plat}` : '';
  const r = await desktopFetch(`${BASE}/api/v1/zcode-plan/billing/${path}${qs}`, {
    Authorization: `Bearer ${jwt ?? getZcodeJwt()}`, ...identityHeaders(appVersion),
    'x-device-mid': deviceMidOrAuth(), 'x-request-id': crypto.randomUUID(),
    'x-os-version': os.release(),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body: redactDeep(body) };
}

// Coding-plan reset oracle (B2b, verified 2026-09-04): dual-token auth — zcode JWT in
// Authorization + oauth access token in x-bigmodel-authorization + bigmodel-target-type.
// Action surface verified against the installed 3.12.1 desktop host: GET status,
// POST use {idempotency_key, reset_type: FIVE_HOUR|WEEK} -> {used:true},
// POST opportunity {idempotency_key} -> {granted:true} or business code 3301 with
// {granted:false, next_try_at}; the host picks the oauth credential by account family.
function resetOauth(store) {
  for (const key of ['oauth:zai:access_token', 'oauth:bigmodel:access_token']) {
    try {
      const token = store[key] === undefined ? undefined : decryptCredential(store[key]);
      if (token) return token;
    } catch { /* a corrupt blob falls through to the next family key */ }
  }
  return undefined;
}
async function resetRequest(path, { method = 'GET', body, appVersion = '3.10.2' } = {}) {
  const store = credentialStore();
  const headers = {
    Authorization: `Bearer ${getZcodeJwt()}`, 'x-bigmodel-authorization': resetOauth(store),
    'bigmodel-target-type': 'PERSONAL', ...identityHeaders(appVersion),
    'x-device-mid': deviceMidOrAuth(), 'x-request-id': crypto.randomUUID(), 'x-os-version': os.release(),
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await desktopFetch(`${BASE}/api/v1/coding-plan/reset${path}`, headers, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed, bodyOk = true;
  try { parsed = await r.json(); } catch { parsed = {}; bodyOk = false; }
  // `settled` = the service gave a definitive answer: a sub-500 status with a
  // parseable body. A 5xx or unreadable body leaves the consume outcome unknown.
  return { status: r.status, body: redactDeep(parsed), settled: r.status < 500 && bodyOk };
}
export function resetStatus(opts) {
  return resetRequest('/status', opts);
}
// Consume-safety: a pending action's idempotency key is persisted BEFORE the POST
// and cleared only once the service settles the outcome (sub-500 + parseable
// body — a business error still means the consume did not silently happen). A
// transport failure, 5xx, or unreadable body leaves the file, so a retry replays
// the SAME key and the service can dedupe instead of consuming a second scarce
// ticket. One file per action slot under ~/.zcode/cli/reset-pending/ (0600),
// published via tmp+hardlink so the first concurrent writer's key wins and
// losers converge on it rather than minting competing keys.
const pendingResetFile = (home, slot) => `${home}/.zcode/cli/reset-pending/${slot}.json`;
function pendingKey(slot, home) {
  try {
    const parsed = JSON.parse(readFileSync(pendingResetFile(home, slot), 'utf8'));
    return /^[0-9a-f-]{36}$/.test(parsed?.idempotency_key ?? '') ? parsed.idempotency_key : null;
  } catch { return null; }
}
// Parks `key` for the slot unless a valid key is already parked; returns the key
// that is actually persisted (the winner's on a concurrent collision).
function rememberPending(slot, key, home) {
  const file = pendingResetFile(home, slot);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(
    { version: 1, idempotency_key: key, created_at: new Date().toISOString() }, null, 1),
    { mode: 0o600 });
  try {
    linkSync(tmp, file);  // atomic create-if-absent: the first writer wins
  } catch {
    // Slot already parked (or hardlinks unsupported): keep a valid parked key;
    // only replace a missing/corrupt one so OUR key is the persisted one.
    if (pendingKey(slot, home) === null) {
      try { renameSync(tmp, file); } catch { /* a winner re-parked meanwhile */ }
    }
  }
  rmSync(tmp, { force: true });
  return pendingKey(slot, home) ?? key;
}
function forgetPending(slot, key, home) {
  try {
    // Compare-and-delete: a concurrent run may have parked its own key after we
    // settled — only remove the file while it still holds OURS.
    if (pendingKey(slot, home) !== key) return;
    rmSync(pendingResetFile(home, slot), { force: true });
  } catch { /* cleanup is best-effort; a stale file only replays a settled key */ }
}
export const RESET_TYPES = { 'five-hour': 'FIVE_HOUR', week: 'WEEK' };
export async function resetUse(resetType, { home = os.homedir(), ...opts } = {}) {
  const mapped = RESET_TYPES[resetType];
  if (!mapped) throw new Error(`unknown reset type "${resetType}" (expected five-hour|week)`);
  const slot = `use-${mapped}`;
  const key = rememberPending(slot, pendingKey(slot, home) ?? crypto.randomUUID(), home);
  const r = await resetRequest('/use', { ...opts, method: 'POST',
    body: { idempotency_key: key, reset_type: mapped } });
  if (r.settled) forgetPending(slot, key, home);
  return r;
}
export async function resetClaim({ home = os.homedir(), ...opts } = {}) {
  const key = rememberPending('claim', pendingKey('claim', home) ?? crypto.randomUUID(), home);
  const r = await resetRequest('/opportunity', { ...opts, method: 'POST',
    body: { idempotency_key: key } });
  if (r.settled) forgetPending('claim', key, home);
  return r;
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
// Resolve the Coding Plan key AND identify which configured plan it belongs to.
// plan is {providerId, name} when the key comes from the CLI provider config
// (e.g. builtin:zai-coding-plan vs builtin:zai-start-plan), null when the key
// source (env var, ccz fallback file) carries no plan identity.
function resolveCodingPlanKeyOrThrow({ env = process.env, home = os.homedir() } = {}) {
  if (env.ZAI_API_KEY?.trim())
    return { key: validateCodingPlanKey(env.ZAI_API_KEY), source: 'ZAI_API_KEY', plan: null };
  let config;
  try { config = JSON.parse(readFileSync(`${home}/.zcode/cli/config.json`, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('Cannot read CLI provider config — a sign-in problem, not a quota limit; repair it or set ZAI_API_KEY'); }
  if (config !== undefined) {
    const id = typeof config?.model?.main === 'string' ? config.model.main.split('/')[0] : undefined;
    const provider = config?.provider?.[id];
    const options = provider?.options;
    if (typeof options?.baseURL !== 'string' || options.baseURL.replace(/\/$/, '') !== 'https://api.z.ai/api/anthropic')
      throw new Error('Selected CLI provider is not a configured Z.ai Coding Plan — a sign-in problem, not a quota limit; set ZAI_API_KEY or re-run `zagent login`');
    // An OAuth-written config before provisioning holds apiKey:'' — fall
    // through to provider_config.json, which may already carry the key.
    if (typeof options.apiKey === 'string' && options.apiKey.trim())
      return { key: validateCodingPlanKey(options.apiKey), source: 'cli-config',
        plan: { providerId: id, name: typeof provider?.name === 'string' ? provider.name : null } };
  }
  // `zagent login` makes the kernel provision the plan key into
  // v2/provider_config.json; cli/config.json only picks it up on a later
  // ensureConfig run. Read it here so the sign-in advice actually fixes this
  // command on the first retry. A missing/corrupt file falls through to the
  // ccz fallback like the CLI reader does.
  let provisioned = null;
  try {
    const pc = JSON.parse(readFileSync(`${home}/.zcode/v2/provider_config.json`, 'utf8'));
    provisioned = pc?.config?.providerConfigRules?.providerRules
      ?.find(r => r?.providerId === 'zai')?.config?.access?.apiKey;
  } catch { /* absent or unparsable — fall through */ }
  if (typeof provisioned === 'string' && provisioned.trim())
    return { key: validateCodingPlanKey(provisioned), source: 'provider-config', plan: null };
  try {
    const key = readFileSync(`${home}/.config/ccz/.api_key`, 'utf8').trim();
    if (key) return { key: validateCodingPlanKey(key), source: 'ccz-fallback', plan: null };
  } catch (e) { if (e.code !== 'ENOENT') throw new Error('Cannot read Coding Plan key — a sign-in problem, not a quota limit; set ZAI_API_KEY'); }
  throw new Error('No Coding Plan key — a sign-in problem, not a quota limit; run `zagent login` or set ZAI_API_KEY, then `zagent quota` shows the windows and reset times');
}
// Every resolution failure is a sign-in-class problem: the fix is always
// `zagent login` or a fresh ZAI_API_KEY, never a quota-window wait.
export function resolveCodingPlanKey(options) {
  try { return resolveCodingPlanKeyOrThrow(options); }
  catch (e) { e.quotaClass ??= 'auth'; throw e; }
}
export function codingPlanKey(options) { return resolveCodingPlanKey(options).key; }

async function monitor(endpoint, params, { fetchImpl = fetch, env = process.env, home = os.homedir() } = {}) {
  const url = new URL(`/api/monitor/usage/${endpoint}`, 'https://api.z.ai');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const { key, source: keySource, plan } = resolveCodingPlanKey({ env, home });
  let response;
  try {
    response = await fetchImpl(url.href, { headers: { authorization: key },
      redirect: 'error', signal: AbortSignal.timeout(15000) });
  } catch {
    // Transport errors may contain request headers; never expose their text.
    throw classified('Coding Plan transport failed — a network problem, not a quota limit; usage and quota are unknown', 'network');
  }
  let body;
  try { body = await response.json(); } catch { throw new Error('Invalid Coding Plan JSON response'); }
  const failure = quotaError({ status: response.status, body });
  if (failure || !body?.data) {
    const cls = quotaFailureClass({ status: response.status, body });
    const code = Number(body?.code);
    const where = `HTTP ${response.status}${Number.isFinite(code) ? `, code ${code}` : ''}`;
    if (cls === 'auth')
      throw Object.assign(classified(`Coding Plan credential rejected (${where}) — ${QUOTA_CLASS_HINT.auth} or set a fresh ZAI_API_KEY`, 'auth'),
        { quotaStatus: response.status, quotaCode: Number.isFinite(code) ? code : null });
    if (cls === 'limit')
      throw Object.assign(classified(`Coding Plan usage limit (${where}) — ${QUOTA_CLASS_HINT.limit}`, 'limit'),
        { quotaStatus: response.status, quotaCode: Number.isFinite(code) ? code : null });
    throw new Error(`Coding Plan request failed (${where}); quota is unknown`);
  }
  return { data: body.data, observedAt: new Date().toISOString(), keySource, plan };
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
  const { data, observedAt, keySource, plan } = await monitor('quota/limit', {}, options);
  return { source: 'Z.ai Coding Plan monitor', observedAt, scope: 'account', keySource, plan, ...normalizeQuota(data) };
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
  const { data, observedAt, keySource, plan } = await monitor('model-usage', range, options);
  return { source: 'Z.ai Coding Plan monitor', observedAt, scope: 'account', keySource, plan,
    timeZone: 'Asia/Singapore', requestedRange: range, ...normalizeUsage(data) };
}
