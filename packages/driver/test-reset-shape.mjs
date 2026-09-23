// reset-shape tests — fixture copied from the live 2026-09-05 response body.
import { normalizeReset, resetLine } from './reset-shape.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const NOW = 1788576000000;
const live = { code: 0, data: {
  available_five_hour_resets: [],
  available_week_resets: [{ expire_at: NOW + 5 * 3600_000 }],
  latest_five_hour_reset_history: { used_at: NOW - 3600_000 },
  latest_week_reset_history: null, has_unread_history: false } };

let n = normalizeReset(live, NOW);
ok(n.fiveHourAvailable === 0 && n.weekAvailable === 1, 'availability counts');
ok(n.weekExpiresInH === 5, 'expiry hours rounded');
ok(n.lastFiveHourResetAt === NOW - 3600_000 && n.lastWeekResetAt === null, 'history passthrough');
ok(n.hasUnreadHistory === false, 'unread flag');
ok(resetLine(n) === 'resets: week reset (expires in 5h)', 'line for week-only');

n = normalizeReset({ data: { available_five_hour_resets: [{ expire_at: 1 }, { expire_at: 2 }], available_week_resets: [] } }, NOW);
ok(resetLine(n) === 'resets: 2 five-hour resets', 'plural five-hour line');
ok(normalizeReset({}, NOW).fiveHourAvailable === 0, 'empty body safe');
ok(resetLine(normalizeReset({}, NOW)) === 'resets: none available', 'none line');
n = normalizeReset({ data: { available_five_hour_resets: [], available_week_resets: [{ expire_at: NOW - 1000 }] } }, NOW);
ok(n.weekExpiresInH === 0, 'expired week clamps to 0h');
n = normalizeReset({ data: { available_five_hour_resets: [{ expire_at: 1 }], available_week_resets: [{ expire_at: 2 }] } }, NOW);
ok(resetLine(n) === 'resets: 1 five-hour reset · week reset (expires in 0h)', 'combined line');

console.log(fails ? `FAIL (${fails})` : 'PASS reset-shape');
process.exit(fails ? 1 : 0);
