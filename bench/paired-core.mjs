// Pure helpers for the paired ZCode CLI versus claude_code benchmark.
//
// This module deliberately has no runtime, filesystem, network, or clock
// dependencies.  The live harness can use these helpers while the tests keep
// scheduling, extraction, failure classification, and aggregation hermetic.

export const TASKS = Object.freeze([
  't1_rot13',
  't2_fixbug',
  't3_toposort',
  't4_multifile',
  't5_json',
  't6_regex',
  't7_cli',
  't8_apiclient',
  't9_sql',
  't10_refactor',
]);

const LANES = Object.freeze(['zcode', 'claude_code']);
const FAILURE_CATEGORIES = Object.freeze(['ok', 'rate_limit', 'auth', 'timeout', 'runtime_error']);
const INFRA_FAILURE_CATEGORIES = new Set(['rate_limit', 'auth', 'timeout', 'runtime_error']);
const EXPECTED_DEFAULT_CELLS = TASKS.length * LANES.length * 3;

function assertRepeats(repeats) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) {
    throw new RangeError('repeats must be a positive integer no greater than 10');
  }
}

/**
 * Build a deterministic, balanced paired schedule.
 *
 * The lane order alternates for every task/repeat pair.  Thus each pair has a
 * lane-first direction while the complete matrix has equal numbers of both
 * lanes, including when the number of repeats is odd.
 */
export function buildMatrix(repeats = 3) {
  assertRepeats(repeats);
  const cells = [];
  let index = 0;
  let pairIndex = 0;
  for (let taskIndex = 0; taskIndex < TASKS.length; taskIndex += 1) {
    for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex += 1) {
      const firstLane = pairIndex % 2;
      pairIndex += 1;
      for (let laneOffset = 0; laneOffset < LANES.length; laneOffset += 1) {
        const lane = LANES[(firstLane + laneOffset) % LANES.length];
        cells.push({
          task: TASKS[taskIndex],
          lane,
          repeat: repeatIndex + 1,
          index,
        });
        index += 1;
      }
    }
  }
  return cells;
}

function runtimeErrorValue(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  if (envelope.is_error || envelope.isError) {
    return envelope.error ?? 'runtime reported an error';
  }
  if (envelope.error !== undefined && envelope.error !== null && envelope.error !== false && envelope.error !== '') {
    return envelope.error;
  }
  return null;
}

function errorDescription(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return 'runtime reported an error';
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : 'runtime reported an error';
  } catch {
    return 'runtime reported an error';
  }
}

function responseText(stdout) {
  if (typeof stdout !== 'string') {
    throw new TypeError('stdout must be a string');
  }

  const trimmed = stdout.trim();
  if (trimmed.startsWith('{')) {
    try {
      const envelope = JSON.parse(trimmed);
      if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
        const runtimeError = runtimeErrorValue(envelope);
        if (runtimeError !== null) {
          throw new Error(`runtime envelope error: ${errorDescription(runtimeError)}`);
        }
        for (const field of ['response', 'result']) {
          if (Object.prototype.hasOwnProperty.call(envelope, field)) {
            if (typeof envelope[field] !== 'string') {
              throw new TypeError(`JSON envelope ${field} must be a string`);
            }
            return envelope[field];
          }
        }
      }
    } catch (error) {
      // Errors raised by a recognized envelope are meaningful and must not be
      // silently converted back to the original JSON text.
      if (error instanceof TypeError || (error instanceof Error && error.message.startsWith('runtime envelope error:'))) {
        throw error;
      }
      // Once output declares itself as an object envelope, malformed JSON is
      // an infrastructure failure rather than an answer fallback.
      throw new Error(`invalid JSON envelope: ${error.message}`);
    }
  }
  return stdout;
}

function extractFence(text) {
  // Parse fence lines as pairs.  A bare closing fence is indistinguishable
  // from an untyped opening fence to a stateless regex, so tracking whether we
  // are inside a block is necessary when multiple blocks are present.
  const blocks = [];
  const line = /^(?:[ \t]*)```([^\r\n]*)(?:\r?\n|$)/gm;
  let open = null;
  for (const match of text.matchAll(line)) {
    const info = match[1].trim().toLowerCase();
    if (!open) {
      open = { accepted: info === '' || info === 'python' || info === 'py', contentStart: match.index + match[0].length };
    } else if (info === '') {
      if (open.accepted) blocks.push(text.slice(open.contentStart, match.index));
      open = null;
    }
  }
  return blocks.length ? blocks[blocks.length - 1] : text;
}

/**
 * Extract a model response without ever stringifying an object into
 * "[object Object]".  Runtime error envelopes and malformed response/result
 * envelopes throw so the caller can record an infrastructure failure.
 */
export function extractResponse(stdout) {
  return extractFence(responseText(stdout));
}

function parseRuntimeError(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const envelope = JSON.parse(trimmed);
    const value = runtimeErrorValue(envelope);
    if (value !== null) return errorDescription(value);
    if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
      for (const field of ['response', 'result']) {
        if (Object.prototype.hasOwnProperty.call(envelope, field) && typeof envelope[field] !== 'string') {
          return `malformed JSON envelope: ${field} must be a string`;
        }
      }
    }
    return null;
  } catch {
    return 'invalid JSON envelope';
  }
}

function hasPythonFence(text) {
  return typeof text === 'string' && extractFence(text) !== text;
}

function diagnosticText(stdout, stderr) {
  const pieces = [typeof stderr === 'string' ? stderr : ''];
  const envelopeError = parseRuntimeError(stdout);
  if (envelopeError) pieces.push(envelopeError);
  // A fenced answer is model output, not a provider diagnostic.  In
  // particular, code containing the number 429 must not become a rate-limit
  // outage merely because the process later failed its correctness oracle.
  if (!hasPythonFence(stdout) && typeof stdout === 'string') pieces.push(stdout);
  return pieces.join('\n');
}

function isRateLimitDiagnostic(text) {
  return /(?:\brate[ _-]*limit(?:ed|ing)?\b|too many requests|payment required|\b429\b|\b402\b)/i.test(text);
}

function isAuthDiagnostic(text) {
  return /(?:\b401\b|\b403\b|unauthori[sz]ed|forbidden|authentication failed|invalid (?:api[ _-]?key|token|credential)|missing (?:api[ _-]?key|token|credential)|login required)/i.test(text);
}

/**
 * Classify a process result.  A clean exit is authoritative unless the
 * runtime returned an explicit error envelope.  Provider markers are read
 * only on a failed process, preventing successful answer text such as
 * ````python\nreturn 429\n```` from being called an outage.
 */
export function classifyRun({ status = 0, signal = null, timedOut = false, stdout = '', stderr = '' } = {}) {
  const runtimeError = parseRuntimeError(stdout) ?? parseRuntimeError(stderr);
  // A missing status is tolerated for callers that only provide an answer;
  // an explicit null status means the child did not produce a normal exit.
  const exitedNonzero = status === null || (status !== undefined && (!Number.isFinite(status) || status !== 0));
  const signaled = signal !== null && signal !== undefined && signal !== '';
  const failed = Boolean(timedOut) || exitedNonzero || signaled || runtimeError !== null;

  if (timedOut) return 'timeout';
  if (!failed) return 'ok';

  const diagnostics = diagnosticText(stdout, stderr);
  if (/(?:\btimeout\b|timed[ -]?out|deadline exceeded)/i.test(diagnostics)) return 'timeout';
  if (status === 402 || isRateLimitDiagnostic(diagnostics)) return 'rate_limit';
  if (isAuthDiagnostic(diagnostics)) return 'auth';
  return 'runtime_error';
}

function median(values) {
  const finite = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!finite.length) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function cellKey(record) {
  return `${record?.task ?? ''}\u0000${record?.repeat ?? ''}`;
}

function recordKey(record) {
  return `${cellKey(record)}\u0000${record?.lane ?? ''}`;
}

function expectedMatrix(expectedCells) {
  if (expectedCells % (TASKS.length * LANES.length) !== 0) return null;
  const repeats = expectedCells / (TASKS.length * LANES.length);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) return null;
  return buildMatrix(repeats);
}

function laneCounts(rows, lane) {
  const laneRows = rows.filter(row => row.lane === lane);
  const pass = laneRows.filter(row => row.pass === true).length;
  const infraFailures = laneRows.filter(row => INFRA_FAILURE_CATEGORIES.has(row.failureCategory)).length;
  return {
    observed: laneRows.length,
    pass,
    failed: laneRows.length - pass,
    infraFailures,
  };
}

function nativeUsageCoverage(rows, lane) {
  const laneRows = rows.filter(row => row.lane === lane);
  const usageRows = laneRows.filter(row => row.usage && typeof row.usage === 'object' && !Array.isArray(row.usage));
  const numericFields = new Map();
  const visit = (value, prefix) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const field = prefix ? `${prefix}.${key}` : key;
      if (typeof child === 'number' && Number.isFinite(child)) {
        const previous = numericFields.get(field) ?? { count: 0, sum: 0 };
        numericFields.set(field, { count: previous.count + 1, sum: previous.sum + child });
      } else if (child && typeof child === 'object' && !Array.isArray(child)) {
        visit(child, field);
      }
    }
  };
  for (const row of usageRows) visit(row.usage, '');
  return {
    records: usageRows.length,
    coverage: laneRows.length ? usageRows.length / laneRows.length : 0,
    numericFields: Object.fromEntries([...numericFields.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

/**
 * Aggregate benchmark records.  Speed medians use only cells where both
 * lanes passed and have a numeric full-process wallMs.  Token totals remain
 * explicitly unknown because the two clients expose different usage
 * semantics; this function never fabricates a combined total.
 */
export function summarize(records, expectedCells = EXPECTED_DEFAULT_CELLS) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (!Number.isInteger(expectedCells) || expectedCells < 1) {
    throw new RangeError('expectedCells must be a positive integer');
  }

  const rows = records.map(record => ({
    ...record,
    failureCategory: record?.failureCategory ?? null,
  }));
  const byLane = {
    zcode: laneCounts(rows, 'zcode'),
    claude_code: laneCounts(rows, 'claude_code'),
  };
  const invalid = rows.filter(row =>
    !LANES.includes(row.lane) || !TASKS.includes(row.task) ||
    !Number.isInteger(row.repeat) || row.repeat < 1 || row.repeat > 10 ||
    typeof row.pass !== 'boolean' || !Number.isFinite(row.wallMs) || row.wallMs < 0 ||
    (row.failureCategory !== null && typeof row.failureCategory !== 'string')
  );
  // Pair keys intentionally omit the lane; record keys include it so the two
  // expected lane rows in one task/repeat pair are not mistaken for a
  // duplicate cell.
  const keys = new Map();
  const recordKeys = new Map();
  for (const row of rows) {
    const key = cellKey(row);
    if (!keys.has(key)) keys.set(key, []);
    keys.get(key).push(row);
    const exactKey = recordKey(row);
    if (!recordKeys.has(exactKey)) recordKeys.set(exactKey, []);
    recordKeys.get(exactKey).push(row);
  }
  const expected = expectedMatrix(expectedCells);
  const expectedKeys = expected ? new Set(expected.map(cell => recordKey(cell))) : null;
  const missing = expectedKeys
    ? [...expectedKeys].filter(key => !recordKeys.has(key))
    : [];
  const duplicateCells = [...recordKeys.values()].filter(group => group.length > 1).length;
  const unexpected = expectedKeys
    ? [...recordKeys.keys()].filter(key => !expectedKeys.has(key))
    : [];
  const complete = rows.length === expectedCells && invalid.length === 0 && duplicateCells === 0 &&
    (expectedKeys ? missing.length === 0 && unexpected.length === 0 : keys.size === expectedCells);
  const infraFailures = rows.filter(row => INFRA_FAILURE_CATEGORIES.has(row.failureCategory)).length;
  const allPassed = complete && rows.every(row => row.pass === true && row.failureCategory === null);

  const pairedSuccessCells = [];
  for (const [key, group] of keys) {
    if (group.length !== 2) continue;
    const zcode = group.find(row => row.lane === 'zcode');
    const claudeCode = group.find(row => row.lane === 'claude_code');
    if (!zcode || !claudeCode || zcode.pass !== true || claudeCode.pass !== true ||
        zcode.failureCategory !== null || claudeCode.failureCategory !== null ||
        !Number.isFinite(zcode.wallMs) || !Number.isFinite(claudeCode.wallMs)) continue;
    pairedSuccessCells.push({ task: zcode.task, repeat: zcode.repeat, key, zcodeWallMs: zcode.wallMs, claudeCodeWallMs: claudeCode.wallMs });
  }
  pairedSuccessCells.sort((a, b) => a.key.localeCompare(b.key));
  const zcodeMedianWallMs = median(pairedSuccessCells.map(cell => cell.zcodeWallMs));
  const claudeCodeMedianWallMs = median(pairedSuccessCells.map(cell => cell.claudeCodeWallMs));
  const canClaimWinner = allPassed && infraFailures === 0 && zcodeMedianWallMs !== null && claudeCodeMedianWallMs !== null;
  const winner = canClaimWinner
    ? (zcodeMedianWallMs < claudeCodeMedianWallMs ? 'zcode' : claudeCodeMedianWallMs < zcodeMedianWallMs ? 'claude_code' : 'tie')
    : null;

  const lane = {
    zcode: { ...byLane.zcode, medianWallMs: zcodeMedianWallMs, nativeUsage: nativeUsageCoverage(rows, 'zcode') },
    claude_code: { ...byLane.claude_code, medianWallMs: claudeCodeMedianWallMs, nativeUsage: nativeUsageCoverage(rows, 'claude_code') },
  };
  return {
    expectedCells,
    observedCells: rows.length,
    complete,
    allPassed,
    missingCells: missing,
    duplicateCells,
    unexpectedCells: unexpected,
    invalidRecords: invalid.length,
    infraFailures,
    perLane: lane,
    pairedSuccessCells,
    pairedSuccessCount: pairedSuccessCells.length,
    medians: { zcodeWallMs: zcodeMedianWallMs, claudeCodeWallMs: claudeCodeMedianWallMs, pairedSuccessCount: pairedSuccessCells.length },
    comparison: {
      eligible: canClaimWinner,
      canClaimWinner,
      winner,
      zcodeMedianWallMs,
      claudeCodeMedianWallMs,
      reason: canClaimWinner ? 'complete matrix with all cells passing and no infrastructure failures' : 'winner withheld until the complete matrix passes without infrastructure failures and has paired successes',
    },
    tokenComparability: {
      status: 'unknown',
      comparable: false,
      totals: null,
      reason: 'zcode and claude_code usage fields are not validated as a common comparable measure',
    },
    tokenTotals: null,
  };
}

export { FAILURE_CATEGORIES };
