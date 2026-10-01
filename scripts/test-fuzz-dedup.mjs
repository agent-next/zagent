#!/usr/bin/env node
// Which directories feed the fuzzer's dedup memory IS the dedup policy, and it
// was wrong once already: seeded from the open queue alone, it worked only while
// that queue was append-only. Once triage started archiving, the memory silently
// got shorter and the fuzzer re-recorded defects a human already owned.
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dedupMemory } from './journey-fuzz.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'fuzz-dedup-'));
const dir = (name, ...files) => {
  const d = path.join(root, name);
  mkdirSync(d, { recursive: true });
  for (const f of files) writeFileSync(path.join(d, `${f}.json`), '{}');
  return d;
};
const open = dir('fuzz', 'aaaaaaaaaaaa');
const filed = dir('filed', 'bbbbbbbbbbbb');
const resolved = dir('resolved', 'cccccccccccc');
const absent = path.join(root, 'never-created');

const tests = [];
const test = (n, f) => tests.push([n, f]);

test('a fingerprint awaiting a human is not recorded again', () => {
  assert.ok(dedupMemory([open, filed]).has('aaaaaaaaaaaa'));
});

test('a fingerprint a human already owns is not recorded again', () => {
  // The archive that fixed the append-only queue also emptied the memory that
  // depended on it. filed/ has to be in, or every sweep re-files the same defect.
  assert.ok(dedupMemory([open, filed]).has('bbbbbbbbbbbb'));
});

test('a fingerprint that was verified FIXED is recorded again', () => {
  // Deliberate: it coming back is a regression, and a regression is news. This
  // is the signal a single "already handled" flag destroyed — resolved and filed
  // are not the same state and must not share one.
  assert.ok(!dedupMemory([open, filed]).has('cccccccccccc'),
    'resolved/ must not be in the dedup memory');
  assert.ok(dedupMemory([open, filed, resolved]).has('cccccccccccc'),
    'the helper should still read any directory it is given');
});

test('a directory that does not exist yet is not an error', () => {
  assert.deepEqual([...dedupMemory([absent])], []);
});

let pass = 0, fail = 0;
for (const [n, f] of tests) {
  try { f(); pass++; } catch (e) { fail++; console.error(`FAIL ${n}\n  ${e.message}`); }
}
rmSync(root, { recursive: true, force: true });
console.log(`${pass}/${tests.length} fuzz-dedup tests passed`);
process.exit(fail ? 1 : 0);
