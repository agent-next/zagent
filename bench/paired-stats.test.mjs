#!/usr/bin/env node
// Hermetic unit test for paired-stats.mjs — NO live runtime, NO network.
// Real oracle: the ACTUAL 2026-09-06 GLM-5.3 paired run (60 cells) must classify as
// PARITY, matching the honest published conclusion. Plus hand-verifiable synthetic cases
// for the sign test, Wilcoxon signed-rank, bootstrap CI and the significance-gated verdict.
import {
  median, mean, cv, pairDeltas, signTest, wilcoxonSignedRank, bootstrapMedianCI, analyze, formatVerdict,
} from './paired-stats.mjs';

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  -' : 'FAIL-'} ${msg}`); if (!cond) failed++; };
const eq = (got, want, msg) => { const p = got === want; console.log(`${p ? 'ok  -' : 'FAIL-'} ${msg}`); if (!p) { console.log(`      got:  ${JSON.stringify(got)}`); console.log(`      want: ${JSON.stringify(want)}`); failed++; } };
const near = (got, want, msg, eps = 1e-9) => { const p = Math.abs(got - want) <= eps; console.log(`${p ? 'ok  -' : 'FAIL-'} ${msg}`); if (!p) { console.log(`      got:  ${got}`); console.log(`      want: ${want}`); failed++; } };

// --- descriptive helpers ---
eq(median([3, 1, 2]), 2, 'median odd');
eq(median([1, 2, 3, 4]), 2.5, 'median even');
eq(mean([2, 4, 6]), 4, 'mean');
near(cv([10, 10, 10]), 0, 'cv of constant is 0');

// --- sign test: exact two-sided p at p0=0.5 ---
near(signTest(Array(10).fill(-1)).pValue, 2 * Math.pow(0.5, 10), 'sign test 10/0 -> 2*0.5^10');
ok(signTest(Array(10).fill(-1)).zcodeFaster === 10, 'sign test counts zcode-faster (delta<0)');
{ const d = [...Array(9).fill(-1), 1]; near(signTest(d).pValue, 22 / 1024, 'sign test 9/1 -> 22/1024'); }
{ const d = [...Array(5).fill(-1), ...Array(5).fill(1)]; eq(signTest(d).pValue, 1, 'sign test 5/5 -> p=1'); }
{ const r = signTest([-1, -1, 0]); eq(r.ties, 1, 'sign test drops ties (count)'); eq(r.n, 2, 'sign test n excludes ties'); near(r.pValue, 0.5, 'sign test 2/0 -> 0.5'); }

// --- Wilcoxon signed-rank ---
{ const w = wilcoxonSignedRank([-1, -2, -3, -4]); eq(w.wPlus, 0, 'wilcoxon all-negative wPlus=0'); eq(w.wMinus, 10, 'wilcoxon all-negative wMinus=10'); eq(w.w, 0, 'wilcoxon w=min=0'); ok(w.smallSample === true, 'wilcoxon flags small n<10'); ok(w.pValue > 0 && w.pValue <= 1, 'wilcoxon p in (0,1]'); }
{ const w = wilcoxonSignedRank([-1, -1, 2]); eq(w.wMinus, 3, 'wilcoxon tie-averaged wMinus (1.5+1.5)'); eq(w.wPlus, 3, 'wilcoxon tie-averaged wPlus (rank 3)'); }

// --- bootstrap CI: deterministic + directional ---
{ const a = bootstrapMedianCI([-5, -5, -6, -6, -5], { iters: 500, seed: 7 }); const b = bootstrapMedianCI([-5, -5, -6, -6, -5], { iters: 500, seed: 7 }); ok(a.lo === b.lo && a.hi === b.hi, 'bootstrap is deterministic for a fixed seed'); ok(a.hi < 0, 'bootstrap CI of all-negative deltas excludes zero (hi<0)'); }
{ const c = bootstrapMedianCI([-3, -2, -1, 1, 2, 3], { iters: 800, seed: 1 }); eq(c.point, 0, 'bootstrap point = median of symmetric deltas = 0'); ok(c.lo <= 0 && c.hi >= 0, 'symmetric deltas: CI straddles zero'); }

// --- verdict gate: a clear, consistent 30% speedup is called zcode-faster ---
{
  const recs = [];
  for (let i = 1; i <= 10; i++) { recs.push({ lane: 'zcode', task: `t${i}`, repeat: 1, pass: true, wallMs: 7000 }); recs.push({ lane: 'claude_code', task: `t${i}`, repeat: 1, pass: true, wallMs: 10000 }); }
  const a = analyze(recs);
  eq(a.nPairs, 10, 'synthetic: 10 pairs');
  ok(a.signTest.pValue < 0.05, 'synthetic: consistent speedup is significant');
  eq(a.verdict, 'zcode-faster', 'synthetic: 30% consistent speedup -> zcode-faster');
}
// pairDeltas drops a pair when one lane fails
{
  const recs = [
    { lane: 'zcode', task: 't1', repeat: 1, pass: true, wallMs: 100 }, { lane: 'claude_code', task: 't1', repeat: 1, pass: true, wallMs: 120 },
    { lane: 'zcode', task: 't1', repeat: 2, pass: false, wallMs: 111 }, { lane: 'claude_code', task: 't1', repeat: 2, pass: true, wallMs: 90 },
  ];
  const { pairs, dropped } = pairDeltas(recs);
  eq(pairs.length, 1, 'pairDeltas keeps only both-passed pairs');
  eq(dropped, 1, 'pairDeltas reports dropped pairs');
}

// Missing and malformed receipts never become latency evidence.
{
  eq(analyze([]).verdict, 'insufficient-evidence', 'empty observations are insufficient');
  ok(!formatVerdict(analyze([])).includes('PARITY'), 'empty report never claims parity');
  const recs = Array.from({ length: 10 }, (_, i) => [
    { lane: 'zcode', task: `task${i}`, repeat: 1, pass: true, wallMs: 100 },
    { lane: 'claude_code', task: `task${i}`, repeat: 1, pass: true, wallMs: 1000 },
  ]).flat();
  const failed = recs.map(r => ({ ...r, failureCategory: 'runtime_error' }));
  eq(analyze(failed).verdict, 'insufficient-evidence', 'infrastructure failures cannot support speed verdict');
  eq(analyze(failed).nPairs, 0, 'infrastructure errors excluded from timing pairs');
  eq(analyze([...recs, recs[0]]).verdict, 'insufficient-evidence', 'duplicate receipts do not overwrite evidence');
  eq(analyze([...recs, { ...recs[0], wallMs: -1 }]).verdict, 'insufficient-evidence', 'invalid timing invalidates evidence');
  eq(analyze([{ ...recs[0], pass: false }]).verdict, 'insufficient-evidence', 'no paired successes are insufficient');
}

// --- REAL ORACLE: the actual 2026-09-06 GLM-5.3 run (60 cells) ---
// [task, repeat, lane, pass, wallMs]
const CELLS = [
  ['t1_rot13', 1, 'zcode', 1, 9498], ['t1_rot13', 1, 'claude_code', 1, 6690], ['t1_rot13', 2, 'claude_code', 1, 6491], ['t1_rot13', 2, 'zcode', 1, 13018], ['t1_rot13', 3, 'zcode', 1, 7662], ['t1_rot13', 3, 'claude_code', 1, 6609],
  ['t2_fixbug', 1, 'claude_code', 1, 14028], ['t2_fixbug', 1, 'zcode', 1, 17435], ['t2_fixbug', 2, 'zcode', 1, 21366], ['t2_fixbug', 2, 'claude_code', 1, 17160], ['t2_fixbug', 3, 'claude_code', 1, 13898], ['t2_fixbug', 3, 'zcode', 1, 16795],
  ['t3_toposort', 1, 'zcode', 1, 11745], ['t3_toposort', 1, 'claude_code', 1, 12179], ['t3_toposort', 2, 'claude_code', 1, 13298], ['t3_toposort', 2, 'zcode', 1, 23091], ['t3_toposort', 3, 'zcode', 1, 12766], ['t3_toposort', 3, 'claude_code', 1, 12776],
  ['t4_multifile', 1, 'claude_code', 1, 24833], ['t4_multifile', 1, 'zcode', 1, 23375], ['t4_multifile', 2, 'zcode', 1, 26674], ['t4_multifile', 2, 'claude_code', 1, 35099], ['t4_multifile', 3, 'claude_code', 1, 20785], ['t4_multifile', 3, 'zcode', 1, 34892],
  ['t5_json', 1, 'zcode', 1, 9078], ['t5_json', 1, 'claude_code', 1, 7301], ['t5_json', 2, 'claude_code', 1, 7359], ['t5_json', 2, 'zcode', 1, 8552], ['t5_json', 3, 'zcode', 1, 8230], ['t5_json', 3, 'claude_code', 1, 11168],
  ['t6_regex', 1, 'claude_code', 1, 13082], ['t6_regex', 1, 'zcode', 1, 12866], ['t6_regex', 2, 'zcode', 1, 21530], ['t6_regex', 2, 'claude_code', 1, 14524], ['t6_regex', 3, 'claude_code', 1, 11848], ['t6_regex', 3, 'zcode', 1, 9166],
  ['t7_cli', 1, 'zcode', 1, 9841], ['t7_cli', 1, 'claude_code', 1, 19817], ['t7_cli', 2, 'claude_code', 1, 10464], ['t7_cli', 2, 'zcode', 0, 11249], ['t7_cli', 3, 'zcode', 1, 18253], ['t7_cli', 3, 'claude_code', 1, 14227],
  ['t8_apiclient', 1, 'claude_code', 1, 22496], ['t8_apiclient', 1, 'zcode', 1, 23801], ['t8_apiclient', 2, 'zcode', 1, 8632], ['t8_apiclient', 2, 'claude_code', 1, 12132], ['t8_apiclient', 3, 'claude_code', 1, 8917], ['t8_apiclient', 3, 'zcode', 1, 36479],
  ['t9_sql', 1, 'zcode', 1, 6793], ['t9_sql', 1, 'claude_code', 1, 9449], ['t9_sql', 2, 'claude_code', 1, 11241], ['t9_sql', 2, 'zcode', 1, 10514], ['t9_sql', 3, 'zcode', 1, 4425], ['t9_sql', 3, 'claude_code', 1, 9271],
  ['t10_refactor', 1, 'claude_code', 1, 57475], ['t10_refactor', 1, 'zcode', 1, 43496], ['t10_refactor', 2, 'zcode', 1, 50871], ['t10_refactor', 2, 'claude_code', 1, 96227], ['t10_refactor', 3, 'claude_code', 1, 61784], ['t10_refactor', 3, 'zcode', 1, 49339],
];
const REAL = CELLS.map(([task, repeat, lane, pass, wallMs]) => ({ task, repeat, lane, pass: pass === 1, wallMs }));
const a = analyze(REAL);
eq(a.correctness.zcode.pass, 29, 'real: zcode correctness 29');
eq(a.correctness.zcode.total, 30, 'real: zcode total 30');
eq(a.correctness.claude_code.pass, 30, 'real: claude_code correctness 30');
eq(a.nPairs, 29, 'real: 29 both-passed pairs');
eq(a.droppedPairs, 1, 'real: 1 pair dropped (t7_cli r2, zcode incorrect)');
eq(a.walls.zcode.median, 13018, 'real: zcode paired median 13018ms');
eq(a.walls.claude_code.median, 13082, 'real: claude_code paired median 13082ms');
eq(a.signTest.zcodeFaster, 15, 'real: zcode faster in 15 of 29 pairs');
eq(a.signTest.claudeCodeFaster, 14, 'real: claude_code faster in 14 of 29 pairs');
eq(a.verdict, 'parity', 'real: honest verdict is PARITY (matches published conclusion)');
ok(/PARITY/.test(formatVerdict(a)), 'real: formatVerdict reports PARITY');

console.log(failed ? `\nFAIL (${failed}) paired-stats` : '\nPASS paired-stats');
process.exit(failed ? 1 : 0);
