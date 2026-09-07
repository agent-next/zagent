// Reset/status shape normalizer (B2b) — live shape verified 2026-09-05:
// {code:0, data:{available_five_hour_resets:[{expire_at}], available_week_resets:[{expire_at}],
//  latest_five_hour_reset_history:{used_at}|null, latest_week_reset_history:{...}|null,
//  has_unread_history:bool}}
// Expiry math: epoch-ms → remaining hours; "available" means the array is non-empty.

export function normalizeReset(body, nowMs = Date.now()) {
  const d = body?.data ?? {};
  const hrs = ms => Math.max(0, Math.round(((ms ?? 0) - nowMs) / 3_600_000));
  const fiveHour = d.available_five_hour_resets ?? [];
  const week = d.available_week_resets ?? [];
  return {
    fiveHourAvailable: fiveHour.length,
    weekAvailable: week.length,
    weekExpiresInH: week[0]?.expire_at != null ? hrs(week[0].expire_at) : null,
    lastFiveHourResetAt: d.latest_five_hour_reset_history?.used_at ?? null,
    lastWeekResetAt: d.latest_week_reset_history?.used_at ?? null,
    hasUnreadHistory: d.has_unread_history === true,
  };
}

export function resetLine(n) {
  if (n.fiveHourAvailable === 0 && n.weekAvailable === 0) return 'resets: none available';
  const parts = [];
  if (n.fiveHourAvailable) parts.push(`${n.fiveHourAvailable} five-hour reset${n.fiveHourAvailable > 1 ? 's' : ''}`);
  if (n.weekAvailable) parts.push(`week reset (expires in ${n.weekExpiresInH}h)`);
  return `resets: ${parts.join(' · ')}`;
}
