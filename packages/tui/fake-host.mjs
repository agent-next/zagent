// A scriptable stand-in for the runtime's 28-member host contract.
//
// Extracted from test-runtui.mjs so three callers share one host: the in-process
// unit test, the hermetic PTY journey harness, and the fuzz loop. The point is
// that it can be told to FAIL: every TUI defect found by hand — the spinner that
// ran forever, "Turn execution failed" with no detail, no way to quit — was on a
// failure path, and a host that only ever succeeds cannot reach any of them.
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Streamed answer, the ordinary case. */
export const OK = 'ok';
/** Throws mid-turn, like a provider business error. */
export const THROW = 'throw';
/** Never settles — the turn hangs. */
export const HANG = 'hang';
/** Emits a tool call and a result before answering. */
export const TOOL = 'tool';
/** Streams a partial answer, THEN throws — what a mid-turn provider failure is. */
export const THROW_MID = 'throw-mid';
/** Asks for permission and waits for the user's answer. */
export const PERMISSION = 'permission';
/** Streams a reasoning block before the answer. */
export const THINKING = 'thinking';
/** Paced reasoning + text deltas — the real kernel spreads them over seconds;
    synchronous emits collapse into one paint, so a temporal journey could never
    catch a half-streamed turn on screen. */
export const STREAM = 'stream';

export const PROVIDER_USAGE_LIMIT =
  'ProviderBusinessError: [1308][Usage limit reached for 5 hour. Your limit will reset at 2099-01-01 06:05:37][req-fake]';
export const PROVIDER_RATE_LIMIT =
  'ProviderBusinessError: [1302][Rate limit reached for requests][req-fake]';

export function createFakeHost(options = {}) {
  const {
    behaviour = OK,
    error = 'Turn execution failed',
    reply = 'ack',
    stdin = process.stdin,
    stdout = process.stdout,
    contextMeter = null,   // {contextUsed, contextWindow}: turn_complete carries
                           // it as payload.projection, the same envelope the
                           // real kernel's meter rides (J5's /context oracle)
    sessionId = 'sess_fakejourney', // every real kernel envelope carries one;
                                  // the transcript latches it (G10 journeys)
    // Isolated default home: input history persists under <home>/.zcode/cli —
    // a standalone fake host must never append to the developer's real file.
    home = mkdtempSync(path.join(os.tmpdir(), 'zagent-fakehome-')),
    workflowEvents = null, // [{type, runId, kind, ...}] emitted on a timer so a
                           // PTY journey spec (pure JSON) can drive the workflow
                           // channel; in-process tests use emitWorkflowEvent
    ...overrides
  } = options;

  const submitted = [];
  const stderr = new EventEmitter();   // a WRITE sink; attaching 'data' here once
                                       // put the shared PTY handle into flowing
                                       // mode and swallowed every keystroke.
  let turn = 0;

  // The kernel's workflow channel (V_n hub): subscribeWorkflowEvents adds the
  // callback to a Set and returns the unsubscribe; a cancelled run emits
  // run_cancelled to every subscriber.
  const workflowSubscribers = new Set();
  const stoppedWorkflows = [];
  const emitWorkflowEvent = (event) => {
    for (const cb of [...workflowSubscribers]) {
      try { cb(event); } catch {}
    }
  };
  if (Array.isArray(workflowEvents)) {
    workflowEvents.forEach((event, i) => {
      const t = setTimeout(() => emitWorkflowEvent(event), 120 + i * 80);
      t.unref?.();
    });
  }

  async function submitPrompt(input, opts) {
    submitted.push(input);
    const id = `m${++turn}`;
    const emit = (payload) => opts?.onEvent?.({ type: 'model_streaming', sessionId, payload });
    opts?.onEvent?.({ type: 'turn_started', turnId: `t${turn}`, sessionId });
    // The real kernel announces the query source on model_request before any
    // delta — the transcript latches its sessionId from this envelope (G10).
    opts?.onEvent?.({ type: 'model_request', sessionId, payload: { querySource: 'main_turn' } });

    if (behaviour === HANG) {
      return new Promise((_, reject) => {
        const abort = opts?.abortSignal;
        if (abort?.aborted) { reject(new Error('aborted')); return; }
        abort?.addEventListener?.('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    if (behaviour === THROW) throw new Error(error);

    emit({ assistantMessageId: id, delta: '', kind: 'start' });

    if (behaviour === THROW_MID) {
      // A provider that dies partway leaves the answer's tail in the live region
      // while the error notices are committed to scrollback — which is where the
      // paint order matters.
      for (const chunk of String(reply).match(/.{1,8}/gs) ?? []) {
        emit({ assistantMessageId: id, delta: chunk, kind: 'text_delta' });
      }
      throw new Error(error);
    }

    if (behaviour === TOOL) {
      // The runtime's real event names and payload shapes. The first version of
      // this stub invented `tool_call`/`tool_result`, so a journey asserting the
      // tool was visible failed against correct code — a stub that lies produces
      // false findings, which is worse than no stub.
      // Two explore calls then a Bash: the journey sees the Explored cell and a
      // classic tool line + result body in one turn.
      const calls = [
        { toolCallId: 'c1', toolName: 'Read', input: { file_path: 'a.txt' }, content: 'read body hidden' },
        { toolCallId: 'c2', toolName: 'Grep', input: { pattern: 'needle' }, content: 'grep hits hidden' },
        { toolCallId: 'c3', toolName: 'Bash', input: { command: 'ls' }, content: 'line one\nline two' },
      ];
      for (const c of calls) {
        const { content, ...payload } = c;
        opts?.onEvent?.({ type: 'tool_call_scheduled', sessionId, payload });
        opts?.onEvent?.({ type: 'tool_call_started', sessionId, payload: { toolCallId: c.toolCallId } });
        opts?.onEvent?.({ type: 'tool_call_result', sessionId,
          payload: { toolCallId: c.toolCallId, duration: 12, result: { success: true, content } } });
      }
    }
    if (behaviour === THINKING) {
      emit({ assistantMessageId: id, delta: 'I should reason about this.\nLine two of thought.\nLine three.\nLine four.', kind: 'reasoning_delta' });
    }
    if (behaviour === STREAM) {
      const pace = () => new Promise(r => setTimeout(r, 120));
      for (const chunk of ['first reasoning fragment\n', 'a second reasoning fragment ', 'still thinking']) {
        emit({ assistantMessageId: id, delta: chunk, kind: 'reasoning_delta' });
        await pace();
      }
      for (const chunk of String(reply).match(/.{1,8}/gs) ?? []) {
        emit({ assistantMessageId: id, delta: chunk, kind: 'text_delta' });
        await pace();
      }
      emit({ assistantMessageId: id, delta: '', done: true, kind: 'finish' });
      opts?.onEvent?.({ type: 'turn_complete', sessionId, payload: {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, duration: 5,
        ...(contextMeter ? { projection: contextMeter } : {}) } });
      return { response: reply, turnId: `t${turn}`, mode: 'build' };
    }
    if (behaviour === PERMISSION) {
      const granted = await opts?.requestPermission?.({
        toolName: 'Edit', input: { path: 'a.txt' },
        options: [
          { optionId: 'allow_once', name: 'Allow once', response: { decision: 'allow' } },
          { optionId: 'allow_always', name: 'Allow for this session', response: { decision: 'allow', scope: 'session' } },
          { optionId: 'deny', name: 'Deny', response: { decision: 'deny' } },
        ],
      }, {});
      const allowed = granted?.decision === 'allow';
      emit({ assistantMessageId: id, delta: allowed ? 'allowed' : 'denied', kind: 'text_delta' });
    }

    for (const chunk of String(reply).match(/.{1,8}/gs) ?? []) {
      emit({ assistantMessageId: id, delta: chunk, kind: 'text_delta' });
    }
    emit({ assistantMessageId: id, delta: '', done: true, kind: 'finish' });
    opts?.onEvent?.({ type: 'turn_complete', sessionId, payload: {
      // Real field names: turn usage is inputTokens/outputTokens/totalTokens.
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, duration: 5,
      ...(contextMeter ? { projection: contextMeter } : {}) } });
    return { response: reply, turnId: `t${turn}`, mode: 'build' };
  }

  return {
    submitted,
    host: {
      initialMode: 'build', initialModel: 'zai/glm-5.3', initialThoughtLevel: 'max',
      loginRequired: false, locale: 'en-US', theme: 'dark', developerMode: false,
      version: '0.16.5', workspaceDirectory: process.cwd(), workspaceGitBranch: 'main',
      noColor: true,
      effortOptions: [{ id: 'low', label: 'low' }, { id: 'max', label: 'max' }],
      // contextWindow is real host contract — the /model picker shows it and
      // the G4 seed reads it for the pre-turn context window.
      modelOptions: [{ alias: 'main', id: 'zai/glm-5.3', name: 'GLM-5.3', contextWindow: 200000 }],
      // The real kernel injects 20 commands through host.slashCommands.
      // The fake host must advertise the same set: the TUI's
      // local unknown-command reply trusts this list, so a fake host missing
      // /rewind would make a perfectly real command look unknown.
      slashCommands: [
        'help', 'new', 'resume', 'fork', 'rewind', 'compact', 'login', 'logout',
        'locale', 'model', 'effort', 'mode', 'expert', 'init', 'goal', 'skill',
        'mcp', 'plugins', 'workflow', 'workflows',
      ].map(name => ({ name, summary: `${name} (runtime)`, usage: `/${name}` })),
      stdin, stdout, stderr, home,
      listWorkspacePathSuggestions: async ({ token }) =>
        ({ items: [{ kind: 'file', path: `src/${token}.mjs` }], truncated: false }),
      listMcpServers: async () => ({}),
      readClipboardImage: async () => null,
      writeClipboardText: async () => {},
      recallPreviousInput: async () => null,
      setMode: async (mode) => ({ mode }),
      submitPrompt,
      // The real host members (vendored 3.11.2-24 wrapper; identical in the
      // 3.12.1 desktop kernel): stop takes {runId}, cancels the run, then
      // returns the rebuilt /workflows panel.
      subscribeWorkflowEvents: (cb) => {
        workflowSubscribers.add(cb);
        return () => { workflowSubscribers.delete(cb); };
      },
      stopWorkflow: async ({ runId } = {}) => {
        stoppedWorkflows.push(runId);
        emitWorkflowEvent({ type: 'run_cancelled', runId, kind: 'goal',
          timestamp: new Date().toISOString() });
        return { title: '/workflows', selectedRunId: runId,
          updatedAt: new Date().toISOString(),
          runs: [{ runId, kind: 'goal', status: 'cancelled' }] };
      },
      ...overrides,
    },
    emitWorkflowEvent,
    stoppedWorkflows,
  };
}
