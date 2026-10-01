// Live slash-command probe: drive zagent's TUI under a PTY (same harness shape
// as scripts/tui-smoke.mjs), send each slash command, replay the erase-and-redraw
// stream, and capture the final rendered screen per step.
//
//   node slash-probe.mjs --repo <zagent checkout dir> --cwd <probe cwd> --out <raw dir>
//
// Not part of the repo test gate; a one-shot verification probe. Public-safe:
// runs in a scratch cwd, prints only replayed screen text.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const repo = path.resolve(arg('repo', '.'));
const cwd = path.resolve(arg('cwd', '.'));
const outDir = path.resolve(arg('out', './raw'));
mkdirSync(outDir, { recursive: true });
const { replayTerminal } = await import(pathToFileURL(path.join(repo, 'packages/tui/screen-replay.mjs')).href);
// scrollback + visible screen is what a person sees; the bounded model parses
// the DECSTBM stream the pinned writer emits (this pty is 0x0 under script(1),
// so the app clamps to 80x24 — the geometry modeled here).
const replayScreen = (text) => {
  const t = replayTerminal(text, { columns: 80, rows: 24 });
  return [...t.scrollback, ...t.screen].join('\n').replace(/\s+$/, '');
};

// Steps are ordered so session-mutating commands run last. The seed turn gives
// /compact context, /rewind a checkpoint and /resume a live session to name.
const STEPS = [
  { name: 'seed', input: 'Reply with exactly: READY', maxWait: 45000 },
  { name: 'skill', input: '/skill', maxWait: 30000 },
  { name: 'mcp', input: '/mcp', maxWait: 30000 },
  { name: 'plugins', input: '/plugins', maxWait: 30000 },
  { name: 'expert', input: '/expert', maxWait: 30000 },
  { name: 'locale', input: '/locale', maxWait: 30000 },
  { name: 'workflow', input: '/workflow', maxWait: 30000 },
  { name: 'workflows', input: '/workflows', maxWait: 30000 },
  { name: 'resume', input: '/resume', maxWait: 30000 },
  { name: 'rewind', input: '/rewind', maxWait: 30000 },
  { name: 'fork', input: '/fork', maxWait: 30000 },
  { name: 'compact', input: '/compact', maxWait: 120000 },
  { name: 'init', input: '/init', maxWait: 120000 },
  { name: 'new', input: '/new', maxWait: 30000 },
].filter(s => !process.argv.includes('--only') || s.name === arg('only', ''));

const entry = path.join(repo, 'packages', 'cli', 'zagent.mjs');
const child = spawn('script', ['-qfec', `stty rows 24 cols 80; node ${shQuote(entry)} --cwd ${shQuote(cwd)}`, '/dev/null'], {
  env: { ...process.env, TERM: 'xterm-256color' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let raw = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (d) => { raw += d; });
child.stderr.on('data', (d) => { raw += d; });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = [];
const slog = (o) => { log.push(o); console.log(JSON.stringify(o)); };

await sleep(4500);
let screen = replayScreen(raw);
if (!/zagent \d/.test(screen)) {
  slog({ step: 'banner', ok: false, note: 'banner never rendered' });
  console.log(screen);
  child.kill('SIGKILL');
  process.exit(2);
}
slog({ step: 'banner', ok: true });

for (let i = 0; i < STEPS.length; i++) {
  const s = STEPS[i];
  const rawStart = raw.length;
  child.stdin.write(s.input);
  await sleep(400);
  child.stdin.write('\r');
  const t0 = Date.now();
  let last = '', stableSince = Date.now();
  // Busy turns repaint the spinner every ~90ms, so a screen unchanged for 1.4s
  // means the command finished (or never started a turn).
  while (Date.now() - t0 < s.maxWait) {
    await sleep(400);
    const cur = replayScreen(raw);
    if (cur !== last) { last = cur; stableSince = Date.now(); }
    else if (Date.now() - stableSince > 1400 && Date.now() - t0 > 2500) break;
  }
  await sleep(400);
  // Dismiss any lingering chooser/palette so the next step starts at a prompt.
  child.stdin.write('\x1b');
  await sleep(600);
  screen = replayScreen(raw);
  const tag = `${String(i).padStart(2, '0')}-${s.name}`;
  writeFileSync(path.join(outDir, `${tag}.screen.txt`), screen + '\n');
  writeFileSync(path.join(outDir, `${tag}.raw.txt`), raw.slice(rawStart));
  slog({ step: s.name, input: s.input, ms: Date.now() - t0, tail: screen.split('\n').slice(-14) });
}

child.stdin.write('\x03');
await sleep(300);
child.stdin.write('\x03');
await sleep(1000);
child.kill('SIGTERM');
writeFileSync(path.join(outDir, 'steps.jsonl'), log.map(l => JSON.stringify(l)).join('\n') + '\n');
