#!/usr/bin/env node
// Explicit live dedicated-idle-channel probe. One ticket; completed turns never replayed.
// node bench/offpeak-probe.mjs --live /absolute/receipt.json
import { writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { checkAvailability, gateFromAvailability, takeTicket, pollTickets, settleTicket,
  offPeakTurn, nextDelayMs } from '../packages/driver/offpeak.mjs';
import { codingPlanStatus } from '../packages/driver/quota.mjs';
if (process.argv.length !== 4 || !['--live', '--resume'].includes(process.argv[2])) throw new Error('Usage: --live|--resume RECEIPT.json');
const output = process.argv[3];
const resume = process.argv[2] === '--resume';
if (!resume) writeFileSync(output, '', { flag: 'wx', mode: 0o600 });
const receipt = resume ? JSON.parse(readFileSync(output, 'utf8')) : { startedAt: new Date().toISOString(), taskId: randomUUID(),
  channel: 'dedicated /api/v1/off-peak/anthropic/v1/messages', polls: [], turns: [],
  billing: 'Dedicated channel execution is distinct from an independently measured credit debit.' };
const save = () => writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
const dataOf = response => response?.body?.data ?? response?.body;
const accepted = response => response?.status === 200 && response.body != null &&
  typeof response.body === 'object' && !Array.isArray(response.body) &&
  (response.body.code === undefined || response.body.code === 0);
if (resume && (receipt.settlementConfirmed || receipt.finishedAt || !dataOf(receipt.take)?.ticket_id)) throw new Error('Receipt is not an unfinished owned ticket');
let ticketId = resume ? dataOf(receipt.take).ticket_id : undefined, stopped = false;
const stop = () => { stopped = true; process.exitCode = 1; };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const previousFetch = globalThis.fetch;
// Bound helper requests too; no credential-bearing redirect is allowed.
globalThis.fetch = (url, options = {}) => previousFetch(url, { ...options,
  redirect: 'error', signal: options.signal ?? AbortSignal.timeout(15000) });
save();
try {
  if (resume && receipt.cleanupPending) throw new Error('Resuming settlement only');
  if (!resume) {
  try { receipt.before = await codingPlanStatus(); }
  catch { receipt.before = { error: 'Coding Plan monitor unavailable' }; }
  receipt.availability = await checkAvailability();
  if (!gateFromAvailability(receipt.availability).eligible) throw new Error('No ticket available');
  receipt.take = await takeTicket(receipt.taskId);
  if (!accepted(receipt.take) || !dataOf(receipt.take)?.ticket_id)
    throw new Error('Ticket creation failed');
  ticketId = dataOf(receipt.take).ticket_id;
  }
  save();
  const deadline = Date.now() + 120 * 60 * 1000;
  let state = resume ? 'queued' : dataOf(receipt.take).state;
  while (!['ready', 'active'].includes(state)) {
    if (stopped || Date.now() > deadline) throw new Error('Probe stopped before ticket readiness');
    const poll = await pollTickets([ticketId]);
    receipt.polls.push({ at: new Date().toISOString(), ...poll }); save();
    if (!accepted(poll)) throw new Error('Ticket poll failed');
    const own = dataOf(poll)?.tickets?.find(t => t.ticket_id === ticketId);
    state = own?.state;
    console.log(JSON.stringify({ ticketState: state, position: own?.position }));
    if (!['queued', 'ready', 'active'].includes(state)) throw new Error('Ticket terminal before execution');
    if (!['ready', 'active'].includes(state)) await new Promise(r => setTimeout(r, nextDelayMs(poll)));
  }
  const tasks = [
    { id: 'sum-squares-flash', model: 'GLM-5.3-Flash', prompt: 'Return only the sum of squares of integers 1 through 10.', expected: '385' },
    { id: 'numeric-sort-full', model: 'GLM-5.3', prompt: 'Return only the ascending numeric sort of [12,2,30,1] as compact JSON.', expected: '[1,2,12,30]' },
    { id: 'typeof-flash', model: 'GLM-5.3-Flash', prompt: 'Return only the result of JavaScript typeof null, without quotation marks.', expected: 'object' },
  ];
  for (const task of tasks) {
    const prior = receipt.turns.find(turn => turn.id === task.id || turn.prompt === task.prompt);
    if (prior) {
      if (prior.pass === true) continue;
      throw new Error('Prior turn failed or has unknown remote outcome; refusing replay');
    }
    if (stopped) throw new Error('Probe interrupted');
    const turn = { ...task, startedAt: new Date().toISOString(), outcome: 'unknown' };
    receipt.turns.push(turn); save(); // Persist intent before an irreversible remote request.
    const start = Date.now();
    const response = await offPeakTurn([{ role: 'user', content: task.prompt }], { ticketId, maxTokens: 4096, model: task.model });
    const answer = response.body?.content?.filter(p => p.type === 'text').map(p => p.text).join('') ?? '';
    const pass = response.status === 200 && answer.trim() === task.expected;
    Object.assign(turn, { pass, outcome: 'received', wallMs: Date.now() - start, ...response });
    save(); console.log(JSON.stringify({ turn: receipt.turns.length, pass, http: response.status,
      code: response.body?.code, answer, usage: response.body?.usage }));
    if (!pass) throw new Error('Dedicated-channel turn did not pass');
  }
  receipt.executionPassed = true;
  try { receipt.after = await codingPlanStatus(); }
  catch { receipt.after = { error: 'Coding Plan monitor unavailable' }; }
} catch (e) {
  receipt.success = false; receipt.error = e.message; process.exitCode = 1;
} finally {
  if (ticketId) {
    receipt.cleanupPending = true; save();
    try { receipt.settle = await settleTicket(ticketId); }
    catch { receipt.settle = { unknown: true }; }
    const settlement = dataOf(receipt.settle);
    receipt.settlementConfirmed = accepted(receipt.settle) && settlement != null &&
      typeof settlement === 'object' && !Array.isArray(settlement) &&
      (settlement.ticket_id === undefined || settlement.ticket_id === ticketId) &&
      (settlement.state === undefined || settlement.state === 'settled');
    receipt.cleanupPending = !receipt.settlementConfirmed;
  }
  receipt.success = receipt.executionPassed === true && receipt.settlementConfirmed === true;
  receipt.billingVerified = false; // Account aggregate percentages cannot attribute this ticket.
  if (receipt.success) { delete receipt.error; process.exitCode = 0; }
  else process.exitCode = 1;
  if (!receipt.cleanupPending) receipt.finishedAt = new Date().toISOString();
  save();
  globalThis.fetch = previousFetch;
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
  console.log(JSON.stringify({ success: receipt.success, error: receipt.error, settled: receipt.settle?.body?.data?.state }));
}
