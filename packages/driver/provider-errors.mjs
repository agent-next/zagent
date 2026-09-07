// Turn a provider business error into something a person can act on.
//
// Hitting the plan's 5-hour window prints 63 lines of stack trace, with the only
// useful fact — when it resets — buried in line 1:
//
//   ProviderBusinessError: [1308][Usage limit reached for 5 hour. Your limit will
//   reset at 2026-09-08 06:05:37][202609080413175c26b2cf149e46ce]
//       at detectProviderBusinessError (…/vendor/zcode.cjs:1736:9162)
//       … 60 more lines
//
// The two limits also need opposite responses and used to be conflated: 1302 is a
// concurrency/arrival rate limit that clears in seconds, so retry; 1308 is the
// plan's usage window, so retrying just burns attempts until the reset.

/** `[code][message][requestId]`, as the runtime formats them. */
const SHAPE = /\[(\d{3,6})\]\[([^\]]*)\](?:\[([^\]]*)\])?/;

export const RETRYABLE = 'rate';     // back off and try again shortly
export const EXHAUSTED = 'usage';    // stop; nothing will succeed until the reset

const KINDS = new Map([
  [1302, { kind: RETRYABLE, title: 'Rate limit — too many requests in flight' }],
  [1304, { kind: RETRYABLE, title: 'Rate limit' }],
  [1308, { kind: EXHAUSTED, title: 'Usage limit reached for this plan window' }],
  [1113, { kind: EXHAUSTED, title: 'Insufficient balance' }],
]);

/**
 * The provider reports a bare timestamp with no zone. Rather than guess, pick the
 * offset that puts the reset in the future but no further away than the window it
 * belongs to — for a 5-hour window only one candidate can satisfy both.
 */
export function resolveReset(stamp, { windowHours = 5, now = Date.now(), offsets = [8, 0, -4, -5, -7, -8] } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(stamp?.trim() ?? '');
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m.map(Number);
  const asUTC = Date.UTC(Y, Mo - 1, D, H, Mi, S);
  const limit = windowHours * 3600_000;
  let best = null;
  for (const off of offsets) {
    const t = asUTC - off * 3600_000;           // stamp is local-to-offset
    const delta = t - now;
    if (delta > 0 && delta <= limit && (best === null || delta < best.delta)) best = { at: t, delta, offset: off };
  }
  return best;
}

export function humanDelta(ms) {
  const mins = Math.max(0, Math.round(ms / 60_000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * @returns {null|{code:number, kind:string, title:string, detail:string,
 *                 requestId:string|null, reset:object|null, advice:string}}
 */
export function explainProviderError(text, opts = {}) {
  const m = SHAPE.exec(`${text ?? ''}`);
  if (!m) return null;
  const code = Number(m[1]);
  const detail = m[2].trim();
  const known = KINDS.get(code);
  const windowHours = Number(/for\s+(\d+)\s*hour/i.exec(detail)?.[1]) || 5;
  const reset = resolveReset(/reset at ([\d-]+[ T][\d:]+)/i.exec(detail)?.[1], { ...opts, windowHours });

  let advice;
  if (known?.kind === EXHAUSTED) {
    advice = reset
      ? `Nothing will succeed until it resets — in ${humanDelta(reset.delta)}.`
      : 'Nothing will succeed until the window resets.';
  } else if (known?.kind === RETRYABLE) {
    advice = 'Transient — retry in a few seconds. The provider sends no retry-after.';
  } else {
    advice = 'Unrecognised provider error code.';
  }

  return {
    code,
    kind: known?.kind ?? 'unknown',
    title: known?.title ?? 'Provider error',
    detail,
    requestId: m[3] ?? null,
    reset,
    advice,
  };
}

/** One block a user can read, instead of a stack trace. */
export function formatProviderError(e, opts = {}) {
  if (!e) return null;
  const lines = [`zagent: ${e.title} (provider code ${e.code})`];
  if (e.reset) {
    const at = new Date(e.reset.at);
    lines.push(`  resets at ${at.toLocaleString()} (in ${humanDelta(e.reset.delta)})`);
  }
  lines.push(`  ${e.advice}`);
  if (e.code === 1308) lines.push('  `zagent offpeak` shows when off-peak routing is available.');
  if (e.requestId) lines.push(`  provider request id: ${e.requestId}`);
  return lines.join('\n');
}
