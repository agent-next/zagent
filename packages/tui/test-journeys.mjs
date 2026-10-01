#!/usr/bin/env node
// The TUI, used the way a person uses it: typing, mistyping, interrupting, hitting
// errors, and trying to leave. Driven under a real PTY against a scripted fake
// host, asserting on the replayed SCREEN plus invariants that must hold after any
// journey.
//
// Every TUI defect this project has had was found by a human doing one of these
// and noticing something wrong. Each is now a test.
import { runJourney, KEY } from './journey.mjs';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { THROW, THROW_MID, HANG, TOOL, PERMISSION, THINKING, STREAM, PROVIDER_USAGE_LIMIT, PROVIDER_RATE_LIMIT } from './fake-host.mjs';

if (process.platform !== 'linux') { console.log('SKIP journeys: needs util-linux script(1) (-qfec), Linux only'); process.exit(0); }
const ESC = String.fromCharCode(27);

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

// -- the ordinary path -------------------------------------------------------
await journey('asks a question and reads the answer',
  { script: ['what is 2+2', KEY.enter, 1200, '/exit', KEY.enter], spec: { reply: 'four' } },
  (r, ok) => {
    ok(r.screen.includes('> what is 2+2'), 'the question is echoed into the transcript');
    ok(r.screen.includes('four'), 'the answer is shown');
    ok(r.exitCode === 0 && !r.forced, 'clean exit, got code ' + r.exitCode + ' forced=' + r.forced);
    ok(r.raw.includes('\x1b[>1u'), 'the kitty disambiguate flag is pushed at startup');
    ok(r.raw.includes('\x1b[<u'), 'the kitty keyboard stack is popped on clean exit');
  });

// -- the failure path, where every hand-found bug lived ----------------------
await journey('a failed turn explains itself and stops claiming to work',
  { script: ['sum', KEY.enter, 2000], spec: { behaviour: THROW, error: PROVIDER_USAGE_LIMIT } },
  (r, ok) => {
    ok(/1308|Usage limit/.test(r.screen), 'the provider reason reaches the user');
    ok(!/at .*\.mjs:\d+/.test(r.screen), 'no stack frames on screen');
  });

await journey('a rate limit is described as retryable, not as an exhausted plan',
  { script: ['hi', KEY.enter, 1500], spec: { behaviour: THROW, error: PROVIDER_RATE_LIMIT } },
  (r, ok) => ok(/retry/i.test(r.screen), 'tells the user it is worth retrying'));

// The kernel's bridge throws a bare "Turn execution failed" — the provider
// detail never crosses it, so explainProviderError finds nothing. A maintainer
// lived here: 5h window at 100%, honest dead error, no reset named. When the
// monitor proves the TOKENS_LIMIT pool is spent, the notice names the reset.
await journey('a bare turn failure names the window reset when the monitor proves exhaustion',
  { script: ['sum', KEY.enter, 2000],
    spec: { behaviour: THROW, error: 'Turn execution failed',
            quota: { pools: [{ type: 'TOKENS_LIMIT', usedPercent: 100, nextResetAt: '2099-01-01T06:05:00Z' }] } } },
  (r, ok) => {
    ok(/error: Turn execution failed/.test(r.raw), 'the dead error still prints');
    ok(/5-hour window used up · resets \d{2}:\d{2}/.test(r.raw), 'the monitor-verdict notice names the reset');
  });

await journey('an unexplained turn failure never blames a window the monitor cannot prove spent',
  { script: ['sum', KEY.enter, 2000],
    spec: { behaviour: THROW, error: 'Turn execution failed',
            quota: { pools: [{ type: 'TOKENS_LIMIT', usedPercent: 42, nextResetAt: '2099-01-01T06:05:00Z' }] } } },
  (r, ok) => {
    ok(/error: Turn execution failed/.test(r.raw), 'the dead error still prints');
    ok(!/window used up/.test(r.raw), 'a 42% pool adds no quota claim — the failure is something else');
  });

// Attribution correctness (review finding): while the pool sits at 100%, an
// unexplained error that is NOT the kernel's bare bridge failure — a local
// TypeError, a harness fault — must never be quota-attributed. The probe is
// gated on the exact 'Turn execution failed' shape.
await journey('a non-bridge unexplained error never gets a quota claim even at 100%',
  { script: ['sum', KEY.enter, 2000],
    spec: { behaviour: THROW, error: 'Cannot read properties of undefined',
            quota: { pools: [{ type: 'TOKENS_LIMIT', usedPercent: 100, nextResetAt: '2099-01-01T06:05:00Z' }] } } },
  (r, ok) => {
    ok(/error: Cannot read properties of undefined/.test(r.raw), 'the real error still prints');
    ok(!/window used up/.test(r.raw), 'a spent pool attaches nothing to a non-bridge failure');
  });

// The monitor call is a real network fetch — a slow one can resolve after the
// user already started the next turn. The probe latches to the turn that threw
// (state.turn identity), so the stale verdict is suppressed: two bare failures
// with a delayed spent-pool report print the notice exactly once.
await journey('a slow monitor probe does not leak its verdict into the next turn',
  { script: ['sum', KEY.enter, { waitFor: /error: Turn execution failed/ }, 'again', KEY.enter, 3200],
    spec: { behaviour: THROW, error: 'Turn execution failed', quotaDelayMs: 1200,
            quota: { pools: [{ type: 'TOKENS_LIMIT', usedPercent: 100, nextResetAt: '2099-01-01T06:05:00Z' }] } } },
  (r, ok) => {
    const count = (r.raw.match(/window used up/g) ?? []).length;
    ok(count === 1, `the stale probe's verdict is suppressed — exactly one notice, got ${count}`);
  });

// -- leaving, which had no answer at all -------------------------------------
// The slash-command journeys (/exit variants, the merged palette, /help,
// /status, the banner) live in test-journeys-commands.mjs — this file reached
// the gate's per-file timeout, so the command surface got its own pty suite.
await journey('ctrl+d on an empty prompt leaves',
  { script: [KEY.ctrlD], spec: {} },
  (r, ok) => ok(r.exitCode === 0 && !r.timedOut && !r.forced, 'ctrl+d did not exit on its own'));

// -- impatience and mistakes -------------------------------------------------
await journey('esc interrupts a hung turn and the UI recovers',
  { script: ['hang please', KEY.enter, 700, KEY.esc, { waitFor: /esc again to interrupt/ }, KEY.esc, 900, '/exit', KEY.enter], spec: { behaviour: HANG } },
  (r, ok) => {
    ok(r.exitCode === 0 && !r.forced, 'could not leave after interrupting');
    ok(/interrupted/.test(r.screen), 'the second esc actually interrupted the turn');
  });

await journey('a typo is editable rather than sent',
  { script: ['helo', KEY.backspace, KEY.backspace, 'llo', KEY.enter, 1000, '/exit', KEY.enter], spec: { reply: 'hi' } },
  (r, ok) => ok(r.screen.includes('> hello'), 'backspace did not edit the input'));

await journey('ctrl+u clears the line',
  { script: ['garbage text', KEY.ctrlU, 'clean', KEY.enter, 1000, '/exit', KEY.enter], spec: { reply: 'ok' } },
  (r, ok) => ok(!/> garbage text/.test(r.screen), 'ctrl+u left the old text in the submission'));

await journey('up-arrow recalls what was typed before',
  { script: ['first message', KEY.enter, 1000, KEY.up, KEY.enter, 1000, '/exit', KEY.enter], spec: { reply: 'ok' } },
  (r, ok) => ok((r.screen.match(/> first message/g) || []).length >= 2, 'history recall did not resubmit'));

// -- things that arrive from outside -----------------------------------------
// Peer-harness baseline (the `• Explored` cell + `• Ran` one-liner): consecutive
// read/search calls group under ONE header as `Name arg` member lines with no
// result bodies; a non-explore call keeps name, argument, timing and result.
await journey('explore calls group under one Explored cell while Bash keeps its result',
  { script: ['look around', KEY.enter, 1400, '/exit', KEY.enter], spec: { behaviour: TOOL } },
  (r, ok) => {
    ok((r.screen.match(/Explored/g) || []).length === 1, 'the run did not collapse under one header');
    ok(/Read a\.txt/.test(r.screen) && /Grep needle/.test(r.screen), 'a member line is missing');
    ok(!/read body hidden/.test(r.screen) && !/grep hits hidden/.test(r.screen),
       'an explore member printed its result body');
    ok(/Bash\(ls\)\s+12ms/.test(r.screen), 'the Bash line lacks the name, the argument or the timing');
    ok(/⎿\s+line one/.test(r.screen) && /line two/.test(r.screen), 'the Bash result body is not under the call');
  });

await journey('a permission prompt can be answered and the turn continues',
  { script: ['edit something', KEY.enter, 900, 'y', KEY.enter, 1200, '/exit', KEY.enter], spec: { behaviour: PERMISSION } },
  (r, ok) => ok(r.exitCode === 0 && !r.timedOut && !r.forced, 'the permission prompt trapped the session'));

await journey('a permission prompt can be allowed with 1',
  { script: ['edit something', KEY.enter, 900, '1', 1200, '/exit', KEY.enter], spec: { behaviour: PERMISSION } },
  (r, ok) => {
    ok(r.exitCode === 0 && !r.timedOut && !r.forced, 'pressing 1 trapped the session');
    ok(/allowed/.test(r.screen), 'pressing 1 allows the selected option');
  });

await journey('a permission prompt can be allowed with enter',
  { script: ['edit something', KEY.enter, 900, KEY.enter, 1200, '/exit', KEY.enter], spec: { behaviour: PERMISSION } },
  (r, ok) => {
    ok(r.exitCode === 0 && !r.timedOut && !r.forced, 'enter trapped the session');
    ok(/allowed/.test(r.screen), 'enter confirms the first option');
  });

await journey('a bracketed paste is not executed as keystrokes',
  { script: [KEY.pasteStart + 'line one\nline two' + KEY.pasteEnd, 400, KEY.ctrlU, '/exit', KEY.enter], spec: {} },
  // No !r.forced here: ctrl+u clears only the LAST line of the pasted
  // multi-line input, so '/exit' lands after 'line one\n' and is prompt text,
  // not a command — the runner's ctrl-c is what leaves.
  (r, ok) => ok(r.exitCode === 0 && !r.timedOut, 'paste left the session unusable'));

// Other harnesses collapse a large paste to a `[Pasted ~N lines]` chip in the
// composer — a 40-line paste must not flood the box, and the transcript echoes
// the chip, not the payload (the runtime still gets the full text).
await journey('a large paste collapses to a chip, not a flooded composer',
  { script: [
      KEY.pasteStart + Array.from({ length: 40 }, (_, i) => `paste body line ${i}`).join('\n') + KEY.pasteEnd,
      500, { snapshot: 'chipped' }, KEY.enter, 1200, '/exit', KEY.enter],
    spec: { reply: 'ok' } },
  (r, ok) => {
    ok(r.snapshots.chipped.includes('[Pasted ~40 lines]'), 'no paste chip in the composer');
    ok(!/paste body line 39/.test(r.snapshots.chipped), 'the pasted body flooded the composer');
    ok(r.screen.includes('> [Pasted ~40 lines]'), 'the transcript echoes the chip, not the payload');
    ok(!/paste body line 39/.test(r.screen), 'the pasted body reached the transcript');
  });

// Burst guard: a terminal without bracketed paste delivers a paste as a char
// flood; its newlines decode as 'enter' and would submit each line on its own.
// The flood must land as ONE draft — a chip for 3+ lines — and only a real
// Enter sends it.
await journey('an unbracketed multi-line paste is one draft, not one prompt per line',
  { script: ['line one\nline two\nline three', 800, { snapshot: 'draft' }, KEY.enter, 1200, '/exit', KEY.enter],
    spec: { reply: 'ok' } },
  (r, ok) => {
    const prompts = r.screen.match(/^> /gm) ?? [];
    ok(prompts.length === 1, `the flood submitted line-by-line (${prompts.length} user prompts on screen)`);
    ok(r.snapshots.draft.includes('[Pasted ~3 lines]'), 'the flood did not collapse to a chip');
    ok(!/line two/.test(r.screen), 'the pasted body flooded the transcript');
  });
await journey('an unbracketed single-line paste ending in Enter submits once',
  { script: ['do the thing\n', 900, '/exit', KEY.enter], spec: { reply: 'ok' } },
  (r, ok) => {
    const prompts = r.screen.match(/^> /gm) ?? [];
    ok(prompts.length === 1, `expected exactly one submitted prompt (got ${prompts.length})`);
    ok(r.screen.includes('do the thing'), 'the single-line paste did not submit');
    ok(r.screen.includes('ok'), 'the turn still answers');
  });

// -- hostile model output ----------------------------------------------------
await journey('model output cannot repaint the screen with escape codes',
  { script: ['tell me', KEY.enter, 1400, '/exit', KEY.enter],
    spec: { reply: 'safe' + ESC + '[2J' + ESC + '[HHIJACKED end' } },
  (r, ok) => {
    ok(r.screen.includes('safe'), 'the harmless part is shown');
    ok(!r.raw.includes(ESC + '[2J'), 'a clear-screen sequence survived sanitisation');
  });

await journey('wide characters do not corrupt the frame',
  { script: ['CJK and emoji test', KEY.enter, 1200, '/exit', KEY.enter], spec: { reply: 'done' } },
  (r, ok) => ok(r.exitCode === 0 && !r.forced, 'a wide-character turn broke the session'));

// Hardening: a fenced block is syntax-colored like every peer TUI — keyword
// and number scopes must reach the terminal as distinct SGR paints, not one
// flat code color. The fake host reports noColor:true and the journey env sets
// NO_COLOR=1, so this oracle re-enables color on BOTH gates.
await journey('fenced code paints syntax scopes, not one flat block',
  { env: { NO_COLOR: '' },
    script: ['show code', KEY.enter, 1400, '/exit', KEY.enter],
    spec: { noColor: false, reply: 'here:\n```js\nconst a = 1;\n```\ndone' } },
  (r, ok) => {
    ok(r.screen.includes('const a = 1;'), 'the code line is not on screen');
    ok(r.raw.includes('\x1b[38;5;176m'), 'the keyword scope never painted');
    ok(r.raw.includes('\x1b[38;5;215m'), 'the number scope never painted');
  });

// Found by the journey fuzzer: it could not leave a hung session and had to
// SIGKILL it. While a turn ran, ctrl-c returned at `if (ui.busy) interrupt()`
// before reaching the double-press check, so the documented escape hatch was
// unreachable exactly when a user needs it — and the status line said
// "ctrl+c twice to exit" the whole time.
await journey('ctrl+c twice escapes a hung turn, as the status line promises',
  { script: ['slow thing', KEY.enter, 900, KEY.ctrlC, 150, KEY.ctrlC, 900], spec: { behaviour: HANG } },
  (r, ok) => ok(r.exitCode === 0 && r.forced === null,
    'ctrl+c twice did not exit a hung turn (forced=' + r.forced + ')'));

await journey('the first ctrl+c still interrupts rather than quitting',
  { script: ['slow thing', KEY.enter, 900, KEY.ctrlC, 1200, '/exit', KEY.enter], spec: { behaviour: HANG } },
  (r, ok) => ok(r.exitCode === 0 && !r.timedOut && !r.forced, 'a single ctrl+c should interrupt, not exit'));

// J9's remaining exit path: the OS kills the process mid-turn — systemd stop,
// tmux kill-pane, logout. script(1) forwards SIGTERM to the child; the TUI's
// once('SIGTERM') handler must run exit(), and the shared invariants then
// verify raw mode was released and bracketed paste turned back off.
await journey('SIGTERM mid-turn exits cleanly and restores the terminal',
  { script: ['slow thing', KEY.enter, 900, { waitFor: /\x1b\[\?2004h/ }, { signal: 'SIGTERM' }, 1500],
    spec: { behaviour: HANG } },
  (r, ok) => ok(r.exitCode === 0 && !r.forced && !r.timedOut,
    'SIGTERM mid-turn did not exit on its own (code ' + r.exitCode + ', forced=' + r.forced + ')'));

// The other outside kill: `kill -INT`, or a ctrl-c that reached the process
// group in the window before raw mode engaged. Once raw mode is on, a terminal
// ctrl-c arrives as the 0x03 byte, never as a signal — so an observed SIGINT is
// always external and belongs on SIGTERM's graceful finish path. Pre-fix it hit
// the default disposition: the process died with raw mode and bracketed paste
// still armed, and the next shell looked broken.
await journey('SIGINT mid-turn exits cleanly and restores the terminal',
  { script: ['slow thing', KEY.enter, 900, { waitFor: /\x1b\[\?2004h/ }, { signal: 'SIGINT' }, 1500],
    spec: { behaviour: HANG } },
  (r, ok) => ok(r.exitCode === 0 && !r.forced && !r.timedOut,
    'SIGINT mid-turn did not exit on its own (code ' + r.exitCode + ', forced=' + r.forced + ')'));

// The last outside kill: SIGHUP — a closing terminal emulator, tmux killing
// the pane's session, logind tearing the session down. Same graceful finish
// as SIGTERM/SIGINT; the shared invariants verify the terminal came back.
await journey('SIGHUP mid-turn exits cleanly and restores the terminal',
  { script: ['slow thing', KEY.enter, 900, { waitFor: /\x1b\[\?2004h/ }, { signal: 'SIGHUP' }, 1500],
    spec: { behaviour: HANG } },
  (r, ok) => ok(r.exitCode === 0 && !r.forced && !r.timedOut,
    'SIGHUP mid-turn did not exit on its own (code ' + r.exitCode + ', forced=' + r.forced + ')'));

// J9's remaining front-door exits: /quit is the same door as /exit — a user who
// reads --help sees both names and reaches for either. (The no-orphan half of
// J9 is the journey.mjs invariant — every journey is checked for it now.)
await journey('J9 /quit leaves',
  { script: ['/quit', KEY.enter], spec: {} },
  (r, ok) => ok(r.exitCode === 0 && !r.timedOut && !r.forced, '/quit did not leave on its own'));

// Sessions are resumable objects — the way out names the one that just
// ended and hands back both ways in (the latest session in this directory,
// or this id exactly). Other harnesses print a resume command on exit; this is ours.
await journey('leaving names the session and how to resume it',
  { script: ['hi', KEY.enter, 1000, '/exit', KEY.enter], spec: { reply: 'ok' } },
  (r, ok) => {
    ok(/session sess_fakejourney/.test(r.screen), 'the exit summary does not name the session');
    ok(/zagent --resume sess_fakejourney/.test(r.screen), 'no --resume hint naming this session id');
    ok(/\bzagent -c\b/.test(r.screen), 'no -c continue hint on exit');
  });

// …and with no session started there is nothing to resume — the hint must not
// lie. /quit before the first turn is that case.
await journey('quitting before any turn prints no resume hint',
  { script: ['/quit', KEY.enter], spec: {} },
  (r, ok) => ok(!/zagent --resume|zagent -c/.test(r.screen), 'a resume hint appeared with nothing to resume'));

// J9's terminal-sane oracle: "raw mode released" is exactly `stty -g` identical
// before and after — the bracketed-paste invariant already covers one flag, but
// a leaked raw mode desyncs every key the user types in the next shell. Wrap
// the entry in a shell inside the same pty that snapshots termios around it.
const ENTRY_PATH = fileURLToPath(new URL('./journey-entry.mjs', import.meta.url));
const sq = v => `'${String(v).replaceAll("'", "'\\''")}'`;
const STTY_WRAP =
  `b=$(stty -g); ${sq(process.execPath)} ${sq(ENTRY_PATH)}; rc=$?; sleep 0.2; a=$(stty -g); ` +
  `if [ -n "$b" ] && [ "$b" = "$a" ]; then echo '[STTY-SANE]'; else echo "[STTY-CHANGED] $b -> $a"; fi; exit $rc`;
await journey('J9 the terminal is handed back unchanged (stty -g identical)',
  { command: STTY_WRAP, script: ['hi', KEY.enter, 1200, '/exit', KEY.enter], spec: { reply: 'ok' } },
  (r, ok) => ok(r.raw.includes('[STTY-SANE]'),
    r.raw.match(/\[STTY-CHANGED\][^\n]*/)?.[0] ?? 'no stty verdict — the wrapper did not run'));

// The stdin 'end' path: a real pty cannot deliver EOF (a keystroke is data,
// never an end-of-stream — closing the master delivers SIGHUP instead), so the
// entry synthesizes it with push(null), the same 'end' a dead pipe or a closed
// master would raise. finish() must still hand the terminal back — the stty
// oracle is the proof a human would run when their shell comes back wrong.
await journey('stdin EOF mid-session exits cleanly and restores the terminal',
  { command: STTY_WRAP, script: [{ waitFor: /\x1b\[\?2004h/ }, 'JOURNEY-EOF', 1200],
    spec: { fault: 'eof-on-key' } },
  (r, ok) => {
    ok(r.exitCode === 0 && !r.forced && !r.timedOut,
      'stdin EOF did not end the session (code ' + r.exitCode + ', forced=' + r.forced + ')');
    ok(r.raw.includes('[STTY-SANE]'),
      r.raw.match(/\[STTY-CHANGED\][^\n]*/)?.[0] ?? 'no stty verdict — the wrapper did not run');
  });

// Found by the fuzzer minutes after the loop started: a permission prompt trapped
// the session. ctrl-c returned at the permission branch before reaching the
// double-press check, so the prompt could be denied forever but never left.
await journey('ctrl+c twice leaves even with a permission prompt on screen',
  { script: ['edit something', KEY.enter, 1000, KEY.ctrlC, 150, KEY.ctrlC, 900], spec: { behaviour: PERMISSION } },
  (r, ok) => ok(r.exitCode === 0 && r.forced === null,
    'a permission prompt trapped the session (forced=' + r.forced + ')'));

// A provider that dies PARTWAY leaves the answer's tail in the live region while
// the error notices are committed to scrollback. An independent review
// reported that compose() can then paint the error above the last answer line;
// through a real pty it does not, because endTurn settles the assistant entry so
// it commits first. Pinned here so that stays true.
await journey('a mid-turn failure reports below the partial answer, not above it',
  { script: ['explain', KEY.enter, 1800, '/exit', KEY.enter],
    spec: { behaviour: THROW_MID, error: PROVIDER_USAGE_LIMIT,
            reply: 'this is a long streamed answer that wraps across more than one line so its tail stays live' },
    columns: 70 },
  (r, ok) => {
    const lines = r.screen.split('\n');
    const lastAnswer = lines.map((l, i) => [l, i]).filter(([l]) => /tail stays live/.test(l)).pop();
    const firstErr = lines.findIndex(l => /Usage limit reached for this plan window/.test(l));
    ok(lastAnswer != null, 'the partial answer never rendered');
    ok(firstErr > (lastAnswer ? lastAnswer[1] : Infinity),
      'the error block rendered ABOVE the partial answer');
  });

await journey('quitting mid-stream paints nothing after the session ends',
  { script: ['go', KEY.enter, 300, '/exit', KEY.enter, 1200], spec: { behaviour: HANG } },
  (r, ok) => {
    const i = r.raw.lastIndexOf('[JOURNEY-EXITED]');
    const after = i === -1 ? '' : r.raw.slice(i + 16).replace(/[\r\n]/g, '');
    ok(after.length === 0, 'painted ' + after.length + ' bytes after the app exited');
    ok(!r.forced, '/exit mid-stream needed force (forced=' + r.forced + ')');
  });

await journey('queued follow-ups show send now, edit, and cancel',
  { script: ['slow thing', KEY.enter, 700, 'follow up task', KEY.enter, 500], spec: { behaviour: HANG } },
  (r, ok) => ok(/\[send now\]/.test(r.screenAtRest) && /\[edit\]/.test(r.screenAtRest) && /\[cancel\]/.test(r.screenAtRest),
    'queued follow-up actions are not shown'));

await journey('esc while idle pulls the last queued follow-up into the input',
  { script: ['slow thing', KEY.enter, 700, 'bring me back', KEY.enter, 400, KEY.esc, 800, KEY.esc, 800, KEY.esc, 500],
    spec: { behaviour: HANG } },
  (r, ok) => {
    ok(/bring me back/.test(r.screenAtRest), 'the queued text is recovered');
    ok(!/\[send now\]/.test(r.screenAtRest), 'pulling the last item removed it from the queue');
  });

// The P0 measured defect: during a turn the screen showed only the spinner and
// the answer dumped at the end. Snapshots taken while the fake host is still
// pacing deltas are the oracle — the replayed screen must hold partial output
// AND still be mid-turn.
await journey('a streamed answer is visible mid-turn, not only at the end',
  { script: ['go', KEY.enter,
      { waitFor: /chunkA/ }, { snapshot: 'mid' },
      { waitFor: /chunkH/ }, 400, '/exit', KEY.enter],
    spec: { behaviour: STREAM, reply: 'chunkA chunkB chunkC chunkD chunkE chunkF chunkG chunkH' } },
  (r, ok) => {
    const mid = r.snapshots?.mid ?? '';
    ok(/> go/.test(mid), 'the user message is not committed to scrollback while the turn still runs');
    ok(/chunkA/.test(mid), 'the first chunks are on screen while the turn still runs');
    ok(!/chunkH/.test(mid), 'the whole answer was not dumped early');
    ok(/\bresponding\b/.test(mid), 'the turn was still active at the snapshot');
    ok(/still thinking/.test(mid), 'the live reasoning preview is visible');
    ok(/chunkA chunkB chunkC chunkD chunkE chunkF chunkG chunkH/.test(r.screen), 'the complete answer lands');
  });

// Newline-gated commit: a TERMINATED source line commits to
// scrollback while the stream is still running — mid-turn the finished line
// is already on screen, and only the still-growing tail line is live.
await journey('terminated lines are on screen mid-stream, before the turn ends',
  { script: ['go', KEY.enter,
      { waitFor: /line two kee/ }, { snapshot: 'mid' },
      { waitFor: /keeps going/ }, 400, '/exit', KEY.enter],
    spec: { behaviour: STREAM,
      reply: 'line one done.\nline two keeps going' } },
  (r, ok) => {
    const mid = r.snapshots?.mid ?? '';
    ok(/line one done/.test(mid), 'the finished line is on screen while the turn still runs');
    ok(/line two kee/.test(mid) && !/keeps going/.test(mid), 'the tail line is present but still growing');
    ok(/\bresponding\b/.test(mid), 'the turn was still active at the snapshot');
    ok(/line one done/.test(r.screen) && /keeps going/.test(r.screen), 'the whole answer lands');
  });

// Table holdback: a streamed table stays live until a
// terminated non-table line closes it, then commits once — the raw pipe
// source must never freeze into scrollback next to the re-rendered table.
await journey('a streamed table renders whole, never as torn pipe source',
  { script: ['tbl', KEY.enter, 2500, '/exit', KEY.enter],
    spec: { behaviour: STREAM,
      reply: 'before\n| a | b |\n|---|---|\n| 1 | 2 |\n| wider | 2 |\nafter' } },
  (r, ok) => {
    ok(/before/.test(r.screen) && /after/.test(r.screen), 'the text around the table lands');
    ok(/a +│ +b/.test(r.screen), 'the header row renders as a table');
    ok(/─+┼─+/.test(r.screen), 'the column divider renders');
    ok(/wider +│ +2/.test(r.screen), 'the widened row renders at the final width');
    ok(!/\| a \| b \|/.test(r.screen), 'the raw pipe source never froze into scrollback');
    ok((r.screen.match(/a +│ +b/g) ?? []).length === 1, 'the header row appears exactly once');
  });

await journey('thinking stays collapsed until ctrl+e expands it',
  { script: ['think', KEY.enter, 1200, '/exit', KEY.enter], spec: { behaviour: THINKING } },
  (r, ok) => {
    ok(/thinking/.test(r.screen), 'thinking is labelled');
    ok(!/Line four/.test(r.screen), 'collapsed thinking does not dump the body');
  });

await journey('ctrl+e expands collapsed thinking into scrollback',
  { script: ['think', KEY.enter, 1200, KEY.ctrlE, 400, '/exit', KEY.enter], spec: { behaviour: THINKING } },
  (r, ok) => ok(/Line four/.test(r.screen), 'ctrl+e appended the hidden reasoning'));

// Single-entry fold: shift+up selects a turn, the peek names the foldable
// under the cursor, and o toggles just that one (ctrl+e touches them all).
await journey('o toggles the single foldable under the cursor of a selected turn',
  { script: ['think', KEY.enter, 1200, KEY.shiftUp, 300, { snapshot: 'peeking' }, 'o', 500, '/exit', KEY.enter],
    spec: { behaviour: THINKING } },
  (r, ok) => {
    ok(/fold 1\/1/.test(r.snapshots.peeking), 'the peek shows the fold cursor');
    ok(/Line four/.test(r.screen), 'o expanded just the selected thinking block');
  });

await journey('shift+up peeks a previous user turn without rewriting it',
  { script: ['first prompt', KEY.enter, 1000, 'second prompt', KEY.enter, 1000, KEY.shiftUp, 200, KEY.shiftUp, 500],
    spec: { reply: 'ok' } },
  (r, ok) => {
    ok(r.screenAtRest.includes('> first prompt'), 'the original user turn stays in scrollback');
    ok(/1\/2/.test(r.screenAtRest), 'shift+up twice peeks the older user turn');
  });

// A crash journey is EXPECTED to die: 'unexpected-exit', 'incomplete-journey'
// and the entry's 'crash' marker are the journey itself, not defects. What is
// under test is whether the terminal survives the death.
async function fatalJourney(name, opts, assertFn) {
  const allowed = new Set(['crash', 'unexpected-exit', 'incomplete-journey']);
  const r = await runJourney(opts);
  const problems = r.invariants.filter(p => !allowed.has(p.id));
  try { await assertFn?.(r, (cond, msg) => { if (!cond) problems.push({ id: 'assert', detail: msg }); }); }
  catch (e) { problems.push({ id: 'threw', detail: e.message }); }
  if (problems.length) {
    fail++; console.error('FAIL ' + name);
    for (const p of problems) console.error('   ' + p.id + ': ' + String(p.detail).slice(0, 200).replace(/\n/g, ' | '));
  } else { pass++; console.log('ok   ' + name); }
}

// The wedged-terminal defect itself: when the process CRASHES — an uncaught
// fault, not a signal — exit() never ran, so raw mode and bracketed paste
// outlived the process and the user's shell came up broken. The fix is a crash
// guard inside runTui: uncaughtException/unhandledRejection release raw mode
// and disarm bracketed paste before the process dies.
await fatalJourney('a crash still hands back a sane terminal',
  { script: [{ waitFor: /\x1b\[\?2004h/ }, 'JOURNEY-BOOM', 900], spec: { fault: 'crash-on-key' } },
  (r, ok) => {
    ok(r.exitCode === 1 && !r.forced, 'the crash did not take the process down (code '
      + r.exitCode + ', forced=' + r.forced + ')');
    ok(r.raw.includes('\x1b[?2004l'), 'bracketed paste was still armed after the crash');
    ok(r.raw.includes('\x1b[<u'), 'the kitty keyboard stack was still armed after the crash');
  });

// Same death through J9's stty oracle: termios identical before and after the
// crash is exactly "raw mode released" — the check a human runs when their
// shell comes back wrong.
await fatalJourney('the terminal survives a crash unchanged (stty -g identical)',
  { command: STTY_WRAP, script: [{ waitFor: /\x1b\[\?2004h/ }, 'JOURNEY-BOOM', 900],
    spec: { fault: 'crash-on-key' } },
  (r, ok) => {
    ok(r.exitCode === 1, 'the crash did not take the process down (code ' + r.exitCode + ')');
    ok(r.raw.includes('[STTY-SANE]'),
      r.raw.match(/\[STTY-CHANGED\][^\n]*/)?.[0] ?? 'no stty verdict — the wrapper did not run');
  });

// The same wedged terminal, by a different death: an unhandled rejection with
// NO host handler takes the guard's fatal path — restore first, exit 1, one
// stderr line. Which fault killed the process must not decide whether the
// user's shell survives.
await fatalJourney('an unowned rejection still hands back a sane terminal',
  { script: [{ waitFor: /\x1b\[\?2004h/ }, 'JOURNEY-REJ', 900], spec: { fault: 'reject-on-key-unowned' } },
  (r, ok) => {
    ok(r.exitCode === 1 && !r.forced, 'the rejection did not take the process down (code '
      + r.exitCode + ', forced=' + r.forced + ')');
    ok(r.raw.includes('\x1b[?2004l'), 'bracketed paste was still armed after the rejection');
    ok(r.raw.includes('zagent: fatal:'), 'the fatal line never reached the terminal');
  });

// …but when the host DOES own rejections — a kernel that registers its own
// unhandledRejection handler — the guard must defer: the process stays up and
// the session survives. The entry's printer is that host handler here, so its
// marker appearing (and the session then leaving normally) is the pass.
await journey('a host-owned rejection defers and the session survives',
  // ctrl+u first: the tripwire itself is typed text sitting in the input box,
  // so /exit must be written on a cleared line or it submits as a prompt.
  { script: [{ waitFor: /\x1b\[\?2004h/ }, 'JOURNEY-REJ', 900, KEY.ctrlU, '/exit', KEY.enter],
    spec: { fault: 'reject-on-key' } },
  (r, ok) => {
    ok(r.raw.includes('[JOURNEY-UNHANDLED-REJECTION]'), 'the host handler never saw the rejection');
    ok(r.exitCode === 0 && !r.forced, 'a deferred rejection killed the session anyway');
  });

// -- config-gated block timestamps ---------------------------------------------
// The person opted in via ~/.zcode/cli/config.json — the stamp must reach the
// real terminal, right-aligned on the entry's first line.
{
  const home = mkdtempSync(path.join(os.tmpdir(), 'ztui-jts-'));
  try {
    mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
    writeFileSync(path.join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({ tui: { timestamps: true } }));
    await journey('block timestamps render on screen when configured',
      { script: ['what time is it', KEY.enter, 1200, '/exit', KEY.enter], spec: { reply: 'four', home } },
      (r, ok) => {
        const line = r.screen.split('\n').find(l => l.includes('> what time is it'));
        ok(line && /\d{2}:\d{2}\s*$/.test(line),
           'the echoed prompt line ends in a HH:MM stamp (got ' + JSON.stringify(line) + ')');
      });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

console.log('\n' + pass + '/' + (pass + fail) + ' journeys passed');
process.exit(fail ? 1 : 0);
