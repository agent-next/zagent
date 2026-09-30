// Offline recovery regression tests. Mock every remote operation; never use credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'offpeak-recovery-test-'));
try {
  const script = fs.readFileSync(new URL('./offpeak-probe.mjs', import.meta.url), 'utf8')
    .replace('../packages/driver/offpeak.mjs', './mock.mjs').replace('../packages/driver/quota.mjs', './mock.mjs');
  fs.writeFileSync(path.join(ws, 'probe.mjs'), script);
  fs.writeFileSync(path.join(ws, 'mock.mjs'), `
    let quotaCalls = 0;
    export const codingPlanStatus = async () => {
      if (++quotaCalls === Number(process.env.QUOTA_FAIL_CALL)) throw Error('fixture monitor unavailable');
      return { fixture: true };
    };
    const result = data => ({status:200,body:{code:0,data}});
    export const checkAvailability = async () => result({can_take_number:true});
    export const gateFromAvailability = () => ({eligible:true});
    export const takeTicket = async () => result({ticket_id:'owned',state:'ready'});
    export const pollTickets = async () => result({tickets:[{ticket_id:'owned',state:'ready'}]});
    export const nextDelayMs = () => 0;
    export const settleTicket = async () => process.env.SETTLE_FAIL === '1'
      ? {status:503,body:{code:9}} : result({ticket_id:'owned',state:'settled'});
    export const offPeakTurn = async messages => ({status:200,body:{content:[{type:'text',
      text: messages[0].content.includes('squares') ? '385' : messages[0].content.includes('sort') ? '[1,2,12,30]' : 'object'}]}});
  `);
  let i = 0;
  const run = (receipt, env = {}) => {
    const output = path.join(ws, 'receipt-' + i++ + '.json');
    if (receipt) fs.writeFileSync(output, JSON.stringify(receipt));
    const result = spawnSync(process.execPath, [path.join(ws, 'probe.mjs'), receipt ? '--resume' : '--live', output],
      { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    return { code: result.status, receipt: JSON.parse(fs.readFileSync(output, 'utf8')) };
  };
  const pass = run();
  assert.equal(pass.code, 0); assert.equal(pass.receipt.success, true);
  assert.equal(pass.receipt.turns.length, 3); assert.equal(pass.receipt.billingVerified, false);
  for (const call of ['1', '2']) {
    const unavailable = run(undefined, { QUOTA_FAIL_CALL: call });
    assert.equal(unavailable.code, 0); assert.equal(unavailable.receipt.success, true);
    assert.equal(unavailable.receipt.billingVerified, false);
    assert.match(unavailable.receipt[call === '1' ? 'before' : 'after'].error, /monitor unavailable/);
  }
  const failedSettle = run(undefined, { SETTLE_FAIL: '1' });
  assert.equal(failedSettle.code, 1); assert.equal(failedSettle.receipt.success, false);
  assert.equal(failedSettle.receipt.cleanupPending, true); assert.equal(failedSettle.receipt.finishedAt, undefined);
  const cleanup = run(failedSettle.receipt);
  assert.equal(cleanup.code, 0); assert.equal(cleanup.receipt.turns.length, 3);
  const partial = structuredClone(pass.receipt);
  for (const key of ['settle','finishedAt','settlementConfirmed','executionPassed','success']) delete partial[key];
  partial.turns = partial.turns.slice(0, 1);
  const resumed = run(partial);
  assert.equal(resumed.code, 0); assert.equal(resumed.receipt.turns.length, 3);
  partial.turns[0] = { id: 'sum-squares-flash', outcome: 'unknown' };
  const uncertain = run(partial);
  assert.equal(uncertain.code, 1); assert.equal(uncertain.receipt.turns.length, 1);
  assert.match(uncertain.receipt.error, /refusing replay/);
  assert.equal(uncertain.receipt.settlementConfirmed, true);
  console.log('PASS offpeak probe settlement, cleanup-only resume, skip completed, no unknown replay');
} finally { fs.rmSync(ws, { recursive: true, force: true }); }
