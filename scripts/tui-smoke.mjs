#!/usr/bin/env node
// End-to-end TUI smoke: drive the real interactive TUI under a PTY, replay the
// erase-and-redraw stream the way a terminal would, and assert on the FINAL
// screen rather than on the raw byte soup.
//
// Reading the raw capture is how three rendering defects were missed and then
// found: duplicated messages, the session-title side-query rendered as an answer,
// and tool-argument JSON appended to prose. All three are invisible in a naive
// grep of the stream and obvious in the replayed screen.
//
// Requires a real ZCode runtime and a Coding Plan credential, so it is opt-in and
// is NOT part of scripts/test-all.mjs.
//
//   node scripts/tui-smoke.mjs [--prompt "..."] [--cwd DIR] [--timeout MS] [--print]
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findRuntime } from '../packages/driver/runtime.mjs';
import { replayTerminal } from '../packages/tui/screen-replay.mjs';
export { replayTerminal };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

/** Replay CSI cursor-up / erase-below into a line buffer: what the user actually sees. */
async function main() {
  const runtime = findRuntime();
  if (!runtime) { console.error('SKIP: no ZCode runtime found'); process.exit(0); }

  const timeout = Number(arg('timeout', 150000));
  const cwd = arg('cwd', process.cwd());
  // A prompt the model CANNOT answer without calling a tool. "List the files" was
  // answerable from context, so the tool assertions failed whenever the model chose
  // to answer directly — a flaky test, not a defect. The token is random per run,
  // so it cannot be guessed or remembered.
  // The SECRET must not appear in the prompt, or the input box echoing the prompt
  // satisfies the assertion and the check proves nothing. The file NAME is public;
  // the value inside it is what only a tool call can reveal.
  const probeName = `.zagent-smoke-${randomBytes(4).toString('hex')}.txt`;
  const token = randomBytes(6).toString('hex').toUpperCase();
  const probeFile = path.join(cwd, probeName);
  writeFileSync(probeFile, `SMOKE-TOKEN=${token}\n`);
  const prompt = arg('prompt',
    `Read ${probeName} in this directory and reply with the exact value of SMOKE-TOKEN, then say DONE.`);
  const entry = path.join(root, 'packages', 'cli', 'zagent.mjs');
  const child = spawn('script', ['-qfec', `stty rows 30 cols 88; node ${entry} --cwd ${cwd}`, '/dev/null'], {
    env: { ...process.env, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let raw = '';
  child.stdout.on('data', (d) => { raw += d.toString(); });
  child.stderr.on('data', (d) => { raw += d.toString(); });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  await sleep(4000);
  child.stdin.write(prompt);
  await sleep(500);
  child.stdin.write('\r');
  await sleep(timeout);
  child.stdin.write('\x03'); await sleep(300); child.stdin.write('\x03');
  await sleep(1200);
  child.kill('SIGTERM');

  // scrollback + screen = what a person sees; replayTerminal parses the
  // DECSTBM stream the pinned writer emits (the unbounded replayScreen cannot).
  const t = replayTerminal(raw, { columns: 88, rows: 30 });
  const screen = [...t.scrollback, ...t.screen].join('\n').replace(/\s+$/, '');
  if (process.argv.includes('--print')) console.log(screen);

  let fails = 0;
  const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
  const count = (re) => (screen.match(re) ?? []).length;

  // The real banner is "⏺ zagent <pkg> · runtime <kind> <ver>" — the old regex
  // wanted the literal "zagent runtime " and failed on every runtime kind.
  ok(/zagent \d[^ ]* · runtime /.test(screen), 'banner rendered');
  // The prompt WRAPS in the transcript, so match its first words, not the whole line.
  ok(screen.includes(`> ${prompt.slice(0, 40)}`), 'the prompt is echoed into the transcript');
  ok(count(/^⏺ \{"title"/mu) === 0, 'the session-title side-query is not rendered as an answer');
  ok(count(/^⏺ .*\{"command"/mu) === 0, 'tool-argument JSON is not appended to prose');
  // Any tool, not a guessed one: the model may pick Read or Bash for this task and
  // both are correct. Asserting the NAME was asserting the model's choice.
  ok(count(/^⏺ [A-Z][A-Za-z_]*\(/mu) >= 1, 'a tool call rendered with its one-line header');
  ok(/⎿/u.test(screen), 'tool output rendered under the result glyph');
  // Not just /DONE/: the prompt itself contains the word, so that matched even
  // when the turn failed outright. Look for it OUTSIDE the echoed prompt line,
  // and fail loudly on a runtime-side error rather than reporting a weak pass.
  // The prompt WRAPS across lines: only the first carries "> ", so filtering on
  // that prefix left the continuation ("...then say DONE.") in body and let a
  // dead turn pass. Strip the contiguous echo block: a "> " line containing
  // prompt text starts it and it runs while following lines are still prompt
  // text. A lone word that also appears in the prompt (the model's "DONE") is
  // kept — it does not sit inside the echo block.
  let echoing = false;
  const body = screen.split('\n').filter((l) => {
    const text = l.replace(/^>\s*/, '').trim();
    const echoText = text !== '' && prompt.includes(text);
    if (l.startsWith('> ') && echoText) { echoing = true; return false; }
    if (echoing && echoText) return false;
    echoing = false;
    return true;
  }).join('\n');
  ok(!/error: Turn execution failed/.test(screen), 'the turn did not fail at the runtime level');
  ok(/DONE/.test(body), 'the model reached the end of the task');
  // The token proves a tool actually ran: it exists only inside the file.
  ok(new RegExp(token).test(body), `the model reported the token, so it really read the file (${token})`);

  // Duplication: no non-trivial assistant line may appear twice.
  const bodies = screen.split('\n').map(l => l.replace(/^[⏺○>]\s*/u, '').trim())
    .filter(l => l.length > 25 && !l.startsWith('-rw') && !l.startsWith('drwx'));
  const seen = new Map();
  for (const line of bodies) seen.set(line, (seen.get(line) ?? 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1);
  ok(dupes.length === 0, `no duplicated transcript lines${dupes.length ? ` (${dupes[0][0].slice(0, 60)}… x${dupes[0][1]})` : ''}`);

  try { rmSync(probeFile, { force: true }); } catch {}
  console.log(fails === 0 ? '\nTUI SMOKE PASS' : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}

// Realpath'd and URL-encoded comparison: a script path with spaces, a
// symlinked argv[1] or a Windows drive path must still run the tool, not
// exit 0 having done nothing (nothing else would catch that — it is opt-in).
const isMain = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(path.resolve(process.argv[1] ?? ''))).href; }
  catch { return false; }
})();
if (isMain) await main();
