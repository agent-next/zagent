#!/usr/bin/env node
// Offline oracles for the FLOCK-PTY interactive-card class: pty-drive.py must
// really drive a pty (send/key/expect/snap/resize round-trips) and its screen
// model must render CSI cursor edits — a dumb ANSI-stripper cannot tell an
// overwrite from an append, which is exactly what a human judge needs.
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRIVER = path.join(root, 'usertest', 'swarm', 'pty-drive.py');
const work = mkdtempSync(path.join(tmpdir(), 'flock-pty-'));

const havePy = spawnSync('python3', ['--version'], { encoding: 'utf8' });
if (havePy.status !== 0) {
  console.log('skip: python3 not on PATH (flock pty driver untestable here)');
  process.exit(0);
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

function drive(scriptText, cmd, args = [], env = {}) {
  const dir = mkdtempSync(path.join(work, 'run-'));
  const script = path.join(dir, 's.txt');
  const dumps = path.join(dir, 'dumps');
  writeFileSync(script, scriptText);
  const r = spawnSync('python3', [DRIVER, script, dumps, '--', ...cmd, ...args],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
  return { r, dumps };
}

const snaps = (dumps) => readdirSync(dumps).filter((f) => f.endsWith('.txt'))
  .map((f) => [f, readFileSync(path.join(dumps, f), 'utf8')]);

test('send+key+expect+snap round-trip: child reads what the pty typed', () => {
  const { r, dumps } = drive(
    'expect PROMPT\nsend hello\nkey enter\nexpect GOT:hello 6000\nsnap done\n',
    ['bash', '-c', 'printf "PROMPT> "; read line; echo "GOT:$line"'],
  );
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
  assert.match(r.stdout, /EXPECT-OK PROMPT/);
  assert.match(r.stdout, /EXPECT-OK GOT:hello/);
  assert.match(r.stdout, /EXIT 0/);
  const [, doneTxt] = snaps(dumps).find(([f]) => f.includes('done')) ?? [];
  assert.ok(doneTxt?.includes('GOT:hello'), `snap missing child output:\n${doneTxt}`);
  assert.ok(existsSync(path.join(dumps, 'raw.bin')));
});

test('screen model applies CSI cursor edits (overwrite, not append)', () => {
  const { r, dumps } = drive(
    'wait 900\nsnap s\n',
    ['bash', '-c', 'printf "abc\\x1b[2DXY"; sleep 0.3'],
  );
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
  const [, txt] = snaps(dumps).find(([f]) => f.includes('-s')) ?? [];
  assert.match(txt, /aXY/, `expected aXY (b,c overwritten):\n${txt}`);
  assert.doesNotMatch(txt, /aXYc/);
});

test('OSC sequences are skipped, not painted', () => {
  const { r, dumps } = drive(
    'wait 900\nsnap s\n',
    ['bash', '-c', 'printf "\\x1b]8;;http://example.invalid\\x07link\\x1b]8;;\\x07 done\\n"; sleep 0.3'],
  );
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
  const [, txt] = snaps(dumps).find(([f]) => f.includes('-s')) ?? [];
  assert.match(txt, /link done/);
  assert.doesNotMatch(txt, /example\.invalid/);
});

test('resize lands on the pty (child sees new winsize)', () => {
  const { r, dumps } = drive(
    'resize 50x12\nsend x\nkey enter\nexpect 12 50 6000\nsnap s\n',
    ['bash', '-c', 'read x; stty size'],
  );
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
  assert.match(r.stdout, /EXPECT-OK 12 50/, `stdout:\n${r.stdout}`);
});

test('ctrl-c reaches the child through the pty', () => {
  const { r, dumps } = drive('wait 400\nkey ctrl-c\nwait 400\nsnap after\n', ['bash', '-c', 'sleep 60']);
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
  assert.match(r.stdout, /CHILD-EXITED|EXIT -2|EXIT 130/, `expected SIGINT exit:\n${r.stdout}`);
  assert.ok(existsSync(path.join(dumps, 'final.txt')));
});

test('a bad script line fails loudly, exit 2', () => {
  const { r } = drive('bogus-verb now\n', ['bash', '-c', 'sleep 60']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /SCRIPT-ERR/);
});

test('bad wait/expect args are SCRIPT-ERR, never a traceback losing the dumps', () => {
  const a = drive('wait 2s\n', ['bash', '-c', 'sleep 60']);
  assert.equal(a.r.status, 2); assert.match(a.r.stderr, /SCRIPT-ERR/);
  const b = drive('expect foo(\n', ['bash', '-c', 'sleep 60']);
  assert.equal(b.r.status, 2); assert.match(b.r.stderr, /SCRIPT-ERR/);
  // evidence is still written even on a bad script
  assert.ok(existsSync(path.join(b.dumps, 'final.txt')));
});

test('DCH/ECH never grow a row past the terminal width', () => {
  const { r, dumps } = drive(
    'wait 900\nsnap s\n',
    ['bash', '-c', 'printf "abcdefghijkl\\x1b[99Pzzz\\x1b[999Xq"; sleep 0.3'],
  );
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
  const [, txt] = snaps(dumps).find(([f]) => f.includes('-s')) ?? [];
  for (const line of (txt ?? '').split('\n')) {
    assert.ok(line.length <= 100, `rendered line wider than 100 cols: ${line.slice(0, 60)}…`);
  }
});

test('saved cursor restored across a shrink-resize stays in bounds (no emulator crash)', () => {
  // Real-world escape: a full-screen child (opencode) leaves a DECSC+DECRC pair
  // buffered in the pty while the driver shrinks the model — the stale restore
  // used to IndexError _put and lose the whole run.
  const { r, dumps } = drive(
    'wait 500\nresize 40x10\nwait 2500\nsnap s\n',
    ['bash', '-c', 'printf "\\x1b[20;30H\\x1b7"; sleep 1; printf "\\x1b8MARK"; sleep 0.2'],
  );
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
  const [, txt] = snaps(dumps).find(([f]) => f.includes('-s')) ?? [];
  assert.match(txt, /MARK/, `restored print missing:\n${txt}`);
});

test('grown rows carry the new width (resize-up repaint cannot crash _put)', () => {
  // The opencode escape: shrink then grow — rows appended by the grow used to
  // come out at the OLD width (self._blank() read stale self.cols), so the
  // child's post-resize repaint wrote past them and IndexError'd the run.
  const { r, dumps } = drive(
    'wait 400\nresize 40x10\nresize 100x30\nwait 2200\nsnap s\n',
    ['bash', '-c', 'sleep 1; printf "\\x1b[25;60HMARK"; sleep 0.2'],
  );
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
  const [, txt] = snaps(dumps).find(([f]) => f.includes('-s')) ?? [];
  assert.match(txt, /MARK/, `grown-row write missing:\n${txt}`);
});

test('kitty CSI >u/<u/=u/?u are not cursor restore — plain CSI u still is', () => {
  // zagent pushes kitty flags with CSI>1u at init and pops with CSI<u at
  // teardown; codex adds CSI?u + CSI<1u. The 'u' final used to always run
  // _restore(), so the init push snapped the cursor to a stale saved cell
  // and every later frame printed on top of old rows (ghost-residue dumps).
  const { r, dumps } = drive(
    'wait 900\nsnap s\n',
    ['bash', '-c', 'printf "\\x1b[5;10H\\x1b[s\\x1b[20;5H\\x1b[>1uMARK\\x1b[uHERE\\x1b[<u\\x1b[?u\\x1b[=2;1u\\x1b[25;1HTAIL"; sleep 0.3'],
  );
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
  const [, txt] = snaps(dumps).find(([f]) => f.includes('-s')) ?? [];
  const lines = (txt ?? '').split('\n'); // lines[0] is the snap header
  assert.equal(lines[20]?.slice(4, 8), 'MARK',
    `kitty push moved the cursor — MARK should print at row 20 col 5:\n${txt}`);
  assert.equal(lines[5]?.slice(9, 13), 'HERE',
    `plain CSI u must still restore to row 5 col 10:\n${txt}`);
  assert.match(lines[25] ?? '', /TAIL/, `writes after kitty pop/query/set lost:\n${txt}`);
});

test('pty:true cards carry the driver + SCREEN-cite contract', async () => {
  const { EXTRA_SCENARIOS } = await import(path.join(root, 'usertest', 'swarm', 'scenarios-extra.mjs'));
  const { SCENARIOS, SIGNIN_SCENARIOS, SIGNIN_PTY_SCENARIOS } = await import(path.join(root, 'usertest', 'swarm', 'scenarios.mjs'));
  const pty = [...SCENARIOS, ...EXTRA_SCENARIOS, ...SIGNIN_SCENARIOS, ...SIGNIN_PTY_SCENARIOS].filter((s) => s.pty);
  assert.ok(pty.length >= 1, 'no pty:true cards — the class silently emptied');
  for (const s of pty) {
    const card = s.card();
    assert.ok(card.includes('pty-drive.py'), `${s.id}: card does not name the driver`);
    assert.ok(card.includes('SCREEN:'), `${s.id}: card does not demand a SCREEN cite`);
  }
});

test('chooser never uses the instantly-resolving promise question form', () => {
  // node:readline's callbackless rl.question() resolves undefined in 0ms on
  // node v22 (nodejs/node#57035) — the working promise form lives only on
  // node:readline/promises. zagent.mjs imports plain node:readline, so a bare
  // `await rl.question(` there is always the dead form: the first-run chooser
  // printed its card and exited before a human could ever type 1/2/3.
  const src = readFileSync(path.join(root, 'packages', 'cli', 'zagent.mjs'), 'utf8');
  assert.doesNotMatch(src, /await rl\.question\(/,
    'chooseSignIn uses the callbackless question — it resolves undefined instantly on node:readline');
});

test('first-run chooser actually CONSUMES input on a real tty (live zagent.mjs)', () => {
  // The bug was in question RESOLUTION, not prompt emission — the dead code
  // also printed `sign in [1/2/3]: ` then exited 2. So this must send '2' and
  // reach the SECOND prompt; on the old code expect() times out instead.
  const home = mkdtempSync(path.join(work, 'home-'));
  // Credential gate sits behind findRuntime — a stub file satisfies it, same
  // as test-signin-card.mjs; the child never launches the runtime (quit path).
  const stub = path.join(home, 'stub-runtime.cjs');
  writeFileSync(stub, '// test stub: existence is all the gate checks\n');
  const { r, dumps } = drive(
    'wait 500\nexpect sign in .1/2/3.: 8000\nsend 2\nkey enter\nexpect paste ZAI_API_KEY 4000\nkey ctrl-d\nwait 600\nsnap s\n',
    [process.execPath, path.join(root, 'packages', 'cli', 'zagent.mjs')], [],
    { HOME: home, ZAI_API_KEY: '', ZCODE_RUNTIME: stub, TERM: 'xterm-256color',
      NODE_OPTIONS: '' }, // else the inherited offline-test preload throws on HOME≠sandbox
  );
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
  assert.match(r.stdout, /EXPECT-OK paste ZAI_API_KEY/, `second prompt unreachable — input not consumed:\n${r.stdout}`);
  assert.match(r.stdout, /EXIT 2/, `ctrl-D decline should exit 2:\n${r.stdout}`);
  const [, txt] = snaps(dumps).find(([f]) => f.includes('-s')) ?? [];
  assert.match(txt ?? '', /paste ZAI_API_KEY:/, 'screen shows no key prompt');
});

test('the harness copies the driver and applies the SCREEN oracle floor', () => {
  const src = readFileSync(path.join(root, 'usertest', 'swarm', 'opencode-flock.mjs'), 'utf8');
  // Assert code shapes, not comment text — a comment alone must not satisfy this.
  assert.match(src, /copyFileSync\([\s\S]*?pty-drive\.py/, 'driver never copied into the sandbox');
  assert.match(src, /scenario\.pty\s*\?\s*\/SCREEN/, 'pty findings not held to the SCREEN-cite floor');
});

let pass = 0, fail = 0;
for (const [n, f] of tests) {
  try { await f(); pass++; } catch (e) { fail++; console.error(`FAIL ${n}\n  ${e.message}`); }
}
rmSync(work, { recursive: true, force: true });
console.log(`${pass}/${tests.length} flock-pty tests passed`);
process.exit(fail ? 1 : 0);
