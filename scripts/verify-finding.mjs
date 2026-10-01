#!/usr/bin/env node
// Replays stored, JSON-encoded keystrokes against the current hermetic TUI.
// exit 0 = still broken; exit 3 = clean; exit 1 = unusable evidence or harness.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJourney } from '../packages/tui/journey.mjs';

export async function verifyFinding(finding, run = runJourney) {
  assert(finding && Array.isArray(finding.script) && finding.script.length, 'missing replay script');
  assert(Array.isArray(finding.invariants) && finding.invariants.length &&
    finding.invariants.every(p => typeof p?.id === 'string' && p.id), 'missing recorded invariants');
  assert(finding.spec && typeof finding.spec === 'object' && !Array.isArray(finding.spec), 'invalid replay spec');
  assert(finding.columns === undefined || (Number.isInteger(finding.columns) && finding.columns > 0), 'invalid columns');
  const script = finding.script.map(step => {
    const value = typeof step === 'number' ? step : JSON.parse(step);
    assert(typeof value === 'string' || (Number.isFinite(value) && value >= 0), 'invalid replay step');
    return value;
  });
  const result = await run({ script, spec: finding.spec, columns: finding.columns });
  const still = result.invariants.map(p => p.id);
  return { fingerprint: finding.fingerprint, recorded: finding.invariants.map(p => p.id),
    nowFailing: still, stillBroken: still.length > 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv[2], 'usage: verify-finding.mjs <finding.json>');
    const result = await verifyFinding(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.stillBroken ? 0 : 3;
  } catch (error) { console.error(`unusable finding: ${error.message}`); process.exitCode = 1; }
}
