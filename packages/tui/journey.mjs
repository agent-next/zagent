// Drive the TUI under a real PTY as a person would, then check what is ON SCREEN.
//
// Design, derived from where the bugs actually were:
//
//   * A REAL pty. The in-process fake-host test cannot see terminal wiring; it
//     missed a regression that swallowed every keystroke.
//   * Assert on the REPLAYED SCREEN, never the raw stream. The stream contains
//     lines that were erased — grepping it reports text nobody saw.
//   * JOURNEYS, not functions. A person types, mistypes, interrupts, gets an
//     error, and tries to leave. Bugs live in that sequence, not in one call.
//   * INVARIANTS after every journey, whatever it did. "The status line must not
//     claim to be working when nothing is" is what makes a stuck spinner a test
//     failure instead of something a human has to notice.
//   * FAULTS are injectable. Every defect found by hand was on a failure path.
//   * HERMETIC: a fake host, so it needs no runtime, no credentials and no quota,
//     and can therefore run in the gate and in a loop forever.
import { spawn, execSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayTerminal } from './screen-replay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, 'journey-entry.mjs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Every descendant pid of `pid` (script(1)'s sh -c -> node chain). POSIX-only,
 * like the rest of this harness. */
function descendants(pid) {
  let kids = [];
  try { kids = execSync(`pgrep -P ${pid}`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); }
  catch { /* pgrep exits 1 on no match */ }
  return kids.flatMap(k => [k, ...descendants(k)]);
}

/**
 * The pids a {signal} step should hit: the journey ENTRY process itself, never
 * the plumbing. script(1) reports its direct child's exit — when SHELL is unset
 * it falls back to dash, which does NOT exec `sh -c`, leaving a live `sh` in the
 * tree; signaling that `sh` makes script report 143 even when the app exits 0.
 */
function signalTargets(rootPid, entryMatch = 'journey-entry') {
  const all = descendants(rootPid);
  const entry = all.filter(p => {
    try {
      // argv[0] must be the interpreter itself: the `sh -c` wrapper's cmdline
      // also contains the entry path, and signaling it dies 143 in script(1).
      const argv = readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0');
      return /node/.test(argv[0]) && argv.slice(1).some(a => a.includes(entryMatch));
    } catch { return false; }
  });
  return entry.length ? entry : (all.length ? all : [rootPid]);
}

/** Keystrokes a real terminal sends. */
export const KEY = {
  enter: '\r', esc: '\x1b', ctrlC: '\x03', ctrlD: '\x04', ctrlU: '\x15', ctrlL: '\x0c',
  ctrlE: '\x05',
  up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C',
  shiftUp: '\x1b[1;2A', shiftDown: '\x1b[1;2B',
  tab: '\t', backspace: '\x7f', home: '\x1b[H', end: '\x1b[F',
  pageUp: '\x1b[5~', pageDown: '\x1b[6~',
  pasteStart: '\x1b[200~', pasteEnd: '\x1b[201~',
};

/**
 * @param {object} o
 * @param {Array<string|number|{signal:string}|{waitFor:RegExp|string,timeoutMs?:number}>} o.script
 *   strings are typed; numbers are pauses in ms; {signal} sends that signal to
 *   the child (J9's SIGTERM-mid-turn exit path); {waitFor} pauses the script
 *   until the raw stream matches — gate signals on real output, since under
 *   gate load node may still be booting when a timed pause elapses and a
 *   signal sent then hits the default disposition before the TUI's handler
 *   exists (observed: SIGTERM journey exiting 143 under test-all, never solo).
 * @param {object} o.spec                  fake-host behaviour (see fake-host.mjs)
 * @param {object} o.env                   extra env for the child (e.g. a ZCODE_RUNTIME fixture)
 * @param {string} o.command               pty command; default is the fake-host journey entry.
 *                                         Live journeys pass the real `bin/zagent` here.
 * @param {string} o.entryMatch            /proc cmdline substring {signal} steps target
 * @param {string} o.cwd                   child cwd (live edit journeys need a scratch dir)
 * @param {string|null} o.marker           completion marker in the stream; null for the real
 *                                         binary, which prints no harness marker — its exit is the marker
 */
export async function runJourney({ script = [], spec = {}, columns = 100, rows = 30, timeoutMs = 20000, env = {},
                                   command = null, entryMatch = 'journey-entry', cwd, marker = '[JOURNEY-EXITED]' } = {}) {
  // `script -qfec` gives a pty with no native dependency. util-linux flavour.
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  // J9's no-orphan oracle, second leg: tree snapshots (knownPids) cannot see a
  // helper that double-forks or daemonizes — once reparented it is nobody's
  // descendant. Diff a pgrep -f scan taken before spawn against one after exit.
  // Linux-only: the survivor confirmation below reads /proc/<pid>/cmdline. The
  // [j] bracket keeps the scan's own `sh -c` cmdline from matching the pattern.
  const ORACLE = process.platform === 'linux';
  const strayScan = () => {
    if (!ORACLE) return [];
    try {
      return execSync(`pgrep -f ${quote(entryMatch.replace(/^./, c => `[${c}]`) + '|zcode\\.cjs')} || true`,
        { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);
    } catch { return []; }
  };
  const baselineStrays = new Set(strayScan());
  // Attribution for the stray leg: the journey env carries a per-run tag —
  // ZAGENT_JOURNEY_RUN=<pid>-<time> — which every descendant inherits. A stray
  // is ours only if its /proc/<pid>/environ holds THIS run's tag. The previous
  // cwd test could not tell two concurrent suite runs apart (observed: a
  // sibling lane running the same worktree's suite false-flagged every
  // journey's orphans); repo-rooted cwd is kept only as the fallback when
  // environ is unreadable.
  const runTag = `${process.pid}-${Date.now().toString(36)}`;
  const REPO_ROOT = path.resolve(here, '..', '..');
  const journeyCwd = cwd ?? process.cwd();
  const strayIsOurs = (p) => {
    try {
      // Every process this journey spawned inherits the tag through env. A
      // readable environ without it means a foreign process — never ours.
      return readFileSync(`/proc/${p}/environ`, 'utf8').includes(`ZAGENT_JOURNEY_RUN=${runTag}`);
    } catch { /* died between scan and read — fall through to cwd */ }
    try {
      const c = readlinkSync(`/proc/${p}/cwd`);
      return c === journeyCwd || c.startsWith(journeyCwd + '/') || c === REPO_ROOT || c.startsWith(REPO_ROOT + '/');
    } catch { return false; }
  };
  // The pty's winsize is made real, not just hinted: with no controlling
  // terminal `script` leaves it 0x0 and the app clamps to 80x24 while the
  // oracle modeled {columns}x{rows} — a geometry mismatch the DECSTBM writer
  // cannot afford (it arms a margin at the height it believes). stty inside
  // the child pins the pty to exactly what the replay below models.
  const child = spawn('script', ['-qfec',
    `stty rows ${rows} cols ${columns}; ${command ?? `${quote(process.execPath)} ${quote(ENTRY)}`}`,
    '/dev/null'], {
    cwd,
    env: {
      ...process.env,
      ZAGENT_JOURNEY: JSON.stringify(spec),
      COLUMNS: String(columns), LINES: String(rows),
      TERM: 'xterm-256color', NO_COLOR: '1',
      // script(1) runs the command through $SHELL — an exotic login shell turns
      // a POSIX command string into a syntax error. Pin the deterministic one.
      SHELL: '/bin/sh',
      ZAGENT_JOURNEY_RUN: runTag,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let raw = '';
  const grab = (d) => { raw += d; };
  child.stdout.on('data', grab);
  child.stderr.on('data', grab);
  // {snapshot:'name'} steps replay the stream AT THAT MOMENT — the only way to
  // assert what was on screen mid-turn, before later frames erase the live line.
  const snapshots = {};
  // What a person sees: scrollback above the visible screen. Under the pinned
  // writer committed lines land in native scrollback; under float the terminal
  // scrolls them there itself — either way the honest oracle is the bounded
  // terminal model (replayTerminal parses DECSTBM; the unbounded replayScreen
  // cannot), and the pty was stty-pinned to this exact geometry above.
  const screenText = (text) => {
    const t = replayTerminal(text, { columns, rows });
    return [...t.scrollback, ...t.screen].join('\n').replace(/\s+$/, '');
  };

  let exitCode = null;
  let timedOut = false;
  let spawnError = null;
  // Every pid the journey tree is ever seen to own — re-checked after exit for
  // the orphan invariant.
  const knownPids = new Set();
  const done = new Promise((resolve) => {
    child.on('error', error => { spawnError = error; resolve(); });
    child.on('close', c => { exitCode = c; resolve(); });
  });
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs);

  await sleep(900);                                   // first paint
  for (const p of descendants(child.pid)) knownPids.add(p);
  for (const step of script) {
    if (exitCode !== null || spawnError || timedOut) break;
    if (typeof step === 'number') { await sleep(step); continue; }
    if (typeof step === 'object' && step !== null && step.waitFor) {
      const want = step.waitFor instanceof RegExp
        ? step.waitFor
        : new RegExp(String(step.waitFor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const deadline = Date.now() + (step.timeoutMs ?? 15000);
      while (exitCode === null && !timedOut && !spawnError && !want.test(raw) && Date.now() < deadline) {
        await sleep(100);
      }
      continue;
    }
    if (typeof step === 'object' && step !== null && step.snapshot) {
      snapshots[step.snapshot] = screenText(raw);
      continue;
    }
    if (typeof step === 'object' && step !== null) {
      // Signal the TUI process tree, never the script(1) wrapper: killing the
      // wrapper takes the pty down first, so nothing the app does during its
      // exit path — raw-mode release, bracketed paste off, the exit marker —
      // can ever be observed. Descendants of script are sh -c -> node; only the
      // node half may be signaled (see signalTargets).
      for (const pid of signalTargets(child.pid, entryMatch)) { knownPids.add(pid); try { process.kill(pid, step.signal); } catch {} }
      await sleep(160);
      continue;
    }
    child.stdin.write(step);
    await sleep(160);
  }
  // J9's no-orphan oracle needs the pids the journey tree once owned; they are
  // re-checked after exit below. Snapshot before the at-rest screen too — a
  // journey with no {signal} step otherwise records nothing.
  for (const p of descendants(child.pid)) knownPids.add(p);
  // The screen AT REST: after everything the person did, before anything we do to
  // shut it down. This is the moment that matters — a stuck spinner is visible
  // while the app is still running, and gone from the final screen once the exit
  // message replaces the status line. Checking only the end missed it entirely.
  await sleep(600);
  const screenAtRest = screenText(raw);

  // Give the app a chance to leave on its own before forcing it.
  await Promise.race([done, sleep(2500)]);
  let forced = null;
  if (exitCode === null) { forced = 'ctrl-c'; try { child.stdin.write(KEY.ctrlC + KEY.ctrlC); } catch {} await Promise.race([done, sleep(1200)]); }
  if (exitCode === null) { forced = 'sigkill'; try { child.kill('SIGKILL'); } catch {} await Promise.race([done, sleep(800)]); }
  clearTimeout(timer);
  if (spawnError) throw spawnError;

  // J9's "no orphan zcode.cjs": anything the journey tree owned must be dead
  // once the app has left. Candidates are the snapshotted tree pids plus the
  // reparented-stray diff; each is polled ~1 s so a wrapper still exiting on a
  // loaded box is not a flaky fail. A SIGKILLed tree is exempt — those orphans
  // are the harness's, not the app's. A recycled pid is not an orphan, so the
  // survivor must still carry a cmdline pointing at this tree.
  const orphans = [];
  if (ORACLE && forced !== 'sigkill') {
    const candidates = new Set([...knownPids, ...strayScan().filter(p => !baselineStrays.has(p) && strayIsOurs(p))]);
    for (const p of candidates) {
      let alive = true;
      for (let i = 0; i < 10 && alive; i++) {
        try { process.kill(p, 0); } catch { alive = false; break; }
        await sleep(100);
      }
      if (alive) {
        try {
          if (/journey-entry|zagent|zcode/.test(readFileSync(`/proc/${p}/cmdline`, 'utf8'))) orphans.push(p);
        } catch { /* died between poll and read */ }
      }
    }
  }

  const screen = screenText(raw);
  return {
    screen, screenAtRest, snapshots, raw, exitCode, timedOut, spec, forced, orphans,
    invariants: checkInvariants({ screen, screenAtRest, raw, exitCode, timedOut, spec, forced, orphans, marker }),
  };
}

/**
 * What must be true after ANY journey. These are the checks that turn a defect a
 * human would merely notice into a test failure.
 */
export function checkInvariants({ screen, screenAtRest, raw, exitCode, timedOut, spec = {}, forced = null, orphans = [], marker = '[JOURNEY-EXITED]' }) {
  const problems = [];
  const add = (id, detail) => problems.push({ id, detail });
  if (exitCode !== 0) add('unexpected-exit', `expected exit 0, got ${exitCode}`);
  if (marker !== null && !raw.includes(marker)) add('incomplete-journey', 'the journey did not reach its completion marker');

  // The stuck spinner, generalised: once the person has stopped and the app is
  // idle, nothing may still claim to be working. Checked on the AT-REST screen,
  // not the final one — after the exit message replaces the status line the
  // symptom is gone, which is why checking only the end caught nothing.
  // Fault-aware: if the host was TOLD to hang, a turn still in flight is correct,
  // and flagging it is a false positive. The loop's first run produced exactly
  // that, and a loop that files false findings costs a human more than it saves.
  const atRest = (screenAtRest ?? screen).split('\n').slice(-6).join('\n');
  if (spec.behaviour !== 'hang'
      && /\bworking\b|\brunning command\b|\bwaiting\b|\bresponding\b/.test(atRest) && /esc to interrupt/.test(atRest)) {
    add('stuck-activity', `still claims activity after the turn ended:\n${atRest.slice(-220)}`);
  }

  // A crash must not masquerade as ordinary output. The 'reject-on-key'
  // journey is the exception — and only for the rejection marker: it is the
  // host-handler signature the deferral leg is supposed to produce. A real
  // uncaught exception is never exempt.
  if (/\[JOURNEY-UNCAUGHT\]/.test(raw)) {
    add('crash', /\[JOURNEY-UNCAUGHT\] (.*)/.exec(raw)?.[1] ?? 'uncaught');
  }
  if (spec.fault !== 'reject-on-key' && /\[JOURNEY-UNHANDLED-REJECTION\]/.test(raw)) {
    add('crash', /\[JOURNEY-UNHANDLED-REJECTION\] (.*)/.exec(raw)?.[1] ?? 'unhandled rejection');
  }
  if (/^\s*at .*\.mjs:\d+/m.test(screen)) {
    add('stack-on-screen', 'a stack trace reached the user');
  }

  // The terminal must be handed back — but only when the app was allowed to leave
  // on its own. A SIGKILLed process cannot run its cleanup, so asserting it did is
  // a false positive, not a defect.
  if (forced !== 'sigkill' && /\x1b\[\?2004h/.test(raw) && !/\x1b\[\?2004l/.test(raw)) {
    add('bracketed-paste-left-on', 'enabled but never disabled — the next shell gets pasted junk');
  }
  if (forced !== 'sigkill' && /\x1b\[>1u/.test(raw) && !/\x1b\[<u/.test(raw)) {
    add('kitty-keyboard-left-on', 'pushed but never popped — the next app reads CSI u keys');
  }

  if (/\x1b\[\?1049h|\x1b\[\?47h/.test(raw)) {
    add('alt-screen', 'entered the alternate screen — scrollback must stay in the primary buffer');
  }

  // Control characters that are not cursor movement should never reach the
  // screen. replayTerminal drops C0 bytes like a real terminal would, so the
  // check runs on the raw stream with escape sequences stripped instead.
  const stray = raw
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')   // CSI
    .replace(/\x1b[\x20-\x7e]/g, '')                            // single-byte escapes
    .match(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g);
  if (stray) add('control-chars-on-screen', `${stray.length} stray control byte(s)`);

  if (timedOut) add('did-not-exit', 'the process had to be killed at the timeout');
  // Being unable to leave is a defect in its own right — unless the turn was told
  // to hang AND the journey never actually asked to quit.
  if (forced === 'sigkill' && !timedOut) {
    add('needed-sigkill', 'neither /exit nor ctrl-c twice ended the session');
  }

  // J9: a clean exit must not leave a helper (a kernel child, a daemon) running
  // after the terminal is handed back.
  if (orphans.length) {
    add('orphan-process', `process(es) ${orphans.join(', ')} outlived the session`);
  }

  return problems;
}
