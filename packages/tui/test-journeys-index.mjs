#!/usr/bin/env node
// The J1..J9 human-journey suite is a CONTRACT (the journey contract, §10)
// spread across four pty files plus the outsider smoke. A letter can be lost
// silently — a file renamed, a journey dropped in a merge — so this index fails
// the day any of J1..J9 has no implementation anywhere.
//
//   J1 first run      → test-journeys-first-run.mjs   (offline, gate)
//   J2 help           → first-run + commands          (offline, gate)
//   J3 ask            → test-journeys-live.mjs        (ZAGENT_LIVE, opt-in)
//   J4 edit/diff/undo → live                          (ZAGENT_LIVE, opt-in)
//   J5 quota          → test-journeys-commands.mjs    (offline, gate)
//   J6 error paths    → test-journeys-first-run.mjs   (offline, gate)
//   J7 headless       → live                          (ZAGENT_LIVE, opt-in)
//   J8 outsider       → the outsider smoke script     (release check)
//   J9 exit paths     → test-journeys.mjs             (offline, gate)
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tui = path.dirname(fileURLToPath(import.meta.url));
// Comments don't implement journeys — strip them so a surviving `// J8 …` note
// cannot keep a letter green after its checks are deleted.
const stripComments = s => s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
const sources = Object.fromEntries(
  readdirSync(tui)
    .filter(f => /^test-journeys.*\.mjs$/.test(f) && f !== 'test-journeys-index.mjs')
    .map(f => [`packages/tui/${f}`, stripComments(readFileSync(path.join(tui, f), 'utf8'))]));
sources['scripts/outsider-smoke.mjs'] =
  stripComments(readFileSync(path.join(tui, '..', '..', 'scripts', 'outsider-smoke.mjs'), 'utf8'));

// The letters that may ONLY exist live — they spend real model turns.
const LIVE_LETTERS = new Set(['J3', 'J4', 'J7']);
const isLive = f => f.includes('test-journeys-live');

let fail = 0;
const bad = (msg) => { fail++; console.error('FAIL ' + msg); };
for (const id of ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8', 'J9']) {
  const where = Object.entries(sources)
    .filter(([, s]) => new RegExp(`\\b${id}\\b`).test(s))
    .map(([f]) => f);
  if (!where.length) { bad(`${id}: no implementation in any suite file`); continue; }
  if (!LIVE_LETTERS.has(id) && where.every(isLive)) {
    bad(`${id}: exists only in the live suite — the commit gate cannot see it`);
    continue;
  }
  console.log(`ok   ${id} → ${where.join(', ')}`);
}

// The live letters must actually be live-gated: real inference behind the
// ZAGENT_LIVE opt-in, never in the commit gate.
const live = sources['packages/tui/test-journeys-live.mjs'] ?? '';
for (const id of LIVE_LETTERS) {
  if (!new RegExp(`\\b${id}\\b`).test(live)) bad(`${id}: missing from the live suite`);
}
if (!/ZAGENT_LIVE/.test(live)) bad('live suite does not gate on ZAGENT_LIVE');

console.log(fail ? `\n${fail} suite-index problem(s)` : '\nJ1..J9 all implemented');
process.exit(fail ? 1 : 0);
