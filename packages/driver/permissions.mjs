// Permission answering (live-verified 2026-09-05, runtime 2.1.0).
//
// The runtime sends `interaction/requestPermission` as a server->client REQUEST whose
// params carry `options[]` — each option has {kind, optionId, response:{decision,...}}.
// The client must reply with ONE OPTION'S `response` object (e.g. the allow_once one).
// Replying `{behavior:'allow'}` is the HOOK schema (kRn union: behavior/permissionUpdates/
// updatedPermissions/updatedInput) — a DIFFERENT flow. The wrong shape is silently treated
// as denial: the model reports "permission request failed" and every edit is dropped
// (this is exactly the 2026-09-05 emulator S3 failure class).
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function autoAllow(p) {
  return p?.options?.find(o => o.kind === 'allow_once')?.response ?? { decision: 'allow' };
}

export function deny(p, message = 'denied by client') {
  return p?.options?.find(o => o.kind === 'deny')?.response ?? { decision: 'deny', reason: message };
}

// Pick by option kind — covers allow_session / custom options the GUI shows.
export function answerOption(p, kind) {
  const o = p?.options?.find(x => x.kind === kind);
  if (!o) throw new Error(`answerOption: no option of kind '${kind}' (kinds: ${(p?.options ?? []).map(x => x.kind).join(', ')})`);
  return o.response;
}

// J5: blocked-action specific reason — the permission request itself carries a human
// reason + riskLevel (live-captured 2026-09-06: "Tool has side effects and requires
// approval" / riskLevel medium; "High risk tools require explicit approval" / high).
export function permissionReason(p) {
  if (!p?.reason && !p?.riskLevel) return null;
  // r17 #1: the raw `input` (arbitrary unknown — file contents, commands, tokens) is
  // deliberately EXCLUDED from this logging-shaped result. Diagnostics that need it use
  // permissionInputPreview() with bounded, redacted output.
  return { reason: p.reason ?? 'unspecified', riskLevel: p.riskLevel ?? 'unknown',
    tool: p.toolName ?? p.tool ?? null };
}

export function redactSecrets(text) {
  return String(text)
    .replace(/(sk-[A-Za-z0-9]{6})[A-Za-z0-9-]+/g, '$1…')
    .replace(/(Bearer )[A-Za-z0-9._-]{8,}/g, '$1…');
}

export function permissionInputPreview(p, maxLen = 80) { // opt-in, bounded, secret-shaped strings redacted
  const red = redactSecrets(JSON.stringify(p?.input ?? null));
  return red.length > maxLen ? red.slice(0, maxLen) + '…' : red;
}

export function blockedLine(p) {
  const r = permissionReason(p);
  if (!r) return 'blocked: no reason provided';
  return `blocked (${r.riskLevel}): ${r.reason}${r.tool ? ` — ${r.tool}` : ''}`;
}

// Persistent Always/Never grants for interaction/requestPermission.
// Keyed by toolName + a stable redacted input fingerprint. Bash (incl. dangerous
// commands like rm / git push) remembers the exact command string, never a glob.
// Stored at ~/.zcode/cli/grants.json with mode 0600. TUI later: lookupGrant first,
// rememberGrant after the user picks an allow_always / deny-always style option.
export function grantsPath() {
  return path.join(os.homedir(), '.zcode', 'cli', 'grants.json');
}

export function isAlwaysOptionId(id) {
  return typeof id === 'string' && /^(allow|deny)[-_]always$/i.test(id.trim());
}

export function optionIdOf(option) {
  if (typeof option === 'string') return option;
  if (!option || typeof option !== 'object') return '';
  if (typeof option.optionId === 'string' && option.optionId) return option.optionId;
  if (typeof option.kind === 'string' && option.kind) return option.kind;
  if (typeof option.value === 'string' && option.value) return option.value;
  return '';
}

function isBashTool(name) {
  return /^(bash|shell)$/i.test(String(name ?? ''));
}

function bashCommand(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && typeof input.command === 'string') return input.command;
  return JSON.stringify(input ?? null);
}

export function grantFingerprint(request) {
  const tool = request?.toolName ?? request?.tool ?? '';
  const input = request?.input;
  // Unbounded redaction: preview truncates at 80ch, which would collide keys.
  if (isBashTool(tool)) return redactSecrets(bashCommand(input));
  return redactSecrets(JSON.stringify(input ?? null));
}

function grantStoreKey(request) {
  const tool = String(request?.toolName ?? request?.tool ?? '');
  return createHash('sha256').update(`${tool}\0${grantFingerprint(request)}`).digest('hex');
}

function loadGrantFile() {
  try {
    const obj = JSON.parse(readFileSync(grantsPath(), 'utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { version: 1, grants: {} };
    const grants = obj.grants && typeof obj.grants === 'object' && !Array.isArray(obj.grants) ? obj.grants : {};
    return { version: 1, grants };
  } catch {
    return { version: 1, grants: {} };
  }
}

function saveGrantFile(obj) {
  const dest = grantsPath();
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    renameSync(tmp, dest);
    chmodSync(dest, 0o600); // write/rename mode is ignored on an existing dest
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

export function lookupGrant(request) {
  const rec = loadGrantFile().grants[grantStoreKey(request)];
  return rec?.response ?? null;
}

export function rememberGrant(request, option) {
  const id = optionIdOf(option);
  if (!isAlwaysOptionId(id)) return null;
  const response = option && typeof option === 'object' && option.response !== undefined
    ? option.response
    : request?.options?.find(o => optionIdOf(o) === id)?.response;
  if (response === undefined) return null;
  const toolName = request?.toolName ?? request?.tool ?? '';
  const file = loadGrantFile();
  file.grants[grantStoreKey(request)] = { toolName, optionId: id, response };
  saveGrantFile(file);
  return response;
}
