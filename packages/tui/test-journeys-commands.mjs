#!/usr/bin/env node
// The merged command palette, used the way a person uses it: '/' opens one list
// of kernel AND zagent commands, a command typed in full runs on Enter, and the
// client commands answer in-process. Driven under a real PTY like
// test-journeys.mjs — split out because that file reached the gate's per-file
// timeout, not because these journeys are different in kind.
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { runJourney, KEY } from './journey.mjs';
import { HANG } from './fake-host.mjs';

if (process.platform === 'win32') { console.log('SKIP journeys: needs a POSIX pty (script(1))'); process.exit(0); }
// PTY golden journeys are unreliable inside containers (script(1) pty vs
// container /dev/pts sizing) - skip where /.dockerenv marks a container.
if (existsSync('/.dockerenv')) { console.log('SKIP journeys: container pty unreliable for TUI goldens'); process.exit(0); }

// findRuntime() probes the real fs in the TUI process, so the banner journeys
// pin ZCODE_RUNTIME: a zcode-app-cli layout resolves a product version, a lone
// file does not, and a missing path exercises the no-runtime fallback. Fixture
// pattern: packages/driver/test-runtime-xplat.mjs.
const rtFixture = mkdtempSync(path.join(os.tmpdir(), 'ztui-journey-'));
const cliBin = path.join(rtFixture, 'node_modules', 'zcode-app-cli', 'bin');
mkdirSync(cliBin, { recursive: true });
writeFileSync(path.join(cliBin, 'zcode.js'), '');
writeFileSync(path.join(cliBin, '..', 'package.json'), '{"version":"3.10.2-19"}');
const loneKernel = path.join(rtFixture, 'lone-kernel.cjs');
writeFileSync(loneKernel, '');
const absentRuntime = path.join(rtFixture, 'absent.cjs');

let pass = 0, fail = 0;
async function journey(name, opts, assertFn) {
  const r = await runJourney(opts);
  const problems = [...r.invariants];
  try { await assertFn?.(r, (cond, msg) => { if (!cond) problems.push({ id: 'assert', detail: msg }); }); }
  catch (e) { problems.push({ id: 'threw', detail: e.message }); }
  if (problems.length) {
    fail++; console.error('FAIL ' + name);
    for (const p of problems) console.error('   ' + p.id + ': ' + String(p.detail).slice(0, 200).replace(/\n/g, ' | '));
  } else { pass++; console.log('ok   ' + name); }
}

// -- leaving, which had no answer at all -------------------------------------
// exitCode 0 alone is a false green: runJourney force-sends ctrl-c when the app
// did not leave, so a dead /exit still exits 0. !r.forced means it left itself.
for (const cmd of ['/exit', '/quit', '/q', '/bye']) {
  await journey(cmd + ' leaves', { script: [cmd, KEY.enter], spec: {} },
    (r, ok) => ok(r.exitCode === 0 && !r.timedOut && !r.forced,
      cmd + ' did not exit on its own (code ' + r.exitCode + ', forced=' + r.forced + ')'));
}

// The regression this whole change exists for: '/' opens the merged palette,
// '/exit' is a candidate in it, and Enter used to only ACCEPT the highlighted
// suggestion — the command could never run. Now the exact match falls through.
await journey('/exit runs while the palette is open',
  { script: ['/', 400, 'exit', KEY.enter], spec: {} },
  (r, ok) => ok(r.exitCode === 0 && !r.timedOut && !r.forced,
    'Enter accepted the highlighted candidate instead of running /exit'));

await journey('the palette lists zagent commands alongside kernel ones',
  // The popup caps at 6 rows: bare '/' must show a client command, and
  // narrowing to '/mod' must still surface the kernel's /model.
  { script: ['/', 400, 'mod', 500, KEY.ctrlU, '/exit', KEY.enter], spec: {} },
  (r, ok) => {
    ok(r.raw.includes('/exit'), 'the merged palette offers /exit');
    ok(r.raw.includes('/model'), 'the merged palette still offers kernel commands');
    ok(!r.forced, 'leaving needed force (forced=' + r.forced + ')');
  });

// -- the palette pages like the other top CLIs --------------------------------
// 10 rows + a status line with the position count, and PgDn/PgUp move a whole
// window (clamped). raw, not screen: the last frame before /exit is the prompt.
await journey('pagedown moves the palette selection a window at a time',
  { script: ['/', 500, KEY.pageDown, 400, KEY.pageUp, 400, KEY.ctrlU, '/exit', KEY.enter], spec: {} },
  (r, ok) => {
    ok(/\b1\/\d+/.test(r.raw), 'the status line counts position/total');
    ok(/\b11\/\d+/.test(r.raw), 'PgDn moved the selection a full window');
    // After the PgDn frame, a later 1/N frame is the PgUp landing back on top.
    ok(/\b1\/\d+/.test(r.raw.slice(r.raw.search(/\b11\/\d+/))),
       'PgUp returns the selection to the top');
    ok(/pgdn/.test(r.raw), 'the status line advertises the page keys');
    ok(!r.forced, 'leaving needed force (forced=' + r.forced + ')');
  });

// -- the honest version line ---------------------------------------------------
// host.version (0.16.5) is the kernel's internal build string, not the product
// version — the banner used to paint it as `runtime 0.16.5`.
await journey('the banner names zagent, the runtime product version and the model',
  { script: ['/version', KEY.enter, 600, '/exit', KEY.enter], spec: {},
    env: { ZCODE_RUNTIME: path.join(cliBin, 'zcode.js') } },
  (r, ok) => {
    ok(/zagent \d+\.\d+\.\d+ · runtime explicit 3\.10\.2-19 · zai\/glm-5\.3/.test(r.raw),
       'banner is "zagent <pkg> · runtime <kind> <version> · <model>"');
    ok(!/runtime 0\.16\.5/.test(r.raw), 'the kernel string is not presented as the product version');
    ok(/zagent \d+\.\d+\.\d+ · runtime explicit 3\.10\.2-19/.test(r.screen), '/version prints the same product version');
    ok(!r.forced, 'leaving needed force (forced=' + r.forced + ')');
  });

await journey('the banner labels the kernel build when the install has no product version',
  { script: ['/version', KEY.enter, 600, '/exit', KEY.enter], spec: {},
    env: { ZCODE_RUNTIME: loneKernel } },
  (r, ok) => {
    ok(/runtime explicit \(kernel 0\.16\.5\)/.test(r.raw),
       'the kernel string is labelled, never the product version');
    ok(!r.forced, 'leaving needed force (forced=' + r.forced + ')');
  });

await journey('the banner labels the kernel string when nothing is installed',
  { script: ['/exit', KEY.enter], spec: {}, env: { ZCODE_RUNTIME: absentRuntime } },
  (r, ok) => {
    ok(/runtime kernel 0\.16\.5/.test(r.raw), 'no runtime found: the kernel string is labelled, not presented as the product');
    ok(!r.forced, 'leaving needed force (forced=' + r.forced + ')');
  });

await journey('/help renders the merged grouped command list in-process',
  { script: ['/help', KEY.enter, 700, '/exit', KEY.enter], spec: {} },
  (r, ok) => {
    ok(/Session/.test(r.screen) && /zagent/.test(r.screen), '/help shows the group headers');
    ok(/\/exit/.test(r.screen) && /\/model/.test(r.screen), 'client and kernel commands are both listed');
    ok(!r.forced, 'leaving needed force (forced=' + r.forced + ')');
  });

// -- quota / cost check --------------------------------------------------------
// After a turn, a person checks what it cost: /usage tokens, /context meter,
// /quota window. The quota report rides the deps seam (spec.quota); the context
// meter rides turn_complete's payload.projection (spec.contextMeter) — the same
// envelopes the real kernel uses, so these oracles are honest. Asserted on raw:
// committed command output stays in the stream; earlier blocks scroll off the
// 30-row replayed screen.
const quotaReport = {
  level: 'pro',
  pools: [
    { type: 'TOKENS_LIMIT', number: 5, usedPercent: 42, nextResetAt: '2099-01-01T06:05:00Z' },
    { type: 'TIME_LIMIT', used: 12, limit: 100, usedPercent: 12, nextResetAt: '2099-02-01T00:00:00Z' },
  ],
};
await journey('J5 /usage /context /quota answer after a turn',
  { script: ['hi', KEY.enter, 900, '/usage', KEY.enter, 400, '/context', KEY.enter, 400,
             '/quota', KEY.enter, 500, '/exit', KEY.enter],
    spec: { reply: 'ok', contextMeter: { contextUsed: 12345, contextWindow: 200000 }, quota: quotaReport } },
  (r, ok) => {
    ok(/tokens this session: [1-9]\d* in/.test(r.raw), '/usage reports tokens consumed');
    ok(/context: 12k \/ 200k/.test(r.raw), '/context shows the filled meter');
    ok(!/context: not reported yet/.test(r.raw), 'the meter stayed empty after a turn');
    ok(/5-hour window: 42% used · resets \d{2}:\d{2}/.test(r.raw), '/quota shows the window and its reset');
    ok(/monthly tool calls: 12 \/ 100/.test(r.raw), '/quota shows the monthly pool');
    ok(!r.forced, 'leaving needed force (forced=' + r.forced + ')');
  });

await journey('/status answers locally with version, session and tokens',
  { script: ['hi', KEY.enter, 800, '/status', KEY.enter, 600, '/exit', KEY.enter], spec: { reply: 'ok' } },
  (r, ok) => {
    ok(/zagent \d+\.\d+\.\d+/.test(r.screen), '/status shows the package version');
    ok(/kernel build 0\.16\.5/.test(r.screen), '/status shows the kernel build, labelled');
    ok(/tokens:/.test(r.screen), '/status shows session tokens');
    // No quota fixture: the seam must fail fast — this journey never touches
    // the real monitor endpoint, and the failure renders as 'not reported'.
    ok(/quota: not reported/.test(r.screen), 'a failed quota probe degrades to not reported');
    ok(!r.forced, 'leaving needed force (forced=' + r.forced + ')');
  });

// -- plan, quota and the context window are visible before the first turn -----
// Other top CLIs surface account usage on the home screen and inside /status;
// ours needed /quota and a completed turn. The startup probe and /status both ride
// the spec.quota seam; the context window is seeded from host.modelOptions —
// the same field the /model picker already shows.
await journey('the home screen shows plan and the 5-hour window at start',
  { script: [900, '/exit', KEY.enter], spec: { quota: quotaReport } },
  (r, ok) => {
    ok(/plan pro · 5-hour window: 42% used · resets \d{2}:\d{2}/.test(r.raw),
      'the startup quota notice names plan, window and reset');
    ok(!r.forced, 'leaving needed force (forced=' + r.forced + ')');
  });

await journey('the footer shows the context window before the first turn',
  // raw, not screen: exit() clears the live region, so the final replayed
  // frame has no footer at all — the bytes it painted are still in the stream.
  { script: [600, '/exit', KEY.enter], spec: {} },
  (r, ok) => {
    ok(/ctx \?\/200k/.test(r.raw), 'the status line shows the seeded model window');
    ok(!/ctx 0\//.test(r.raw), 'no used count was invented');
    ok(!r.forced, 'leaving needed force (forced=' + r.forced + ')');
  });

await journey('/context shows the model window before the first turn',
  { script: ['/context', KEY.enter, 600, '/exit', KEY.enter], spec: {} },
  (r, ok) => {
    ok(/context: window 200k · used fills in/.test(r.raw), 'the catalog window is shown pre-turn');
    ok(!/context: not reported yet/.test(r.raw), 'no window shown though the catalog carries it');
    ok(!r.forced, 'leaving needed force (forced=' + r.forced + ')');
  });

await journey('/status folds in plan, credential and limit bars',
  { script: ['/status', KEY.enter, 800, '/exit', KEY.enter], spec: { quota: quotaReport } },
  (r, ok) => {
    ok(/credential:/.test(r.raw), '/status names the credential source');
    ok(/plan: pro/.test(r.raw), '/status shows the plan level');
    ok(/5-hour window: \[█+░+\] 42% used/.test(r.raw), '/status renders the window bar');
    ok(/monthly tool calls: \[█+░+\] 12 \/ 100/.test(r.raw), '/status renders the monthly bar');
    ok(!r.forced, 'leaving needed force (forced=' + r.forced + ')');
  });

await journey('/exit works while a turn is still running',
  // The state a person is actually in when they want out: something is hung.
  { script: ['do something slow', KEY.enter, 700, '/exit', KEY.enter], spec: { behaviour: HANG } },
  (r, ok) => ok(r.exitCode === 0 && !r.timedOut && !r.forced,
    'quit was queued behind the running turn (forced=' + r.forced + ')'));

// -- unknown commands are answered locally with the MERGED list ---------------
// The kernel's own "Unknown command" reply named only its 20 commands — /exit,
// the way out, was not among them. The TUI now answers itself.
await journey('an unknown slash command lists client commands too',
  { script: ['/bogus', KEY.enter, 700, '/exit', KEY.enter], spec: {} },
  (r, ok) => {
    ok(/Unknown command: \/bogus/.test(r.raw), 'the unknown command is named');
    ok(/Available commands/.test(r.raw), 'the reply offers the command list');
    // /status is never typed in this script — its presence proves the merged
    // list printed; /exit would false-pass via the final exit's own echo.
    ok(/\/status/.test(r.raw) && /\/workflows/.test(r.raw),
      'the merged list spans client (/status) and kernel (/workflows) commands');
    ok(!r.forced, 'leaving needed force (forced=' + r.forced + ')');
  });

await journey('//help is answered locally, not by the kernel',
  { script: ['//help', KEY.enter, 700, '/exit', KEY.enter], spec: {} },
  (r, ok) => {
    ok(/Unknown command: \/\/help/.test(r.raw), '//help reaches the local handler');
    ok(/\/status/.test(r.raw), 'the reply lists client commands (/status is never typed here)');
  });

// The exact reported sequence: Esc used to leave a bare '/', so the
// next /help arrived at the kernel as '//help'. Esc now clears slash debris.
await journey('esc after / leaves a clean prompt, /help then runs',
  { script: ['/', 400, KEY.esc, 300, '/help', KEY.enter, 800, '/exit', KEY.enter], spec: {} },
  (r, ok) => {
    ok(!/Unknown command: \/\/help/.test(r.raw), 'the bare / survived Esc and poisoned /help');
    ok(/Session/.test(r.raw), '/help rendered after Esc cleared the input');
  });

// -- the keys are discoverable ------------------------------------------------
await journey('/help ends with a Shortcuts section',
  { script: ['/help', KEY.enter, 800, '/exit', KEY.enter], spec: {} },
  (r, ok) => {
    ok(/Shortcuts/.test(r.raw), 'the Shortcuts section is present');
    ok(/ctrl\+c/.test(r.raw) && /esc/.test(r.raw), 'the section names real keys');
  });

await journey('? prints the same help',
  { script: ['?', KEY.enter, 800, '/exit', KEY.enter], spec: {} },
  (r, ok) => ok(/Shortcuts/.test(r.raw), '? is the one-keystroke help'));

// -- session records are managed without leaving the TUI ------------------------
// The store is the runtime's own tasks-index.sqlite under HOME; the journey
// child gets a seeded throwaway HOME so the real store is never touched. The
// fake host emits a sessionId on its envelopes, latched on the first turn.
const tasksHome = mkdtempSync(path.join(os.tmpdir(), 'zjour-tasks-'));
const tasksDbFile = path.join(tasksHome, '.zcode', 'v2', 'tasks-index.sqlite');
const seedTasks = (rows) => {
  mkdirSync(path.dirname(tasksDbFile), { recursive: true });
  const db = new DatabaseSync(tasksDbFile);
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (workspace_key TEXT, task_id TEXT, title TEXT,
    task_status TEXT, pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0,
    title_overridden INTEGER DEFAULT 0, updated_at INTEGER, PRIMARY KEY (workspace_key, task_id))`);
  for (const r of rows) {
    db.prepare('INSERT OR REPLACE INTO tasks (workspace_key, task_id, title, task_status, updated_at) VALUES (?,?,?,?,?)')
      .run(r.ws ?? tasksHome, r.id, r.title ?? 'untitled', r.status ?? 'completed', Date.now());
  }
  db.close();
};
const readTask = (id) => {
  const db = new DatabaseSync(tasksDbFile, { readOnly: true });
  const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(id);
  db.close();
  return row;
};
// The offline-test preload refuses to load in a child whose HOME is not the
// declared sandbox — redirecting HOME means redirecting all three coordinates.
const tasksEnv = { HOME: tasksHome, USERPROFILE: tasksHome, ZAGENT_TEST_SANDBOX: tasksHome };

await journey('/rename before the first turn explains itself',
  { script: ['/rename early', KEY.enter, 600, '/exit', KEY.enter], spec: {}, env: tasksEnv },
  (r, ok) => ok(/no session yet/.test(r.raw), '/rename with no session did not explain itself'));

seedTasks([{ id: 'sess_fakejourney', title: 'old title' }]);
await journey('/rename retitles the current session record',
  { script: ['hi', KEY.enter, 900, '/rename journey session', KEY.enter, 700, '/exit', KEY.enter],
    spec: {}, env: tasksEnv },
  (r, ok) => {
    ok(/renamed sess_fakejourney → journey session/.test(r.raw), 'the rename report never printed');
    ok(readTask('sess_fakejourney')?.title === 'journey session', 'the store row keeps the old title');
    ok(!r.forced, 'leaving needed force (forced=' + r.forced + ')');
  });

seedTasks([{ id: 'sess_fakejourney' }]);
await journey('/archive flags the current session record',
  { script: ['hi', KEY.enter, 900, '/archive', KEY.enter, 600, '/exit', KEY.enter],
    spec: {}, env: tasksEnv },
  (r, ok) => {
    ok(/archived sess_fakejourney/.test(r.raw), 'the archive report never printed');
    ok(readTask('sess_fakejourney')?.archived === 1, 'the store row is not archived');
  });

seedTasks([{ id: 'sess_fakejourney' }]);
await journey('/delete declined leaves the record alone',
  { script: ['hi', KEY.enter, 900, '/delete', KEY.enter, { waitFor: /delete the record/ },
    'n', 600, '/exit', KEY.enter],
    spec: {}, env: tasksEnv },
  (r, ok) => {
    ok(/delete the record for sess_fakejourney/.test(r.raw), 'the confirm never asked');
    ok(/left unchanged/.test(r.raw), 'declining /delete did not say so');
    ok(readTask('sess_fakejourney')?.deleted === 0, 'a declined /delete still flagged the row');
  });

seedTasks([{ id: 'sess_fakejourney' }]);
await journey('/delete confirmed flags the record',
  { script: ['hi', KEY.enter, 900, '/delete', KEY.enter, { waitFor: /delete the record/ },
    'y', 600, '/exit', KEY.enter],
    spec: {}, env: tasksEnv },
  (r, ok) => {
    ok(/deleted sess_fakejourney/.test(r.raw), 'the delete report never printed');
    ok(readTask('sess_fakejourney')?.deleted === 1, 'the store row is not flagged deleted');
  });

// -- transcript markdown -----------------------------------------------------
// Top-CLI baseline: an answer renders as terminal markdown — heading, bullets,
// fenced code with its language label, a quote — never the raw '##' / '```'
// source. renderMarkdown has a unit test, but only a PTY journey proves the
// rendered form is what lands on screen once the stream commits. Every source
// line stays short: a still-growing line's wrapped head can commit before its
// tail arrives, which is a real limitation, not what is being verified here.
// Lives in the commands file only because the suites split by wall-clock budget.
await journey('an answer renders as markdown, not raw source',
  { script: ['md please', KEY.enter, { waitFor: /const x = 1/ }, 500, '/exit', KEY.enter],
    spec: { reply: '## Summary\n\n- first point\n- **bold** second\n\n```js\nconst x = 1\n```\n\n> a note\n' } },
  (r, ok) => {
    ok(/Summary/.test(r.screen) && !/## Summary/.test(r.screen), 'the heading kept its text but lost the ##');
    ok(/• first point/.test(r.screen), 'the bullet lost its marker');
    ok(/bold second/.test(r.screen) && !/\*\*bold/.test(r.screen), 'strong text kept its text but lost the **');
    ok(/^\s*js$/m.test(r.screen), 'the fence language label is not shown');
    ok(/const x = 1/.test(r.screen) && !/^\s*```/m.test(r.screen), 'the code shows but a fence marker does too');
    ok(/│ a note/.test(r.screen), 'the quote lost its gutter');
  });

// -- /permissions manages grants inside the TUI -------------------------------
// The store file is seeded under a spec.home the fake host reports; the picker
// rows come from listGrants, and enter -> 'y' must remove exactly that record
// — a pattern-substring revoke could take the k2 sibling with it.
{
  const grantsHome = mkdtempSync(path.join(os.tmpdir(), 'zjour-grants-'));
  mkdirSync(path.join(grantsHome, '.zcode', 'cli'), { recursive: true });
  writeFileSync(path.join(grantsHome, '.zcode', 'cli', 'grants.json'),
    JSON.stringify({ version: 1, grants: {
      k1: { toolName: 'Bash', optionId: 'allow_always', pattern: 'npm test', response: { decision: 'allow' } },
      k2: { toolName: 'Write', optionId: 'deny_always', pattern: 'src/secret.txt', response: { decision: 'deny' } },
    } }));
  await journey('/permissions revokes the highlighted grant on y',
    { script: ['/permissions', KEY.enter, { waitFor: /revokes the highlighted/ },
      KEY.enter, { waitFor: /revoke Bash\(npm test\)\?/ }, 'y', 600,
      '/exit', KEY.enter],
      spec: { home: grantsHome } },
    (r, ok) => {
      ok(r.raw.includes('Bash(npm test)'), 'the picker shows what was granted');
      ok(r.raw.includes('allow_always'), 'the grant decision is visible');
      ok(/revoked Bash\(npm test\)/.test(r.raw), 'the revoke was reported');
      const after = JSON.parse(readFileSync(path.join(grantsHome, '.zcode', 'cli', 'grants.json'), 'utf8'));
      ok(!after.grants.k1 && after.grants.k2, 'exactly the picked grant is gone');
      ok(!r.forced, 'leaving needed force (forced=' + r.forced + ')');
    });
  rmSync(grantsHome, { recursive: true, force: true });
}

// A revoke that cannot write the store must surface an error notice — an
// unhandled throw inside pick used to crash the whole TUI via onRejection.
{
  const grantsHome = mkdtempSync(path.join(os.tmpdir(), 'zjour-grants-ro-'));
  const cliDir = path.join(grantsHome, '.zcode', 'cli');
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(path.join(cliDir, 'grants.json'),
    JSON.stringify({ version: 1, grants: {
      k1: { toolName: 'Bash', optionId: 'allow_always', pattern: 'npm test', response: { decision: 'allow' } },
    } }));
  chmodSync(cliDir, 0o555);
  await journey('/permissions revoke failure is a notice, not a crash',
    { script: ['/permissions', KEY.enter, { waitFor: /revokes the highlighted/ },
      KEY.enter, { waitFor: /revoke Bash\(npm test\)\?/ }, 'y', 600,
      '/exit', KEY.enter],
      spec: { home: grantsHome } },
    (r, ok) => {
      ok(/revoke failed:/.test(r.raw), 'a failed revoke is reported');
      ok(!r.raw.includes('revoked Bash(npm test)'), 'no success was claimed');
      ok(!r.forced, 'leaving needed force (forced=' + r.forced + ')');
    });
  chmodSync(cliDir, 0o755);
  rmSync(grantsHome, { recursive: true, force: true });
}

console.log('\n' + pass + '/' + (pass + fail) + ' journeys passed');
rmSync(tasksHome, { recursive: true, force: true });
rmSync(rtFixture, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
