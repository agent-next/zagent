// Goal API + projection tests — fake client, shapes from live probes 2026-09-05.
import { goalShow, goalSet, goalReplace, goalControl, projectionOf } from './session-control.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const fake = replies => { const calls = [];
  return { calls, call: async (m, p) => { calls.push({ m, p }); const r = replies[m]; if (r instanceof Error) throw r; return r; } }; };

let f = fake({ 'session/goal': { response: 'No goal is set.', snapshot: { projection: { contextUsed: 0, contextWindow: 1000000, mode: 'build' } } } });
ok((await goalShow(f, 's')).response === 'No goal is set.', 'show passthrough');
ok(projectionOf(await goalShow(f, 's')).contextWindow === 1000000, 'projectionOf extracts contextWindow');
ok(f.calls[0].p.action === 'show', 'show action');

f = fake({ 'session/goal': { response: 'Goal active' } });
await goalSet(f, 's', 'ship it');
ok(f.calls[0].m === 'session/goal' && f.calls[0].p.objective === 'ship it' && f.calls[0].p.action === 'set', 'set calls session/goal with objective key (not goal)');
await goalReplace(f, 's', 'v2');
ok(f.calls[1].p.action === 'replace' && f.calls[1].p.objective === 'v2', 'replace');

await goalControl(f, 's', 'pause'); await goalControl(f, 's', 'resume'); await goalControl(f, 's', 'clear');
ok(f.calls.slice(2).every(c => c.m === 'session/goal' && c.p.sessionId === 's'), 'control actions all hit session/goal with sessionId');
ok(['pause','resume','clear'].every((a, i) => f.calls[2 + i].p.action === a), 'control actions in order');
let threw = false; try { await goalControl(f, 's', 'show'); } catch { threw = true; }
ok(threw, 'goalControl rejects non pause|resume|clear');

ok(projectionOf({ snapshot: { projection: { contextUsed: 'x', contextWindow: null, mode: 5 } } }).contextUsed === 0, 'projection junk-safe');
ok(projectionOf({}) === null, 'projection missing -> null');
ok(projectionOf({ projection: { contextUsed: 1, contextWindow: 2 } }).contextWindow === 2, 'projection at top level too');

console.log(fails ? `FAIL (${fails})` : 'PASS goal-api');
process.exit(fails ? 1 : 0);
