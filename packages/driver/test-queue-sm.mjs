// I2 state-machine tests — statuses from the C4 classifier semantics + tolerant poll shapes.
import { initialQueueState, onTicketTaken, onPollResult, onQueueError, queueLine } from './offpeak.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

let s = initialQueueState();
ok(s.state === 'idle', 'initial idle');
s = onTicketTaken(s, { taskId: 't1', ticketId: 'TKN123' });
ok(s.state === 'queued' && s.ticketId === 'TKN123' && s.attempts === 1, 'take -> queued');
ok(onTicketTaken(s, { taskId: 'x', ticketId: 'y' }).error.includes('state queued'), 'double-take refused');

ok(onPollResult(s, { data: { tickets: [{ ticket_id: 'TKN123', status: 'running' }] } }).state === 'running', 'running');
ok(onPollResult(s, { data: { tickets: [{ ticket_id: 'TKN123', status: 'completed' }] } }).state === 'done', 'completed -> done');
ok(onPollResult(s, { data: { tickets: [{ ticket_id: 'TKN123', status: 'pending' }] } }).state === 'queued', 'pending -> queued');
ok(onPollResult(s, { data: { tickets: [{ ticket_id: 'TKN123', status: 'waiting_for_quota' }] } }).state === 'queued', 'unknown status -> state PRESERVED (r12: no assuming in-flight)');
ok(onPollResult(s, { data: {} }).state === 'queued', 'no ticket in body -> state preserved (r12)');

// errors: 3102 abort_retake (bounded), 3105 wait, 429 retry, 3101 eligibility terminal
let r = onQueueError(s, 200, 3102);
ok(r.state === 'idle' && r.attempts === 1, '3102 -> retake (back to idle)');
r = onQueueError(s, 200, 3105);
ok(r.state === 'queued' && (r.error ?? '').includes('retryable wait'), '3105 (wait+retry) -> queued, keeps polling');
r = onQueueError(s, 429, 0);
ok(r.state === 'queued', '429 -> retry queued');
r = onQueueError(s, 200, 3101);
ok(r.state === 'failed', '3101 -> failed (terminal)');
// bounded retake exhaustion
let s3 = { ...s, attempts: 3 };
ok(onQueueError(s3, 200, 3102).state === 'failed', 'retake bounded at 3 attempts');

// in-queue requeues are bounded too: `attempts` only counts ticket takes and
// never moves while a ticket is held, so an error loop needs its own counter.
let q = s; // queued, attempts 1, retries 0
q = onQueueError(q, 429, 0);
ok(q.state === 'queued' && q.retries === 1, '429 #1 -> queued (retries 1)');
q = onQueueError(q, 429, 0);
ok(q.state === 'queued' && q.retries === 2, '429 #2 -> queued (retries 2)');
q = onQueueError(q, 429, 0);
ok(q.state === 'failed' && q.retries === 3, '429 #3 -> failed (requeue bound)');
let w = s;
w = onQueueError(w, 200, 3105);
ok(w.state === 'queued' && w.retries === 1, '3105 #1 -> queued (retries 1)');
w = onQueueError(w, 200, 3105);
w = onQueueError(w, 200, 3105);
ok(w.state === 'failed', '3105 #3 -> failed (same bound)');
const retake = onTicketTaken({ ...s, state: 'idle', retries: 3 }, { taskId: 't2', ticketId: 'TKN999' });
ok(retake.retries === 0 && retake.attempts === 2, 'retake resets retries, bumps attempts');
const exhausted = onTicketTaken({ ...s, state: 'failed', attempts: 3 }, { taskId: 't3', ticketId: 'TKN1000' });
ok(exhausted.state === 'failed' && /attempt bound/.test(exhausted.error), 'retake-from-failed bounded at 3 attempts');

ok(queueLine(s3).includes('attempt 3'), 'line shows attempts');
ok(queueLine(initialQueueState()) === 'task -: idle', 'initial line');

console.log('interim:', fails ? `FAIL (${fails})` : 'ok');

// r12: foreign ticket / malformed body never move the state
ok(onPollResult(s, { data: { tickets: [{ ticket_id: 'OTHER', status: 'completed' }] } }).state === 'queued', 'foreign ticket status ignored');
ok(onPollResult(s, { data: { tickets: [null] } }).state === 'queued', 'null entry safe');
ok(onPollResult(s, { data: { tickets: 'nope' } }).state === 'queued', 'non-array safe');
ok(onPollResult(s, { data: {} }).state === 'queued', 'empty body preserves state');
console.log(fails ? `FAIL (${fails})` : 'PASS queue-sm');
process.exit(fails ? 1 : 0);
