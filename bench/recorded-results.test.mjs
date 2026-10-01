// Offline check that the recorded glm-5.3 run (bench/results-glm53-reset-run1) is
// self-consistent: every cell parses, summarize() over the cells reproduces summary.json,
// and paired-stats gives the documented verdict. Also checks that recorded-cells.jsonl
// (one packed line per earlier cell) is byte-identical to a fresh pack and backs RESULTS.md.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from './paired-core.mjs';
import { analyze } from './paired-stats.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runDir = path.join(here, 'results-glm53-reset-run1');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

const cells = readdirSync(runDir).filter(f => /^cell-\d+\.json$/.test(f)).sort().map(f => readJson(path.join(runDir, f)));
const recorded = readJson(path.join(runDir, 'summary.json'));
assert.equal(cells.length, 60);

const core = summarize(cells, recorded.expectedCells);
for (const [key, value] of Object.entries(core)) {
  assert.deepEqual(recorded[key], value, `summary.json field ${key} is not reproduced by summarize()`);
}
assert.equal(recorded.perLane.zcode.pass, 29);
assert.equal(recorded.perLane.claude_code.pass, 30);

const verdict = analyze(cells);
assert.equal(verdict.nPairs, 29);
assert.equal(verdict.verdict, 'parity');

const packedText = readFileSync(path.join(here, 'recorded-cells.jsonl'), 'utf8');
const packed = packedText.split('\n').filter(Boolean).map(line => JSON.parse(line));
assert.equal(packed.length, 524);
const names = packed.map(entry => entry.file);
assert.equal(new Set(names).size, names.length, 'recorded-cells.jsonl has duplicate file names');
assert.deepEqual(names, [...names].sort(), 'recorded-cells.jsonl is not sorted by file');
for (const { file, cell } of packed) {
  assert.match(file, /^[A-Za-z0-9_.-]+\.json$/, `unsafe file name ${file}`);
  assert.equal(typeof cell, 'object', `${file}: cell is not an object`);
}
// re-packing the parsed cells must reproduce the shipped bytes exactly
const repacked = packed.map(({ file, cell }) => JSON.stringify({ file, cell })).join('\n') + '\n';
assert.equal(repacked, packedText, 'recorded-cells.jsonl is not byte-identical to a fresh pack of its own cells');

// RESULTS.md headline numbers must be re-derivable from the shipped cells
const results = readFileSync(path.join(here, '..', 'docs/benchmarks/RESULTS.md'), 'utf8');
const lane = packed.filter(({ file }) => !file.startsWith('mh_')).map(({ cell }) => cell);
const median = values => {
  const v = [...values].sort((x, y) => x - y), m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const pick = (laneName, runIds) => lane.filter(c => c.lane === laneName && runIds.includes(c.runId));
const passes = cs => cs.filter(c => c.pass).length;
const z13 = pick('zcode', ['1', '2', '3']), c13 = pick('claude_code', ['1', '2', '3']);
const z46 = pick('zcode', ['4', '5', '6']), c46 = pick('claude_code', ['4', '5', '6']);
assert.deepEqual([z13.length, passes(z13), c13.length, passes(c13)], [18, 17, 18, 18]);
assert.deepEqual([z46.length, passes(z46), c46.length, passes(c46)], [30, 25, 30, 26]);
assert.match(results, /\*\*17\/18\*\* \(94%\) \| 18\/18 \(100%\)/);
assert.match(results, /42\/48 vs 44\/48/);
assert.match(results, /zcode 25\/30 with 4 turn-timeouts/);
assert.match(results, /claude_code 26\/30/);
assert.equal(median(z13.map(c => c.turn_s)), 7.8);
assert.match(results, /turn med 7\.8s/);
assert.equal(median(z13.map(c => c.usage.inputSum)), 18419);
assert.equal(median(c13.map(c => c.usage.inputTokens)), 24486.5);
assert.match(results, /\| 18,419 \| 24,487 \|/);
assert.equal(Math.max(...c13.map(c => c.usage.cacheReadTokens)), 326464);
assert.match(results, /up to 326k/);
const byTask = cs => Object.entries(Object.groupBy(cs, c => c.task)).map(([task, v]) => [task, median(v.map(c => c.wall_s)), median(v.map(c => c.turn_s ?? 0))]);
const zWalls = byTask(z13).map(t => t[1]), cWalls = byTask(c13).map(t => t[1]);
assert.deepEqual([Math.min(...zWalls), Math.max(...zWalls)], [9, 27.2]);
assert.deepEqual([Math.min(...cWalls), Math.max(...cWalls)], [16.7, 41.6]);
const ratios = byTask(z13).map(([task, w]) => byTask(c13).find(t => t[0] === task)[1] / w);
assert.equal(Math.min(...ratios).toFixed(1), '1.5');
assert.equal(Math.max(...ratios).toFixed(1), '4.2');
assert.match(results, /1\.5–4\.2×/);

console.log(`ok: ${cells.length} cells reproduce summary.json; ${packed.length} packed recorded cells re-pack byte-identically and back RESULTS.md`);
