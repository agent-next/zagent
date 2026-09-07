// zagent's native TUI — the implementation of '@zcode/tui' that the official
// ZCode kernel imports and z.ai does not ship.
//
// The kernel calls runTui(host) with a 28-member injected host, whose contract
// was enumerated by execution against the stock runtime.
// Nothing here reads or modifies the kernel: it is the consumer side of z.ai's
// own dependency-injection seam, the same relationship a plugin has.
//
// The five other exports are imported by the kernel's login path. They must
// exist or the module fails to load.

import crypto from 'node:crypto';
import { createTheme } from './theme.mjs';
import { createTranscript, applyEvent, addUserEntry, addNotice, addCommandEntry, endTurn } from './events.mjs';
import { createScreen, composeFrame } from './screen.mjs';
import { renderFooter, renderBanner, renderPermission, permissionOptions, renderChooser } from './chrome.mjs';
import { effortItems, modelItems, parseModes, pickerFor } from './pickers.mjs';
import { decodeKeys, applyKey } from './keys.mjs';
import { explainProviderError, formatProviderError } from '../driver/provider-errors.mjs';
import { completionContext, rankCandidates, applyCompletion, slashCandidates, fileCandidates } from './complete.mjs';
import { stringsFor } from './strings.mjs';
import { sanitizeText } from './sanitize.mjs';

const SPINNER_MS = 90;
const DOUBLE_CTRL_C_MS = 2000;

/** The most conservative choice the runtime offered, for every path that must refuse. */
const denyResponse = (options) => options.at(-1)?.response ?? { decision: 'deny' };

export async function runTui(host = {}) {
  const stdout = host.stdout ?? process.stdout;
  const stdin = host.stdin ?? process.stdin;
  const state = createTranscript();
  const theme = createTheme({
    enabled: host.noColor !== true && stdout.isTTY !== false,
    colorScheme: host.theme === 'light' ? 'light' : 'dark',
    ascii: process.env.ZAGENT_ASCII === '1',
  });
  const screen = createScreen(stdout, { columns: () => stdout.columns });
  // host.locale is one of the members the TUI was handed and ignored. The runtime
  // supports en-US / zh-CN / auto, and this is a Chinese model's client.
  const str = stringsFor(host.locale);

  const ui = {
    input: { value: '', cursor: 0 },
    mode: typeof host.initialMode === 'string' ? host.initialMode : 'build',
    effort: typeof host.initialThoughtLevel === 'string' ? host.initialThoughtLevel : '',
    model: typeof host.initialModel === 'string' ? host.initialModel : '',
    busy: false,
    abortedByUser: false,
    spinnerFrame: 0,
    activity: 'working',
    permission: null,          // {request, options, selected, resolve}
    attachments: [],           // images pasted with ctrl+v, sent with the next prompt
    recallDepth: 0,            // how far back in the runtime's own input history
    completion: null,          // {type, items, index, context}
    chooser: null,             // {title, items, index, pick}
    completionSeq: 0,          // guards against a slow file lookup overwriting a newer one
    queue: [],                 // typed while a turn runs; drained in order when it ends
    history: [],
    historyIndex: -1,
    lastCtrlC: 0,
    abort: null,
  };

  screen.writeRaw(renderBanner(theme, screen.width, {
    version: host.version, workspace: host.workspaceDirectory, branch: host.workspaceGitBranch, str,
  }).join('\n') + '\n');

  if (host.loginRequired === true) {
    addNotice(state, str.noModelAccess, 'warning');
  }

  const draw = () => {
    const { commit, live } = composeFrame(state, theme, screen.width);
    const tail = ui.permission
      ? renderPermission(ui.permission.request, ui.permission.selected, theme, screen.width)
      : ui.chooser
      ? renderChooser(ui.chooser, theme, screen.width)
      : renderFooter(state, ui.input.value, theme, screen.width, {
          mode: ui.mode, model: ui.model, effort: ui.effort, busy: ui.busy, queue: ui.queue,
          completion: ui.completion, str,
          spinnerFrame: ui.spinnerFrame, activity: ui.activity,
        });
    screen.paint(commit, [...live, ...tail]);
  };

  let spinner = null;
  const startSpinner = () => {
    if (spinner) return;
    spinner = setInterval(() => { ui.spinnerFrame += 1; draw(); }, SPINNER_MS);
    if (typeof spinner.unref === 'function') spinner.unref();
  };
  const stopSpinner = () => { if (spinner) { clearInterval(spinner); spinner = null; } };

  // --- submitting -----------------------------------------------------------
  /** Enter while a turn runs queues instead of dropping the message. */
  // Slash commands are the runtime's, and its list has no way to leave: a user who
  // typed /exit got "Unknown command", then /exi, and was stuck — the only
  // documented way out is ctrl+c twice, which is not what anyone tries first.
  // Handled here rather than sent to the runtime, which knows nothing of our loop.
  const QUIT = new Set(['/exit', '/quit', '/q', '/bye']);
  const isQuit = (t) => QUIT.has(t.toLowerCase());
  const quit = () => { exit(); resolveRun?.(); };

  function enqueueOrSubmit(text) {
    const trimmed = sanitizeText(text, { keepNewlines: false }).trim();
    if (trimmed === '') return;
    // Before the busy guard below, which would otherwise QUEUE the quit: the user
    // typing /exit while a turn runs is asking to leave now, not after it finishes.
    // That is exactly the state they are in when a turn has hung.
    if (isQuit(trimmed)) { quit(); return; }
    // A bare /effort, /model or /mode is a request to choose, not a command to run.
    const picker = pickerFor(trimmed);
    if (picker && !ui.busy) {
      ui.input = { value: '', cursor: 0 };
      draw();
      // If the runtime cannot offer a list, fall through to the plain command.
      void openPicker(picker).then(opened => { if (!opened) void submit(trimmed); });
      return;
    }
    ui.input = { value: '', cursor: 0 };
    ui.history.push(trimmed);
    ui.historyIndex = ui.history.length;
    if (ui.busy) { ui.queue.push(trimmed); draw(); return; }
    void submit(trimmed);
  }

  async function submit(text) {
    const trimmed = text.trim();
    if (isQuit(trimmed)) { quit(); return; }   // also covers the queue drain
    if (trimmed === '' || ui.busy) return;
    // History is recorded once, by enqueueOrSubmit. Recording it here too made a
    // drained queue re-append every message (queue [a,b] -> history a,b,a,b).
    addUserEntry(state, trimmed);
    ui.busy = true;
    ui.activity = trimmed.startsWith('/') ? 'running command' : 'working';
    ui.abort = new AbortController();
    startSpinner();
    draw();

    try {
      // submitPrompt, not sendInput: the kernel's sendInput wrapper dereferences
      // an undefined `result` on this build and throws before the turn starts
      // (verified 2026-09-07 — receipt official-tui-seam-2026-09-07.md).
      const payload = ui.attachments.length ? { text: trimmed, attachments: [...ui.attachments] } : trimmed;
      ui.attachments = [];
      const result = await host.submitPrompt(payload, {
        abortSignal: ui.abort.signal,
        delivery: 'start_turn',
        inputId: `input_${crypto.randomUUID()}`,
        queryId: `query_${crypto.randomUUID()}`,
        onEvent: (event) => { applyEvent(state, event); draw(); },
        requestPermission: (request, context) => askPermission(request, context),
      });
      // A slash command that produced a turn (e.g. /goal <objective>) streamed its
      // answer already; only a command with no turnId is pure command output.
      applyResult(result, { wasCommand: trimmed.startsWith('/') && !result?.turnId });
    } catch (error) {
      const message = String(error?.message ?? error);
      if (ui.abort?.signal.aborted) {
        addNotice(state, 'interrupted', 'muted');
      } else {
        addNotice(state, `error: ${message}`, 'error');
        // "Turn execution failed" on its own tells the user nothing. When the
        // provider said WHY — a rate limit, or the plan's usage window and when it
        // resets — say that too. The headless path already did; the TUI did not.
        const explained = explainProviderError(`${error?.stack ?? ''}\n${message}`);
        if (explained) {
          for (const line of formatProviderError(explained).split('\n')) {
            addNotice(state, line.replace(/^zagent: /, ''), 'warning');
          }
        }
      }
    } finally {
      // A prompt still open when the turn ends would trap every later keypress in
      // permission mode and leak its resolve — the host is not guaranteed to pass
      // a context.abortSignal, so this cannot be left to the abort listener.
      denyPendingPermission();
      ui.busy = false;
      ui.abort = null;
      stopSpinner();
      // The reducer owns turn.active and the status line renders the spinner from
      // it, so stopping the animation is not the same as ending the turn: an
      // errored turn left "working 3.2s" on screen forever. Only `turn_complete`
      // used to clear it, and a throw never gets one.
      endTurn(state, { reason: 'error' });
      draw();
    }
    // Drain in order. A turn that was interrupted drops the queue: the user hit
    // esc to stop, and silently continuing with queued work would defy that.
    const next = ui.abortedByUser ? (ui.queue.length = 0, undefined) : ui.queue.shift();
    ui.abortedByUser = false;
    if (next !== undefined) await submit(next);
  }

  /**
   * Slash commands come back as {mode, response, ...} — verified live for /help,
   * /goal, /workflows, /mode, /model, /skill. `response` was missing from this
   * list, so every slash command ran and printed NOTHING.
   *
   * A prompt turn also returns `response`, but its text already streamed into the
   * transcript; only command output needs printing, so turns are excluded by
   * their turnId.
   */
  function applyResult(result, { wasCommand }) {
    if (!result || typeof result !== 'object') return;
    if (typeof result.mode === 'string') ui.mode = result.mode;
    if (typeof result.model === 'string') ui.model = result.model;
    if (typeof result.thoughtLevel === 'string') ui.effort = result.thoughtLevel;   // shown in the footer
    if (!wasCommand) return;
    for (const key of ['response', 'message', 'text', 'output', 'detail']) {
      if (typeof result[key] === 'string' && result[key].trim() !== '') {
        addCommandEntry(state, result[key].trim());
        return;
      }
    }
  }

  /** Tool arguments are rendered in the prompt; their string values are untrusted. */
  function sanitizeInputFields(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = typeof v === 'string' ? sanitizeText(v, { keepNewlines: false }) : v;
    }
    return out;
  }

  /** Resolve an open prompt with its most conservative option (the last one). */
  function denyPendingPermission() {
    const pending = ui.permission;
    if (!pending) return;
    pending.resolve(denyResponse(pending.options));
  }

  function askPermission(request, context) {
    return new Promise((resolve) => {
      const options = permissionOptions(request);
      const settle = (response) => {
        if (ui.permission?.resolve !== settle) return;
        ui.permission = null;
        draw();
        resolve(response);
      };
      // The prompt renders host-supplied, model-influenced fields. Everything else
      // is sanitised on the way into the transcript; this path stored the raw
      // request, so a crafted tool argument could clear the screen and repaint a
      // forged "Allow" prompt inside the real one — the exact threat sanitize.mjs
      // exists to prevent. Newlines are collapsed too: an embedded one made a row
      // paint three lines while rowsFor counted one, under-counting eraseHeight.
      const safeRequest = {
        ...request,
        toolName: sanitizeText(request?.toolName, { keepNewlines: false }),
        input: typeof request?.input === 'string'
          ? sanitizeText(request.input, { keepNewlines: false })
          : sanitizeInputFields(request?.input),
      };
      ui.permission = { request: safeRequest, options, selected: 0, resolve: settle };
      // A caller-side abort must release the prompt, or an interrupted turn hangs.
      context?.abortSignal?.addEventListener?.('abort', () => settle(denyResponse(options)), { once: true });
      draw();
    });
  }

  // --- completion -----------------------------------------------------------
  // Both sources are the runtime's own: host.slashCommands (20, with usage and
  // summary) and host.listWorkspacePathSuggestions.
  const commands = slashCandidates(host.slashCommands);

  async function refreshCompletion() {
    const context = completionContext(ui.input.value, ui.input.cursor);
    if (!context) { if (ui.completion) { ui.completion = null; draw(); } return; }

    if (context.type === 'slash') {
      const items = rankCandidates(commands, context.query);
      ui.completion = items.length ? { type: 'slash', items, index: 0, context } : null;
      draw();
      return;
    }

    if (typeof host.listWorkspacePathSuggestions !== 'function') return;
    const seq = ++ui.completionSeq;
    let suggestions;
    // {token} in, {items:[{kind,path}]} out — verified live; a bare string throws.
    try { suggestions = await host.listWorkspacePathSuggestions({ token: context.query }); }
    catch { return; }                       // a failed lookup closes nothing
    if (seq !== ui.completionSeq) return;   // a newer keystroke already superseded this
    const items = rankCandidates(fileCandidates(suggestions), context.query);
    ui.completion = items.length ? { type: 'file', items, index: 0, context } : null;
    draw();
  }

  function acceptCompletion() {
    const c = ui.completion;
    if (!c) return false;
    const item = c.items[Math.min(Math.max(0, c.index), c.items.length - 1)];
    if (!item) return false;
    // Accepting must CHANGE something. When the typed text already is the
    // selected candidate, enter meant "submit" — otherwise a fully typed command
    // silently ate its own enter and the next line concatenated onto it.
    const next = applyCompletion(ui.input, c.context, item.value);
    if (next.value.trim() === ui.input.value.trim()) { ui.completion = null; return false; }
    ui.input = next;
    ui.completion = null;
    draw();
    void refreshCompletion();               // a completed directory keeps completing
    return true;
  }

  function onCompletionKey(event) {
    const c = ui.completion;
    switch (event.name) {
      case 'tab': case 'down':
        c.index = (c.index + 1) % c.items.length; draw(); return true;
      case 'up':
        c.index = (c.index - 1 + c.items.length) % c.items.length; draw(); return true;
      case 'enter':
        return acceptCompletion();
      case 'escape':
        ui.completion = null; draw(); return true;
      default:
        return false;
    }
  }

  // --- the runtime's three session knobs -------------------------------------
  // effortOptions, modelOptions and setMode are handed to us by the host. Without
  // a picker, /effort, /model and /mode only worked if you already knew the
  // argument to type.
  async function openPicker(kind) {
    if (kind === 'effort') {
      const items = effortItems(host.effortOptions, ui.effort);
      if (!items.length) return false;
      ui.chooser = { title: str.effortTitle, detail: str.effortDetail,
        items, index: Math.max(0, items.findIndex(i => i.value === ui.effort)),
        pick: (item) => { void submit(`/effort ${item.value}`); } };
      draw();
      return true;
    }
    if (kind === 'model') {
      const items = modelItems(host.modelOptions, ui.model);
      if (!items.length) return false;
      ui.chooser = { title: str.modelTitle, items,
        index: Math.max(0, items.findIndex(i => i.value === ui.model)),
        pick: (item) => { void submit(`/model ${item.value}`); } };
      draw();
      return true;
    }
    if (kind === 'mode') {
      if (typeof host.setMode !== 'function') return false;
      // Ask the runtime for its own vocabulary rather than hardcoding one.
      let parsed = null;
      try {
        const probe = await host.submitPrompt('/mode', {
          abortSignal: new AbortController().signal, delivery: 'start_turn',
          inputId: `input_${crypto.randomUUID()}`, queryId: `query_${crypto.randomUUID()}`,
          onEvent: () => {}, requestPermission: () => denyResponse([]),
        });
        parsed = parseModes(probe?.response);
        if (typeof probe?.mode === 'string') ui.mode = probe.mode;
      } catch { return false; }
      if (!parsed) return false;
      ui.chooser = { title: str.modeTitle, items: parsed.items,
        index: Math.max(0, parsed.items.findIndex(i => i.value === (parsed.current ?? ui.mode))),
        pick: async (item) => {
          try { const r = await host.setMode(item.value); ui.mode = r?.mode ?? item.value; }
          catch (e) { addNotice(state, `could not switch mode: ${String(e?.message ?? e)}`, 'error'); }
          draw();
        } };
      draw();
      return true;
    }
    return false;
  }

  function onChooserKey(event) {
    const c = ui.chooser;
    const close = () => { ui.chooser = null; draw(); };
    if (event.text && /^[1-9]$/.test(event.text)) {
      const item = c.items[Number(event.text) - 1];
      if (item) { close(); void c.pick(item); }
      return true;
    }
    switch (event.name) {
      case 'up': c.index = (c.index - 1 + c.items.length) % c.items.length; draw(); return true;
      case 'down': case 'tab': c.index = (c.index + 1) % c.items.length; draw(); return true;
      case 'enter': { const item = c.items[c.index]; close(); if (item) void c.pick(item); return true; }
      case 'escape': case 'ctrl-c': close(); return true;
      default: return true;                    // the chooser is modal
    }
  }

  // --- input ----------------------------------------------------------------
  function onPermissionKey(event) {
    const p = ui.permission;
    if (!p) return;
    if (event.text && /^[1-9]$/.test(event.text)) {
      const index = Number(event.text) - 1;
      if (index < p.options.length) { p.selected = index; p.resolve(p.options[index].response); }
      return;
    }
    switch (event.name) {
      case 'up': p.selected = Math.max(0, p.selected - 1); draw(); break;
      case 'down': p.selected = Math.min(p.options.length - 1, p.selected + 1); draw(); break;
      case 'enter': p.resolve(p.options[p.selected]?.response); break;
      case 'escape': p.resolve(denyResponse(p.options)); break;
      default: break;
    }
  }

  /** Both statements must always fire together; three copies drifted apart easily. */
  const interrupt = () => { ui.abortedByUser = true; ui.abort?.abort(); };

  let exiting = false;

  // Hoisted so a /exit typed at the prompt can end the run loop. Without it, exit()

  // only flips `exiting` and the process waits for a keypress that never comes.

  let resolveRun = null;
  const exit = () => {
    if (exiting) return;
    exiting = true;
    stopSpinner();
    screen.clearLive();
    try { stdin.setRawMode?.(false); } catch {}
    screen.writeRaw('\x1b[?2004l');
    stdin.pause?.();
  };

  function onKey(event) {
    // ctrl-c is handled BEFORE the permission dispatch. Routing it into the
    // prompt swallowed it, so neither abort nor double-ctrl-c exit worked while a
    // prompt was on screen — contradicting the UI's own "press ctrl+c again" hint.
    if (event.name === 'ctrl-c' && ui.permission) {
      denyPendingPermission();
      interrupt();
      return;
    }
    if (ui.chooser) return void onChooserKey(event);
    if (ui.permission) return onPermissionKey(event);

    if (event.name === 'ctrl-c') {
      if (ui.busy) { interrupt(); return; }
      const now = Date.now();
      if (now - ui.lastCtrlC < DOUBLE_CTRL_C_MS) { exit(); return; }
      ui.lastCtrlC = now;
      addNotice(state, str.exitTwice, 'faint');
      draw();
      return;
    }
    // Completion owns tab/up/down/enter/escape while it is open.
    if (ui.completion && onCompletionKey(event)) return;

    if (event.name === 'escape') { if (ui.busy) interrupt(); return; }
    if (event.name === 'ctrl-d') { if (ui.input.value === '' && !ui.busy) exit(); return; }
    if (event.name === 'ctrl-l') { screen.writeRaw('\x1b[2J\x1b[H'); draw(); return; }
    // In developer mode ctrl+o reports the event kinds the reducer had no renderer
    // for — the counter that already exists and nothing displayed.
    if (event.name === 'ctrl-o' && host.developerMode === true) {
      const unknown = [...state.unhandled].map(([k, n]) => `${k}×${n}`).join(', ');
      addNotice(state, unknown ? `unhandled: ${unknown}` : 'no unhandled runtime events', 'faint');
      draw();
      return;
    }
    // ctrl+v: the lite model accepts images, and the host hands us the clipboard.
    if (event.name === 'ctrl-v' && typeof host.readClipboardImage === 'function') {
      void Promise.resolve(host.readClipboardImage())
        .then((image) => {
          if (!image) { addNotice(state, str.noImage, 'faint'); draw(); return; }
          ui.attachments.push(image);
          addNotice(state, str.imagePasted(ui.attachments.length), 'muted');
          draw();
        })
        .catch(() => { addNotice(state, str.noImage, 'faint'); draw(); });
      return;
    }
    // ctrl+y: copy the newest answer out, using the host's own clipboard writer.
    if (event.name === 'ctrl-y' && typeof host.writeClipboardText === 'function') {
      const last = [...state.entries].reverse().find(e => e.kind === 'assistant' && e.text.trim() !== '');
      if (!last) { addNotice(state, str.nothingToCopy, 'faint'); draw(); return; }
      void Promise.resolve(host.writeClipboardText(last.text))
        .then(() => { addNotice(state, str.copied, 'muted'); draw(); })
        .catch(() => {});
      return;
    }
    if (event.name === 'tab') { void refreshCompletion(); return; }
    if (event.name === 'enter') { ui.completion = null; enqueueOrSubmit(ui.input.value); return; }

    if (event.name === 'up' || event.name === 'down') {
      // The runtime keeps input history that OUTLIVES the session; ours died with
      // it. Ask the host first and fall back to the in-memory list.
      const step = event.name === 'up' ? 1 : -1;
      // The in-memory fallback. Named so the host path can actually reach it: the
      // previous version returned unconditionally after asking the host, so the
      // fallback was dead code whenever the host implemented the method — and a
      // fresh session has no persisted history, so recallPreviousInput answers
      // null and up-arrow silently did nothing. Which is precisely when a user
      // first presses it.
      const recallLocal = () => {
        if (ui.history.length === 0) return;
        const next = event.name === 'up' ? ui.historyIndex - 1 : ui.historyIndex + 1;
        ui.historyIndex = Math.min(ui.history.length, Math.max(0, next));
        const recalled = ui.history[ui.historyIndex] ?? '';
        ui.input = { value: recalled, cursor: recalled.length };
        draw();
      };
      if (typeof host.recallPreviousInput === 'function') {
        ui.recallDepth = Math.max(0, (ui.recallDepth ?? 0) + step);
        void Promise.resolve(host.recallPreviousInput(ui.recallDepth))
          .then((recalled) => {
            const text = typeof recalled === 'string' ? recalled : recalled?.text;
            if (typeof text !== 'string') {
              ui.recallDepth = Math.max(0, ui.recallDepth - step);
              recallLocal();                      // the host has nothing; we might
              return;
            }
            ui.input = { value: text, cursor: text.length };
            draw();
          })
          .catch(() => { recallLocal(); });       // a broken host must not disable history
        return;
      }
      recallLocal();
      return;
    }

    const before = ui.input;
    ui.input = applyKey(ui.input, event);
    if (ui.input !== before) { draw(); void refreshCompletion(); }
  }

  // MCP servers fail silently otherwise: the probe on this machine found
  // node_repl in state "failed" with a version-negotiation error and nothing said
  // so. Report once at startup rather than inventing a panel.
  if (typeof host.listMcpServers === 'function') {
    void Promise.resolve(host.listMcpServers())
      .then((servers) => {
        const broken = Object.entries(servers ?? {})
          .filter(([, v]) => v && typeof v === 'object' && v.status && v.status !== 'connected' && v.status !== 'ready');
        if (broken.length === 0) return;
        for (const [name, v] of broken.slice(0, 3)) {
          addNotice(state, `mcp ${name}: ${v.status}${v.error ? ` — ${String(v.error).slice(0, 120)}` : ''}`, 'warning');
        }
        draw();
      })
      .catch(() => {});
  }

  /**
   * host.stderr is a WRITE sink — the channel the runtime keeps for diagnostics —
   * not a source. Attaching a 'data' listener to it put the shared terminal handle
   * into flowing mode and SWALLOWED every keystroke: under a PTY the TUI received
   * no input at all and the prompt could never be submitted. The fake-host harness
   * cannot catch that (its stderr is a plain EventEmitter), which is why the PTY
   * smoke stays in the loop.
   *
   * Used correctly: our own errors go there, so they land in the runtime's log
   * instead of being painted over by the next frame.
   */
  const logDiagnostic = (text) => {
    try { host.stderr?.write?.(`zagent: ${String(text).slice(0, 400)}\n`); } catch {}
  };

  // --- run ------------------------------------------------------------------
  try { stdin.setRawMode?.(true); } catch {}
  screen.writeRaw('\x1b[?2004h');            // bracketed paste: paste arrives verbatim
  stdin.resume?.();
  stdin.setEncoding?.('utf8');
  draw();

  await new Promise((resolve) => {
    resolveRun = resolve;
    stdin.on('data', (chunk) => {
      if (process.env.ZAGENT_KEYLOG) { try { (require('node:fs')).appendFileSync(process.env.ZAGENT_KEYLOG, JSON.stringify({raw: String(chunk).slice(0,40), events: decodeKeys(chunk).map(e=>e.name??('t:'+e.text))}) + '\n'); } catch {} }
      for (const event of decodeKeys(chunk)) onKey(event); if (exiting) resolve(); });
    stdin.on('end', () => { exit(); resolve(); });
    stdout.on?.('resize', draw);
    const finish = () => { exit(); resolve(); };
    process.once('SIGTERM', finish);
    process.once('SIGHUP', finish);
  });
  exit();
}

// Imported by the kernel's login path; absent exports break module load.
export const loginFailureDiagnostic = () => undefined;
export const shouldSuspendForLoginCommand = () => false;
export const shouldUseNoBrowserForLogin = () => false;
export const suppressTuiAiSdkWarnings = () => {};
export const suspendedZaiLoginCommand = () => undefined;
