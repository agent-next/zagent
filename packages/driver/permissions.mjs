// Permission answering (live-verified 2026-09-05, runtime 2.1.0).
//
// The runtime sends `interaction/requestPermission` as a server->client REQUEST whose
// params carry `options[]` — each option has {kind, optionId, response:{decision,...}}.
// The client must reply with ONE OPTION'S `response` object (e.g. the allow_once one).
// Replying `{behavior:'allow'}` is the HOOK schema (kRn union: behavior/permissionUpdates/
// updatedPermissions/updatedInput) — a DIFFERENT flow. The wrong shape is silently treated
// as denial: the model reports "permission request failed" and every edit is dropped
// (this is exactly the 2026-09-05 emulator S3 failure class).
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

export function permissionInputPreview(p, maxLen = 80) { // opt-in, bounded, secret-shaped strings redacted
  const raw = JSON.stringify(p?.input ?? null);
  const red = raw.replace(/(sk-[A-Za-z0-9]{6})[A-Za-z0-9-]+/g, '$1…').replace(/(Bearer )[A-Za-z0-9._-]{8,}/g, '$1…');
  return red.length > maxLen ? red.slice(0, maxLen) + '…' : red;
}

export function blockedLine(p) {
  const r = permissionReason(p);
  if (!r) return 'blocked: no reason provided';
  return `blocked (${r.riskLevel}): ${r.reason}${r.tool ? ` — ${r.tool}` : ''}`;
}
