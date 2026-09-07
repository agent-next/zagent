// Headless (-p --json) retry policy — product-level (2026-09-06; review-r5 hardened).
// Evidence: the runtime returned EMPTY stdout on 429 as the final answer (2 of 3 gate
// failures) while ccz retried internally. ONE outer retry only: the app runtime already
// retries 429s internally (up to 6-11 provider attempts) — three full process restarts
// would amplify to 18-33 provider attempts and replay tool side effects (r5 #5).
import { spawnSync } from 'node:child_process';

export function decideRetry(stdout, exitCode, spawnError, { jsonMode = true } = {}) {
  if (spawnError) return { retry: false, terminal: true, reason: `spawn ${spawnError}` }; // r5 #6: ENOENT etc are deterministic — never retried
  const text = String(stdout ?? '').trim();
  if (text.length === 0) return { retry: true, reason: exitCode === 0 ? 'empty output' : `empty output, exit ${exitCode}` };
  if (jsonMode && text.startsWith('{')) {
    let j = null;
    try { j = JSON.parse(text); } catch { return { retry: true, reason: 'malformed JSON envelope' }; } // r5 #2: --json route fails closed
    if (j && typeof j === 'object' && j.error != null) return { retry: true, reason: 'error envelope' }; // r5 #3: null is not an error
    if (j && typeof j === 'object' && j.isError === true) return { retry: true, reason: 'isError envelope' };
  }
  return { retry: false, reason: null };
}

export function runHeadlessWithRetry(cmd, args, { cwd, env, maxAttempts = 2, backoffMs = [8000], maxBuffer = 64e6, onAttempt } = {}) {
  let last = null, lastVerdict = null, attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer });
    const verdict = decideRetry(r.stdout, r.status, r.error?.code);
    last = r; lastVerdict = verdict;
    onAttempt?.(attempt, verdict, r.status, (r.stdout ?? '').length);
    // r5 #1/#5: spawn errors terminal; retry only transient shapes, ONE extra attempt
    if (!verdict.retry || verdict.terminal || attempt === maxAttempts) break;
    const until = Date.now() + backoffMs[Math.min(attempt - 1, backoffMs.length - 1)];
    while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(200, until - Date.now()));
  }
  const exhaustedRetryable = lastVerdict?.retry === true; // still retryable at final attempt
  return {
    stdout: last?.stdout ?? '',
    stderr: last?.stderr ?? '', // r5 #6: surfaced, not swallowed
    exitCode: exhaustedRetryable ? 1 : (last?.status ?? 1), // r5 #1: a retryable final result is FAILURE, not success
    attempts,
    terminal: lastVerdict?.terminal === true,
    reason: lastVerdict?.reason ?? null,
    retryable: exhaustedRetryable,
  };
}
