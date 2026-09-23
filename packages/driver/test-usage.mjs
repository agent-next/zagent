// E7 usage extraction tests — shapes copied from the live-verified 2026-09-05 dump.
import { extractUsage, usageLine } from './zcode-protocol.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const delta = (over = {}) => ({ kind: 'v4/telemetry/event', params: { kind: 'usage.delta',
  modelId: 'glm-5.3', inputTokens: 100, outputTokens: 5, totalTokens: 105,
  reasoningTokens: 0, cacheReadTokens: 80, cacheWriteTokens: 0, ...over } });

// empty / no usage events
ok(extractUsage([]).totals.deltas === 0, 'no events -> 0 deltas');
ok(extractUsage(undefined).totals.deltas === 0, 'undefined events -> 0 deltas');
ok(extractUsage([{ kind: 'state.updated', params: {} }]).totals.deltas === 0, 'non-usage events ignored');

// single delta aggregates
let u = extractUsage([delta()]);
ok(u.totals.inputTokens === 100 && u.totals.outputTokens === 5, 'single delta totals');
ok(u.totals.cacheReadTokens === 80, 'cacheRead counted');
ok(u.byModel['glm-5.3'].totalTokens === 105, 'byModel bucket');

// multiple deltas sum; multiple models separate
u = extractUsage([delta(), delta({ inputTokens: 50, modelId: 'glm-5.3-flash' }), delta({ outputTokens: 7 })]);
ok(u.totals.inputTokens === 250, 'sums across deltas');
ok(u.totals.outputTokens === 17, 'outputs sum');
ok(u.byModel['glm-5.3'].inputTokens === 200 && u.byModel['glm-5.3-flash'].inputTokens === 50, 'per-model split');

// junk fields ignored (non-numeric / missing)
u = extractUsage([{ kind: 'v4/telemetry/event', params: { kind: 'usage.delta', modelId: 'x', inputTokens: 'NaN-str', outputTokens: null } }]);
ok(u.totals.inputTokens === 0 && u.totals.outputTokens === 0, 'junk numeric fields ignored');

// other telemetry kinds ignored (usage is a sub-kind)
u = extractUsage([{ kind: 'v4/telemetry/event', params: { kind: 'tool.call', modelId: 'glm-5.3', inputTokens: 999 } }]);
ok(u.totals.inputTokens === 0, 'non-usage.delta telemetry ignored');

// line formatting
ok(usageLine(extractUsage([delta()])) === '100 in · 5 out · 80 cache-read · glm-5.3', 'usageLine exact');
ok(/18\.3k in/.test(usageLine(extractUsage([delta({ inputTokens: 18333, cacheReadTokens: 12288 })]))), 'k-formatting');
ok(usageLine(extractUsage([])) === 'no usage', 'empty -> no usage');
ok(/cache-write/.test(usageLine(extractUsage([delta({ cacheWriteTokens: 40 })]))), 'cache-write shown when nonzero');

console.log(fails ? `FAIL (${fails})` : 'PASS usage-e7');
process.exit(fails ? 1 : 0);
