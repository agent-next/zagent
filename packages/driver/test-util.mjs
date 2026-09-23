// Shared test mini-framework — one assert/eq/ok for driver tests (test.mjs, test-a2.mjs)
// and hermetic tests, replacing the three per-file copies. Styles preserved:
//   assert(): fail-fast (exit 1) — real-oracle tests.
//   eq()/ok()/summary(): count failures, exit at summary — hermetic tests.
let failed = 0;
export function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok -', msg);
}
export const ok = (cond, msg) => {
  console.log(`${cond ? 'ok  -' : 'FAIL-'} ${msg}`);
  if (!cond) failed++;
};
export const eq = (got, want, msg) => {
  const pass = got === want;
  console.log(`${pass ? 'ok  -' : 'FAIL-'} ${msg}`);
  if (!pass) { console.log(`      got:  ${JSON.stringify(got)}`); console.log(`      want: ${JSON.stringify(want)}`); failed++; }
};
export function summary(label = 'assertions') {
  console.log(failed ? `\nFAILED ${failed} assertion(s)` : `\nPASS ${label} (all assertions)`);
  process.exit(failed ? 1 : 0);
}
