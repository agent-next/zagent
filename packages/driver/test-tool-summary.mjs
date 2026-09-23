// E1 substrate tests — shapes from live probe (tool-started carries toolName, 2026-09-06).
import { toolCallSummary } from './zcode-protocol.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const ev = (kind, over = {}) => ({ kind: 'computer-use/operation-event', params: { kind, ...over } });

ok(toolCallSummary([]).count === 0 && toolCallSummary([]).line === 'no tools', 'empty -> no tools');
ok(toolCallSummary([ev('tool-scheduled'), ev('turn-started')]).count === 0, 'scheduled alone not counted');
const s = toolCallSummary([ev('tool-started', { toolName: 'Bash', sequenceNumber: 5 }), ev('tool-started', { toolName: 'Edit', sequenceNumber: 9 })]);
ok(s.count === 2 && s.tools.join(',') === 'Bash,Edit' && s.line === 'Bash → Edit', 'started calls in order');
ok(toolCallSummary([ev('tool-started')]).tools[0] === 'unknown', 'missing toolName -> unknown, never thrown');
ok(toolCallSummary(null).count === 0, 'null events safe');
ok(toolCallSummary([ev('tool-completed')]).count === 0, 'completed alone not double-counted');

console.log('interim:', fails ? `FAIL (${fails})` : 'ok');

// r8: subagent mirror events (different sessionId) not double-counted
const ev2 = (sid, tool) => ({ kind: 'computer-use/operation-event', params: { kind: 'tool-started', toolName: tool, sessionId: sid } });
ok(toolCallSummary([ev2('parent', 'Bash'), ev2('child', 'Bash')], 'parent').count === 1, 'foreign-session mirror filtered');
ok(toolCallSummary([ev2('parent', 'Bash'), ev2('child', 'Edit')], 'parent').tools[0] === 'Bash', 'only own session counted');
ok(toolCallSummary([ev2('a', 'B')]).count === 1, 'no filter -> all counted (legacy behavior)');
console.log('interim:', fails ? `FAIL (${fails})` : 'ok');

// E1 grouping
import { groupTools } from './zcode-protocol.mjs';
let g = groupTools(['Edit', 'Write', 'Read', 'Bash', 'Unknown']);
ok(g.changes === 2 && g.explore === 1 && g.terminal === 1 && g.other === 1, 'grouping counts');
ok(JSON.stringify(groupTools([])) === '{"changes":0,"explore":0,"terminal":0,"other":0}', 'empty groups');
ok(groupTools(['Read']).explore === 1, 'single');
console.log('interim2:', fails ? `FAIL (${fails})` : 'ok');

// I6 turn summary format
import { turnSummary } from './zcode-protocol.mjs';
const lens = { count: 2, tools: ['Read', 'Edit'] };
ok(turnSummary({ end: { ended: 'turn-completed' }, turnMs: 8400, usage: { totals: { inputTokens: 100, outputTokens: 5 } } }, lens) === '✓ 8.4s · 2 tools (1 change, 1 explore) · 100 in / 5 out', 'summary exact');
ok(turnSummary({ end: { ended: 'turn-failed' }, turnMs: 500 }, { count: 0, tools: [] }) === '✗ 0.5s · no tools', 'fail no-tools');
ok(turnSummary({ end: { ended: 'timeout' }, turnMs: 120000 }, { count: 1, tools: ['Bash'] }) === '⏱ 120.0s · 1 tool (1 terminal)', 'timeout terminal');
ok(turnSummary({}, lens).startsWith('? '), 'unknown outcome safe');
console.log('interim3:', fails ? `FAIL (${fails})` : 'ok');

// r11: NaN duration omitted; partial usage omitted; lens count derived from tools
ok(!/NaN|Infinity/.test(turnSummary({ end: { ended: 'turn-completed' } }, lens)), 'NaN duration omitted');
ok(!turnSummary({ end: { ended: 'turn-completed' }, turnMs: 1000, usage: { totals: { inputTokens: 1 } } }, lens).includes('undefined'), 'partial usage omitted');
ok(!turnSummary({ end: { ended: 'turn-completed' }, turnMs: 1000, usage: { totals: { inputTokens: 0, outputTokens: 0, deltas: 0 } } }, lens).includes('0 in / 0 out'), 'zero-delta usage omitted');
ok(turnSummary({ end: { ended: 'turn-completed' }, turnMs: 1000 }, { count: 9, tools: ['Read'] }) === '✓ 1.0s · 1 tool (1 explore)', 'lens count derived from tools');
console.log(fails ? `FAIL (${fails})` : 'PASS tool-summary');
process.exit(fails ? 1 : 0);
