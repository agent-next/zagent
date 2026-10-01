// Paired-benchmark statistics — turns raw per-cell records into a verdict that is
// honest about noise. The runner (paired-core.mjs) reports paired MEDIANS only, which
// cannot distinguish a real difference from single-run variance. This module adds the
// missing rigor: paired deltas, an exact two-sided sign test, a Wilcoxon signed-rank
// test, a seeded bootstrap CI on the median difference, per-lane dispersion (CV), and a
// verdict that returns 'parity' unless a difference is BOTH statistically significant
// (p < alpha) AND practically meaningful (|median delta| >= a relative floor) AND the
// bootstrap CI excludes zero. No live account or network needed; pure functions.
//
// Record shape (identical to paired-core.mjs): { lane:'zcode'|'claude_code', task, repeat:int>=1,
// pass:boolean, wallMs:number>=0, failureCategory?:string|null }.
//
// CLI: node bench/paired-stats.mjs <records.json>  (records = JSON array of the above)
// prints the significance-gated verdict for a completed run's receipts.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LANES = ['zcode', 'claude_code'];

export function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }
export function stdev(xs) { // population standard deviation
  if (xs.length < 2) return 0;
  const mu = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length);
}
export function cv(xs) { const mu = mean(xs); return mu ? stdev(xs) / mu : NaN; }

// Pair zcode/claude_code by (task, repeat); keep only pairs where BOTH lanes passed with a
// finite wallMs. delta = zcodeWallMs - claudeCodeWallMs (negative => zcode faster).
export function pairDeltas(records) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const byKey = new Map();
  let invalidRecords = 0, duplicateRecords = 0, infrastructureFailures = 0;
  for (const r of records) {
    if (!r || !LANES.includes(r.lane) || typeof r.task !== 'string' || !r.task ||
        !Number.isInteger(r.repeat) || r.repeat < 1 || typeof r.pass !== 'boolean' ||
        !Number.isFinite(r.wallMs) || r.wallMs < 0 ||
        (r.failureCategory != null && typeof r.failureCategory !== 'string')) {
      invalidRecords++; continue;
    }
    if (r.failureCategory != null && r.failureCategory !== 'incorrect') infrastructureFailures++;
    if (r.pass && r.failureCategory === 'incorrect') invalidRecords++;
    const key = `${r.task}\0${r.repeat}`;
    if (!byKey.has(key)) byKey.set(key, {});
    if (byKey.get(key)[r.lane]) { duplicateRecords++; continue; }
    byKey.get(key)[r.lane] = r;
  }
  const pairs = [];
  let dropped = 0;
  for (const [key, g] of byKey) {
    const z = g.zcode, c = g.claude_code;
    const ok = z && c && z.pass === true && c.pass === true &&
      z.failureCategory == null && c.failureCategory == null &&
      Number.isFinite(z.wallMs) && Number.isFinite(c.wallMs);
    if (!ok) { dropped += 1; continue; }
    pairs.push({ task: z.task, repeat: z.repeat, key, zcodeWallMs: z.wallMs, claudeCodeWallMs: c.wallMs, delta: z.wallMs - c.wallMs });
  }
  pairs.sort((a, b) => a.key.localeCompare(b.key));
  return { pairs, dropped, invalidRecords, duplicateRecords, infrastructureFailures };
}

// Exact two-sided sign test on paired deltas (null: P(zcode faster)=0.5). Ties (delta==0)
// are dropped, per the standard test.
export function signTest(deltas) {
  const nz = deltas.filter(d => d !== 0);
  const n = nz.length;
  const zcodeFaster = nz.filter(d => d < 0).length;
  const claudeCodeFaster = n - zcodeFaster;
  const ties = deltas.length - n;
  if (n === 0) return { n, zcodeFaster, claudeCodeFaster, ties, pValue: 1 };
  const k = Math.min(zcodeFaster, claudeCodeFaster);
  // cumulative binomial mass 0..k at p=0.5, built incrementally to avoid large C(n,i).
  let term = Math.pow(0.5, n); // C(n,0)*0.5^n
  let cum = term;
  for (let i = 1; i <= k; i += 1) { term *= (n - i + 1) / i; cum += term; }
  return { n, zcodeFaster, claudeCodeFaster, ties, pValue: Math.min(1, 2 * cum) };
}

function erf(x) { // Abramowitz & Stegun 7.1.26
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const normCdf = z => 0.5 * (1 + erf(z / Math.SQRT2));

// Wilcoxon signed-rank test (normal approximation with continuity + tie correction).
// Good for n >= ~10; below that treat the p-value as indicative only.
export function wilcoxonSignedRank(deltas) {
  const nz = deltas.filter(d => d !== 0);
  const n = nz.length;
  if (n === 0) return { n, wPlus: 0, wMinus: 0, w: 0, z: 0, pValue: 1, smallSample: true };
  const items = nz.map(d => ({ d, abs: Math.abs(d) })).sort((a, b) => a.abs - b.abs);
  // average ranks for tied absolute values
  const ranks = new Array(n);
  let tieCorrection = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j < n && items[j].abs === items[i].abs) j += 1;
    const avg = (i + 1 + j) / 2; // ranks are 1-based: (i+1 .. j) inclusive
    const t = j - i;
    if (t > 1) tieCorrection += t ** 3 - t;
    for (let k = i; k < j; k += 1) ranks[k] = avg;
    i = j;
  }
  let wPlus = 0, wMinus = 0;
  for (let i = 0; i < n; i += 1) { if (items[i].d > 0) wPlus += ranks[i]; else wMinus += ranks[i]; }
  const w = Math.min(wPlus, wMinus);
  const mu = n * (n + 1) / 4;
  const sigma = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - tieCorrection / 48);
  const z = sigma > 0 ? (w - mu + 0.5) / sigma : 0; // continuity correction toward the mean
  const pValue = sigma > 0 ? Math.min(1, 2 * normCdf(z)) : 1;
  return { n, wPlus, wMinus, w, z, pValue, smallSample: n < 10 };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Percentile bootstrap CI for the median of paired deltas. Seeded => deterministic.
export function bootstrapMedianCI(deltas, { iters = 2000, alpha = 0.05, seed = 12345 } = {}) {
  const n = deltas.length;
  if (n === 0) return { point: NaN, lo: NaN, hi: NaN, iters: 0 };
  const rng = mulberry32(seed);
  const medians = new Array(iters);
  const sample = new Array(n);
  for (let b = 0; b < iters; b += 1) {
    for (let i = 0; i < n; i += 1) sample[i] = deltas[(rng() * n) | 0];
    medians[b] = median(sample);
  }
  medians.sort((a, b) => a - b);
  const lo = medians[Math.floor((alpha / 2) * iters)];
  const hi = medians[Math.min(iters - 1, Math.ceil((1 - alpha / 2) * iters) - 1)];
  return { point: median(deltas), lo, hi, iters };
}

// Full analysis + significance-gated verdict.
export function analyze(records, { alpha = 0.05, minRelEffect = 0.10, bootstrapIters = 2000, seed = 12345 } = {}) {
  const { pairs, dropped, invalidRecords, duplicateRecords, infrastructureFailures } = pairDeltas(records);
  const deltas = pairs.map(p => p.delta);
  const zWalls = pairs.map(p => p.zcodeWallMs);
  const cWalls = pairs.map(p => p.claudeCodeWallMs);
  const correctness = {
    zcode: laneCorrectness(records, 'zcode'),
    claude_code: laneCorrectness(records, 'claude_code'),
  };
  const sign = signTest(deltas);
  const wilcoxon = wilcoxonSignedRank(deltas);
  const ci = bootstrapMedianCI(deltas, { iters: bootstrapIters, alpha, seed });
  const medZ = median(zWalls), medC = median(cWalls);
  const medianDeltaMs = median(deltas);
  const floorMs = minRelEffect * Math.min(medZ, medC);
  const significant = (sign.pValue < alpha || wilcoxon.pValue < alpha);
  const practical = Math.abs(medianDeltaMs) >= floorMs;
  const ciExcludesZero = Number.isFinite(ci.lo) && Number.isFinite(ci.hi) && (ci.lo > 0 || ci.hi < 0);
  let verdict = 'parity';
  if (significant && practical && ciExcludesZero) verdict = medianDeltaMs < 0 ? 'zcode-faster' : 'claude_code-faster';
  if (!pairs.length || invalidRecords || duplicateRecords || infrastructureFailures) verdict = 'insufficient-evidence';
  return {
    nPairs: pairs.length, droppedPairs: dropped,
    evidence: { invalidRecords, duplicateRecords, infrastructureFailures },
    correctness,
    walls: {
      zcode: { median: medZ, mean: mean(zWalls), cv: cv(zWalls) },
      claude_code: { median: medC, mean: mean(cWalls), cv: cv(cWalls) },
    },
    medianDeltaMs, floorMs,
    signTest: sign, wilcoxon, bootstrapCI: ci,
    perTask: perTaskDeltas(pairs),
    verdict,
    verdictReason: { significant, practical, ciExcludesZero, alpha, minRelEffect },
  };
}

function laneCorrectness(records, lane) {
  const rows = records.filter(r => r && r.lane === lane);
  const pass = rows.filter(r => r.pass === true).length;
  return { pass, total: rows.length };
}
function perTaskDeltas(pairs) {
  const byTask = new Map();
  for (const p of pairs) {
    if (!byTask.has(p.task)) byTask.set(p.task, []);
    byTask.get(p.task).push(p.delta);
  }
  return [...byTask.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([task, ds]) => ({
    task, n: ds.length, medianDeltaMs: median(ds), faster: median(ds) < 0 ? 'zcode' : 'claude_code',
  }));
}

// One-line human summary for CLI/report use.
export function formatVerdict(a) {
  if (a.verdict === 'insufficient-evidence') {
    return `verdict: INSUFFICIENT EVIDENCE (no valid latency comparison)\npaired n=${a.nPairs}; ${JSON.stringify(a.evidence)}`;
  }
  const pct = a.walls.claude_code.median ? (a.medianDeltaMs / a.walls.claude_code.median) * 100 : 0;
  const v = a.verdict === 'parity'
    ? 'PARITY (no statistically + practically significant speed difference)'
    : `${a.verdict.toUpperCase()} by median ${Math.abs(a.medianDeltaMs).toFixed(0)}ms`;
  return [
    `verdict: ${v}`,
    `correctness: zcode ${a.correctness.zcode.pass}/${a.correctness.zcode.total}, claude_code ${a.correctness.claude_code.pass}/${a.correctness.claude_code.total}`,
    `paired n=${a.nPairs} (dropped ${a.droppedPairs}); median wall zcode ${a.walls.zcode.median.toFixed(0)}ms vs claude_code ${a.walls.claude_code.median.toFixed(0)}ms (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`,
    `dispersion CV: zcode ${a.walls.zcode.cv.toFixed(2)}, claude_code ${a.walls.claude_code.cv.toFixed(2)}`,
    `sign test p=${a.signTest.pValue.toFixed(4)} (zcode faster ${a.signTest.zcodeFaster}/${a.signTest.n}); wilcoxon p=${a.wilcoxon.pValue.toFixed(4)}${a.wilcoxon.smallSample ? ' [small-n]' : ''}`,
    `median-delta 95% CI [${a.bootstrapCI.lo?.toFixed(0)}, ${a.bootstrapCI.hi?.toFixed(0)}]ms`,
  ].join('\n');
}

// CLI entry (only when run directly, never on import).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node bench/paired-stats.mjs <records.json>'); process.exit(2); }
  let records;
  try { records = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { console.error(`cannot read records: ${e.message}`); process.exit(2); }
  if (!Array.isArray(records)) { console.error('records file must be a JSON array of cell records'); process.exit(2); }
  const analysis = analyze(records);
  console.log(formatVerdict(analysis));
  if (analysis.verdict === 'insufficient-evidence') process.exitCode = 1;
}
