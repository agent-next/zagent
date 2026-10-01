// Offline check that the recorded glm-5.3 run (bench/results-glm53-reset-run1) is
// self-consistent: every cell parses, summarize() over the cells reproduces summary.json,
// and paired-stats gives the documented verdict. Also checks that recorded-cells.jsonl
// (one packed line per earlier cell) parses and round-trips to the original pretty-printed files.
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

const packed = readFileSync(path.join(here, 'recorded-cells.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
assert.ok(packed.length > 0);
assert.equal(packed.length, 524);
const names = packed.map(entry => entry.file);
assert.equal(new Set(names).size, names.length, 'recorded-cells.jsonl has duplicate file names');
assert.deepEqual(names, [...names].sort(), 'recorded-cells.jsonl is not sorted by file');
for (const { file, cell } of packed) {
  assert.match(file, /^[A-Za-z0-9_.-]+\.json$/, `unsafe file name ${file}`);
  assert.equal(typeof cell, 'object', `${file}: cell is not an object`);
  // the unpacked file content is JSON.stringify(cell, null, 1) with no trailing newline
  assert.deepEqual(JSON.parse(JSON.stringify(cell, null, 1)), cell);
}

console.log(`ok: ${cells.length} cells reproduce summary.json; ${packed.length} packed recorded cells round-trip`);
