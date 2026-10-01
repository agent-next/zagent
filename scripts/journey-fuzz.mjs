#!/usr/bin/env node
// Random human sessions, forever, for free.
//
// The engine of the autonomous loop deliberately uses NO model. Journeys are
// generated from a grammar of things people do, run against the hermetic pty
// harness, and judged by invariants. That costs nothing per iteration, so it can
// run continuously — and it is where most bugs are actually found. Models are
// only worth spending on the two things a generator cannot do: inventing a shape
// nobody thought of, and writing a failure up for a human.
//
// A finding is only reported when it REPRODUCES: a flaky one-off filed as an issue
// is worse than silence, because someone has to disprove it.
//
//   node scripts/journey-fuzz.mjs --iterations 50
//   node scripts/journey-fuzz.mjs --forever --seed 7
import { runJourney, KEY } from '../packages/tui/journey.mjs';
import { THROW, HANG, TOOL, PERMISSION, OK, PROVIDER_USAGE_LIMIT, PROVIDER_RATE_LIMIT } from '../packages/tui/fake-host.mjs';
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FINDINGS = path.join(root, 'artifacts', 'fuzz');
// Dedup memory. It used to be the open queue alone, which worked only because
// that queue was append-only: once triage started archiving, the fuzzer's memory
// silently got shorter and it re-recorded defects a human already owned.
//
// `filed/` is in — a defect somebody is holding is not news. `resolved/` is
// deliberately OUT: a fingerprint that was verified fixed and then reappears is
// a REGRESSION, and it should be recorded and filed like anything else.
const FILED = path.join(root, 'artifacts', 'loop', 'filed');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const has = (n) => process.argv.includes('--' + n);

// Deterministic PRNG so any run is replayable from its seed alone.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

const WORDS = ['fix', 'the', 'parser', 'add', 'a', 'flag', 'why', 'is', 'this', 'slow',
  'refactor', 'tests', 'explain', 'summarise', 'CJK text', 'emoji', 'a very long line ' .repeat(3)];

/** Things a person does at a prompt. Weighted toward the ordinary. */
function actions(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const word = () => pick(WORDS);
  return [
    { w: 30, make: () => [word()] },
    { w: 10, make: () => [word(), KEY.backspace, KEY.backspace, word()] },
    { w: 8,  make: () => [word(), KEY.ctrlU, word()] },
    { w: 8,  make: () => [KEY.up] },
    { w: 6,  make: () => [KEY.down] },
    { w: 6,  make: () => [KEY.tab] },
    { w: 5,  make: () => ['/'] },
    { w: 5,  make: () => ['@'] },
    { w: 5,  make: () => [KEY.esc] },
    { w: 5,  make: () => [KEY.left, KEY.right, KEY.home, KEY.end] },
    { w: 4,  make: () => [KEY.pasteStart + word() + '\n' + word() + KEY.pasteEnd] },
    { w: 3,  make: () => [String.fromCharCode(27) + '[200~' + '\t'.repeat(5) + String.fromCharCode(27) + '[201~'] },
    { w: 3,  make: () => ['   '] },
    { w: 2,  make: () => [word().repeat(40)] },
  ];
}

function journeyFor(r) {
  const acts = actions(r);
  const total = acts.reduce((n, a) => n + a.w, 0);
  const one = () => {
    let x = r() * total;
    for (const a of acts) { x -= a.w; if (x <= 0) return a.make(); }
    return acts[0].make();
  };
  const script = [];
  const steps = 2 + Math.floor(r() * 5);
  for (let i = 0; i < steps; i++) {
    script.push(...one());
    if (r() < 0.6) { script.push(KEY.enter); script.push(600 + Math.floor(r() * 900)); }
  }
  // Every journey ends by trying to leave: a session you cannot exit is a bug.
  script.push('/exit', KEY.enter);

  const behaviours = [
    { w: 45, spec: { behaviour: OK, reply: 'done' } },
    { w: 12, spec: { behaviour: THROW, error: PROVIDER_USAGE_LIMIT } },
    { w: 12, spec: { behaviour: THROW, error: PROVIDER_RATE_LIMIT } },
    { w: 10, spec: { behaviour: THROW, error: 'Turn execution failed' } },
    { w: 8,  spec: { behaviour: TOOL } },
    { w: 8,  spec: { behaviour: PERMISSION } },
    { w: 5,  spec: { behaviour: HANG } },
  ];
  const bt = behaviours.reduce((n, b) => n + b.w, 0);
  let y = r() * bt;
  let spec = behaviours[0].spec;
  for (const b of behaviours) { y -= b.w; if (y <= 0) { spec = b.spec; break; } }

  const columns = [60, 80, 100, 140][Math.floor(r() * 4)];
  return { script, spec, columns };
}

/** Same defect, same fingerprint — so a loop cannot file the same issue nightly. */
function fingerprint(problems, spec) {
  const ids = problems.map(p => p.id).sort().join('+');
  return createHash('sha256').update(`${ids}|${spec.behaviour ?? 'ok'}`).digest('hex').slice(0, 12);
}

export async function reproduces(journey, expected, times = 2, run = runJourney) {
  if (!expected.length || !Number.isInteger(times) || times < 1) throw new Error('confirmation requires recorded invariants and positive repeats');
  const expectedIds = JSON.stringify(expected.map(p => p.id).sort());
  let result;
  for (let i = 0; i < times; i++) {
    result = await run(journey);
    const ids = result.invariants.map(p => p.id).sort();
    if (JSON.stringify(ids) !== expectedIds) return null;
  }
  return result;
}

/** Fingerprints not worth recording again. Exported because which directories
 * feed it is the whole dedup policy, and that policy was wrong once already. */
export function dedupMemory(dirs) {
  return new Set(dirs.flatMap(dir =>
    existsSync(dir) ? readdirSync(dir).map(f => f.split('.')[0]) : []));
}

async function main() {
  mkdirSync(FINDINGS, { recursive: true });
  const seen = dedupMemory([FINDINGS, FILED]);
  const forever = has('forever');
  const iterations = Number(arg('iterations', forever ? Infinity : 20));
  const r = rng(Number(arg('seed', Date.now() % 100000)));

  let ran = 0, found = 0, deduped = 0, errors = 0;
  while (ran < iterations) {
    ran++;
    const journey = journeyFor(r);
    let result;
    try { result = await runJourney(journey); }
    catch (e) { errors++; console.error(`iteration ${ran}: harness error ${e.message}`); continue; }

    if (result.invariants.length === 0) { process.stdout.write('.'); continue; }

    // Confirm before reporting. A flake filed as an issue costs someone a day.
    let confirmed;
    try { confirmed = await reproduces(journey, result.invariants); }
    catch (e) { errors++; console.error(`iteration ${ran}: confirmation error ${e.message}`); continue; }
    if (!confirmed) { process.stdout.write('?'); continue; }

    const fp = fingerprint(confirmed.invariants, journey.spec);
    if (seen.has(fp)) { deduped++; process.stdout.write('='); continue; }
    seen.add(fp); found++;

    const record = {
      fingerprint: fp,
      // The seed of the RUN that produced it. Recorded because the issue template
      // used to ask a model to cite a seed the finding never carried, so every
      // reproduction line it wrote was invented.
      seed: Number(arg('seed', 0)) || null,
      foundAt: new Date().toISOString(),
      invariants: confirmed.invariants,
      spec: journey.spec,
      script: journey.script.map(s => typeof s === 'number' ? s : JSON.stringify(s)),
      columns: journey.columns,
      screenAtRest: confirmed.screenAtRest,
      exitCode: confirmed.exitCode,
      timedOut: confirmed.timedOut,
    };
    writeFileSync(path.join(FINDINGS, `${fp}.json`), JSON.stringify(record, null, 2));
    console.log(`\nFINDING ${fp}: ${confirmed.invariants.map(p => p.id).join(', ')}`);
  }
  console.log(`\n${ran} journeys, ${found} new finding(s), ${deduped} already known, ${errors} harness errors`);
  return errors ? 2 : found ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (e) { console.error(`harness error: ${e.message}`); process.exitCode = 2; }
}
