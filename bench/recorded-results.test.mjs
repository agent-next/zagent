// Offline check that the recorded glm-5.3 run (bench/results-glm53-reset-run1) is
// self-consistent: every cell parses, summarize() over the cells reproduces summary.json,
// and paired-stats gives the documented verdict. Also parses every file in recorded-cells/.
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

const loose = readdirSync(path.join(here, 'recorded-cells')).filter(f => f.endsWith('.json'));
assert.ok(loose.length > 0);
for (const f of loose) readJson(path.join(here, 'recorded-cells', f));

console.log(`ok: ${cells.length} cells reproduce summary.json; ${loose.length} recorded cells parse`);
