#!/usr/bin/env node
// Offline oracle for the flock triage dedupe: the known-findings
// side must parse waiver lines exactly like the finding side — `- title |
// disposition` AND the dominant `- title — DISPOSITION` form sign only the
// title half (disposition prose never waives), a title that tokenizes to
// nothing (pure CJK) dedupes on its normalized text via the __raw__
// fallback, and a group is `known` only when EVERY merged member is waived.
// Also pins the unsafe direction: a sub-2-token waiver must match EXACTLY,
// never blanket every finding sharing one word (release gate).
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLOCK = path.join(root, 'usertest', 'swarm', 'opencode-flock.mjs');
const work = mkdtempSync(path.join(tmpdir(), 'flock-triage-'));

const rec = (findings, extra = {}) => JSON.stringify({
  ts: '2026-09-18T00:00:00.000Z', worker: 1, round: 1, scenario: 'fixture',
  seed: 1, runSeed: 1, model: 'fixture/model', tarball: 't.tgz',
  class: 'FINDING', findings, ...extra,
});
const KNOWN_WAIVER = '- known alpha beta title | disposition words must not leak';
const CJK_TITLE = '会话数据库读取失败却返回成功空列表';
writeFileSync(path.join(work, 'runs.ndjson'), [
  rec(['known alpha beta title | CMD: zagent x']),
  rec([`${CJK_TITLE} | CMD: zagent y`]),
  rec(['different crash report entirely | CMD: zagent z']),   // shares 'crash' with the 1-token waiver
  rec(['crash | CMD: zagent w']),                              // exact 1-token waiver hit
  rec(['totally novel symptom here | CMD: zagent v']),         // unwaivered -> NEW
  rec(['table row waived thing | CMD: zagent u']),             // `|` rows are not waivers
  rec(['fresh install bug | CMD: zagent t']),                  // em-dash waiver title half
  rec(['verified words leak everywhere | CMD: zagent s']),     // shares only DISPOSITION tokens -> NEW
  rec(['mno pqr vwx | CMD: zagent r']),                        // 2/3 = 0.67 partial merge -> known
  rec(['omega sigma theta | CMD: zagent q',                    // waived group anchor (subset of 4-token waiver)
       'omega sigma zeta eta iota | CMD: zagent p']),          // merges at 0.67 but only 2/4 waiver tokens -> NEW group
  rec(['checkbox item text | CMD: zagent n']),                 // `- [ ]` is not a waiver -> NEW
  rec(['drift format bug | CMD: zagent m']),                   // unspaced-em-dash waiver title half
  rec(['wontfix verifier only | CMD: zagent l']),              // shares only unspaced-`—` disposition tokens -> NEW
  JSON.stringify({ ts: 'x', class: 'FINDING', findings: 'not-an-array' }),      // malformed: skipped
  JSON.stringify({ ts: 'x', class: 'FINDING', findings: [123, null] }),         // malformed: skipped
  // Template echoes — a degraded model parroting the verdict FORMAT (the 0.0.238
  // release gate refused on 4 of these; literal <placeholder> fields are malformed
  // output, never a product finding). Echo = <…> title OR >=2 placeholder
  // fields; a single `GOT: <empty>`-style field stays a real finding.
  rec(['<title> | CMD: <exact command it ran> | EXPECTED: <expected> | GOT: <observed>']),
  rec(['<title> | CMD: <command> | EXPECTED: <expected> | GOT: <observed>'], { templateEchoes: 1 }), // qwen prompt's shorter template
  rec(['plausible real title | CMD: <exact command it ran> | EXPECTED: <expected> | GOT: <observed>']),
  rec(['another plausible title | CMD: zagent ok | EXPECTED: <expected> | GOT: <observed>']), // 2 fields = echo
  rec(['kept single placeholder field | CMD: zagent kept | GOT: <empty>']),      // 1 field = real finding -> NEW
].join('\n'));
writeFileSync(path.join(work, 'known-findings.md'), [
  '# fixture waivers',
  KNOWN_WAIVER,
  `- ${CJK_TITLE} | fixed in a later release`,
  '- crash | one-token waiver — exact match only',
  '| table row waived thing | a pipe-table row is NOT a waiver bullet |',
  '- fresh install bug — FIXED in a later release (verified words leak everywhere, exit 2, fresh HOME)', // em-dash form: disposition must not sign
  '- mno pqr stu | partial-merge waiver',
  '- omega sigma theta kappa | group anchor waiver',
  '- [ ] checkbox item text — unchecked todo, NOT a waiver',
  '- drift format bug—wontfix verifier only', // unspaced em-dash must still cut the disposition
].join('\n'));

const r = spawnSync(process.execPath, [FLOCK, '--triage'], {
  env: { ...process.env, FLOCK_DIR: work, NODE_OPTIONS: '' },
  encoding: 'utf8', timeout: 30000,
});
rmSync(work, { recursive: true, force: true });
assert.equal(r.status, 0, `triage exited ${r.status}: ${r.stderr}`);
const out = r.stdout;

const tests = [];
const test = (n, f) => tests.push([n, f]);

test('`- title | disposition` waiver suppresses the finding by title alone', () => {
  assert.match(out, /known\s+\[x1\].*known alpha beta title/, 'waiver title half must match the finding');
});
test('pure-CJK waiver suppresses the identical CJK finding (__raw__ fallback both sides)', () => {
  assert.match(out, new RegExp(`known\\s+\\[x1\\].*${CJK_TITLE}`), 'CJK title must dedupe, not re-report NEW');
});
test('a 1-token waiver does NOT blanket a different finding sharing the token', () => {
  assert.match(out, /NEW\s+\[x1\].*different crash report entirely/, 'containment needs >=2 tokens');
});
test('a 1-token waiver still matches the identical 1-token title', () => {
  assert.match(out, /known\s+\[x1\].*crash/, 'exact same single token is a deliberate waiver');
});
test('an unwaivered finding reports NEW', () => {
  assert.match(out, /NEW\s+\[x1\].*totally novel symptom here/);
});
test('pipe-table rows are not waiver bullets (the - prefix is the contract)', () => {
  assert.match(out, /NEW\s+\[x1\].*table row waived thing/, 'a `|`-row must not suppress — fail toward NEW');
});
test('em-dash waiver suppresses the finding by its title half', () => {
  assert.match(out, /known\s+\[x1\].*fresh install bug/, 'title before ` — ` must match');
});
test('em-dash disposition prose does NOT sign (tokens after ` — ` never waive)', () => {
  assert.match(out, /NEW\s+\[x1\].*verified words leak everywhere/, 'disposition tokens must not enter the signature');
});
test('a >=0.6 partial merge still waives (rephrase collapse is the feature)', () => {
  assert.match(out, /known\s+\[x1\].*mno pqr vwx/, 'wording-variant collapse must keep working');
});
test('an unwaived member cannot hide inside a waived group (transitive merge)', () => {
  assert.match(out, /NEW\s+\[x2\].*omega sigma theta/, 'group known only when EVERY member is waived');
});
test('markdown `- [ ]` checkboxes are open items, not waivers', () => {
  assert.match(out, /NEW\s+\[x1\].*checkbox item text/, 'a checkbox must not suppress — fail toward NEW');
});
test('malformed records are skipped, not fatal (exit 0, totals still print)', () => {
  assert.match(out, /totals:.*FINDING=/, 'triage must finish the report past corrupt lines');
});
test('unspaced `—` still cuts the disposition (title half waives, prose does not)', () => {
  assert.match(out, /known\s+\[x1\].*drift format bug/, 'title before `—` must match');
  assert.match(out, /NEW\s+\[x1\].*wontfix verifier only/, 'unspaced-`—` disposition must not sign');
});
test('a NEW group surfaces its unwaived member in the examples', () => {
  assert.match(out, /NEW\s+\[x2\].*omega sigma theta[\s\S]*?omega sigma zeta eta iota/, 'the unwaived member must be visible');
});
test('verdict-template echoes never become findings (the dead-upstream refusal class)', () => {
  assert.doesNotMatch(out, /<title>/, 'a literal <title> placeholder must not group');
  assert.doesNotMatch(out, /plausible real title|another plausible title/, '>=2 placeholder fields is still an echo');
  assert.match(out, /NEW\s+\[x1\].*kept single placeholder field/, 'a single <…> field is a real finding — fail toward keeping');
  assert.match(out, /totals:.*FINDING=20\b/, 'the records still count in the class totals');
  assert.match(out, /templateEchoes=1\b/, 'recorded echo drops surface in totals');
});

let failed = 0;
for (const [name, f] of tests) {
  try { f(); console.log(`ok ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
console.log(failed ? `${failed} failure(s)` : 'all triage-dedupe oracles passed');
process.exit(failed ? 1 : 0);
