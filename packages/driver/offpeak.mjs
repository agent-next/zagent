// I3 — off-peak scheduler helper: pure functions for the zero-quota flash window.
// Window is data-driven (from the docs client-configs endpoint when reachable, cached);
// local fallback is 23:00–09:00 SGT (the documented campaign default through 2026-09-20).
// Z.ai's campaign advertises GLM-5.3-Flash via ZCode at no quota cost in this window.
// That is their published claim, not a measurement: the plan's rolling usage window is
// enforced independently (a 1308 was observed during an open window, 2026-09-07). Routing
// work to flash in this window does not verify this adapter's billing eligibility.

import os from 'node:os';
import crypto from 'node:crypto';
import { BASE, identityHeaders, getZcodeJwt, redactDeep } from './quota.mjs';
import { deviceMid, loadCredentialStore, decryptCredential } from './credentials.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const cacheFile = () => `${os.homedir()}/.zcode/cli/offpeak-cache.json`;
const DEFAULT = { startHourSGT: 23, endHourSGT: 9, campaignEnd: '2026-09-20', source: 'default' };

export function defaultWindow() { return { ...DEFAULT }; }

// Pure: given a Date and a window, is the moment inside the off-peak hours?
// Hours are compared in SGT (UTC+8) regardless of the caller's local timezone.
const sgtHourOf = now => new Date(now.getTime() + 8 * 3600e3).getUTCHours();
const sgtMinuteOf = now => new Date(now.getTime() + 8 * 3600e3).getUTCMinutes();

export function inOffPeak(now, win = DEFAULT) {
  const h = sgtHourOf(now);
  return win.startHourSGT > win.endHourSGT        // wrapping window (e.g. 23–09)
    ? (h >= win.startHourSGT || h < win.endHourSGT)
    : (h >= win.startHourSGT && h < win.endHourSGT); // non-wrapping (e.g. 01–05)
}

// Pure: is the campaign still active at the given date?
export function campaignActive(now, win = DEFAULT) {
  return now.getTime() < new Date(`${win.campaignEnd}T09:00:00+08:00`).getTime();
}

// Pure: routing recommendation for a task — should it go to flash now?
export function routeToFlash(now, { mechanical = true, win = DEFAULT } = {}) {
  if (!mechanical) return { flash: false, reason: 'judgment task stays on main model' };
  if (!campaignActive(now, win)) return { flash: false, reason: 'campaign ended' };
  if (!inOffPeak(now, win)) return { flash: false, reason: 'outside off-peak hours (costs credits)' };
  return { flash: true, reason: 'mechanical + off-peak + campaign active' };
}

// Pure: how many minutes until the next off-peak window opens (for scheduling delayed work).
export function minutesUntilWindow(now, win = DEFAULT) {
  if (inOffPeak(now, win)) return 0;
  return ((win.startHourSGT - sgtHourOf(now) + 24) % 24) * 60 - sgtMinuteOf(now);
}

// Fetch the real window from the docs client-configs endpoint (best-effort, cached).
export async function fetchWindow({ timeoutMs = 5000 } = {}) {
  try {
    const r = await fetch(`${BASE}/api/v1/client/configs?app_version=3.10.2&platform=${process.platform}-${process.arch}`,
      { signal: AbortSignal.timeout(timeoutMs) });
    const body = await r.json();
    const offPeak = body?.data?.configs?.offPeak;
    if (offPeak?.enable_offpeak_task === true && offPeak.allowed_models?.length) {
      // only mark 'server' for fields the server actually controls (allowedModels);
      // hours/campaignEnd stay DEFAULT until the server exposes them explicitly
      const win = { ...DEFAULT, source: offPeak.allowed_models ? 'server' : 'default', allowedModels: offPeak.allowed_models };
      mkdirSync(dirname(cacheFile()), { recursive: true });
      writeFileSync(cacheFile(), JSON.stringify({ ...win, fetchedAt: Date.now() }, null, 1));
      return win;
    }
    return { ...DEFAULT };
  } catch {
    return { ...DEFAULT };
  }
}

// Sync read of the cached window (or the default if never fetched).
export function cachedWindow() {
  try {
    const w = JSON.parse(readFileSync(cacheFile(), 'utf8'));
    // shape-validate: a corrupt/partial file must fall back to DEFAULT, not silently
    // produce NaN dates that read as "campaign ended"
    if (typeof w.campaignEnd !== 'string' || !/\d{4}-\d{2}-\d{2}/.test(w.campaignEnd)) return { ...DEFAULT };
    if (typeof w.startHourSGT !== 'number' || typeof w.endHourSGT !== 'number') return { ...DEFAULT };
    return w;
  } catch { return { ...DEFAULT }; }
}

// --- C1: off-peak REST client — the 4-call ticket lifecycle ---
// POST /ticket → create; POST /ticket/status → batch poll; POST /ticket/{id}/settle → settle
// Auth: desktop JWT + the selected desktop Coding Plan API key, not its OAuth token.
// This adapter currently supports the personal Z.ai desktop connection only.
export function offPeakPlanKey({ settings, config, activeProvider }) {
  const provider = 'builtin:zai-coding-plan';
  if (activeProvider !== 'zai' || settings?.providerFamilyDomain !== 'zai' ||
      settings?.modelProviderFamilyModes?.zai !== 'oauth' ||
      settings?.modelProviderFamilySelectedKeys?.zai !== `coding-plan:${provider}`)
    throw new Error('Select the personal Z.ai Coding Plan desktop connection for idle tasks');
  const options = config?.provider?.[provider]?.options;
  const key = typeof options?.apiKey === 'string' ? options.apiKey.trim() : '';
  if (typeof options?.baseURL !== 'string' || options.baseURL.replace(/\/$/, '') !== 'https://api.z.ai/api/anthropic' || !/^[\x21-\x7e]+$/.test(key))
    throw new Error('Selected desktop Coding Plan API key is unavailable or invalid');
  return key;
}
function getCodingPlanKey() {
  let settings, config, activeProvider;
  try {
    settings = JSON.parse(readFileSync(`${os.homedir()}/.zcode/v2/setting.json`, 'utf8'));
    config = JSON.parse(readFileSync(`${os.homedir()}/.zcode/v2/config.json`, 'utf8'));
    activeProvider = decryptCredential(loadCredentialStore()['oauth:active_provider']);
  } catch { throw new Error('Cannot read the selected desktop Coding Plan connection'); }
  return offPeakPlanKey({ settings, config, activeProvider });
}
export async function offPeakRequest(path, init = {}, { jwt, apiKey } = {}) {
  const r = await fetch(`${BASE}/api/v1/off-peak${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${jwt ?? getZcodeJwt()}`,
      'x-coding-plan-api-key': apiKey ?? getCodingPlanKey(),
      'Content-Type': 'application/json',
      'user-agent': 'ZCode/3.11.2', 'x-platform': `${process.platform}-${process.arch}`,
      ...identityHeaders('3.11.2'), 'x-device-mid': deviceMid(), 'x-request-id': crypto.randomUUID(),
      ...init.headers,
    },
  });
  let body;
  try { body = await r.json(); } catch { throw new Error('Invalid off-peak ticket JSON'); }
  return { status: r.status, body: redactDeep(body) };
}

export async function checkAvailability() { return offPeakRequest('/ticket/availability'); }
export async function takeTicket(taskId) {
  return offPeakRequest('/ticket', { method: 'POST', body: JSON.stringify({ task_id: taskId }) });
}
export async function pollTickets(ticketIds) {
  return offPeakRequest('/ticket/status', { method: 'POST', body: JSON.stringify({ ticket_ids: ticketIds.slice(0, 100) }) });
}
export async function settleTicket(ticketId, result) {
  return offPeakRequest(`/ticket/${ticketId}/settle`, { method: 'POST', body: JSON.stringify(result) });
}

// --- C2: poll loop — server-driven timing with exponential backoff ---
export function nextDelayMs(pollResponse, errorCount = 0) {
  if (errorCount > 0) return Math.min(10_000 * 2 ** (errorCount - 1), 300_000); // 10s·2^n cap 5min
  const sec = pollResponse?.body?.data?.next_poll_after;
  if (typeof sec === 'number') return Math.max(5, Math.min(sec, 300)) * 1000; // clamp 5-300s
  return 5_000; // default 5s
}

// --- C3: turn execution via the off-peak synthetic provider ---
// Routes an Anthropic-format request to {origin}/api/v1/off-peak/anthropic/v1/messages
// with the offpeak-idle-plan provider identity.
// Kernel ClientRequestSigningV4Signer treats this path as isUnsignedModelRequestPath
// and sendUnsigned(); do not attach X-Client-Sig / PoW headers.
function offPeakTurnHeaders({ jwt, apiKey, ticketId }) {
  let mid;
  try { mid = deviceMid(); } catch { /* kernel omits X-Device-Mid when unknown */ }
  return {
    ...identityHeaders('3.11.2'),
    'x-os-version': os.release(),
    'x-request-id': crypto.randomUUID(),
    'X-ZCode-Agent': 'glm',
    ...mid ? { 'x-device-mid': mid } : {},
    Authorization: `Bearer ${jwt}`,
    'x-coding-plan-api-key': apiKey,
    'x-off-peak-ticket-id': ticketId,
    'x-api-key': jwt,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  };
}
export async function offPeakTurn(messages, { ticketId, maxTokens = 4096,
  model = 'GLM-5.3-Flash', fetchImpl = fetch, jwt, apiKey } = {}) {
  if (typeof ticketId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(ticketId))
    throw new Error('A valid ready off-peak ticket ID is required');
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('maxTokens must be a positive integer');
  jwt ??= getZcodeJwt();
  apiKey ??= getCodingPlanKey();
  let r;
  try { r = await fetchImpl(`${BASE}/api/v1/off-peak/anthropic/v1/messages`, {
    method: 'POST',
    redirect: 'error', signal: AbortSignal.timeout(120000),
    headers: offPeakTurnHeaders({ jwt, apiKey, ticketId }),
    body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
  }); } catch { throw new Error('Off-peak inference transport failed'); }
  let body;
  try { body = await r.json(); } catch { throw new Error('Invalid off-peak inference JSON'); }
  // Preserve generated text and numeric token usage; redact only actual credentials.
  const cleanText = text => [jwt, apiKey].filter(Boolean)
    .reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), text);
  const clean = value => {
    if (typeof value === 'string') return cleanText(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [cleanText(key), clean(entry)]));
    return value;
  };
  return { status: r.status, body: clean(body) };
}

// C4: error classification per the dossier's semantics
export function classifyOffPeakError(status, code) {
  if (code === 3102) return { action: 'abort_retake', retry: false };                    // ticket expired
  // Live HTTP 400 "parameter error". Kernel isUnsignedModelRequestPath includes
  // /api/v1/off-peak/anthropic/v1/messages and sendUnsigned() strips X-Client-*.
  // GUI resolveOffPeakFailureDecision maps 3001 to ticketExpired (same as 3102).
  if (code === 3001) return { action: 'invalid_request', retry: false };
  if (code === 3105 || status === 429) return { action: 'wait', retry: true };            // transient
  if (code === 3103) return { action: 'quota_wait', retry: true };                          // quota exhausted
  if (code === 3101) return { action: 'eligibility_fail', retry: false };                   // not eligible
  return { action: 'unknown', retry: false };
}

// --- C5: create-gate UX — the pre-checks before a user can submit an idle task ---
// Pure core (testable without HTTP): eligible ONLY on explicit can_take_number === true
// (the availability endpoint returns exactly {can_take_number} — live-verified 2026-09-05;
// it does NOT carry allowed_models/queue_position, so we never guess eligibility from
// missing fields). Review r4: a 200 with empty data must be NOT-eligible, not eligible.
export function gateFromAvailability(avail) {
  const d = avail?.body?.data ?? {};
  const ok = avail?.status === 200 && (avail.body?.code === undefined || avail.body?.code === 0) && d.can_take_number === true;
  return {
    eligible: ok,
    reasons: ok ? [] : [avail?.status === 200 ? 'no ticket available right now' : `availability check failed (http ${avail?.status ?? 'n/a'})`],
    canTakeNumber: d.can_take_number ?? false,
  };
}

export async function idleTaskGate() {
  return gateFromAvailability(await checkAvailability());
}

// --- I2: idle-task queue state machine over the ticket lifecycle ---
// Pure transitions (testable): idle → queued(taken) → running(polled) → done|failed,
// driven by poll bodies and the C4 error classifier. Retry policy: only abort_retake
// and 429 go back to queued (bounded); quota_wait/eligibility park as waiting.
export const QUEUE_STATES = ['idle', 'queued', 'ready', 'running', 'waiting', 'settled', 'done', 'failed'];

export function initialQueueState() { return { state: 'idle', ticketId: null, taskId: null, attempts: 0 }; }

export function onTicketTaken(s, { taskId, ticketId }) {
  if (s.state !== 'idle' && s.state !== 'failed') return { ...s, error: `take in state ${s.state}` };
  return { state: 'queued', taskId, ticketId, attempts: s.attempts + 1, error: undefined };
}

export function onPollResult(s, pollBody) {
  const d = pollBody?.body?.data ?? pollBody?.data ?? pollBody ?? {};
  const tickets = d.tickets ?? d.items ?? (d.ticket_id ? [d] : []);
  // r12 #1/#2: ONLY our own ticket's status may move the state — a foreign ticket's
  // 'completed' must not; malformed bodies preserve state rather than guess 'running'.
  const t = Array.isArray(tickets) ? tickets.find(x => x?.ticket_id === s.ticketId || x?.id === s.ticketId) : null;
  if (!t) return { ...s, error: 'poll: no entry for our ticket (state preserved)' };
  const map = { running: 'running', pending: 'queued', queued: 'queued', processing: 'running',
    done: 'done', completed: 'done', success: 'done', failed: 'failed', error: 'failed',
    cancelled: 'failed', canceled: 'failed', waiting: 'waiting' };
  // Ticket states are not task outcomes: settled does not prove task success.
  const ticketStates = { queued: 'queued', ready: 'ready', active: 'running', expired: 'failed',
    not_found: 'failed', settled: 'settled' };
  const states = t.state !== undefined ? ticketStates : map;
  const label = String(t.state ?? t.status ?? '').toLowerCase();
  const next = Object.hasOwn(states, label) ? states[label] : undefined;
  if (!next) return { ...s, error: `poll: unrecognized status '${t.status}' (state preserved)` };
  return { ...s, state: next, error: undefined };
}

export function onQueueError(s, status, code) {
  const { action, retry } = classifyOffPeakError(status, code);
  if (action === 'abort_retake') return { ...s, state: s.attempts >= 3 ? 'failed' : 'idle', error: `code ${code}` }; // bounded retake
  if (action === 'quota_wait') return { ...s, state: 'waiting', error: `code ${code}` }; // parked until quota resets
  if (action === 'wait' && retry) return { ...s, state: s.attempts >= 3 ? 'failed' : 'queued', error: `code ${code} (retryable wait)` }; // 429-class: requeue bounded
  if (action === 'wait') return { ...s, state: 'waiting', error: `code ${code}` };
  if (retry) return { ...s, state: s.attempts >= 3 ? 'failed' : 'queued', error: `http ${status}` };
  return { ...s, state: 'failed', error: `code ${code} http ${status}` };
}

export function queueLine(s) {
  return `task ${s.taskId ?? '-'}: ${s.state}${s.ticketId ? ` (ticket ${String(s.ticketId).slice(0, 6)}…)` : ''}${s.attempts ? ` · attempt ${s.attempts}` : ''}${s.error ? ` · ${s.error}` : ''}`;
}
