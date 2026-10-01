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
import { readFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTheme } from './theme.mjs';
import { createTranscript, applyEvent, addUserEntry, addNotice, addCommandEntry, endTurn,
  createFold, foldStateFor, collapse as collapseEntry, expand as expandEntry,
  setFold, COLLAPSED, EXPANDED,
  toggleAllThinking, foldablesInTurn, stepUserTurn, getSubagentCount, quotaExhaustedNotice,
} from './events.mjs';
import { createScreen, composeFrame } from './screen.mjs';
import { createFrameScheduler } from './frames.mjs';
import { renderFooter, renderBanner, renderPermission, permissionOptions, renderChooser, renderPrompt, readContextMeter, COMPLETION_ROWS, inputBoxCursor, FOOTER_ROWS_BELOW_BOX } from './chrome.mjs';
import { effortItems, modelItems, modelOptionId, modelOptionMatches, parseModes, pickerFor, grantItems } from './pickers.mjs';
import { lookupGrant, rememberGrant, listGrants, revokeGrant } from '../driver/permissions.mjs';
import { sessionDiffArtifacts, artifactPatch } from '../driver/diffs.mjs';
import { createKeyDecoder, applyKey } from './keys.mjs';
import { pasteToken, expandChips, insertChip, chipSpanAt, chipSpanIn, takeChips, attachChips, pruneChips } from './paste-chips.mjs';
import { createPasteBurst } from './paste-burst.mjs';
import { appendHistory, HISTORY_CAP, loadHistory } from './history.mjs';
import { explainProviderError, formatProviderError } from '../driver/provider-errors.mjs';
import { completionContext, rankCandidates, applyCompletion, slashCandidates, fileCandidates, skillCandidates, conversationCandidates } from './complete.mjs';
import { mergeCommands, CLIENT_COMMANDS, matchClientCommand, zagentVersion, runtimeLabel, quotaHomeLine } from './commands.mjs';
import { codingPlanStatus } from '../driver/quota.mjs';
import { stringsFor } from './strings.mjs';
import { sanitizeText } from './sanitize.mjs';
import { listSkills, listConversationsAsync, mcpSummary } from '../driver/catalog.mjs';

const SPINNER_MS = 90;
// Paint-rate ceiling: streaming deltas, the spinner and key echoes all funnel
// through one scheduler, so no source can repaint faster than ~60 fps (codex's
// FrameRequester caps at 120; opencode batches at 16 ms — same order).
const FRAME_MS = 16;
const DOUBLE_CTRL_C_MS = 2000;
// Armed-interrupt window (opencode parity): the first Esc while a turn runs
// only flips the status hint; a second inside the window aborts.
const ESC_INTERRUPT_MS = 5000;

/** The most conservative choice the runtime offered, for every path that must refuse. */
const denyResponse = (options) => options.at(-1)?.response ?? { decision: 'deny' };

// A "/login <plan>-api-key <key>" command carries a credential as its last
// argument. The kernel keeps it out of its own input history (its router's
// api-key exclusion); ours matches: the key is masked while typing, the echo
// shows [redacted], and the command never enters the recall list.
const SECRET_PREFIX = /^\/login\s+\S+-api-key\s+/iu;
const SECRET_COMMAND = /^\/login\s+\S+-api-key\s+\S/iu;
const secretMaskFrom = (t) => { const m = SECRET_PREFIX.exec(t); return m ? m[0].length : -1; };
const isSecretCommand = (t) => SECRET_COMMAND.test(t);
const displayFor = (t) => isSecretCommand(t) ? `${t.slice(0, secretMaskFrom(t))}[redacted]` : t;

// ~/.zcode/cli/config.json {tui:{timestamps:true}} opts each transcript block
// into a right-aligned faint HH:MM stamp (the W5 audit-trail row). Absent or
// invalid config stays off — the default transcript is unchanged.
const tuiTimestampsEnabled = ({ home } = {}) => {
  try {
    return JSON.parse(readFileSync(path.join(home || os.homedir(), '.zcode', 'cli', 'config.json'), 'utf8'))
      ?.tui?.timestamps === true;
  } catch { return false; }
};

export async function runTui(host = {}, { deps = null } = {}) {
  const stdout = host.stdout ?? process.stdout;
  const stdin = host.stdin ?? process.stdin;
  const state = createTranscript();
  // `let`: /theme repaints the live chrome without a restart. Committed
  // scrollback keeps its old palette — it cannot be repainted by design.
  let theme = createTheme({
    enabled: host.noColor !== true && stdout.isTTY !== false,
    colorScheme: host.theme === 'light' ? 'light' : 'dark',
    ascii: process.env.ZAGENT_ASCII === '1',
  });
  const screen = createScreen(stdout, { columns: () => stdout.columns, rows: () => stdout.rows });
  // The popup never outgrows the terminal: 10 rows on a 12-row screen would
  // shove the transcript and the input box off the top. Page keys step by the
  // same guarded window so PgDn never skips rows the user never saw.
  // Reserve rows for the fixed chrome: box(3) + status(1) + hint(1) + the
  // popup's own status line + a live transcript row still needing room = 9.
  const completionPageRows = () => Math.min(COMPLETION_ROWS, Math.max(2, screen.height - 9));
  // host.locale is one of the members the TUI was handed and ignored. The runtime
  // supports en-US / zh-CN / auto, and this is a Chinese model's client.
  const str = stringsFor(host.locale);
  // chrome.mjs resolves locale through theme.str — attaching it is what reaches
  // the permission prompt, chooser hints and the completion status line. It was
  // never set, so a zh-CN host still got an English 'needs permission'.
  theme.str = str;

  const ui = {
    input: { value: '', cursor: 0 },
    mode: typeof host.initialMode === 'string' ? host.initialMode : 'build',
    effort: typeof host.initialThoughtLevel === 'string' ? host.initialThoughtLevel : '',
    model: typeof host.initialModel === 'string' ? host.initialModel : '',
    busy: false,
    busySince: 0,              // submit time — the status spinner's base before turn_started lands
    abortedByUser: false,
    spinnerFrame: 0,
    activity: null,             // status line derives the turn phase when unset
    permission: null,          // {request, options, selected, resolve}
    attachments: [],           // images pasted with ctrl+v, sent with the next prompt
    pastes: [],                // {token, text} — large pastes shown as `[Pasted ~N lines]` chips
    recallDepth: 0,            // how far back in the runtime's own input history
    completion: null,          // {type, items, index, context}
    chooser: null,             // {title, items, index, pick}
    prompt: null,              // {title, value, cursor, mask, command} — a selection item's input spec
    completionSeq: 0,          // guards against a slow file lookup overwriting a newer one
    queue: [],                 // typed while a turn runs; drained in order when it ends
    queueItem: 0,              // selected follow-up in the queue list
    queueAction: 0,            // 0 send now, 1 edit, 2 cancel
    fold: createFold(),
    userTurn: -1,              // selection index over user-prompt turns; -1 = none
    foldSel: 0,                // cursor over the selected turn's foldables (j/k) — o toggles it
    // Persisted across sessions at ~/.zcode/cli/history.jsonl — the runtime's
    // own recallPreviousInput is asked first, this is the floor under it.
    history: loadHistory({ home: host.home }),
    historyIndex: 0,           // set to history.length right below
    draft: '',                 // the half-typed input stashed while recalling
    draftChips: [],
    lastCtrlC: 0,
    escArmedAt: 0,             // last Esc during a turn; inside the window the next one aborts
    abort: null,
    mcp: null,                 // {connected, failed, total}
    workflows: new Map(),      // runId -> {kind, status}; fed by subscribeWorkflowEvents
    goal: '',                  // last /goal objective shown in the status line
    skills: listSkills({ cwd: host.workspaceDirectory || process.cwd() }),
    conversations: [],
  };
  ui.historyIndex = ui.history.length;
  void listConversationsAsync({}).then((rows) => { if (!exiting) ui.conversations = rows; }).catch(() => {});

  // G4: the context window is knowable before the first turn — the host's own
  // modelOptions carry it (the /model picker shows it). Seed the meter so the
  // footer and /context can show the window while 'used' is still unreported;
  // latchMeter merges, so a real kernel sighting overwrites the seed.
  // modelOptionMatches/alias only — seeding another model's window would be a lie.
  const modelWindowFor = (model) => {
    const opts = Array.isArray(host.modelOptions) ? host.modelOptions : [];
    const m = opts.find(o => modelOptionId(o) === model || o?.alias === model)
      ?? opts.find(o => modelOptionMatches(o, model));
    return Number.isFinite(m?.contextWindow) && m.contextWindow > 0 ? m.contextWindow : null;
  };
  let seededWindow = modelWindowFor(ui.model);
  if (seededWindow !== null) state.projection = { ...state.projection, contextWindow: seededWindow };
  let exiting = false;
  let escapeTimer = null;
  let burstTimer = null;
  let unsubscribeWorkflow = null;
  const keyDecoder = createKeyDecoder();
  // Unbracketed pastes arrive as a char flood whose newlines decode as 'enter'
  // and would submit line-by-line. The collector buffers the flood; the flush
  // timer re-inserts it as one text event (chip-eligible) once it goes quiet.
  const pasteBurst = createPasteBurst(deps?.pasteBurst);
  const escInterruptMs = deps?.escInterruptMs ?? ESC_INTERRUPT_MS;

  const clearCompletion = () => { ui.completionSeq += 1; ui.completion = null; };

  // The official context meter rides usage.delta / snapshot.projection events
  // and snapshot-bearing command replies (/goal, /model). Latched straight off
  // the envelope so the status line shows it even for event types the reducer
  // only counts as unhandled; partial sightings merge.
  const latchMeter = (source) => {
    const meter = readContextMeter(source);
    if (meter) state.projection = { ...state.projection, ...meter };
  };

  // W3 diff surface: a file-changing tool call's "updated successfully" prose
  // adds nothing the patch does not show better — and the runtime already wrote
  // the per-call change artifact (kind workspace_file_before_change, keyed by
  // toolCallId). Attach a bounded copy so the row paints colored +/- lines.
  // The artifact can land a tick after the result event, so a miss retries
  // briefly instead of never painting; attaching post-commit is safe — the
  // fingerprint flips and the commit ledger re-prints from the first changed
  // line. Accepted: on that late-attach path the already-committed "updated"
  // prose stays in scrollback with the diff appended below it (append-only
  // ledger — scrollback cannot be erased); the common case attaches before
  // the first paint and shows the patch alone.
  // Artifact reads are memoized briefly: a tool-call burst resolves many calls
  // inside one paint window, and each artifact carries full beforeContent —
  // re-parsing the whole session dir per call (x3 with retries) is real IO on
  // the event path. 300 ms is short enough that the 150/500 ms retries still
  // re-read a just-landed artifact.
  let diffArtMemo = { sid: null, at: 0, list: [] };
  const diffArtifacts = (sid) => {
    if (diffArtMemo.sid === sid && Date.now() - diffArtMemo.at < 300) return diffArtMemo.list;
    const list = sessionDiffArtifacts(sid, { home: host.home });
    diffArtMemo = { sid, at: Date.now(), list };
    return list;
  };
  const attachToolDiff = (event, attempt = 0) => {
    if (event?.type !== 'tool_call_result') return;
    const callId = sanitizeText(String(event?.payload?.toolCallId ?? ''));
    if (callId === '') return;
    // Newest match — findEntry's direction; a replayed tool_call_scheduled can
    // leave a same-id stale entry that would otherwise swallow the patch.
    const entry = state.entries.findLast(e => e.kind === 'tool' && e.id === callId);
    if (!entry || entry.diff !== undefined) return;
    try {
      const art = diffArtifacts(state.sessionId ?? '')
        .find(a => a?.toolCallId === callId);
      if (art) {
        const patch = artifactPatch(art);
        for (const f of patch.files) {
          f.path = sanitizeText(f.path, { keepNewlines: false });
          f.lines = f.lines.map(l => sanitizeText(l, { keepNewlines: false }));
        }
        entry.diff = patch;
        draw();
        return;
      }
    } catch { /* a malformed artifact is a display miss, never a turn error */ }
    if (attempt < 2) {
      const t = setTimeout(() => { if (!exiting) attachToolDiff(event, attempt + 1); }, attempt === 0 ? 150 : 500);
      t.unref?.();
    }
  };

  // The honest version line: zagent's own package version, then the installed
  // runtime's product version — findRuntime() resolves it (desktop-bundle
  // 3.11.2, zcode-app-cli 3.10.2-19); the kernel's internal string is only ever
  // shown labelled. host.version was painted as the runtime version before, so
  // the banner lied on every startup.
  const packageVersion = zagentVersion();
  screen.writeRaw('\x1b[r' + renderBanner(theme, screen.width, {
    version: packageVersion, runtime: runtimeLabel(host), model: ui.model,
    workspace: host.workspaceDirectory, branch: host.workspaceGitBranch, str,
    // Rotating hint (G6): one of str.hints per launch — the fixed line was the
    // only place the keys were discoverable.
    hint: (Array.isArray(str.hints) && str.hints.length
      ? str.hints[Math.floor(Math.random() * str.hints.length)] : str.hint),
  }).join('\n') + '\n');

  if (host.loginRequired === true) {
    addNotice(state, str.noModelAccess, 'warning');
  }

  const timestamps = deps?.timestamps ?? tuiTimestampsEnabled({ home: host.home });
  const paintNow = () => {
    if (exiting) return;
    const foldOf = (entry, i) => foldStateFor(ui.fold, entry, i);
    const { commit, live } = composeFrame(state, theme, screen.width, { str, foldOf, timestamps });
    const tail = ui.permission
      ? renderPermission(ui.permission.request, ui.permission.selected, theme, screen.width, ui.permission.options)
      : ui.prompt
      ? renderPrompt(ui.prompt, theme, screen.width)
      : ui.chooser
      ? renderChooser(ui.chooser, theme, screen.width)
      : renderFooter(state, ui.input.value, theme, screen.width, {
          mode: ui.mode, model: ui.model, effort: ui.effort, busy: ui.busy,
          // Queued commands are painted verbatim — an api-key command must show
          // the same [redacted] echo the transcript will.
          queue: ui.queue.map(q => ({ ...q, text: displayFor(q?.text ?? q) })),
          queueItem: ui.queueItem, queueAction: ui.queueAction, userTurn: ui.userTurn,
          // Which foldable `o` would toggle — the peek names it so the key is
          // aimable, and only while the same empty-input gate the keys use holds.
          foldPeek: ui.userTurn < 0 || ui.input.value !== '' ? null : (() => {
            const targets = foldTargets();
            if (targets.length === 0) return null;
            const sel = foldSelIndex(targets);
            return { index: sel, count: targets.length, entry: targets[sel][0] };
          })(),
          completion: ui.completion, completionRows: completionPageRows(), str,
          spinnerFrame: ui.spinnerFrame, activity: ui.activity, busySince: ui.busySince,
          escArmed: ui.escArmedAt !== 0 && Date.now() - ui.escArmedAt < escInterruptMs,
          mcp: ui.mcp, goal: ui.goal, agents: getSubagentCount(state),
          cursor: ui.input.cursor,
          // Measured on the SANITIZED text the box will paint — a stripped
          // control byte before the key would otherwise shift the boundary and
          // leave leading secret chars visible.
          maskFrom: secretMaskFrom(sanitizeText(ui.input.value)),
        });
    // Park the hardware cursor inside the input box — the whole point of the
    // tracked cursor is that the user can SEE where the next keystroke lands.
    // The box is the last block before the status line and the hint bar, so
    // its top is tail.length - FOOTER_ROWS_BELOW_BOX - box height.
    let cursor = null;
    if (!ui.permission && !ui.chooser && !ui.prompt) {
      const spot = inputBoxCursor(ui.input.value, theme, screen.width,
        { busy: ui.busy, str, cursor: ui.input.cursor,
          maskFrom: secretMaskFrom(sanitizeText(ui.input.value)) });
      if (spot) cursor = { line: live.length + tail.length - FOOTER_ROWS_BELOW_BOX - spot.rows + spot.row, col: spot.col };
    }
    screen.paint(commit, [...live, ...tail], cursor);
  };

  // Every draw site requests a frame instead of painting directly: bursts of
  // streaming deltas collapse into one paint per FRAME_MS window instead of
  // one repaint per event. Composition still happens at fire time, so a held
  // frame always renders the latest state. `deps.frameMs = 0` is the
  // in-process test seam — fully synchronous paints, same convention as
  // pasteBurst.flushMs 0; the real window is exercised by the PTY journeys.
  const frames = createFrameScheduler({ paint: paintNow, frameMs: deps?.frameMs ?? FRAME_MS });
  const draw = frames.scheduleFrame;

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

  // --- client slash commands --------------------------------------------------
  // ONE palette: the kernel's host.slashCommands merged with zagent's own.
  // Kernel commands still go through submitPrompt verbatim; client commands run
  // here, against local state — /exit never reached the runtime ("Unknown
  // command") and there was no way to leave without two ctrl+c.
  const merged = mergeCommands(host.slashCommands, CLIENT_COMMANDS);

  function openChooser({ title, detail, items, index = 0, pick, cancel, yn }) {
    if (exiting || !Array.isArray(items) || items.length === 0) return false;
    ui.chooser = { title, detail, items, index, pick, cancel, yn };
    draw();
    return true;
  }

  // The inline y/N confirm /undo and /update share. 'no' is the default so a
  // stray Enter can never trigger the action.
  function askConfirm(question) {
    if (exiting || ui.chooser || ui.permission) return Promise.resolve(false);
    return new Promise((resolve) => {
      ui.chooser = {
        title: question, yn: true, index: 1, hint: 'y / n — default: no',
        items: [{ value: 'y', label: 'yes' }, { value: 'n', label: 'no' }],
        pick: (item) => resolve(item.value === 'y'),
        cancel: () => resolve(false),
      };
      draw();
    });
  }

  const applyTheme = (scheme) => {
    // 'auto' follows the runtime's own setting; the terminal's preference is not
    // observable, so auto resolves through host.theme.
    theme = createTheme({
      enabled: host.noColor !== true && stdout.isTTY !== false,
      colorScheme: scheme === 'auto' ? (host.theme === 'light' ? 'light' : 'dark') : scheme,
      ascii: process.env.ZAGENT_ASCII === '1',
    });
    theme.str = str;
    draw();
  };

  const setMode = async (mode) => {
    if (typeof host.setMode === 'function') {
      try { const r = await host.setMode(mode); ui.mode = r?.mode ?? mode; }
      catch (e) { addNotice(state, `could not switch mode: ${String(e?.message ?? e)}`, 'error'); }
      draw();
      return true;
    }
    // Older hosts without setMode: the kernel still understands '/mode <x>'.
    enqueueOrSubmit(`/mode ${mode}`);
    return false;
  };

  const cmdCtx = {
    host, state, ui, str,
    env: process.env,
    version: packageVersion,
    commands: merged,
    workspace: host.workspaceDirectory ?? process.cwd(),
    cwd: host.workspaceDirectory ?? process.cwd(),
    home: undefined,                       // drivers default to os.homedir()
    deps,                                  // test seams: { exec, codingPlanStatus }
    print: (text) => addCommandEntry(state, text),
    notice: (text, level) => addNotice(state, text, level),
    draw, quit,
    interrupt: () => interrupt(),           // lazy: `interrupt` is declared below
    send: enqueueOrSubmit,
    // Straight to the runtime, skipping client dispatch: /workflow forwards its
    // non-stop forms through this — ctx.send would match the client command
    // again and recurse.
    sendRuntime: (text) => enqueueOrSubmit(text, { trusted: true, runtime: true }),
    openPicker, choose: openChooser, confirm: askConfirm,
    setTheme: applyTheme, setMode,
    clearView: () => {
      // Same visual as ctrl-l, plus the entries are gone for good. Committed
      // scrollback cannot be un-painted, so a screen clear is all "clear" means.
      state.entries.length = 0;
      state.printedAny = false;
      // The turn selection and the index-keyed fold overrides point at entries
      // that are gone: a rebuilt transcript would eat j/k/o with no peek line
      // and inherit folds by index collision. Reset both.
      ui.userTurn = -1; ui.foldSel = 0; ui.fold = createFold();
      screen.writeRaw('\x1b[2J\x1b[H');
    },
  };

  // A command a client command forwards to the runtime (e.g. a non-stop
  // /workflow) was already echoed and history-recorded by the client dispatch —
  // doing either again on submit shows the line twice. Counted, not boolean, so
  // a busy queue and repeated identical forwards stay exact.
  const forwarded = new Map();
  // A client command that forwards its line to the runtime (/workflow) re-enters
  // enqueueOrSubmit with runtime:true — the typed line's chips travel along.
  let pendingChips = null;

  function enqueueOrSubmit(text, { trusted = false, runtime = false, activity, cancelNotice } = {}) {
    if (exiting) return;
    clearCompletion();
    let trimmed = sanitizeText(text).trim();
    if (trimmed === '') return;
    // G6: '?' is the one-keystroke help the other top CLIs open on — an exact
    // bare '?' resolves to /help instead of spending a model turn on it.
    if (trimmed === '?') trimmed = '/help';
    // Before the busy guard below, which would otherwise QUEUE the quit: the user
    // typing /exit while a turn runs is asking to leave now, not after it finishes.
    // That is exactly the state they are in when a turn has hung.
    if (isQuit(trimmed)) { quit(); return; }
    // A zagent command runs HERE — never submitted to the runtime, never queued:
    // /stop and /status must work mid-turn, and /exit already left above.
    const client = runtime ? null : matchClientCommand(trimmed);
    if (client) {
      pendingChips = takeChips(ui.pastes, trimmed);
      ui.input = { value: '', cursor: 0 };
      ui.pastes = pruneChips(ui.pastes, '');
      recordHistory(trimmed, pendingChips);
      addUserEntry(state, trimmed);
      draw();
      void Promise.resolve(client.command.run(cmdCtx, client.args))
        .then(() => { if (!exiting) draw(); })
        .catch((e) => {
          if (exiting) return;
          addNotice(state, `${client.command.name}: ${String(e?.message ?? e).slice(0, 200)}`, 'error');
          draw();
        })
        .finally(() => { pendingChips = null; });   // never forwarded — release them
      return;
    }
    // A bare /effort, /model or /mode is a request to choose, not a command to run.
    const picker = pickerFor(trimmed);
    if (picker && !ui.busy) {
      ui.input = { value: '', cursor: 0 };
      draw();
      // If the runtime cannot offer a list, fall through to the plain command.
      void openPicker(picker).then(opened => { if (!opened) { recordHistory(trimmed); void submit(trimmed); } });
      return;
    }
    // G9: a slash word matching NOTHING in the merged palette used to reach the
    // kernel, which answered "Unknown command" listing only ITS commands —
    // every zagent command (incl. /exit, the way out) missing. Answer locally
    // with the merged list. Skipped when the host reports no command list:
    // then the kernel's list is the only truth and it answers for itself.
    if (!trusted && trimmed.startsWith('/')
        && Array.isArray(host.slashCommands) && host.slashCommands.length > 0) {
      const name = (/^\/+([^\s/]+)/.exec(trimmed)?.[1] ?? '').toLowerCase();
      // A "/login <plan>-api-key <key>" must never take this branch even when a
      // kernel build doesn't advertise /login: the gate records history and
      // echoes verbatim — the key would land in recall and scrollback.
      const known = name !== '' && !trimmed.startsWith('//')
        && (isSecretCommand(trimmed)
          || merged.some(c => c.name === name || (c.aliases ?? []).includes(name)));
      if (!known) {
        recordHistory(trimmed);
        ui.input = { value: '', cursor: 0 };
        ui.pastes = pruneChips(ui.pastes, '');
        addUserEntry(state, trimmed);
        const names = merged.map(c => `/${c.name}`).join(' ');
        addCommandEntry(state, `Unknown command: ${trimmed.split(/\s/)[0]}. Available commands: ${names}`);
        draw();
        return;
      }
    }
    // Chips bound to this message leave the buffer with it — a queued entry
    // drains to the full payload and a history recall can re-attach them, while
    // no later keystroke can prune a queued paste away. A runtime-forwarded
    // send never touches the buffer table: it inherits the typed line's chips
    // (pendingChips) or nothing — generated text must not steal buffer chips.
    const chips = runtime ? pendingChips ?? [] : takeChips(ui.pastes, trimmed);
    if (runtime) pendingChips = null;
    ui.input = { value: '', cursor: 0 };
    ui.pastes = pruneChips(ui.pastes, '');
    if (runtime) {
      forwarded.set(trimmed, (forwarded.get(trimmed) ?? 0) + 1);
    } else if (!isSecretCommand(trimmed)) {
      // An api-key command never enters history — up-arrow would put the key
      // back into the input, a later recall would carry it anywhere, and
      // recordHistory persists it to ~/.zcode/cli/history.jsonl on disk.
      recordHistory(trimmed, chips);
    }
    if (ui.busy) {
      ui.queue.push({ text: trimmed, chips, activity, cancelNotice });
      ui.queueItem = ui.queue.length - 1;
      ui.queueAction = 0;
      draw();
      return;
    }
    void submit(trimmed, chips, { activity, cancelNotice });
  }

  // History entries carry the compact text plus its paste chips so recall can
  // restore both — a recalled chip still expands on resubmit. Entries are also
  // appended to ~/.zcode/cli/history.jsonl so the NEXT session's up-arrow has
  // something to find. A consecutive duplicate is submitted but not re-recorded
  // (shell-style) — recalling it twice in a row would look like a stuck key.
  // NOTE: the chips default MUTATES ui.pastes (takeChips removes what it finds);
  // pass an explicit chips list when the buffer table must stay intact.
  function recordHistory(text, chips = takeChips(ui.pastes, text)) {
    if (ui.history.at(-1)?.text !== text) {
      ui.history.push({ text, chips });
      if (ui.history.length > HISTORY_CAP) ui.history.splice(0, ui.history.length - HISTORY_CAP);
      appendHistory({ text, chips }, { home: host.home });
    }
    ui.historyIndex = ui.history.length;
    ui.draft = ''; ui.draftChips = [];
    // A submit ends recall navigation — a stale host recallDepth would make the
    // next up-arrow skip entries AND defeat the draft-stash guard below.
    ui.recallDepth = 0;
  }

  async function submit(text, chips = [], { activity, cancelNotice } = {}) {
    if (exiting) return;
    const trimmed = text.trim();
    if (isQuit(trimmed)) { quit(); return; }   // also covers the queue drain
    if (trimmed === '' || ui.busy) return;
    // History is recorded once, by enqueueOrSubmit. Recording it here too made a
    // drained queue re-append every message (queue [a,b] -> history a,b,a,b).
    const fwd = forwarded.get(trimmed) ?? 0;
    if (fwd > 0) forwarded.set(trimmed, fwd - 1);
    else addUserEntry(state, displayFor(trimmed));
    // Kernel session-switch commands change which session later envelopes
    // describe; until a main-turn model_request re-latches the real one, a
    // stale id would aim /rename, /archive and /delete at the session the user
    // just left. /resume <id> adopts its target; the rest go unknown-but-safe.
    const sessionSwitch = /^\/(new|resume|fork|rewind)\b(?:\s+(\S+))?/.exec(trimmed);
    if (sessionSwitch) {
      state.sessionId = sessionSwitch[1] === 'resume' && sessionSwitch[2] ? sessionSwitch[2] : null;
      // The old session's title would mislabel the exit summary until (if) a
      // session_title_updated for the new session arrives.
      state.title = '';
    }
    ui.busy = true;
    ui.busySince = Date.now();
    // A picked selection item may name what the wait is (e.g. login's "Waiting
    // for browser authorization...") — far better than a generic spinner while
    // the kernel polls for the OAuth callback.
    // A null activity lets the status line name the reducer's turn phase
    // (waiting -> responding) instead of a static label; only a host that
    // knows better (a picked selection item) passes one.
    ui.activity = activity ?? null;
    const abort = new AbortController();
    ui.abort = abort;
    startSpinner();
    draw();

    try {
      // submitPrompt, not sendInput: the kernel's sendInput wrapper dereferences
      // an undefined `result` on this build and throws before the turn starts
      // (verified on the installed build).
      // Chips stay compact in the transcript, queue and history; only the
      // payload the runtime receives expands back to the pasted text.
      const expanded = expandChips(chips, trimmed);
      const payload = ui.attachments.length ? { text: expanded, attachments: [...ui.attachments] } : expanded;
      ui.attachments = [];
      // turn_started replaces state.turn — identity is the latch for "this
      // submit produced a real turn", so a kernel that streams but forgets to
      // echo turnId in the result still can't get its reply double-printed.
      const turnAtSubmit = state.turn;
      const result = await host.submitPrompt(payload, {
        abortSignal: abort.signal,
        delivery: 'start_turn',
        inputId: `input_${crypto.randomUUID()}`,
        queryId: `query_${crypto.randomUUID()}`,
        onEvent: (event) => { if (!exiting && !abort.signal.aborted) { applyEvent(state, event); latchMeter(event); attachToolDiff(event); draw(); } },
        requestPermission: (request, context) => askPermission(request, context),
      });
      // A slash command that produced a turn (e.g. /goal <objective>) streamed its
      // answer already; only a command with no turnId is pure command output.
      if (!exiting) {
        applyResult(result, turnAtSubmit);
        latchGoal(trimmed);
      }
    } catch (error) {
      const message = String(error?.message ?? error);
      if (exiting) return;
      if (abort.signal.aborted) {
        addNotice(state, cancelNotice ?? 'interrupted', 'muted');
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
        } else if (message.trim() === 'Turn execution failed') {
          // The kernel's bridge throws a bare "Turn execution failed" — the
          // provider detail never crosses it. Ask the monitor: when the
          // 5-hour pool is spent, the failure IS the window and its reset is
          // the fact that matters. A report that cannot prove exhaustion adds
          // nothing — the failure is something else. The probe is gated on the
          // exact bridge shape: while the pool sits near 100%, any other
          // unexplained error (a local TypeError, a harness fault) must NOT be
          // quota-attributed.
          const turnAtError = state.turn;
          void Promise.resolve().then(() => quotaProbe())
            .then((report) => {
              // A slow monitor call must not stamp its verdict onto the NEXT
              // turn — turn_started replaces state.turn, so identity is the latch.
              if (exiting || state.turn !== turnAtError) return;
              if (report && typeof report === 'object') {
                state.quotaReport = report;   // retryNotice prefers the monitor's reset
              }
              const line = quotaExhaustedNotice(report);
              if (line) { addNotice(state, line, 'warning'); draw(); }
            })
            .catch(() => {});
        }
      }
    } finally {
      // A prompt still open when the turn ends would trap every later keypress in
      // permission mode and leak its resolve — the host is not guaranteed to pass
      // a context.abortSignal, so this cannot be left to the abort listener.
      denyPendingPermission();
      ui.busy = false;
      ui.abort = null;
      ui.escArmedAt = 0;
      stopSpinner();
      // The reducer owns turn.active and the status line renders the spinner from
      // it, so stopping the animation is not the same as ending the turn: an
      // errored turn left "working 3.2s" on screen forever. Only `turn_complete`
      // used to clear it, and a throw never gets one.
      endTurn(state, { reason: 'error' });
      draw();
    }
    // Drain in order. Exiting still drops the queue. An interrupt keeps it so
    // idle Esc can pull the last follow-up back into the input.
    const next = exiting ? (ui.queue.length = 0, undefined)
      : ui.abortedByUser ? undefined
      : ui.queue.shift();
    ui.abortedByUser = false;
    if (next !== undefined) await submit(next.text, next.chips, { activity: next.activity, cancelNotice: next.cancelNotice });
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
  function latchGoal(trimmed) {
    const m = /^\/goal(?:\s+(.*))?$/u.exec(trimmed);
    if (!m) return;
    const arg = (m[1] ?? '').trim();
    if (!arg || arg === 'show') return;
    if (arg === 'clear') { ui.goal = ''; return; }
    if (arg === 'pause' || arg === 'resume') return;
    ui.goal = arg.replace(/\s+/gu, ' ').slice(0, 40);
  }

  function applyResult(result, turnAtSubmit) {
    if (!result || typeof result !== 'object') return;
    latchMeter(result);
    if (typeof result.mode === 'string') ui.mode = result.mode;
    if (typeof result.model === 'string') {
      ui.model = result.model;
      // The seeded window belongs to the model it was read from: on a switch,
      // re-seed only while the meter still carries OUR seed — a real kernel
      // sighting is never overwritten (latchMeter above already merged it).
      if (seededWindow !== null && state.projection?.contextWindow === seededWindow) {
        const w = modelWindowFor(ui.model);
        const { contextWindow, ...rest } = state.projection;
        state.projection = w !== null ? { ...rest, contextWindow: w } : rest;
        seededWindow = w;
      }
    }
    if (typeof result.thoughtLevel === 'string') ui.effort = result.thoughtLevel;   // shown in the footer
    if (openSelection(result.selection)) return;
    // A prompt whose turn never started still answers through `response` — the
    // kernel's no-model refusal resolves {loginRequired:true, response:'Model
    // not set, send /login to login.'} with no turnId. Printing only for slash
    // commands dropped that answer entirely: the prompt echoed, then the
    // screen sat unchanged forever. A real turn's reply already streamed — the
    // turnId flag marks it, and the turnAtSubmit identity latch covers a kernel
    // that streams a turn but forgets to echo the flag.
    if (result.turnId || state.turn !== turnAtSubmit) return;
    for (const key of ['response', 'message', 'text', 'output', 'detail']) {
      if (typeof result[key] === 'string' && result[key].trim() !== '') {
        addCommandEntry(state, result[key].trim());
        return;
      }
    }
  }

  /**
   * A bare /rewind, /fork, /resume, /login or /plugins (and a /goal that would
   * replace) answers with the kernel's own picker contract, verified in the
   * runtime's command router:
   *   selection: { title, prompt, emptyMessage, selectedIndex,
   *                items: [{ id, command, primary, secondary, meta }] }
   * Each item's `command` is the follow-up slash to run, so picking one submits
   * it. The payload used to be dropped, which left these commands printing
   * "Select a checkpoint" with no way to.
   */
  function openSelection(selection) {
    if (exiting || !selection || typeof selection !== 'object') return false;
    const items = (Array.isArray(selection.items) ? selection.items : [])
      .filter(i => i && typeof i === 'object')
      .map(i => ({
        value: typeof i.command === 'string' && i.command !== '' ? i.command : i.id,
        label: typeof i.primary === 'string' && i.primary !== '' ? i.primary : String(i.id ?? i.command ?? ''),
        note: [i.secondary, i.meta].filter(v => typeof v === 'string' && v !== '').join('  '),
        // The kernel's login items carry two extras: `input` asks for text
        // before the command can run (the api-key entries send
        // {input:{mask:true,...}} — the bare command alone answers with a
        // usage error), and `pending` names the wait while the picked
        // command's turn runs.
        input: i.input && typeof i.input === 'object' ? i.input : null,
        pending: i.pending && typeof i.pending === 'object' ? i.pending : null,
      }))
      .filter(i => typeof i.value === 'string' && i.value !== '');
    if (items.length === 0) {
      // An empty picker would be a dead modal; say why there is nothing to pick.
      if (typeof selection.emptyMessage === 'string' && selection.emptyMessage.trim() !== '') {
        addCommandEntry(state, selection.emptyMessage.trim());
        return true;
      }
      return false;
    }
    ui.chooser = {
      title: typeof selection.title === 'string' && selection.title !== '' ? selection.title : 'select',
      detail: typeof selection.prompt === 'string' ? selection.prompt : undefined,
      items,
      index: Number.isInteger(selection.selectedIndex) ? selection.selectedIndex : 0,
      // enqueueOrSubmit, not submit: a queued turn may still be draining, and a
      // pick made while busy must queue rather than silently drop. trusted:
      // the kernel's own follow-up command must skip the unknown-command gate —
      // a kernel pick for a command it never advertised is still the kernel's.
      pick: (item) => {
        if (item.input) { openTextPrompt(item, () => openSelection(selection)); return; }
        const text = (v) => typeof v === 'string' && v !== '' ? v : undefined;
        // The pending status names what the wait is. A slash command never
        // starts a turn, so the status-line spinner label never shows — put it
        // in the transcript where the authorize URL lands below it.
        if (text(item.pending?.status)) addNotice(state, item.pending.status, 'muted');
        // The pick is not the user's draft — a line typed while the command
        // result was on the wire must survive the submit's input clear.
        const draft = ui.input, pastes = ui.pastes;
        enqueueOrSubmit(item.value, {
          trusted: true,
          activity: text(item.pending?.status),
          cancelNotice: text(item.pending?.cancelStatus),
        });
        ui.input = draft; ui.pastes = pastes;
      },
    };
    draw();
    return true;
  }

  /**
   * A selection item carrying an `input` spec needs a value before its command
   * can run. Enter submits `<command> <value>`; Esc/ctrl-c backs out. When the
   * spec masks (the api-key entries), the value paints as mask glyphs — a
   * credential must never reach the screen, and the redaction on the submit
   * path keeps it out of the transcript and history too.
   */
  function openTextPrompt(item, reopen) {
    if (exiting) return;
    const spec = item.input;
    const opt = (k) => typeof spec[k] === 'string' && spec[k] !== '' ? spec[k] : undefined;
    ui.prompt = {
      title: opt('primary') ?? item.label,
      detail: opt('secondary'),
      placeholder: opt('placeholder'),
      hint: opt('help'),
      mask: spec.mask === true,
      emptyStatus: opt('emptyStatus'),
      cancelStatus: opt('cancelStatus'),
      submitStatus: opt('submitStatus'),
      command: item.value,
      pending: item.pending,
      reopen,
      value: '', cursor: 0,
    };
    draw();
  }

  function onPromptKey(event) {
    const p = ui.prompt;
    if (!p) return;
    const text = (v) => typeof v === 'string' && v !== '' ? v : undefined;
    switch (event.name) {
      case 'enter': {
        const value = p.value.trim();
        if (value === '') {
          if (p.emptyStatus) addNotice(state, p.emptyStatus, 'warning');
          draw();
          return;
        }
        ui.prompt = null;
        // The spec's submitStatus ("Saving API key...") is the activity while
        // the configure call is in flight; item-level pending still wins if a
        // kernel sends both.
        enqueueOrSubmit(`${p.command} ${value}`, {
          trusted: true,
          activity: text(p.pending?.status) ?? p.submitStatus,
          cancelNotice: text(p.pending?.cancelStatus),
        });
        return;
      }
      // Esc backs out to the selection the prompt came from — the kernel's own
      // help text for the api-key items promises exactly that.
      case 'escape': case 'ctrl-c':
        ui.prompt = null;
        if (p.cancelStatus) addNotice(state, p.cancelStatus, 'muted');
        if (p.reopen) { p.reopen(); return; }
        draw();
        return;
      default: {
        // applyKey returns the same object on a no-op key — the prompt shares
        // the editor's movement/erase/paste vocabulary verbatim.
        const next = applyKey(p, event);
        if (next !== p) { ui.prompt = { ...p, ...next }; draw(); }
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
    const options = permissionOptions(request);
    if (exiting || context?.abortSignal?.aborted) return Promise.resolve(denyResponse(options));
    const remembered = lookupGrant(request, { home: host.home });
    if (remembered) return Promise.resolve(remembered);
    return new Promise((resolve) => {
      const onAbort = () => settle(denyResponse(options));
      const settle = (response) => {
        if (ui.permission?.resolve !== settle) return;
        ui.permission = null;
        context?.abortSignal?.removeEventListener?.('abort', onAbort);
        const option = options.find((o) => o.response === response);
        if (option) rememberGrant(request, option, { home: host.home });
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
      context?.abortSignal?.addEventListener?.('abort', onAbort, { once: true });
      draw();
    });
  }

  // --- completion -----------------------------------------------------------
  // The palette is the merged list built above: kernel commands plus zagent's
  // client commands, group-ordered. Files still come from
  // host.listWorkspacePathSuggestions.
  const commands = slashCandidates(merged);

  async function refreshCompletion() {
    const seq = ++ui.completionSeq;
    if (exiting) return;
    const context = completionContext(ui.input.value, ui.input.cursor);
    if (!context) { if (ui.completion) { ui.completion = null; draw(); } return; }

    if (context.type === 'slash') {
      const items = rankCandidates(commands, context.query);
      ui.completion = items.length ? { type: 'slash', items, index: 0, context } : null;
      draw();
      return;
    }
    if (context.type === 'skill') {
      const items = rankCandidates(skillCandidates(ui.skills), context.query);
      ui.completion = items.length ? { type: 'skill', items, index: 0, context } : null;
      draw();
      return;
    }
    if (context.type === 'conversation') {
      const items = rankCandidates(conversationCandidates(ui.conversations), context.query);
      ui.completion = items.length ? { type: 'conversation', items, index: 0, context } : null;
      draw();
      return;
    }

    if (typeof host.listWorkspacePathSuggestions !== 'function') return;
    const input = ui.input;
    if (ui.completion) { ui.completion = null; draw(); }
    let suggestions;
    // {token} in, {items:[{kind,path}]} out — verified live; a bare string throws.
    try { suggestions = await host.listWorkspacePathSuggestions({ token: context.query }); }
    catch { return; }                       // a failed lookup closes nothing
    if (exiting || seq !== ui.completionSeq || ui.input !== input) return;
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
    if (next.value.trim() === ui.input.value.trim()) { clearCompletion(); return false; }
    ui.input = next;
    clearCompletion();
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
      // G3: page keys step a whole window instead of a row — clamped, not
      // wrapped, so the bottom of the list is a stable place to land.
      case 'pagedown':
        c.index = Math.min(c.index + completionPageRows(), c.items.length - 1); draw(); return true;
      case 'pageup':
        c.index = Math.max(c.index - completionPageRows(), 0); draw(); return true;
      case 'enter': {
        // A command typed in full must RUN, not accept the highlighted
        // suggestion: "/exit" used to be un-runnable because Enter only ever
        // completed to the palette's own candidate. An exact match on a name
        // or alias falls through to the submit path. Match the FULL merged
        // list, not the filtered rows: "/q" filters /exit out of the popup
        // (ranking scores names, not aliases) but is still an exact alias.
        const q = c.type === 'slash' ? c.context?.query : null;
        if (q != null && commands.some(i => i.value === q || (i.aliases ?? []).includes(q))) {
          clearCompletion();
          return false;
        }
        return acceptCompletion();
      }
      case 'escape':
        clearCompletion();
        // G9: closing the palette must drop slash debris too, or the next
        // typed /help becomes '//help'. Mirrored in the main escape branch.
        if (/^\/+$/.test(ui.input.value)) ui.input = { value: '', cursor: 0 };
        draw(); return true;
      default:
        return false;
    }
  }

  // --- the runtime's three session knobs -------------------------------------
  // effortOptions, modelOptions and setMode are handed to us by the host. Without
  // a picker, /effort, /model and /mode only worked if you already knew the
  // argument to type.
  async function openPicker(kind, grants) {
    if (exiting) return false;
    if (kind === 'effort') {
      const items = effortItems(host.effortOptions, ui.effort);
      if (!items.length) return false;
      ui.chooser = { title: str.effortTitle, detail: str.effortDetail,
        items, index: Math.max(0, items.findIndex(i => i.value === ui.effort)),
        pick: (item) => { recordHistory(`/effort ${item.value}`); void submit(`/effort ${item.value}`); } };
      draw();
      return true;
    }
    if (kind === 'model') {
      const items = modelItems(host.modelOptions, ui.model);
      if (!items.length) return false;
      ui.chooser = { title: str.modelTitle, items,
        index: Math.max(0, items.findIndex(i => i.current)),
        pick: (item) => { recordHistory(`/model ${item.value}`); void submit(`/model ${item.value}`); } };
      draw();
      return true;
    }
    if (kind === 'skill') {
      const items = skillCandidates(ui.skills);
      if (!items.length) return false;
      ui.chooser = { title: '/skill', items: items.map(s => ({ value: s.value, label: `$${s.value}`, note: s.hint ?? '' })),
        index: 0, pick: (item) => { recordHistory(`$${item.value}`); void submit(`$${item.value}`); } };
      draw();
      return true;
    }
    if (kind === 'mcp') {
      const servers = ui.mcpServers && typeof ui.mcpServers === 'object' ? Object.entries(ui.mcpServers) : [];
      if (!servers.length) return false;
      ui.chooser = {
        title: '/mcp',
        items: servers.map(([name, v]) => ({
          value: name,
          label: name,
          note: v && typeof v === 'object' ? String(v.status ?? '') : '',
        })),
        index: 0,
        pick: (item) => { recordHistory(`/mcp ${item.value}`); void submit(`/mcp ${item.value}`); },
      };
      draw();
      return true;
    }
    if (kind === 'goal') {
      ui.chooser = {
        title: '/goal',
        items: [
          { value: 'show', label: 'show', note: ui.goal ? ui.goal : '' },
          { value: 'pause', label: 'pause', note: '' },
          { value: 'resume', label: 'resume', note: '' },
          { value: 'clear', label: 'clear', note: '' },
        ],
        index: 0,
        pick: (item) => { recordHistory(`/goal ${item.value}`); void submit(`/goal ${item.value}`); },
      };
      draw();
      return true;
    }
    if (kind === 'permissions') {
      // F14b: view + revoke inside the TUI. Picking a grant asks the shared
      // y/N confirm (the key handler closes this chooser first, so askConfirm
      // is free to open), then removes exactly that record by store key.
      const items = grantItems(Array.isArray(grants) ? grants : listGrants({ home: host.home }));
      if (!items.length) return false;
      ui.chooser = { title: str.grantsTitle, detail: str.grantsDetail,
        items, index: 0,
        pick: async (item) => {
          const yes = await askConfirm(`revoke ${item.label}?`);
          if (!yes) { draw(); return; }
          try {
            const done = revokeGrant(item.value, { home: host.home });
            addNotice(state,
              done ? `revoked ${item.label}` : `grant already gone: ${item.label}`,
              done ? 'muted' : 'warning');
          } catch (e) {
            addNotice(state, `revoke failed: ${String(e?.message ?? e).slice(0, 160)}`, 'error');
          }
          draw();
        } };
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
      if (!parsed || exiting) return false;
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
    // The y/N confirm answers on the letter itself; digits are for the
    // numbered pickers the kernel sends.
    if (c.yn && event.text && /^[yn]$/i.test(event.text)) {
      const yes = event.text.toLowerCase() === 'y';
      close();
      void c.pick(yes ? c.items[0] : c.items[1]);
      return true;
    }
    if (event.text && /^[1-9]$/.test(event.text)) {
      const item = c.items[Number(event.text) - 1];
      if (item) { close(); void c.pick(item); }
      return true;
    }
    switch (event.name) {
      case 'up': c.index = (c.index - 1 + c.items.length) % c.items.length; draw(); return true;
      case 'down': case 'tab': c.index = (c.index + 1) % c.items.length; draw(); return true;
      case 'enter': { const item = c.items[c.index]; close(); if (item) void c.pick(item); return true; }
      // Esc/ctrl-c declines: pickers without a cancel callback close silently.
      case 'escape': case 'ctrl-c': close(); void c.cancel?.(); return true;
      default: return true;                    // the chooser is modal
    }
  }

  function applyQueueAction(index, action) {
    if (index < 0 || index >= ui.queue.length) return;
    const entry = ui.queue[index];
    ui.queue.splice(index, 1);
    ui.queueItem = Math.min(ui.queueItem, Math.max(0, ui.queue.length - 1));
    if (action === 0) {
      if (ui.busy) ui.queue.unshift(entry);
      else void submit(entry.text, entry.chips, { activity: entry.activity, cancelNotice: entry.cancelNotice });
    } else if (action === 1) {
      ui.input = { value: entry.text, cursor: entry.text.length };
      attachChips(ui.pastes, entry.text, entry.chips);
      ui.pastes = pruneChips(ui.pastes, entry.text);
    }
    draw();
  }

  function foldSelectedTurn(mode) {
    const targets = foldablesInTurn(state.entries, ui.userTurn);
    if (targets.length === 0) return false;
    const apply = mode === 'collapsed' ? collapseEntry : expandEntry;
    for (const [entry, i] of targets) apply(ui.fold, entry, i);
    draw();
    return true;
  }

  // The single-entry fold cursor (W3): j/k walk the selected turn's foldables
  // and o toggles just that one. Clamped every read so entries arriving or a
  // stale foldSel can never aim outside the list.
  const foldTargets = () => foldablesInTurn(state.entries, ui.userTurn);
  const foldSelIndex = (targets) =>
    Math.min(Math.max(0, ui.foldSel), Math.max(0, targets.length - 1));

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
      case 'tab': p.selected = (p.selected + 1) % p.options.length; draw(); break;
      case 'shift-tab': p.selected = (p.selected - 1 + p.options.length) % p.options.length; draw(); break;
      case 'enter': p.resolve(p.options[p.selected]?.response); break;
      case 'escape': p.resolve(denyResponse(p.options)); break;
      default: break;
    }
  }

  /** Both statements must always fire together; three copies drifted apart easily. */
  const interrupt = () => { ui.abortedByUser = true; ui.abort?.abort(); };

  // Hoisted so a /exit typed at the prompt can end the run loop. Without it, exit()

  // only flips `exiting` and the process waits for a keypress that never comes.

  let resolveRun = null;
  const exit = () => {
    if (exiting) return;
    // Flush BEFORE the flag: a coalesced frame can hold scrollback commits
    // (stream tail, the interrupted notice) that cancel() would discard.
    frames.flush();
    exiting = true;
    interrupt();
    ui.queue.length = 0;
    clearCompletion();
    ui.prompt = null;
    denyPendingPermission();
    stopSpinner();
    frames.cancel();
    clearTimeout(escapeTimer);
    clearTimeout(burstTimer);
    try { unsubscribeWorkflow?.(); } catch {}
    unsubscribeWorkflow = null;
    stdin.removeListener?.('data', onData);
    stdin.removeListener?.('end', finish);
    stdout.removeListener?.('resize', draw);
    process.removeListener('SIGTERM', finish);
    process.removeListener('SIGHUP', finish);
    process.removeListener('SIGINT', finish);
    process.removeListener('uncaughtException', onFatal);
    process.removeListener('unhandledRejection', onRejection);
    screen.clearLive();
    try { stdin.setRawMode?.(false); } catch {}
    screen.writeRaw('\x1b[?2004l\x1b[<u');   // paste off + kitty keyboard pop
    stdin.pause?.();
    // W5 exit summary: a session is a resumable object — the way out names it
    // and hands back both ways in (the latest in this directory, or this id
    // exactly). Only when the runtime actually started one — nothing to resume
    // means no hint. Fatal exits keep their own diagnostic line instead.
    const sid = [...sanitizeText(state.sessionId ?? '', { keepNewlines: false }).trim()].slice(0, 80).join('');
    if (sid && !fatalInFlight) {
      const title = [...sanitizeText(state.title ?? '', { keepNewlines: false }).replace(/\s+/g, ' ').replaceAll('"', "'").trim()].slice(0, 60).join('');
      screen.writeRaw(`${theme.faint(`${str.sessionEnded(title, sid)}\n${str.resumeHint(sid)}`)}\n`);
    }
  };

  function onKey(event) {
    if (exiting) return;
    // ctrl-c is handled BEFORE the permission dispatch. Routing it into the
    // prompt swallowed it, so neither abort nor double-ctrl-c exit worked while a
    // prompt was on screen — contradicting the UI's own "press ctrl+c again" hint.
    if (event.name === 'ctrl-c' && ui.permission) {
      // The doubled press must leave from here too. This branch returned before
      // reaching the double-press check below, so a permission prompt trapped the
      // session: ctrl+c only ever denied-and-interrupted, and the prompt reopened
      // on the next tool call. Found by the journey fuzzer, which could not exit a
      // session with a prompt on screen and had to SIGKILL it. Same defect class as
      // the busy branch, in the one place that fix did not reach.
      const now = Date.now();
      if (now - ui.lastCtrlC < DOUBLE_CTRL_C_MS) { denyPendingPermission(); quit(); return; }
      ui.lastCtrlC = now;
      denyPendingPermission();
      interrupt();
      return;
    }
    // Dispatch order matches draw()'s tail priority — permission, then prompt,
    // then chooser — so keys always go to the surface actually painted.
    if (ui.permission) return onPermissionKey(event);
    // A modal text prompt (the login api-key entry) owns every key until Enter
    // or Esc resolves it — including ctrl-c, which cancels the prompt like the
    // chooser rather than counting toward exit.
    if (ui.prompt) return void onPromptKey(event);
    if (ui.chooser) return void onChooserKey(event);

    if (event.name === 'ctrl-c') {
      const now = Date.now();
      // The doubled press exits whether or not a turn is running. Previously a
      // busy session returned at `if (ui.busy) interrupt()` before ever reaching
      // this, so the double-ctrl-c exit was unreachable during a turn — and if the
      // provider ignored the abort (a hung turn) the user could press it forever
      // while the status line said "ctrl+c twice to exit". Found by the journey
      // fuzzer, which could not leave a hung session and had to SIGKILL it.
      if (now - ui.lastCtrlC < DOUBLE_CTRL_C_MS) { quit(); return; }
      ui.lastCtrlC = now;
      if (ui.busy) { interrupt(); return; }   // the first press still interrupts
      addNotice(state, str.exitTwice, 'faint');
      draw();
      return;
    }
    // Completion owns tab/up/down/enter/escape while it is open.
    if (ui.completion && onCompletionKey(event)) return;

    if (event.name === 'escape') {
      clearCompletion();
      if (ui.busy) {
        // Armed double-Esc: one stray press — a reflexive palette-dismiss or a
        // misread chord — must not kill a turn. The first arms and the status
        // hint flips to "esc again to interrupt"; only a second inside the
        // window aborts.
        const now = Date.now();
        if (ui.escArmedAt !== 0 && now - ui.escArmedAt < escInterruptMs) { ui.escArmedAt = 0; interrupt(); return; }
        ui.escArmedAt = now;
        // The busy status hint covers the gap before turn_started too, but a
        // transcript notice is belt-and-suspenders — cheap, and still the only
        // record once the status line moves on.
        if (!state.turn?.active) addNotice(state, str.interruptAgain ?? str.interrupt, 'muted');
        draw();
        return;
      }
      ui.escArmedAt = 0;
      if (ui.queue.length > 0) { applyQueueAction(ui.queue.length - 1, 1); return; }
      // G9: Esc dismissed the palette but left a bare '/', so typing /help next
      // produced '//help' and the kernel's unknown-command reply. An input that
      // is only slashes is debris — drop it.
      if (/^\/+$/.test(ui.input.value)) { ui.input = { value: '', cursor: 0 }; draw(); return; }
      if (ui.userTurn >= 0) { ui.userTurn = -1; ui.foldSel = 0; draw(); }
      return;
    }
    if (event.name === 'ctrl-e') { toggleAllThinking(ui.fold); draw(); return; }
    if (event.name === 'shift-up' || event.name === 'shift-down') {
      ui.userTurn = stepUserTurn(state.entries, ui.userTurn, event.name === 'shift-up' ? -1 : 1);
      ui.foldSel = 0;
      draw();
      return;
    }
    if (ui.userTurn >= 0 && ui.input.value === '' && typeof event.text === 'string') {
      // j/k/o need the same fall-through h/l have: a selected turn with nothing
      // foldable leaves the letter free to type.
      const targets = foldTargets();
      if (targets.length > 0) {
        if (event.text === 'j' || event.text === 'k') {
          const step = event.text === 'j' ? 1 : -1;
          ui.foldSel = (foldSelIndex(targets) + step + targets.length) % targets.length;
          draw();
          return;
        }
        if (event.text === 'o') {
          const [entry, i] = targets[foldSelIndex(targets)];
          setFold(ui.fold, entry, i,
            foldStateFor(ui.fold, entry, i) === COLLAPSED ? EXPANDED : COLLAPSED);
          draw();
          return;
        }
      }
      if (event.text === 'h' || event.text === 'l') {
        if (foldSelectedTurn(event.text === 'h' ? 'collapsed' : 'expanded')) return;
      }
    }
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
    if (event.name === 'tab') {
      if (ui.queue.length > 0 && ui.input.value === '') {
        ui.queueAction = (ui.queueAction + 1) % 3;
        draw();
        return;
      }
      void refreshCompletion();
      return;
    }
    if (event.name === 'shift-tab' && ui.queue.length > 0 && ui.input.value === '') {
      ui.queueItem = (ui.queueItem - 1 + ui.queue.length) % ui.queue.length;
      draw();
      return;
    }
    if (event.name === 'enter') {
      if (ui.input.value.trim() === '' && ui.queue.length > 0) {
        applyQueueAction(ui.queueItem, ui.queueAction);
        return;
      }
      enqueueOrSubmit(ui.input.value);
      return;
    }

    if (event.name === 'up' || event.name === 'down') {
      if (ui.queue.length > 0 && ui.input.value === '') {
        const step = event.name === 'up' ? -1 : 1;
        ui.queueItem = (ui.queueItem + step + ui.queue.length) % ui.queue.length;
        draw();
        return;
      }
      // Inside a multi-line draft the arrows move the cursor first (applyKey
      // returns the same object at the boundary) — a stray up must not clobber
      // a half-typed draft with a history entry.
      const moved = applyKey(ui.input, event);
      if (moved !== ui.input) { ui.input = moved; draw(); return; }
      // Leaving the live input for history: stash the draft (and its chips) so
      // navigating back past the newest entry restores it, not an empty box.
      if (ui.historyIndex === ui.history.length && (ui.recallDepth ?? 0) === 0) {
        ui.draft = ui.input.value;
        const held = takeChips(ui.pastes, ui.draft);
        attachChips(ui.pastes, ui.draft, held);       // take+attach = copy, not move
        ui.draftChips = held;
      }
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
        // Past the newest entry sits the stashed draft — never an empty box.
        const recalled = ui.historyIndex === ui.history.length
          ? { text: ui.draft, chips: ui.draftChips }
          : ui.history[ui.historyIndex];
        const text = typeof recalled === 'string' ? recalled : recalled?.text ?? '';
        ui.input = { value: text, cursor: text.length };
        if (typeof recalled === 'object') attachChips(ui.pastes, text, recalled?.chips);
        ui.pastes = pruneChips(ui.pastes, text);
        draw(); void refreshCompletion();
      };
      if (typeof host.recallPreviousInput === 'function') {
        ui.recallDepth = Math.max(0, (ui.recallDepth ?? 0) + step);
        void Promise.resolve(host.recallPreviousInput(ui.recallDepth))
          .then((recalled) => {
            if (exiting) return;
            const text = typeof recalled === 'string' ? recalled : recalled?.text;
            if (typeof text !== 'string') {
              ui.recallDepth = Math.max(0, ui.recallDepth - step);
              recallLocal();                      // the host has nothing; we might
              return;
            }
            ui.input = { value: text, cursor: text.length };
            ui.pastes = pruneChips(ui.pastes, text);
            draw(); void refreshCompletion();
          })
          .catch(() => {
            ui.recallDepth = Math.max(0, ui.recallDepth - step);   // same unwind as the null path
            recallLocal();                      // a broken host must not disable history
          });
        return;
      }
      recallLocal();
      return;
    }

    // A cursor parked inside a chip token would let the next edit split the
    // literal and strand the payload — snap the insert point past the chip.
    // Arrows never rest inside a chip (snapped below), so this guards every
    // other cursor source: home/end on a chip-filled line, future click-to-
    // place, any path that assigns ui.input.cursor directly.
    const parked = chipSpanAt(ui.pastes, ui.input.value, ui.input.cursor);
    if (parked) ui.input = { value: ui.input.value, cursor: parked.end };

    // A large paste arrives as ONE text event (bracketed paste) and collapses
    // to a `[Pasted ~N lines]` chip in the buffer; ui.pastes holds the payload
    // (sanitized, same as any submitted text) and submit() expands it. Small
    // pastes still land as literal text.
    if (typeof event.text === 'string') {
      const token = pasteToken(event.text);
      if (token !== null) {
        const { value, cursor } = ui.input;
        insertChip(ui.pastes, value.slice(0, cursor) + token + value.slice(cursor),
          cursor, token, sanitizeText(event.text));
        event = { text: token };
      }
    }
    const before = ui.input;
    // A delete-ish key touching a chip removes the WHOLE chip — editing the
    // token into a broken literal is how placeholders leak into prompts.
    const delRange = (() => {
      const { value, cursor } = ui.input;
      if (event.name === 'backspace') return cursor > 0 ? [cursor - 1, cursor] : null;
      if (event.name === 'delete') return cursor < value.length ? [cursor, cursor + 1] : null;
      if (event.name === 'ctrl-u') {
        const start = cursor === 0 ? 0 : value.lastIndexOf('\n', cursor - 1) + 1;
        return cursor > start ? [start, cursor] : null;
      }
      if (event.name === 'ctrl-w') {
        const start = value.slice(0, cursor).replace(/\S+\s*$/u, '').length;
        return start < cursor ? [start, cursor] : null;
      }
      return null;
    })();
    if (delRange) {
      // ctrl-u on a real draft is a data-loss key: record the doomed input so
      // up-arrow brings it back. The chips are COPIED (take+attach) — taking
      // them here would blind the atomic chip delete below to the span.
      // Never a secret command: a wiped api-key must not be resurrected from
      // recall, and recordHistory writes history.jsonl to disk.
      if (event.name === 'ctrl-u' && delRange[1] - delRange[0] >= 20
          && !isSecretCommand(ui.input.value)) {
        const held = takeChips(ui.pastes, ui.input.value);
        attachChips(ui.pastes, ui.input.value, held);
        recordHistory(ui.input.value, held);
      }
      const span = chipSpanIn(ui.pastes, ui.input.value, delRange[0], delRange[1]);
      if (span) {
        ui.pastes.splice(span.index, 1);
        const { value } = ui.input;
        ui.input = { value: value.slice(0, span.start) + value.slice(span.end), cursor: span.start };
      }
    }
    if (ui.input === before) ui.input = applyKey(ui.input, event);
    // Arrows skip a chip atomically: a mid-chip landing snaps past the token
    // in the direction of travel, so the cursor can never rest inside one.
    if (event.name === 'left' || event.name === 'right') {
      const inside = chipSpanAt(ui.pastes, ui.input.value, ui.input.cursor);
      if (inside) ui.input = { value: ui.input.value, cursor: event.name === 'left' ? inside.start : inside.end };
    }
    if (ui.pastes.length > 0) ui.pastes = pruneChips(ui.pastes, ui.input.value);
    // An edit while a recall is showing makes the buffer the new live draft:
    // adopt it (chips included) and reset the nav state, or the next up-arrow
    // would judge "leaving the live input" off a recalled entry's stale slot.
    if (ui.input !== before && (ui.historyIndex < ui.history.length || (ui.recallDepth ?? 0) > 0)) {
      ui.historyIndex = ui.history.length;
      ui.recallDepth = 0;
      ui.draft = ui.input.value;
      const held = takeChips(ui.pastes, ui.draft);
      attachChips(ui.pastes, ui.draft, held);
      ui.draftChips = held;
    }
    if (ui.input !== before || parked) { draw(); void refreshCompletion(); }
  }

  // MCP servers fail silently otherwise: the probe on this machine found
  // node_repl in state "failed" with a version-negotiation error and nothing said
  // so. Report once at startup rather than inventing a panel.
  if (typeof host.listMcpServers === 'function') {
    void Promise.resolve(host.listMcpServers())
      .then((servers) => {
        ui.mcpServers = servers ?? {};
        ui.mcp = mcpSummary(servers);
        const broken = Object.entries(servers ?? {})
          .filter(([, v]) => v && typeof v === 'object' && v.status && v.status !== 'connected' && v.status !== 'ready');
        if (broken.length === 0) { draw(); return; }
        for (const [name, v] of broken.slice(0, 3)) {
          addNotice(state, `mcp ${name}: ${v.status}${v.error ? ` — ${String(v.error).slice(0, 120)}` : ''}`, 'warning');
        }
        draw();
      })
      .catch(() => {});
  }

  // The kernel's workflow channel (C1 re-probe; the same wrappers verified in
  // the installed 3.12.1 kernel): host.subscribeWorkflowEvents registers the
  // callback on a Set and returns the unsubscribe. Each event is the in-memory
  // {kind, message?, nodeId?, payload?, phase?, runId, timestamp, type} object —
  // the same one the store persists. The five run-level lifecycle types get one
  // transcript line each; the other 23 only update the tracker /workflow stop
  // reads. A host may omit the member entirely — the runTuiCommand builder
  // spreads it conditionally.
  const WORKFLOW_STATUS = {
    run_started: 'running', run_completed: 'completed', run_failed: 'failed',
    run_cancelled: 'cancelled', workflow_paused: 'paused',
  };
  const WORKFLOW_VERB = { running: 'started', completed: 'completed', failed: 'failed', cancelled: 'cancelled', paused: 'paused' };
  if (typeof host.subscribeWorkflowEvents === 'function') {
    try {
      unsubscribeWorkflow = host.subscribeWorkflowEvents((event) => {
        if (exiting || !event || typeof event !== 'object' || typeof event.runId !== 'string') return;
        const status = WORKFLOW_STATUS[event.type];
        const prev = ui.workflows.get(event.runId);
        // A run emitting work events that we never saw start is alive; any
        // non-terminal label keeps it stoppable.
        ui.workflows.set(event.runId, { kind: event.kind ?? prev?.kind, status: status ?? prev?.status ?? 'running' });
        if (status === undefined) return;
        const runId = sanitizeText(event.runId, { keepNewlines: false });
        const why = status === 'failed' && typeof event.message === 'string' && event.message !== ''
          ? ` — ${sanitizeText(event.message, { keepNewlines: false }).slice(0, 120)}` : '';
        addNotice(state, `workflow ${runId} ${WORKFLOW_VERB[status]}${why}`, status === 'failed' ? 'warning' : 'muted');
        draw();
      });
    } catch {}
  }

  // G4: the plan window on the home screen — the other top CLIs surface quota
  // at start; ours only answered on /quota. One async probe, silent on failure:
  // a missing credential is already covered by the first-run card.
  const quotaProbe = deps?.codingPlanStatus ?? codingPlanStatus;
  if (typeof quotaProbe === 'function') {
    void Promise.resolve().then(() => quotaProbe())
      .then((report) => {
        if (exiting) return;
        state.quotaReport = report;      // retryNotice prefers the monitor's reset
        const line = quotaHomeLine(report);
        if (line) { addNotice(state, line, 'muted'); draw(); }
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
  function finish() { exit(); resolveRun?.(); }

  /**
   * Deliver the buffered flood as ONE text event — the chipify path in onKey
   * decides whether it collapses to a `[Pasted ~N lines]` token. `submit`
   * fires only for a flood whose last byte was Enter and whose payload is a
   * single line; a multi-line paste always stays in the composer for review.
   */
  function flushBurst({ submit }) {
    clearTimeout(burstTimer);
    const out = pasteBurst.takeFlush();
    if (!out || exiting) return;
    if (out.text) onKey({ text: out.text });
    // A modal prompt owns the keys (api-key entry is a designed paste target):
    // its Enter resolves the prompt, not the composer. Otherwise submit the
    // composer the same way a real Enter does.
    if (submit && out.submit) {
      if (ui.prompt) onKey({ name: 'enter' });
      else enqueueOrSubmit(ui.input.value);
    }
  }

  const armBurst = () => {
    clearTimeout(burstTimer);
    if (pasteBurst.flushMs <= 0) return;   // onData flushes at the emit's end
    burstTimer = setTimeout(() => flushBurst({ submit: true }), pasteBurst.flushMs);
    if (typeof burstTimer.unref === 'function') burstTimer.unref();
  };

  function dispatchKey(event) {
    const action = pasteBurst.onEvent(event);
    switch (action.kind) {
      case 'swallow': armBurst(); return;
      case 'capture': {
        // The burst's first chars already reached the composer as ordinary
        // inserts — pull them back so the flood re-lands as one paste. While a
        // modal surface owns the keys (ui.prompt) they went there instead, so
        // the composer's tail is not the prefix and must not be cut.
        const { value, cursor } = ui.input;
        if (action.prefix !== '' && !ui.prompt && !ui.permission && !ui.chooser
            && value.slice(0, cursor).endsWith(action.prefix)) {
          ui.input = { value: value.slice(0, cursor - action.prefix.length) + value.slice(cursor),
                       cursor: cursor - action.prefix.length };
          draw();
        } else if (action.prefix !== '') {
          if (ui.prompt || ui.permission || ui.chooser) {
            // A modal owned those keystrokes — they stay consumed there.
            pasteBurst.dropPrefix(action.prefix.length);
          }
          // Otherwise a non-text binding ate them (the selected-turn fold keys
          // — h/l precedent, now j/k/o) and the composer never saw them: the
          // buffer still holds the prefix, so the flush lands the paste whole.
          // The fold toggle stands as a cosmetic side effect; the data stays.
        }
        armBurst();
        return;
      }
      case 'flush-then':
        // A non-text key ends the flood; it is not itself part of the paste.
        // The collector already detached the buffer into action.text — a
        // takeFlush() here would drain nothing.
        clearTimeout(burstTimer);
        if (action.text) onKey({ text: action.text });
        onKey(event);
        return;
      default: onKey(event);
    }
  }

  function onData(chunk) {
    clearTimeout(escapeTimer);
    for (const event of keyDecoder.push(chunk)) {
      if (exiting) break;
      dispatchKey(event);
    }
    if (exiting) { resolveRun?.(); return; }
    // flushMs 0 is a test seam: deliver the burst at the emit's end so
    // in-process drives stay synchronous. The real window (60 ms) instead
    // guards terminals that stream a paste across several reads.
    if (pasteBurst.flushMs <= 0) flushBurst({ submit: true });
    // A bare Escape is ambiguous until the terminal has had a chance to send
    // the rest of a sequence. Incomplete CSI and paste payloads never time out
    // into ordinary keystrokes.
    if (keyDecoder.waitingForEscape) {
      escapeTimer = setTimeout(() => { for (const event of keyDecoder.flushEscape()) dispatchKey(event); }, 40);
    }
  }

  // The crash guard goes in BEFORE raw mode: from here to exit() the terminal
  // is ours, and any death that skips exit() — a fault, an outside kill — must
  // still hand back a sane terminal. Pre-fix the only release was exit(), so an
  // uncaught error left the shell in raw mode with bracketed paste armed.
  let fatalInFlight = false;
  const onFatal = (err) => {
    if (fatalInFlight) return;               // a second fault mid-flush: once is enough
    fatalInFlight = true;
    frames.cancel();                         // a held frame must not repaint into the teardown
    try { stdin.setRawMode?.(false); } catch {}
    // The stack belongs to the runtime's diagnostic log — on the user's screen
    // it is exactly the stack-on-screen defect the journeys already gate.
    logDiagnostic(`fatal: ${err?.stack || err}`);
    // process.exit() drops writes still queued on a piped stream — and the
    // paste-off is exactly the byte the user's next shell needs. A stream that
    // exposes its fd takes the write synchronously, bypassing the queue;
    // otherwise the write callback (fired on flush OR error) gates the exit.
    // The backstop is armed FIRST: a throwing fd getter below must not skip it.
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 400).unref();
    let pending = 2;
    const fin = () => { if (--pending === 0) process.exit(1); };
    const once = (f) => { let done = false; return () => { if (!done) { done = true; f(); } }; };
    const flush = (stream, text) => {
      const finOnce = once(fin);             // a sink may both call back AND return undefined
      if (typeof stream?.fd === 'number') {
        try {
          // writeSync counts BYTES, not chars — a CJK error line must not
          // miscompare and land twice. A short write drops the tail on
          // purpose: queueing the full text would duplicate the prefix, and
          // the process is dying anyway.
          if (writeSync(stream.fd, text) > 0) return void finOnce();
        } catch {}
      }
      // A sink that ignores the callback returns undefined: it already has the
      // text, so that side is done. A real stream returns a boolean and its
      // callback does the counting.
      try { if (stream?.write?.(text, finOnce) === undefined) finOnce(); }
      catch { finOnce(); }
    };
    // Each flush is independently fallible — a throwing fd getter on a
    // hostile host.stdout must not skip the stderr line.
    // \x1b[r too: a crash while the pinned writer's DECSTBM region is armed
    // would otherwise leave the shell inside a partial scroll region.
    try { flush(stdout, '\x1b[?2004l\x1b[<u\x1b[r'); } catch {}
    try { flush(process.stderr, `zagent: fatal: ${String(err?.message || err).split('\n')[0].slice(0, 300)}\n`); } catch {}
  };
  // Raw mode turns a terminal ctrl-c into the 0x03 byte, so an observed SIGINT
  // is always an outside kill — it takes SIGTERM's graceful finish, not the
  // key path.
  process.once('SIGINT', finish);
  process.once('uncaughtException', onFatal);
  // A rejection is fatal only when nothing else handles it: if the host process
  // has its own unhandledRejection listener it owns the survive/die call — the
  // process is staying up, so there is nothing to restore and exiting here
  // would override its intent. `on`, not `once`: a deferred rejection must not
  // disarm the guard for a later unowned one.
  const onRejection = (err) => {
    if (process.listenerCount('unhandledRejection') > 1) return;
    onFatal(err);
  };
  process.on('unhandledRejection', onRejection);

  try {
    try { stdin.setRawMode?.(true); } catch {}
    // Kitty disambiguate (CSI >1u) makes shift+enter/ctrl+letter arrive as CSI u
    // instead of ambiguous bytes; terminals that don't know it ignore the push.
    screen.writeRaw('\x1b[>1u\x1b[?2004h');  // kitty push + bracketed paste: paste arrives verbatim
    stdin.resume?.();
    stdin.setEncoding?.('utf8');
    draw();

    await new Promise((resolve) => {
      resolveRun = resolve;
      stdin.on('data', onData);
      stdin.on('end', finish);
      stdout.on?.('resize', draw);
      process.once('SIGTERM', finish);
      process.once('SIGHUP', finish);
    });
  } finally {
    // A throw between the guard and the run loop must not leave it armed —
    // the caller may catch the rejection and live on with a sane terminal.
    process.removeListener('SIGINT', finish);
    process.removeListener('uncaughtException', onFatal);
    process.removeListener('unhandledRejection', onRejection);
  }
  exit();
}

// --- the module's login-helper exports -----------------------------------------
// Part of the '@zcode/tui' contract: the kernel loads this module as a whole
// and the vendored implementation exports these for its suspended login flow.
// Semantics ported verbatim from the runtime's own @zcode/tui build so any
// consumer sees the same behaviour.

/**
 * SSH or a display-less Linux session cannot open a browser; the suspended
 * login child is told to print the authorize URL instead.
 */
export function shouldUseNoBrowserForLogin(env = process.env, platform = process.platform) {
  if (env.SSH_CONNECTION?.trim() || env.SSH_TTY?.trim()) return true;
  if (platform !== 'linux') return false;
  return !env.DISPLAY?.trim() && !env.WAYLAND_DISPLAY?.trim();
}

/** The one /login form whose OAuth flow runs as a suspended child process. */
export function shouldSuspendForLoginCommand(command) {
  return command === '/login zai-coding-plan';
}

/**
 * The suspended login child: the zcode-app-cli launcher when both of its env
 * vars are set (it wraps the runtime), else the running runtime itself.
 */
export function suspendedZaiLoginCommand(env = process.env, runtimeExecutable = process.execPath, runtimeEntry = process.argv[1]) {
  const executable = env.ZCODE_APP_CLI_EXECUTABLE?.trim();
  const launcher = env.ZCODE_APP_CLI_ENTRY?.trim();
  if (executable && launcher) return { program: executable, args: [launcher, 'login', '--oauth'] };
  if (!runtimeEntry) throw new Error('Unable to locate the ZCode runtime entry point.');
  return { program: runtimeExecutable, args: [runtimeEntry, 'login'] };
}

/**
 * The line worth showing when a suspended login child fails: the first
 * conventional error line, else the last thing it said. stderr is read first;
 * stdout only when the child said nothing on stderr.
 */
export function loginFailureDiagnostic(stdout, stderr) {
  const lines = (stderr || stdout).trim().split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /^(?:error:|failed\b|invalid\b|unknown\b)/iu.test(line)) ?? lines.at(-1);
}

/**
 * The AI SDK paints its warning banner through console.info when no handler is
 * installed — terminal garbage inside a TUI. Suppress only the default; a
 * runtime-installed structured handler is left alone.
 */
export function suppressTuiAiSdkWarnings() {
  if (typeof globalThis.AI_SDK_LOG_WARNINGS === 'function') return;
  try { globalThis.AI_SDK_LOG_WARNINGS = false; } catch {}
}
suppressTuiAiSdkWarnings();
