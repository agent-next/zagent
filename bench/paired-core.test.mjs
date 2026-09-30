#!/usr/bin/env node
// Hermetic tests for bench/paired-core.mjs.  No live clients, network, clock,
// filesystem, credentials, or provider calls are used here.
import assert from 'node:assert/strict';
import {
  TASKS,
  buildMatrix,
  extractResponse,
  classifyRun,
  summarize,
} from './paired-core.mjs';

const ok = (name, fn) => {
  try {
    fn();
    console.log(`ok  - ${name}`);
  } catch (error) {
    console.error(`FAIL- ${name}: ${error.message}`);
    throw error;
  }
};

ok('canonical task list has ten ordered tasks', () => {
  assert.deepEqual(TASKS, [
    't1_rot13', 't2_fixbug', 't3_toposort', 't4_multifile', 't5_json',
    't6_regex', 't7_cli', 't8_apiclient', 't9_sql', 't10_refactor',
  ]);
});

ok('default matrix has sixty unique indexed cells and balanced lanes', () => {
  const matrix = buildMatrix();
  assert.equal(matrix.length, 60);
  assert.deepEqual(matrix.map(cell => cell.index), [...Array(60).keys()]);
  assert.equal(new Set(matrix.map(cell => `${cell.task}/${cell.lane}/${cell.repeat}`)).size, 60);
  assert.equal(matrix.filter(cell => cell.lane === 'zcode').length, 30);
  assert.equal(matrix.filter(cell => cell.lane === 'claude_code').length, 30);
  assert.deepEqual(matrix[0], { task: 't1_rot13', lane: 'zcode', repeat: 1, index: 0 });
  assert.deepEqual(matrix[1], { task: 't1_rot13', lane: 'claude_code', repeat: 1, index: 1 });
  assert.deepEqual(matrix[2], { task: 't1_rot13', lane: 'claude_code', repeat: 2, index: 2 });
  assert.deepEqual(matrix[3], { task: 't1_rot13', lane: 'zcode', repeat: 2, index: 3 });
  const firstLanes = [];
  for (let i = 0; i < matrix.length; i += 2) firstLanes.push(matrix[i].lane);
  assert.deepEqual(firstLanes, firstLanes.map((_, i) => i % 2 ? 'claude_code' : 'zcode'));
});

ok('matrix supports one and ten repeats and rejects invalid repeat counts', () => {
  assert.equal(buildMatrix(1).length, 20);
  assert.equal(buildMatrix(10).length, 200);
  for (const repeats of [0, -1, 1.5, 11, NaN, '3']) {
    assert.throws(() => buildMatrix(repeats), /repeats must be a positive integer/);
  }
});

ok('extracts response and result JSON string envelopes', () => {
  assert.equal(extractResponse('{"response":"plain answer"}'), 'plain answer');
  assert.equal(extractResponse('{"result":"plain result"}'), 'plain result');
  assert.equal(extractResponse('prefix log\n```python\nprint(1)\n```'), 'print(1)\n');
});

ok('extracts the last Python, py, or untyped fence', () => {
  const output = [
    'first',
    '```python\nold()\n```',
    '```javascript\nnot_answer()\n```',
    '```\nnew()\n```',
    '```py\nlast()\n```',
  ].join('\n');
  assert.equal(extractResponse(output), 'last()\n');
  assert.equal(extractResponse('```javascript\nreturn 429\n```'), '```javascript\nreturn 429\n```');
});

ok('falls back to plain text and rejects malformed object envelopes', () => {
  assert.equal(extractResponse('hello\nworld'), 'hello\nworld');
  assert.throws(() => extractResponse('{"response":{"answer":"no"}}'), /response must be a string/);
  assert.throws(() => extractResponse('{"result":null}'), /result must be a string/);
  assert.throws(() => extractResponse('{"is_error":true,"error":"boom"}'), /runtime envelope error: boom/);
  assert.throws(() => extractResponse('{"isError":true}'), /runtime envelope error/);
  assert.throws(() => extractResponse('{"error":"boom","response":"ok"}'), /runtime envelope error/);
  assert.throws(() => extractResponse({ response: 'object input' }), /stdout must be a string/);
  assert.equal(extractResponse('{"response":"hello"}'), 'hello');
});

ok('classifies clean and explicit timeout outcomes', () => {
  assert.equal(classifyRun({ status: 0, stdout: '```python\nreturn 429\n```' }), 'ok');
  assert.equal(classifyRun({ status: 0, stdout: 'successful answer mentions 429' }), 'ok');
  assert.equal(classifyRun({ status: 0, timedOut: true, stderr: 'deadline exceeded' }), 'timeout');
  assert.equal(classifyRun({ status: 1, signal: 'SIGTERM', stderr: 'timed out' }), 'timeout');
});

ok('classifies provider failures only when the run failed', () => {
  assert.equal(classifyRun({ status: 1, stderr: 'HTTP 429 Too Many Requests' }), 'rate_limit');
  assert.equal(classifyRun({ status: 1, stderr: 'payment required (402)' }), 'rate_limit');
  assert.equal(classifyRun({ status: 1, stderr: 'HTTP 402 Payment Required' }), 'rate_limit');
  assert.equal(classifyRun({ status: 402, stderr: 'provider rejected request' }), 'rate_limit');
  assert.equal(classifyRun({ status: 1, stderr: '401 invalid API key' }), 'auth');
  assert.equal(classifyRun({ status: 1, stderr: '403 forbidden' }), 'auth');
  assert.equal(classifyRun({ status: 1, stderr: 'unexpected child crash' }), 'runtime_error');
  assert.equal(classifyRun({ status: 0, stdout: '{"is_error":true,"error":"429 rate limit"}' }), 'rate_limit');
  assert.equal(classifyRun({ status: 0, stdout: '{"isError":true,"error":"invalid token"}' }), 'auth');
  assert.equal(classifyRun({ status: 0, stdout: '{"response":{"not":"text"}}' }), 'runtime_error');
  assert.equal(classifyRun({ status: 0, stdout: '{not valid json' }), 'runtime_error');
  assert.equal(classifyRun({ status: null, stdout: 'answer' }), 'runtime_error');
});

const completeRecords = buildMatrix().map(cell => ({
  ...cell,
  pass: true,
  failureCategory: null,
  wallMs: cell.lane === 'zcode' ? 100 + cell.repeat : 200 + cell.repeat,
  usage: cell.lane === 'zcode'
    ? { inputTokens: 10, outputTokens: 4, native: { total: 14 } }
    : undefined,
}));

ok('summarizes complete records with paired-success process medians', () => {
  const report = summarize(completeRecords);
  assert.equal(report.complete, true);
  assert.equal(report.observedCells, 60);
  assert.equal(report.perLane.zcode.pass, 30);
  assert.equal(report.perLane.claude_code.pass, 30);
  assert.equal(report.pairedSuccessCount, 30);
  assert.equal(report.medians.zcodeWallMs, 102);
  assert.equal(report.medians.claudeCodeWallMs, 202);
  assert.equal(report.perLane.zcode.nativeUsage.records, 30);
  assert.equal(report.perLane.zcode.nativeUsage.coverage, 1);
  assert.equal(report.perLane.zcode.nativeUsage.numericFields.inputTokens.count, 30);
  assert.equal(report.perLane.zcode.nativeUsage.numericFields.inputTokens.sum, 300);
  assert.equal(report.perLane.zcode.nativeUsage.numericFields['native.total'].count, 30);
  assert.equal(report.perLane.claude_code.nativeUsage.records, 0);
  assert.equal(report.perLane.claude_code.nativeUsage.coverage, 0);
  assert.equal(report.comparison.canClaimWinner, true);
  assert.equal(report.comparison.winner, 'zcode');
  assert.equal(report.tokenComparability.status, 'unknown');
  assert.equal(report.tokenComparability.comparable, false);
  assert.equal(report.tokenComparability.totals, null);
  assert.equal(report.tokenTotals, null);
});

ok('withholds winner and medians ignore unpaired successful cells', () => {
  const records = completeRecords.slice(0, 1);
  const report = summarize(records);
  assert.equal(report.complete, false);
  assert.equal(report.pairedSuccessCount, 0);
  assert.equal(report.medians.zcodeWallMs, null);
  assert.equal(report.medians.claudeCodeWallMs, null);
  assert.equal(report.comparison.winner, null);
  assert.equal(report.comparison.canClaimWinner, false);
});

ok('withholds winner on infrastructure failures even for a full matrix', () => {
  const records = completeRecords.map(record => ({ ...record }));
  records[0] = { ...records[0], pass: false, failureCategory: 'rate_limit' };
  const report = summarize(records);
  assert.equal(report.complete, true);
  assert.equal(report.allPassed, false);
  assert.equal(report.infraFailures, 1);
  assert.equal(report.comparison.winner, null);
  assert.equal(report.comparison.canClaimWinner, false);
  assert.equal(report.pairedSuccessCount, 29);
  assert.equal(report.medians.zcodeWallMs, 102);
  assert.equal(report.medians.claudeCodeWallMs, 202);
});

ok('detects duplicate or missing cells as incomplete', () => {
  const duplicate = completeRecords.slice(0, 59).concat({ ...completeRecords[0] });
  const report = summarize(duplicate);
  assert.equal(report.complete, false);
  assert.equal(report.duplicateCells, 1);
  assert.ok(report.missingCells.length > 0);
});

ok('correctness failures are counted separately from infrastructure failures', () => {
  const records = completeRecords.map(record => ({ ...record }));
  records[0] = { ...records[0], pass: false, failureCategory: null };
  const report = summarize(records);
  assert.equal(report.complete, true);
  assert.equal(report.allPassed, false);
  assert.equal(report.perLane.zcode.pass, 29);
  assert.equal(report.infraFailures, 0);
  assert.equal(report.pairedSuccessCount, 29);
});

console.log('\nPASS paired-core.test (all assertions)');
