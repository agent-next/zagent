// runTui driven by a FAKE host — no runtime, no credentials, no PTY.
//
// The TUI had zero interactive coverage in CI: the live smoke script needs a
// ZCode runtime and a Coding Plan credential, so it is excluded from the gate
// and could not run at all while the quota was exhausted. Every regression in
// the key loop therefore had to be found by hand.
//
// This stubs the 28-member host contract instead, so the loop can be exercised
// anywhere.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTui } from './index.mjs';

// These oracles drive the float writer's raw stream; the pinned strategy is
// covered by test-screen-pinned.mjs and the PTY journeys. Pin the mode so a
// host TERM cannot flip the default mid-suite.
process.env.ZAGENT_TUI_SCROLL = 'float';

// runTui's real quota seam would read the fallback credential file and hit the
// network — the in-process suite stays hermetic with a fast-failing stub.
// pasteBurst.flushMs 0 flushes a burst at the end of each emit — the in-process
// suite stays synchronous while the real 60 ms quiet window guards real
// terminals (and is exercised by the PTY journeys).
// frameMs 0 is the same seam for the frame coalescer: every draw paints
// synchronously, while the real 16 ms window is covered by test-frames.mjs
// (fake-clock oracles) and the coalescing scenario below.
const TEST_DEPS = { deps: {
  codingPlanStatus: async () => { throw new Error('test: no quota fixture'); },
  pasteBurst: { flushMs: 0 },
  frameMs: 0,
} };

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** A writable that records everything the TUI paints. */
function fakeStdout() {
  const chunks = [];
  const out = new EventEmitter();
  Object.assign(out, { isTTY: true, columns: 80, rows: 24,
    write(s) { chunks.push(String(s)); return true; } });
  Object.defineProperty(out, 'text', { get: () => chunks.join('') });
  return out;
}

/** A readable the test can push keystrokes into, like a terminal would. */
function fakeStdin() {
  const s = new EventEmitter();
  s.setRawMode = () => {};
  s.resume = () => {};
  s.pause = () => {};
  s.setEncoding = () => {};
  s.type = (text) => s.emit('data', text);
  return s;
}

// Every host gets its own throwaway home so input-history persistence never
// reads or writes the developer's real ~/.zcode/cli/history.jsonl.
let homeSeq = 0;
function fakeHost(overrides = {}) {
  const submitted = [];
  // An override replaces submitPrompt entirely, so recording has to happen around
  // it — otherwise a test that overrides it silently observes nothing.
  const record = (fn) => async (input, options) => { submitted.push(input); return fn(input, options); };
  const stderr = new EventEmitter();
  const workflowSubscribers = new Set();
  const stoppedWorkflows = [];
  return {
    submitted, stoppedWorkflows, workflowSubscribers,
    emitWorkflowEvent: (event) => {
      for (const cb of [...workflowSubscribers]) { try { cb(event); } catch {} }
    },
    host: {
      initialMode: 'build', initialModel: 'zai/glm-5.3', initialThoughtLevel: 'max',
      loginRequired: false, locale: 'en-US', theme: 'dark', developerMode: false,
      version: '0.16.5', workspaceDirectory: '/w', workspaceGitBranch: 'main', noColor: true,
      effortOptions: [{ id: 'low', label: 'low' }, { id: 'max', label: 'max' }],
      modelOptions: [{ alias: 'main', id: 'zai/glm-5.3', name: 'GLM-5.3' }],
      // The real kernel's 20: the local unknown-command
      // reply trusts this list, so a stub missing /rewind would make real
      // commands look unknown.
      slashCommands: ['help', 'new', 'resume', 'fork', 'rewind', 'compact',
        'login', 'logout', 'locale', 'model', 'effort', 'mode', 'expert',
        'init', 'goal', 'skill', 'mcp', 'plugins', 'workflow', 'workflows']
        .map(name => ({ name, summary: `${name} (runtime)`, usage: `/${name}` })),
      stdin: fakeStdin(), stdout: fakeStdout(), stderr,
      home: mkdtempSync(path.join(os.tmpdir(), `ztui-home-${process.pid}-${homeSeq++}-`)),
      listWorkspacePathSuggestions: async ({ token }) =>
        ({ items: [{ kind: 'file', path: `src/${token}.mjs` }], truncated: false }),
      listMcpServers: async () => ({}),
      readClipboardImage: async () => null,
      writeClipboardText: async () => {},
      recallPreviousInput: async () => null,
      setMode: async (mode) => ({ mode }),
      // Vendored 3.11.2-24 host members (identical wrappers in
      // the installed 3.12.1 kernel): subscribe hands the callback the
      // in-memory event object and returns the unsubscribe; stop takes
      // {runId} and resolves to the rebuilt /workflows panel.
      subscribeWorkflowEvents: (cb) => {
        workflowSubscribers.add(cb);
        return () => { workflowSubscribers.delete(cb); };
      },
      stopWorkflow: async ({ runId } = {}) => {
        stoppedWorkflows.push(runId);
        return { title: '/workflows', selectedRunId: runId, runs: [] };
      },
      async submitPrompt(input, options) {
        submitted.push(input);
        options?.onEvent?.({ type: 'model_streaming', payload: { assistantMessageId: 'm', delta: '', kind: 'start' } });
        options?.onEvent?.({ type: 'model_streaming', payload: { assistantMessageId: 'm', delta: 'ack', kind: 'text_delta' } });
        options?.onEvent?.({ type: 'model_streaming', payload: { assistantMessageId: 'm', delta: '', done: true, kind: 'finish' } });
        return { response: 'ack', turnId: 't1', mode: 'build' };
      },
      ...overrides,
      ...(overrides.submitPrompt ? { submitPrompt: record(overrides.submitPrompt) } : {}),
    },
  };
}

// The 40 ms inter-step sleep equals the escape-flush delay in index.mjs: a step
// ENDING in a lone '\x1b' races the flush — use scenario() + longer sleeps there.
async function drive(steps, overrides) {
  const { host, submitted } = fakeHost(overrides);
  const done = runTui(host, TEST_DEPS);
  await sleep(40);
  for (const s of steps) { host.stdin.type(s); await sleep(40); }
  host.stdin.type('\x03'); await sleep(20); host.stdin.type('\x03');
  await Promise.race([done, sleep(600)]);
  return { submitted, screen: host.stdout.text };
}

// --- the regression that started this file ------------------------------------
{
  const { submitted, screen } = await drive(['hello world', '\r']);
  ok(submitted.length === 1, `enter submits the typed prompt (got ${submitted.length} submissions)`);
  ok(submitted[0] === 'hello world', `the prompt arrives verbatim (got ${JSON.stringify(submitted[0])})`);
  ok(/hello world/.test(screen), 'and is echoed into the transcript');
  ok(/ack/.test(screen), 'the streamed answer is rendered');
}

// --- multi-line input ----------------------------------------------------------
{
  const { submitted } = await drive(['one', '\x1b\r', 'two', '\r']);
  ok(submitted[0] === 'one\ntwo',
     `alt+enter inserts a newline instead of submitting (got ${JSON.stringify(submitted[0])})`);
}
{
  const { submitted } = await drive(['one', '\x1b[13;2u', 'two', '\r']);
  ok(submitted[0] === 'one\ntwo',
     `kitty shift+enter inserts a newline instead of submitting (got ${JSON.stringify(submitted[0])})`);
}

// --- IME commit: the composed text must land before Enter reads the buffer ----
// A terminal IME delivers the whole composition as a burst of code points with
// Enter right behind. The submit path reads ui.input.value synchronously and the
// burst collector flushes held text BEFORE honouring a trailing enter, so the
// "defer twice so the last char flushes" race seen in other harnesses cannot
// drop a char here.
{
  const { submitted } = await drive(['你好\r']);
  ok(submitted[0] === '你好', `a 2-char IME commit + fast enter submits the composed text (got ${JSON.stringify(submitted[0])})`);
}
{
  const { submitted } = await drive(['今天天气不错\r']);
  ok(submitted[0] === '今天天气不错', `a longer IME commit survives the burst collector intact (got ${JSON.stringify(submitted[0])})`);
}

// --- a bare enter submits nothing ----------------------------------------------
{
  const { submitted } = await drive(['\r', '   ', '\r']);
  ok(submitted.length === 0, 'empty and whitespace-only input is never submitted');
}

// --- the slash palette ---------------------------------------------------------
{
  const { screen, submitted } = await drive(['/mod', '\r']);
  ok(/\/model/.test(screen), 'typing /mod offers /model');
  ok(submitted.length === 0 || submitted[0] !== '/mod', 'enter accepts the completion rather than sending the fragment');
}

// --- the model picker on the kernel 3.12.x registry shape ----------------------
// Bundle 3.12.1 hands {ref:{providerId,modelId}, label, providerLabel} entries —
// no id/alias/name. Before modelOptionId, the picker opened empty and the
// kernel's own reply rendered "• undefined". The chooser must list the models.
{
  const { screen } = await drive(['/model', '\r'], {
    modelOptions: [
      { ref: { providerId: 'zai', modelId: 'glm-5.3' }, label: 'glm-5.3',
        providerLabel: 'Z.AI Coding Plan', contextWindow: 1000000,
        properties: { inputFormat: { supportsText: true } } },
      { ref: { providerId: 'zai', modelId: 'glm-5.3-flash' }, label: 'glm-5.3-flash',
        providerLabel: 'Z.AI Coding Plan', contextWindow: 1000000,
        properties: { inputFormat: { supportsText: true, supportsImage: true, supportsVideo: true } } },
    ],
  });
  ok(/glm-5\.3/.test(screen) && /glm-5\.3-flash/.test(screen),
    'the /model chooser lists registry-shaped options (screen tail: ' +
    JSON.stringify(screen.split('\n').filter(Boolean).slice(-2)) + ')');
  ok(/image|video/.test(screen), 'the registry inputFormat note is visible');
}

// --- queueing while a turn runs ------------------------------------------------
// The first turn is held open just long enough for the second Enter to land
// mid-turn, then released, so both submissions are observable.
{
  let release;
  const slow = new Promise(r => { release = r; });
  setTimeout(() => release(), 200);
  const { submitted } = await drive(['first', '\r', 'second', '\r'], {
    async submitPrompt(input, options) {
      if (input === 'first') await slow;
      options?.onEvent?.({ type: 'model_streaming', payload: { assistantMessageId: 'm', delta: 'x', kind: 'text_delta' } });
      return { response: 'x', turnId: 't' };
    },
  });
  ok(submitted.includes('first'), `the first prompt is submitted (got ${JSON.stringify(submitted)})`);
  ok(submitted.includes('second'), 'the prompt typed mid-turn is queued and then drained');
  ok(!submitted.includes(''), 'the queued prompt is never submitted as empty');
}

// --- ctrl+c exits without leaving the terminal in raw mode ---------------------
{
  const { screen } = await drive(['\x03']);
  ok(/press ctrl\+c again/.test(screen), 'a single ctrl+c warns instead of exiting');
  ok(screen.includes('\x1b[?2004l'), 'bracketed paste is turned back off on exit');
}

const tick = () => new Promise(r => setImmediate(r));
async function scenario(name, overrides, check, deps = {}) {
  const f = fakeHost(overrides);
  const { host, submitted } = f;
  const listeners = { term: process.listenerCount('SIGTERM'), hup: process.listenerCount('SIGHUP') };
  const done = runTui(host, { deps: { ...TEST_DEPS.deps, ...deps } });
  try {
    await check({ host, submitted, done, listeners,
      emitWorkflowEvent: f.emitWorkflowEvent, stoppedWorkflows: f.stoppedWorkflows,
      workflowSubscribers: f.workflowSubscribers });
    ok(true, name);
  } catch (error) { ok(false, `${name}: ${error.message}`); }
  finally { host.stdin.emit('end'); await done; }
}

await scenario('fragmented paste reaches the host only after explicit Enter, with newlines intact', {}, async ({ host, submitted }) => {
  host.stdin.type('\x1b[200~if True:\n');
  await tick();
  assert.deepEqual(submitted, []);
  host.stdin.type('    print(1)\nprint(2)\x1b[20');
  await tick();
  assert.deepEqual(submitted, []);
  host.stdin.type('1~');
  await tick();
  assert.deepEqual(submitted, []);
  host.stdin.type('\r');
  await tick();
  assert.deepEqual(submitted, ['if True:\n    print(1)\nprint(2)']);
});

{
  let release, activeOptions;
  const pending = new Promise(resolve => { release = resolve; });
  await scenario('exit aborts work, discards queued input, removes listeners, and ignores late events', {
    async submitPrompt(input, options) {
      activeOptions = options;
      if (input === 'first') await pending;
      return { turnId: 't1' };
    },
  }, async ({ host, submitted, done, listeners }) => {
    host.stdin.type('first\r');
    host.stdin.type('queued\r');
    host.stdin.type('/exit\r');
    await done;
    assert.equal(activeOptions.abortSignal.aborted, true);
    assert.equal(host.stdin.listenerCount('data'), 0);
    assert.equal(host.stdin.listenerCount('end'), 0);
    assert.equal(host.stdout.listenerCount('resize'), 0);
    assert.equal(process.listenerCount('SIGTERM'), listeners.term);
    assert.equal(process.listenerCount('SIGHUP'), listeners.hup);
    const screen = host.stdout.text;
    release();
    await tick();
    activeOptions.onEvent({ type: 'model_streaming', payload: { kind: 'text_delta', delta: 'late' } });
    host.stdin.type('another\r');
    host.stdout.emit('resize');
    assert.deepEqual(submitted, ['first']);
    assert.equal(host.stdout.text, screen);
  });
  release();
}

{
  let decision;
  await scenario('ending input denies a pending permission and does not repaint after shutdown', {
    async submitPrompt(input, options) {
      decision = await options.requestPermission({ toolName: 'Edit', options: [
        { kind: 'allow_once', response: { decision: 'allow' } },
        { kind: 'deny', response: { decision: 'deny' } },
      ] }, {});
      return { turnId: 't1' };
    },
  }, async ({ host, done }) => {
    host.stdin.type('edit\r');
    host.stdin.emit('end');
    await done;
    const screen = host.stdout.text;
    await tick();
    assert.deepEqual(decision, { decision: 'deny' });
    assert.equal(host.stdout.text, screen);
  });
}

// '/workflows' rather than '/help': /help is now a client command answered
// locally, so it would never reach submitPrompt and the assertion would test
// nothing. A kernel-only command still exercises the lookup race.
for (const replacement of ['hello', '/workflows']) {
  let resolveSuggestion;
  await scenario(`a late file suggestion cannot replace new input ${replacement}`, {
    listWorkspacePathSuggestions: ({ token }) => token === 'r'
      ? new Promise(resolve => { resolveSuggestion = resolve; }) : Promise.resolve({ items: [] }),
  }, async ({ host, submitted }) => {
    host.stdin.type('@r');
    host.stdin.type('\x15' + replacement);
    resolveSuggestion({ items: [{ kind: 'file', path: 'readme.md' }] });
    await tick();
    host.stdin.type('\r');
    await tick();
    assert.deepEqual(submitted, [replacement]);
  });
}

{
  let resolveSuggestion;
  await scenario('submitting invalidates the previous input file lookup', {
    listWorkspacePathSuggestions: ({ token }) => token === 'r'
      ? new Promise(resolve => { resolveSuggestion = resolve; }) : Promise.resolve({ items: [] }),
  }, async ({ host, submitted }) => {
    host.stdin.type('@r\r');
    await tick();
    resolveSuggestion({ items: [{ kind: 'file', path: 'readme.md' }] });
    await tick();
    host.stdin.type('next\r');
    await tick();
    assert.deepEqual(submitted, ['@r', 'next']);
  });
}

{
  await scenario('esc while idle pulls the last queued follow-up into the input', {
    async submitPrompt(input, options) {
      if (input === 'first') {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          options.abortSignal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
        });
      }
      return { turnId: 't1' };
    },
  }, async ({ host }) => {
    host.stdin.type('first\r');
    await tick();
    host.stdin.type('bring me back\r');
    await tick();
    host.stdin.type('\x1b');          // arms the interrupt — the turn keeps running
    await sleep(80);
    host.stdin.type('\x1b');          // the second esc interrupts
    await sleep(80);
    host.stdin.type('\x1b');          // NOW idle: esc pulls the queued follow-up
    await sleep(80);
    assert.match(host.stdout.text, /│ > bring me back/);
  });
}

// -- armed double-esc interrupt (parity with other harnesses) -------------------
// One stray Esc — a misread chord, a reflexive palette-dismiss — must not kill a
// turn. The first press arms and the status hint flips; only a second inside the
// window aborts.
const hungTurn = {
  async submitPrompt(input, options) {
    // turn_started marks state.turn.active — without it the status line renders
    // idle and the armed-interrupt hint has no surface to appear on.
    options?.onEvent?.({ type: 'turn_started', turnId: 't1', sessionId: 's1' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      options.abortSignal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    });
    return { turnId: 't1' };
  },
};

{
  await scenario('a single esc only arms the interrupt; the second inside the window aborts', hungTurn,
    async ({ host }) => {
      host.stdin.type('slow\r');
      await tick();
      host.stdin.type('\x1b');
      await sleep(80);
      assert.match(host.stdout.text, /esc again to interrupt/);
      assert.doesNotMatch(host.stdout.text, /interrupted/);
      host.stdin.type('\x1b');
      await sleep(80);
      assert.match(host.stdout.text, /interrupted/);
    });
}

{
  await scenario('the armed esc expires and the next esc re-arms instead of aborting', hungTurn,
    async ({ host }) => {
      host.stdin.type('slow\r');
      await tick();
      host.stdin.type('\x1b');            // arm
      await sleep(280);                   // past the 200 ms test window
      host.stdin.type('\x1b');            // re-arm, not abort
      await sleep(60);
      assert.doesNotMatch(host.stdout.text, /interrupted/);
      host.stdin.type('\x1b');            // inside the window: abort
      await sleep(80);
      assert.match(host.stdout.text, /interrupted/);
    }, { escInterruptMs: 200 });
}

{
  // A turn that never emitted turn_started has no status-line surface for the
  // armed hint — the press must still tell the user it armed (transcript notice).
  const silent = {
    async submitPrompt(input, options) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        options.abortSignal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
      return { turnId: 't1' };
    },
  };
  await scenario('an armed esc on a turn without turn_started still says so', silent,
    async ({ host }) => {
      host.stdin.type('slow\r');
      await tick();
      host.stdin.type('\x1b');
      await sleep(80);
      assert.match(host.stdout.text, /esc again to interrupt/);
      assert.doesNotMatch(host.stdout.text, /interrupted/);
    });
}

{
  // PTY-verified: on a no-model-access machine a
  // submitted prompt dead-screened — the kernel answers instantly through
  // `response` ({loginRequired:true, response:'Model not set, send /login to
  // login.'}) with NO turnId, and the slash-command-only print path dropped it.
  const noAccess = {
    loginRequired: true,
    async submitPrompt() {
      return { loginRequired: true, mode: 'build',
        response: 'Model not set, send /login to login.\nLocal commands still work: /help, /locale, /mode, and /login.' };
    },
  };
  await scenario('a prompt refused with loginRequired still prints the kernel answer', noAccess,
    async ({ host }) => {
      host.stdin.type('hi\r');
      await sleep(80);
      assert.match(host.stdout.text, /> hi/, 'the prompt echo should still render');
      assert.match(host.stdout.text, /Model not set, send \/login to login\./,
        'the no-turnId response text must reach the transcript');
    });
}

{
  // Same finding's other half: between submit and the kernel's first event the
  // status line painted as idle — no spinner, no phase — so a stalled turn was
  // indistinguishable from no turn at all. ui.busy now carries 'waiting'.
  const silent = {
    async submitPrompt(input, options) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        options.abortSignal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
      return { turnId: 't1' };
    },
  };
  await scenario('a pending turn shows the waiting status before turn_started lands', silent,
    async ({ host }) => {
      host.stdin.type('slow\r');
      await sleep(80);
      assert.match(host.stdout.text, /waiting/, 'busy-without-turn_started must paint the waiting phase');
      assert.match(host.stdout.text, /esc to interrupt/, 'and still name the way out');
      host.stdin.type('\x1b');
      await sleep(80);
      host.stdin.type('\x1b');
      await sleep(80);
      assert.match(host.stdout.text, /interrupted/, 'the armed esc must still abort the pending turn');
    });
}

{
  // Contextual hint bar: the persistent footer row teaches the keys that are
  // real right now — send/newline while idle, interrupt/exit while a turn runs —
  // and flips back when the turn ends. A hint naming a binding that does not
  // exist is a lie, so the swap is the whole feature.
  await scenario('the hint bar swaps editing keys for interrupt keys during a turn', hungTurn,
    async ({ host }) => {
      assert.match(host.stdout.text, /enter send · alt\+enter newline/, 'idle hint bar missing at boot');
      host.stdin.type('slow\r');
      await tick();
      assert.match(host.stdout.text, /esc to interrupt · ctrl\+c twice to exit/, 'busy hint bar missing');
      host.stdin.type('\x1b');          // arm — the bar names the confirming press
      await sleep(80);
      assert.match(host.stdout.text, /esc again to interrupt · ctrl\+c twice to exit/);
      host.stdin.type('\x1b');          // inside the window: interrupt
      await sleep(80);
      const after = host.stdout.text.slice(host.stdout.text.lastIndexOf('interrupted'));
      assert.match(after, /enter send · alt\+enter newline/, 'the idle hint never came back');
    });
}

{
  // Turn-status phases: the status line answers "working vs stuck" — the
  // spinner says 'waiting' until the first observable model output, then
  // 'responding' with the ⇣ received-bytes counter (parity with other harnesses).
  let stream;
  const phased = {
    async submitPrompt(input, options) {
      options?.onEvent?.({ type: 'turn_started', turnId: 't1', sessionId: 's1' });
      stream = (delta) => options?.onEvent?.(
        { type: 'model_streaming', payload: { assistantMessageId: 'm', delta, kind: 'text_delta' } });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        options.abortSignal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
      return { turnId: 't1' };
    },
  };
  await scenario('the status line flips waiting -> responding and counts received bytes', phased,
    async ({ host }) => {
      host.stdin.type('go\r');
      await sleep(80);
      assert.match(host.stdout.text, /waiting/);
      assert.doesNotMatch(host.stdout.text, /⇣/);
      stream('partial answer');
      await sleep(80);
      assert.match(host.stdout.text, /responding/);
      assert.match(host.stdout.text, /⇣14/);
    });
}

{
  let selected;
  await scenario('tab cycles permission options inside the card', {
    async submitPrompt(input, options) {
      const decision = await options.requestPermission({ toolName: 'Edit', options: [
        { optionId: 'allow_once', name: 'Allow once', response: { decision: 'allow' } },
        { optionId: 'deny', name: 'Deny', response: { decision: 'deny' } },
      ] }, {});
      selected = decision;
      return { turnId: 't1' };
    },
  }, async ({ host }) => {
    host.stdin.type('edit\r');
    await sleep(40);
    host.stdin.type('\t');
    await tick();
    host.stdin.type('\r');
    await sleep(40);
    assert.deepEqual(selected, { decision: 'deny' });
  });
}

{
  await scenario('ctrl+e toggles thinking and does not insert a character', {}, async ({ host, submitted }) => {
    host.stdin.type('\x05');
    await tick();
    host.stdin.type('hello\r');
    await tick();
    assert.deepEqual(submitted, ['hello']);
  });
}

{
  await scenario('shift+up jumps between user-prompt turns without rewriting them', {}, async ({ host, submitted }) => {
    host.stdin.type('first prompt\r');
    await sleep(40);
    host.stdin.type('second prompt\r');
    await sleep(40);
    host.stdin.type('\x1b[1;2A');
    await tick();
    host.stdin.type('\x1b[1;2A');
    await tick();
    assert.deepEqual(submitted, ['first prompt', 'second prompt']);
    assert.match(host.stdout.text, /1\/2/);
    assert.match(host.stdout.text, /first prompt/);
  });
}

// --- single-entry fold ---------------------------------------------------------
// h/l fold or expand EVERY foldable in the selected turn; collapseEntry/
// expandEntry existed per-entry but no key reached them. j/k walk the turn's
// foldables (vim-style, wrapping) and o toggles just the one under the cursor —
// the peek names it so a human can aim before pressing o.
const foldTurn = {
  async submitPrompt(input, options) {
    options?.onEvent?.({ type: 'tool_call_scheduled', payload: { toolCallId: 'c1', toolName: 'Read', input: { file_path: 'a.txt' } } });
    options?.onEvent?.({ type: 'tool_call_result', payload: { toolCallId: 'c1', duration: 12, result: { success: true, content: 'line one\nline two' } } });
    options?.onEvent?.({ type: 'model_streaming', payload: { assistantMessageId: 'm', delta: 'r1\nr2\nr3\nr4\nr5', kind: 'reasoning_delta' } });
    options?.onEvent?.({ type: 'model_streaming', payload: { assistantMessageId: 'm', delta: 'the answer', kind: 'text_delta' } });
    options?.onEvent?.({ type: 'model_streaming', payload: { assistantMessageId: 'm', delta: '', done: true, kind: 'finish' } });
    return { response: 'the answer', turnId: 't1', mode: 'build' };
  },
};

{
  await scenario('j/k walk a selected turn\'s foldables and o toggles just that one', foldTurn,
    async ({ host }) => {
      host.stdin.type('go\r');
      await sleep(80);
      host.stdin.type('\x1b[1;2A');
      await tick();
      assert.match(host.stdout.text, /fold 1\/2/, 'the peek shows the fold cursor on the first foldable');
      assert.match(host.stdout.text, /Read/, 'the foldable under the cursor is named');
      // The collapsed block commits header + count only; a mid-body line never
      // paints (the streaming live-tail shows body.at(-1) = r5, so r5 is not
      // discriminating on the cumulative byte stream — r4 is).
      assert.doesNotMatch(host.stdout.text, /r4/, 'the collapsed thinking body stays hidden');
      host.stdin.type('j');
      await tick();
      assert.match(host.stdout.text, /fold 2\/2/, 'j moves the cursor to the thinking entry');
      host.stdin.type('o');
      await sleep(60);
      assert.match(host.stdout.text, /r4/, 'o expanded only the selected thinking block');
      host.stdin.type('j');
      await tick();
      assert.match(host.stdout.text, /fold 1\/2/, 'j wraps around to the first foldable');
      host.stdin.type('k');
      await tick();
      assert.match(host.stdout.text, /fold 2\/2/, 'k wraps to the last foldable');
    });
}

{
  // A pasted/fast-typed run whose first chars are fold letters: the fold keys
  // eat the prefix before the burst detector fires, so the retro-capture must
  // restore those chars as input text — dropping them loses the paste's head.
  await scenario('a burst prefix eaten by fold keys is restored as input text', foldTurn,
    async ({ host }) => {
      host.stdin.type('go\r');
      await sleep(80);
      host.stdin.type('\x1b[1;2A');
      await tick();
      host.stdin.type('old notes');
      await sleep(80);
      assert.match(host.stdout.text, /> old notes/,
        'the pasted text reached the composer whole (fold keys must not eat its head)');
    });
}

{
  // A selected turn with NO foldables: the letters must still type, exactly the
  // fall-through h/l already have.
  await scenario('j/k/o still type when the selected turn has nothing to fold', {},
    async ({ host }) => {
      host.stdin.type('hi\r');
      await sleep(60);
      host.stdin.type('\x1b[1;2A');
      await tick();
      host.stdin.type('j');
      await tick();
      assert.match(host.stdout.text, /│ > j|> j/, 'j landed in the input when there was nothing to fold');
    });
}

// --- kernel `selection` results ------------------------------------------------
// /rewind, /fork, /resume, /login and /plugins answer with the kernel's picker
// payload {selection:{title, prompt, items:[{command, primary, ...}]}}. It was
// dropped, so those commands printed "Select a checkpoint" with no way to.
const REWIND_SELECTION = {
  title: 'Rewind To Checkpoint', prompt: 'Choose a checkpoint to rewind to.',
  emptyMessage: 'No workspace checkpoints are available yet.',
  items: [
    { id: 'cp1', command: '/rewind cp1', primary: 'message one', secondary: 'cp1', meta: '3 files' },
    { id: 'cp2', command: '/rewind cp2', primary: 'message two', secondary: 'cp2', meta: '1 file' },
  ],
  selectedIndex: 0,
};
const rewindHost = async (input) => input === '/rewind'
  ? { mode: 'build', response: 'Select a checkpoint to rewind.', selection: REWIND_SELECTION }
  : { mode: 'build', response: `ran ${input}` };

{
  await scenario('a selection result opens the chooser and enter submits the picked command', {
    submitPrompt: rewindHost,
  }, async ({ host, submitted }) => {
    host.stdin.type('/rewind\r');
    await sleep(60);
    assert.match(host.stdout.text, /Rewind To Checkpoint/);
    assert.match(host.stdout.text, /Choose a checkpoint/);
    assert.match(host.stdout.text, /message one/);
    host.stdin.type('\x1b[B');            // down
    await tick();
    host.stdin.type('\r');                // enter picks
    await sleep(60);
    assert.deepEqual(submitted, ['/rewind', '/rewind cp2']);
  });
}

{
  await scenario('a digit key picks the numbered selection item', {
    submitPrompt: rewindHost,
  }, async ({ host, submitted }) => {
    host.stdin.type('/rewind\r');
    await sleep(60);
    host.stdin.type('2');
    await sleep(60);
    assert.deepEqual(submitted, ['/rewind', '/rewind cp2']);
  });
}

{
  await scenario('escape closes the selection without submitting', {
    submitPrompt: rewindHost,
  }, async ({ host, submitted }) => {
    host.stdin.type('/rewind\r');
    await sleep(60);
    host.stdin.type('\x1b');
    await sleep(80);
    host.stdin.type('next\r');
    await sleep(60);
    assert.deepEqual(submitted, ['/rewind', 'next']);
  });
}

{
  await scenario('an empty selection prints its emptyMessage instead of trapping a dead modal', {
    async submitPrompt(input) {
      return input === '/resume'
        ? { mode: 'build', response: 'Select a session to resume.',
            selection: { ...REWIND_SELECTION, title: 'Resume Session', items: [] } }
        : { mode: 'build', response: `ran ${input}` };
    },
  }, async ({ host, submitted }) => {
    host.stdin.type('/resume\r');
    await sleep(60);
    assert.match(host.stdout.text, /No workspace checkpoints are available yet/);
    host.stdin.type('next\r');            // the modal must not eat later input
    await sleep(60);
    assert.deepEqual(submitted, ['/resume', 'next']);
  });
}

// --- client slash commands -----------------------------------------------------
// /exit, /status, /help and friends are zagent's, not the kernel's: they must
// run in-process and never touch submitPrompt. The banner must name zagent's own
// package version and the runtime's PRODUCT version — host.version (0.16.5) is
// the kernel's internal build string, and painting it as the runtime version
// was the bug. findRuntime() probes the real fs, so ZCODE_RUNTIME is pinned per
// case: the result must not depend on what this machine has installed.
{
  const savedRuntime = process.env.ZCODE_RUNTIME;
  const rtDir = mkdtempSync(path.join(os.tmpdir(), 'ztui-rt-'));
  try {
    // Nothing installed: the kernel string is shown, labelled as such.
    process.env.ZCODE_RUNTIME = path.join(rtDir, 'absent.cjs');
    await scenario('the banner reports zagent and the runtime separately', {}, async ({ host }) => {
      assert.match(host.stdout.text, /zagent \d+\.\d+\.\d+ · runtime kernel 0\.16\.5 · zai\/glm-5\.3/);
      assert.doesNotMatch(host.stdout.text, /zagent runtime 0\.16\.5/);
    });

    // A zcode-app-cli layout carries its own package.json — the fixture pattern
    // from packages/driver/test-runtime-xplat.mjs. That version is the truth.
    const cliBin = path.join(rtDir, 'node_modules', 'zcode-app-cli', 'bin');
    mkdirSync(cliBin, { recursive: true });
    writeFileSync(path.join(cliBin, 'zcode.js'), '');
    writeFileSync(path.join(cliBin, '..', 'package.json'), '{"version":"3.10.2-19"}');
    process.env.ZCODE_RUNTIME = path.join(cliBin, 'zcode.js');
    await scenario('the banner shows the driver-resolved product version', {}, async ({ host }) => {
      assert.match(host.stdout.text, /zagent \d+\.\d+\.\d+ · runtime explicit 3\.10\.2-19 · zai\/glm-5\.3/);
      assert.doesNotMatch(host.stdout.text, /runtime 0\.16\.5/);
    });

    // Found but not versioned: the kernel string is still shown — labelled.
    const lone = path.join(rtDir, 'lone-kernel.cjs');
    writeFileSync(lone, '');
    process.env.ZCODE_RUNTIME = lone;
    await scenario('the banner labels the kernel build when no product version resolves', {}, async ({ host }) => {
      assert.match(host.stdout.text, /zagent \d+\.\d+\.\d+ · runtime explicit \(kernel 0\.16\.5\) · zai\/glm-5\.3/);
    });
  } finally {
    if (savedRuntime === undefined) delete process.env.ZCODE_RUNTIME;
    else process.env.ZCODE_RUNTIME = savedRuntime;
    rmSync(rtDir, { recursive: true, force: true });
  }
}

{
  await scenario('/status runs locally and shows the honest version line', {}, async ({ host, submitted }) => {
    host.stdin.type('/status\r');
    await sleep(60);
    assert.deepEqual(submitted, []);                    // nothing reaches the kernel
    assert.match(host.stdout.text, /zagent \d+\.\d+\.\d+/);
    assert.match(host.stdout.text, /kernel build 0\.16\.5/);
    assert.match(host.stdout.text, /mode build/);
  });
}

{
  await scenario('/help renders the merged grouped list without a turn', {}, async ({ host, submitted }) => {
    host.stdin.type('/help\r');
    await sleep(60);
    assert.deepEqual(submitted, []);
    assert.match(host.stdout.text, /Session/);
    assert.match(host.stdout.text, /\/exit/);
    assert.match(host.stdout.text, /\/model/);          // kernel commands still listed
  });
}

{
  // Typing '/exi' opens the palette with /exit highlighted; Enter used to only
  // ACCEPT the candidate, so the command could never run. Now the exact match
  // falls through to dispatch and the TUI leaves.
  const { host, submitted } = fakeHost();
  const done = runTui(host, TEST_DEPS);
  await sleep(40);
  host.stdin.type('/exi');
  await sleep(60);
  assert.match(host.stdout.text, /\/exit/, 'the palette offers /exit while typing');
  host.stdin.type('t\r');
  await Promise.race([done, sleep(800)]);
  assert.deepEqual(submitted, []);
}

{
  // Same Enter path, through an ALIAS: '/q' filters /exit out of the popup —
  // ranking scores names, not aliases — so the palette shows /quit instead and
  // Enter used to complete to it rather than dispatch. The exact-match check
  // must see the full merged list, not the filtered rows.
  const { host, submitted } = fakeHost();
  const done = runTui(host, TEST_DEPS);
  await sleep(40);
  host.stdin.type('/q');
  await sleep(60);
  assert.match(host.stdout.text, /\/quit/, 'the palette narrows to /quit');
  host.stdin.type('\r');
  await Promise.race([done, sleep(800)]);
  assert.deepEqual(submitted, []);
}

{
  await scenario('/theme applies without reaching the kernel', {}, async ({ host, submitted }) => {
    host.stdin.type('/theme dark\r');
    await sleep(60);
    assert.deepEqual(submitted, []);
    assert.match(host.stdout.text, /theme: dark/);
  });
}

// --- workflow control surfaces ----------------------------------------------------
// Verified host contract: host.subscribeWorkflowEvents delivers the
// in-memory event object {kind, message?, nodeId?, payload?, phase?, runId,
// timestamp, type}; host.stopWorkflow({runId}) returns the rebuilt /workflows panel.
{
  await scenario('workflow lifecycle events are surfaced as notices', {}, async ({ host, workflowSubscribers, emitWorkflowEvent }) => {
    assert.equal(workflowSubscribers.size, 1);          // subscribed at startup
    emitWorkflowEvent({ type: 'run_started', runId: 'run-1', kind: 'goal', timestamp: '2026-09-15T00:00:00Z' });
    await sleep(60);
    assert.match(host.stdout.text, /workflow run-1.*started/);
    emitWorkflowEvent({ type: 'run_completed', runId: 'run-1', kind: 'goal', timestamp: '2026-09-15T00:00:01Z' });
    await sleep(60);
    assert.match(host.stdout.text, /workflow run-1.*completed/);
    // Non-lifecycle types (node_started, graph_updated, ...) update the tracker
    // silently — no transcript line per event.
    emitWorkflowEvent({ type: 'node_started', runId: 'run-1', kind: 'goal', nodeId: 'n1', timestamp: '2026-09-15T00:00:02Z' });
    await sleep(60);
    assert.doesNotMatch(host.stdout.text, /node_started/);
  });
}

{
  await scenario('the workflow subscription is released on exit', {}, async ({ host, workflowSubscribers, done }) => {
    assert.equal(workflowSubscribers.size, 1);
    host.stdin.emit('end');
    await done;
    assert.equal(workflowSubscribers.size, 0);
  });
}

{
  await scenario('/workflow stop <runId> calls the host and prints the rebuilt panel', {}, async ({ host, stoppedWorkflows, submitted }) => {
    host.stdin.type('/workflow stop run-9\r');
    await sleep(60);
    assert.deepEqual(stoppedWorkflows, ['run-9']);
    assert.match(host.stdout.text, /\/workflows/);
    // stop is a client command: nothing may reach the runtime's submitPrompt.
    assert.deepEqual(submitted, []);
  });
}

{
  await scenario('a forwarded /workflow is recorded once and echoed once', {}, async ({ host, submitted }) => {
    // subscribeWorkflowEvents exists on this fake host; that must not change
    // where a plain kernel command goes.
    host.stdin.type('seed one\r');
    await sleep(60);
    host.stdin.type('/workflow nightly\r');
    await sleep(60);
    assert.deepEqual(submitted, ['seed one', '/workflow nightly']);
    // The client dispatch already echoed + recorded the typed line; the forward
    // must not record it again. Two recalls walk past it to 'seed one' — a
    // duplicate history entry would surface '/workflow nightly' twice instead.
    host.stdin.type('\x1b[A');
    await tick();
    host.stdin.type('\x1b[A');
    await tick();
    assert.match(host.stdout.text, /│ > seed one/);
  });
}

{
  await scenario('a host without the workflow members still runs', {
    subscribeWorkflowEvents: undefined, stopWorkflow: undefined,
  }, async ({ host, submitted }) => {
    host.stdin.type('hello\r');
    await sleep(60);
    assert.deepEqual(submitted, ['hello']);
    host.stdin.type('/workflow stop run-1\r');
    await sleep(60);
    assert.match(host.stdout.text, /not available/i);
  });
}

// --- meta chords ---------------------------------------------------------------
// ESC + a printable key in one read is alt+key, not the Escape key. Decoded as
// escape+text it both cleared/interrupted AND injected the letter (the orphan
// alt+letter finding).
{
  const { submitted } = await drive(['ab', '\x1bx', '\r']);
  ok(submitted[0] === 'ab',
     `alt+x is swallowed as a chord — it does not inject 'x' or fire Escape (got ${JSON.stringify(submitted)})`);
}

// --- zh-CN reaches the permission prompt ----------------------------------------
// theme.str was never attached, so a zh-CN host still saw the English card —
// the orphaned zh-CN strings finding.
await scenario('a zh-CN host sees a localized permission prompt', {
  locale: 'zh-CN',
  async submitPrompt(input, options) {
    void options.requestPermission({ toolName: 'Bash', input: 'ls', options: [
      { kind: 'allow_once', name: 'Allow once', response: { decision: 'allow' } },
      { kind: 'deny', name: 'Deny', response: { decision: 'deny' } },
    ] }, {});
    return { turnId: 't1' };
  },
}, async ({ host }) => {
  host.stdin.type('x\r');
  await sleep(60);
  const screen = host.stdout.text;
  assert.ok(screen.includes('需要授权'), 'permission title localized to zh-CN');
  assert.ok(screen.includes('拒绝'), 'permission hint localized to zh-CN');
});

// --- hardware cursor parks inside the input box ---------------------------------
// The last write of every draw ends with the park sequence: at width 80 the
// footer is box(3)+status(1)+hint(1), the cursor row is the first text row, and
// the text lead is 4 cells — so 'ab' ends at column 7.
{
  await scenario('typing parks the hardware cursor inside the input box', {}, async ({ host }) => {
    host.stdin.type('ab');
    await tick();
    assert.match(host.stdout.text, /(?:\x1b\[\d+[AB])?\x1b\[7G\x1b\[\?2026l$/, 'cursor parks after the typed text, inside the sync region');
    host.stdin.type('\x1b[D');                        // left
    await tick();
    assert.match(host.stdout.text, /(?:\x1b\[\d+[AB])?\x1b\[6G\x1b\[\?2026l$/, 'moving left moves the parked cursor');
  });
}

// --- a large paste collapses to a chip ----------------------------------------
// Other harnesses keep a `[Pasted ~N lines]` token in the composer; the runtime
// still receives the full text. Flooding the box with the payload is the bug.
{
  const pasted = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const { submitted, screen } = await drive(['\x1b[200~' + pasted + '\x1b[201~', '\r']);
  ok(submitted.length === 1 && submitted[0] === pasted,
     'the chip expands to the full paste on submit');
  ok(screen.includes('[Pasted ~20 lines]'), 'the composer shows the chip');
  ok(!/line 19/.test(screen), 'the pasted body never floods the screen');
  ok(/ack/.test(screen), 'the turn still answers');
}
{
  // A chip is one composer object: one backspace removes all of it — editing it
  // into a broken literal is how placeholder text leaks into prompts.
  const pasted = 'x'.repeat(400);
  const { submitted } = await drive(['\x1b[200~' + pasted + '\x1b[201~', '\x7f', 'sent', '\r']);
  ok(submitted[0] === 'sent', `one backspace deletes the whole chip (got ${JSON.stringify(submitted[0])})`);
}
{
  const { submitted } = await drive(['\x1b[200~short text\x1b[201~', '\r']);
  ok(submitted[0] === 'short text', 'a small paste stays literal text');
}
{
  const { submitted } = await drive(['[Pasted ~3 lines]', '\r']);
  ok(submitted[0] === '[Pasted ~3 lines]',
     'a chip token the user typed is not expanded');
}
{
  // A chip queued mid-turn keeps its payload even when the buffer is edited
  // afterwards — the chips leave the composer WITH the message.
  const pasted = Array.from({ length: 6 }, (_, i) => `queued line ${i}`).join('\n');
  let release;
  const slow = new Promise(r => { release = r; });
  setTimeout(() => release(), 300);
  const { submitted } = await drive(
    ['first', '\r', '\x1b[200~' + pasted + '\x1b[201~', '\r', 'noise', '\x15', 'more'],
    {
      async submitPrompt(input, options) {
        if (input === 'first') await slow;
        options?.onEvent?.({ type: 'model_streaming', payload: { assistantMessageId: 'm', delta: 'x', kind: 'text_delta' } });
        return { response: 'x', turnId: 't' };
      },
    });
  ok(submitted[1] === pasted,
     `a queued chip still expands on drain (got ${JSON.stringify(submitted[1])?.slice(0, 80)})`);
}
{
  // ...and recalled history re-attaches the chip: up-arrow shows the token and
  // resubmits the payload, never the literal placeholder.
  const pasted = 'z'.repeat(300);
  const { submitted } = await drive(
    ['\x1b[200~' + pasted + '\x1b[201~', '\r', '\x1b[A', '\r']);
  ok(submitted.length === 2 && submitted[1] === pasted,
     'history recall of a chipped message resubmits the full paste');
}
{
  // /workflow forwards its args verbatim to the runtime — the typed line's
  // chips must travel with the forward, not die with the client dispatch.
  const pasted = 'w'.repeat(300);
  const { submitted } = await drive(
    ['/workflow x ', '\x1b[200~' + pasted + '\x1b[201~', '\r']);
  ok(submitted.length === 1 && submitted[0] === `/workflow x ${pasted}`,
     `a forwarded client command expands its chips (got ${JSON.stringify(submitted[0])?.slice(0, 60)})`);
}
{
  // ctrl-u over a chip removes the whole chip — never a broken literal
  // fragment — and conservatively leaves the rest of the line.
  const pasted = 'a\nb\nc\nd';
  const { submitted } = await drive(['pre ', '\x1b[200~' + pasted + '\x1b[201~', '\x15', 'kept', '\r']);
  ok(submitted[0] === 'pre kept', `ctrl-u removed the chip atomically (got ${JSON.stringify(submitted[0])})`);
}
{
  // A chip is atomic for the cursor too: left-arrow skips the whole token, so
  // the typed char lands on the chip's left edge instead of splitting it.
  const pasted = 'q'.repeat(300);
  const { submitted } = await drive(['pre ', '\x1b[200~' + pasted + '\x1b[201~', '\x1b[D', 'x', '\r']);
  ok(submitted[0] === `pre x${pasted}`,
     `an arrow cannot park inside a chip (got ${JSON.stringify(submitted[0])?.slice(0, 60)})`);
}
// right-arrow is the symmetric skip — but a submit-only oracle cannot see it:
// the pre-key parked guard would snap a mid-chip cursor to the same right edge
// before the next insert. The parked hardware cursor pins where the key RESTED
// (col 28 = past the 23-cell buffer, not col 10 inside the token).
await scenario('right-arrow skips a chip atomically', {}, async ({ host, submitted }) => {
  const pasted = 'r'.repeat(300);
  host.stdin.type('pre ');
  host.stdin.type('\x1b[200~' + pasted + '\x1b[201~');
  await tick();
  host.stdin.type('\x1b[D');   // left snaps to the chip's left edge (col 9)
  await tick();
  assert.match(host.stdout.text, /(?:\x1b\[\d+[AB])?\x1b\[9G\x1b\[\?2026l$/,
    'left-arrow rests at the chip edge — without the snap it parks mid-token (col 27)');
  host.stdin.type('\x1b[C');   // right must snap back past the whole token
  await tick();
  assert.match(host.stdout.text, /(?:\x1b\[\d+[AB])?\x1b\[28G\x1b\[\?2026l$/,
    'right-arrow rests the cursor past the chip, never inside it');
  host.stdin.type('x\r');
  await tick();
  assert.equal(submitted[0], `pre ${pasted}x`);
});
{
  // Home jumps to the line start — before 'pre ', so the typed char must not
  // disturb the chip token: it still expands on submit.
  const pasted = 'h'.repeat(300);
  const { submitted } = await drive(['pre ', '\x1b[200~' + pasted + '\x1b[201~', '\x1b[H', 'x', '\r']);
  ok(submitted[0] === `xpre ${pasted}`,
     `home cannot park inside a chip (got ${JSON.stringify(submitted[0])?.slice(0, 60)})`);
}
{
  // End jumps to the line end — past the chip — so the typed char lands after
  // the whole token, which still expands on submit.
  const pasted = 'e'.repeat(300);
  const { submitted } = await drive(['pre ', '\x1b[200~' + pasted + '\x1b[201~', '\x1b[D', '\x1b[F', 'x', '\r']);
  ok(submitted[0] === `pre ${pasted}x`,
     `end cannot park inside a chip (got ${JSON.stringify(submitted[0])?.slice(0, 60)})`);
}

// --- paste-burst suppression ---------------------------------------------------
// A terminal without bracketed paste delivers a paste as a char flood; its
// newlines decode as 'enter' and would submit each line on its own. The burst
// collector buffers the flood instead (deps flushMs 0 = flush at emit end).
await scenario('an unbracketed multi-line paste lands as one draft, never one prompt per line', {},
  async ({ host, submitted }) => {
    host.stdin.type('line one\nline two\nline three');
    await tick();
    assert.deepEqual(submitted, [], 'a mid-flood newline must not submit');
    assert.match(host.stdout.text, /\[Pasted ~3 lines\]/, 'the flood lands as a chip');
    host.stdin.type('\r');
    await tick();
    assert.deepEqual(submitted, ['line one\nline two\nline three'],
      'a real Enter sends the whole paste as one prompt');
  });
await scenario('a pasted line ending in Enter submits once, atomically', {}, async ({ host, submitted }) => {
  host.stdin.type('do the thing\r');
  await tick();
  assert.deepEqual(submitted, ['do the thing'],
    `the trailing Enter submits the single-line paste once (got ${JSON.stringify(submitted)})`);
});
await scenario('a pasted multi-line payload ending in Enter still waits for review', {},
  async ({ host, submitted }) => {
    host.stdin.type('alpha\nbeta\n');
    await tick();
    assert.deepEqual(submitted, [], 'multi-line pastes never auto-submit');
  });
await scenario('a keystroke mid-flood flushes the paste before it is handled', {},
  async ({ host, submitted }) => {
    host.stdin.type('abc\x1b[D\r');        // left-arrow ends the burst, enter submits
    await tick();
    assert.deepEqual(submitted, ['abc'],
      `the flood flushes intact before the named key runs (got ${JSON.stringify(submitted)})`);
  });
await scenario('an unbracketed paste with CRLF endings keeps single line breaks', {},
  async ({ host, submitted }) => {
    host.stdin.type('one\r\ntwo');         // Windows clipboard: \r\n is ONE break
    await tick();
    assert.deepEqual(submitted, []);
    host.stdin.type('\r');
    await tick();
    assert.deepEqual(submitted, ['one\ntwo'],
      `CRLF must not double into blank lines (got ${JSON.stringify(submitted)})`);
  });

// --- persistent input history --------------------------------------------------
{
  // A fresh session's up-arrow finds what the LAST session submitted — the file
  // under <home>/.zcode/cli/history.jsonl is the memory the runtime never gave us.
  const home = mkdtempSync(path.join(os.tmpdir(), 'ztui-hist-'));
  try {
    await drive(['first session prompt', '\r'], { home });
    const { submitted } = await drive(['\x1b[A', '\r'], { home });
    ok(submitted[0] === 'first session prompt',
       `up-arrow in a new session recalls last session's input (got ${JSON.stringify(submitted[0])})`);
  } finally { rmSync(home, { recursive: true, force: true }); }
}
{
  // Draft stash: typing a draft, recalling, then down-arrow must restore the
  // draft — not the empty box it replaced.
  const { submitted } = await drive(['earlier', '\r', 'my half-typed draft', '\x1b[A', '\x1b[B', '\r']);
  ok(submitted[1] === 'my half-typed draft',
     `down past the newest entry restores the stashed draft (got ${JSON.stringify(submitted[1])})`);
}
{
  // ctrl-u on a real draft records it first: up-arrow brings the wiped text back.
  const { submitted } = await drive(['a draft long enough to keep around', '\x15', '\x1b[A', '\r']);
  ok(submitted[0] === 'a draft long enough to keep around',
     `ctrl-u'd draft is retrievable via history (got ${JSON.stringify(submitted[0])})`);
}
{
  // Inside a multi-line draft, up moves the cursor to the previous line instead
  // of recalling history over the draft. Submit must carry both lines.
  const { submitted } = await drive(['previous', '\r', 'line1', '\x1b\r', 'line2', '\x1b[A', 'X', '\r']);
  ok(submitted[1] === 'line1X\nline2',
     `up inside a multi-line draft moves the cursor up a line (got ${JSON.stringify(submitted[1])})`);
}
{
  // Stale host-recall depth must not eat a draft: up,up recalls host-2, enter
  // submits it (resetting recallDepth), then a typed draft + up + down must
  // return the draft — not an empty box.
  const recallPreviousInput = async (d) => (d >= 1 && d <= 2 ? `host-entry-${d}` : null);
  const { submitted } = await drive(
    ['\x1b[A', '\x1b[A', '\r', 'typed draft', '\x1b[A', '\x1b[B', '\r'],
    { recallPreviousInput });
  ok(submitted[0] === 'host-entry-2',
     `host recall submitted the recalled entry (got ${JSON.stringify(submitted[0])})`);
  ok(submitted[1] === 'typed draft',
     `the draft survives recall navigation after a host-recalled submit (got ${JSON.stringify(submitted[1])})`);
}

// --- /login: kernel selection + in-band OAuth + masked API-key entry -----------
// The kernel answers a bare /login with {response, selection}; picking an OAuth
// item submits its command and host.login() announces the authorize URL as an
// assistant_message event; api-key items carry an `input` spec for a masked
// prompt. The URL used to be dropped (event unhandled) and the key item ran the
// bare command into a usage error — /login was uncompletable.
const LOGIN_SELECTION = {
  title: 'Set Up Coding Plan',
  prompt: 'Choose a login or API key setup method.',
  items: [
    { command: '/login zai-coding-plan', id: 'zai-coding-plan',
      primary: 'Z.AI Coding Plan', secondary: 'Open browser login and create a Coding Plan API key.',
      pending: { status: 'Waiting for browser authorization...', cancelStatus: 'Login cancelled. Choose a setup method.' } },
    { command: '/login zai-coding-plan-api-key', id: 'zai-coding-plan-api-key',
      primary: 'Z.AI Coding Plan API Key', secondary: 'Paste a Coding Plan API key manually.',
      input: { mask: true, primary: 'Enter Z.AI Coding Plan API Key',
        secondary: 'Paste the key here. It is hidden while typing.', placeholder: 'Paste API key',
        help: 'Enter saves the key. Esc returns to setup choices.',
        status: 'Enter the API key, then press Enter.', submitStatus: 'Saving API key...',
        emptyStatus: 'API key is required.', cancelStatus: 'API key entry cancelled. Choose a setup method.' } },
  ],
};

{
  const { screen } = await drive(['/login', '\r'], {
    async submitPrompt(input) {
      if (input === '/login') {
        return { response: 'Choose how to set up a Coding Plan provider.', selection: LOGIN_SELECTION };
      }
      return { response: 'ack' };
    },
  });
  ok(/Set Up Coding Plan/.test(screen), '/login opens the kernel selection — its title is painted');
  ok(/Z\.AI Coding Plan API Key/.test(screen), 'the api-key option is listed');
}

{
  const { submitted, screen } = await drive(['/login', '\r', '\r'], {
    async submitPrompt(input, options) {
      if (input === '/login') {
        return { response: 'Choose how to set up a Coding Plan provider.', selection: LOGIN_SELECTION };
      }
      if (input === '/login zai-coding-plan') {
        options?.onEvent?.({ type: 'assistant_message', id: 'local-login-authorize-1',
          sessionId: 'local-login', traceId: 'local-login',
          payload: { content: 'Open this URL to sign in with Z.AI:\n\nhttps://example.test/auth\n\nAfter authorization, return here and I will finish the login automatically.' } });
        return { response: 'Configured Z.AI Coding Plan as tester.', loginRequired: false };
      }
      return { response: 'ack' };
    },
  });
  ok(submitted.includes('/login zai-coding-plan'), 'picking the OAuth item submits its kernel command verbatim');
  ok(/https:\/\/example\.test\/auth/.test(screen), 'the authorize URL paints while login polls');
  ok(/Configured Z\.AI Coding Plan/.test(screen), 'the login result prints as command output');
  ok(/Waiting for browser authorization/.test(screen), 'the pending status names what the spinner waits on');
}

{
  // down to the api-key item, enter opens the masked prompt, type the key, enter
  // submits the full command. Then up-arrow must NOT recall the secret.
  const { submitted, screen } = await drive(
    ['/login', '\r', '\x1b[B', '\r', 'my-secret-key', '\r', '\x1b[A'], {
      async submitPrompt(input) {
        if (input === '/login') {
          return { response: 'Choose how to set up a Coding Plan provider.', selection: LOGIN_SELECTION };
        }
        return { response: 'ack' };
      },
    });
  ok(submitted.includes('/login zai-coding-plan-api-key my-secret-key'),
     'the masked prompt submits command + key to the runtime');
  ok(!/my-secret-key/.test(screen),
     'the key is never painted — not in the masked prompt, the echo, or history recall');
  ok(/\[redacted\]/.test(screen), 'the transcript echo shows [redacted]');
}

{
  // A directly typed api-key command masks in the input box, echoes [redacted],
  // and stays out of the recall history (the kernel skips it too).
  const { submitted, screen } = await drive(
    ['/login bigmodel-coding-plan-api-key typed-secret', '\r', '\x1b[A'], {});
  ok(submitted[0] === '/login bigmodel-coding-plan-api-key typed-secret',
     'a typed api-key command reaches the runtime verbatim');
  ok(!/typed-secret/.test(screen), 'a typed api-key is masked while typing and redacted after');
}

{
  // The unknown-command gate records history + echoes verbatim — a typed
  // api-key command must bypass it even when the host never advertised /login.
  const { submitted, screen } = await drive(
    ['/login zai-coding-plan-api-key gated-secret', '\r', '\x1b[A'],
    { slashCommands: [{ name: 'help' }] });   // no 'login' in the kernel list
  ok(submitted.includes('/login zai-coding-plan-api-key gated-secret'),
     'the api-key command still reaches the runtime when /login is unadvertised');
  ok(!/gated-secret/.test(screen), 'the gate never sees the key: no echo, no history, no recall');
}

{
  // Persistent history lives at ~/.zcode/cli/history.jsonl. A secret command
  // skipped the in-memory push already — it must skip the disk write too, or
  // the key sits plaintext in a file forever.
  const home = mkdtempSync(path.join(os.tmpdir(), 'ztui-secret-hist-'));
  try {
    const { submitted } = await drive(
      ['/login zai-coding-plan-api-key disk-secret', '\r'], { home });
    ok(submitted.includes('/login zai-coding-plan-api-key disk-secret'),
       'the api-key command reaches the runtime with persistent history on');
    const file = path.join(home, '.zcode', 'cli', 'history.jsonl');
    let raw = '';
    try { raw = readFileSync(file, 'utf8'); } catch { /* no file is also clean */ }
    ok(!/disk-secret/.test(raw), 'history.jsonl on disk holds no api-key');
    // ctrl-u on a half-typed secret must not resurrect it through the
    // doomed-draft recording either.
    const { screen } = await drive(
      ['/login zai-coding-plan-api-key wiped-secret', '\x15', '\x1b[A'], { home });
    let raw2 = '';
    try { raw2 = readFileSync(file, 'utf8'); } catch { /* still no file */ }
    ok(!/wiped-secret/.test(raw2) && !/wiped-secret/.test(screen),
       'ctrl-u on a secret draft records nothing — not to memory, disk, or screen');
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// Esc out of the api-key prompt returns to the selection — the kernel's own
// help text promises "returns to setup choices". A lone '\x1b' races the
// 40 ms escape flush in drive(), so this one uses scenario() with real sleeps.
await scenario('esc from the api-key prompt returns to the login chooser', {
  async submitPrompt(input) {
    if (input === '/login') return { response: 'x', selection: LOGIN_SELECTION };
    return { response: 'ack' };
  },
}, async ({ host, submitted }) => {
  host.stdin.type('/login'); await sleep(40);
  host.stdin.type('\r'); await sleep(60);        // submit → chooser opens
  host.stdin.type('\x1b[B'); await sleep(40);    // down to the api-key item
  host.stdin.type('\r'); await sleep(40);        // pick → masked prompt
  assert.match(host.stdout.text, /Paste API key/, 'the input-spec prompt opened');
  host.stdin.type('\x1b'); await sleep(80);      // bare esc — past the flush window
  assert.match(host.stdout.text, /API key entry cancelled/, 'esc shows the cancel status');
  assert.match(host.stdout.text, /Set Up Coding Plan/, 'esc reopened the chooser');
  host.stdin.type('\r'); await sleep(60);        // enter on item 1 → OAuth submit
  assert.ok(submitted.includes('/login zai-coding-plan'), 'the reopened chooser still picks');
});

// --- the frame coalescer turns a burst of draws into one paint --------------
// Each paint writes exactly one ?2026 sync-open marker. A same-tick burst of
// keystrokes must produce at most two paints — the first while the window was
// idle, one coalesced — never one per event.
{
  const frames = (text) => (text.match(/\x1b\[\?2026h/g) ?? []).length;
  await scenario('a same-tick burst of draws collapses into one coalesced paint', {}, async ({ host }) => {
    await sleep(450);                                   // idle: comfortably past the boot frame window
    const before = frames(host.stdout.text);
    host.stdin.type('a'); host.stdin.type('b'); host.stdin.type('c');
    await tick();
    assert.equal(frames(host.stdout.text), before + 1, 'the burst holds after one paint');
    assert.ok(!host.stdout.text.includes('abc'), 'the coalesced frame has not landed yet');
    await sleep(250);                                   // > frameMs: the held frame fires
    assert.ok(host.stdout.text.includes('abc'), 'the coalesced paint renders the latest state');
    assert.ok(frames(host.stdout.text) <= before + 2, 'three draws cost at most two paints');
  }, { frameMs: 150 });
}

// --- exit summary: sessions are resumable objects ----------------------------
// The way out names the session that just ended — its kernel title when one
// arrived — and hands back both ways in (`-c` for the latest session in this
// directory, `--resume <id>` for this one exactly).
await scenario('leaving names the session and both ways back in', {
  async submitPrompt(input, options) {
    options?.onEvent?.({ type: 'turn_started', turnId: 't1', sessionId: 'sess_rt1' });
    options?.onEvent?.({ type: 'model_streaming', sessionId: 'sess_rt1', payload: { assistantMessageId: 'm', delta: 'ok', kind: 'text_delta' } });
    options?.onEvent?.({ type: 'model_streaming', sessionId: 'sess_rt1', payload: { assistantMessageId: 'm', delta: '', done: true, kind: 'finish' } });
    // A kernel title is model-generated text — quotes fold and control bytes
    // must never reach the terminal through the summary line.
    options?.onEvent?.({ type: 'session_title_updated', sessionId: 'sess_rt1', payload: { title: 'Greeting "quoted" \x1b[?1049hturn' } });
    return { response: 'ok', turnId: 't1', mode: 'build' };
  },
}, async ({ host, done }) => {
  host.stdin.type('hi\r');
  await sleep(60);
  host.stdin.emit('end');                      // a graceful end, like a closed pipe
  await done;
  assert.match(host.stdout.text, /session "Greeting 'quoted'/, 'the exit summary does not name the titled session (quotes folded)');
  assert.match(host.stdout.text, /turn" \(sess_rt1\)/, 'the exit summary drops the session id');
  assert.match(host.stdout.text, /zagent --resume sess_rt1/, 'no --resume hint naming this session id');
  assert.match(host.stdout.text, /zagent -c/, 'no -c continue hint on exit');
  assert.doesNotMatch(host.stdout.text, /\x1b\[\?1049h/, 'a poisoned title smuggled an escape into the summary');
});

// With no session started there is nothing to resume — the hint must not lie.
await scenario('no session started means no resume hint on the way out', {}, async ({ host, done }) => {
  host.stdin.emit('end');
  await done;
  assert.doesNotMatch(host.stdout.text, /zagent --resume|zagent -c/, 'a resume hint appeared with nothing to resume');
});

// --- config-gated block timestamps --------------------------------------------
// ~/.zcode/cli/config.json {tui:{timestamps:true}} opts each transcript block
// into a right-aligned HH:MM; the same run without it stamps nothing.
{
  const home = mkdtempSync(path.join(os.tmpdir(), 'ztui-ts-'));
  try {
    mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
    writeFileSync(path.join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({ tui: { timestamps: true } }));
    const { screen } = await drive(['stamp me', '\r'], { home });
    ok(/> stamp me {2,}\d{2}:\d{2}/.test(screen),
       'the configured stamp lands right-aligned on the echoed prompt line');
  } finally { rmSync(home, { recursive: true, force: true }); }

  const { screen: unstamped } = await drive(['nostamp', '\r']);
  ok(!/> nostamp {2,}\d{2}:\d{2}/.test(unstamped), 'no stamp when the config is absent');
}

// --- diff surface: an edit call paints its recorded patch ---------------------
// The runtime drops call_<id>-tool-result-*.json under <home>/.zcode/cli/
// artifacts/<sessionId>/ when a file-changing tool resolves; the row renders
// those +/- rows instead of the "updated successfully" prose. A call with no
// artifact keeps its prose.
await scenario('a file-changing tool call renders the recorded diff', {
  async submitPrompt(input, options) {
    const sid = 'sess_diff1';
    options?.onEvent?.({ type: 'turn_started', turnId: 't1', sessionId: sid });
    options?.onEvent?.({ type: 'model_request', sessionId: sid, payload: { querySource: 'main_turn' } });
    options?.onEvent?.({ type: 'tool_call_scheduled', sessionId: sid,
      payload: { toolCallId: 'e1', toolName: 'Edit', input: { file_path: 'a.js' } } });
    options?.onEvent?.({ type: 'tool_call_started', sessionId: sid, payload: { toolCallId: 'e1' } });
    options?.onEvent?.({ type: 'tool_call_result', sessionId: sid,
      payload: { toolCallId: 'e1', duration: 7, result: { success: true, content: 'The file a.js has been updated successfully.' } } });
    options?.onEvent?.({ type: 'tool_call_scheduled', sessionId: sid,
      payload: { toolCallId: 'e2', toolName: 'Bash', input: { command: 'ls' } } });
    options?.onEvent?.({ type: 'tool_call_result', sessionId: sid,
      payload: { toolCallId: 'e2', duration: 3, result: { success: true, content: 'plain output here' } } });
    options?.onEvent?.({ type: 'model_streaming', sessionId: sid, payload: { assistantMessageId: 'm', delta: 'done', kind: 'text_delta' } });
    options?.onEvent?.({ type: 'model_streaming', sessionId: sid, payload: { assistantMessageId: 'm', delta: '', done: true, kind: 'finish' } });
    return { response: 'done', turnId: 't1', mode: 'build' };
  },
}, async ({ host }) => {
  const dir = path.join(host.home, '.zcode', 'cli', 'artifacts', 'sess_diff1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'call_e1-tool-result-1.json'), JSON.stringify({
    version: 1, kind: 'workspace_file_before_change', toolCallId: 'e1', toolName: 'Edit',
    createdAt: '2026-09-17T00:00:00.000Z',
    files: [{ path: 'a.js', existedBefore: true, beforeContent: 'const b = 2;\n',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
        lines: ['-const b = 2;', '+const b = 3;'] }] }],
  }));
  host.stdin.type('change it\r');
  await sleep(60);
  const text = host.stdout.text;
  assert.match(text, /\+const b = 3;/, 'the recorded + row renders under the Edit call');
  assert.match(text, /-const b = 2;/, 'the recorded - row renders under the Edit call');
  assert.doesNotMatch(text, /updated successfully/, 'the prose is replaced by the patch');
  assert.match(text, /plain output here/, 'a call without an artifact keeps its result body');
});

// The artifact can land a tick AFTER the result event — the bounded retry
// (150 ms / 500 ms, past the 300 ms read memo) must still attach the patch.
await scenario('a late-landing change artifact still paints the diff', {
  async submitPrompt(input, options) {
    const sid = 'sess_diff2';
    options?.onEvent?.({ type: 'turn_started', turnId: 't1', sessionId: sid });
    options?.onEvent?.({ type: 'model_request', sessionId: sid, payload: { querySource: 'main_turn' } });
    options?.onEvent?.({ type: 'tool_call_scheduled', sessionId: sid,
      payload: { toolCallId: 'e1', toolName: 'Edit', input: { file_path: 'b.py' } } });
    options?.onEvent?.({ type: 'tool_call_result', sessionId: sid,
      payload: { toolCallId: 'e1', duration: 4, result: { success: true, content: 'updated' } } });
    options?.onEvent?.({ type: 'model_streaming', sessionId: sid, payload: { assistantMessageId: 'm', delta: 'done', kind: 'text_delta' } });
    options?.onEvent?.({ type: 'model_streaming', sessionId: sid, payload: { assistantMessageId: 'm', delta: '', done: true, kind: 'finish' } });
    return { response: 'done', turnId: 't1', mode: 'build' };
  },
}, async ({ host }) => {
  host.stdin.type('edit it\r');
  await sleep(60);
  assert.doesNotMatch(host.stdout.text, /return b/, 'no patch before the artifact lands');
  const dir = path.join(host.home, '.zcode', 'cli', 'artifacts', 'sess_diff2');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'call_e1-tool-result-2.json'), JSON.stringify({
    version: 1, kind: 'workspace_file_before_change', toolCallId: 'e1', toolName: 'Edit',
    createdAt: '2026-09-17T00:00:01.000Z',
    files: [{ path: 'b.py', existedBefore: true, beforeContent: 'def f():\n    return a\n',
      structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1,
        lines: ['-    return a', '+    return b'] }] }],
  }));
  await sleep(1000);  // past the 150+500 ms retries and the 300 ms read memo
  assert.match(host.stdout.text, /\+    return b/, 'the late artifact attaches on retry and paints');
});

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
