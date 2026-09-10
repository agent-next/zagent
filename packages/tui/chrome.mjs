// The sticky footer: input box + status line.
//
// Claude Code keeps exactly one persistent surface at the bottom and lets the
// transcript scroll away above it. That is the whole reason this TUI does not
// take the alternate screen buffer: your scrollback, search and mouse selection
// keep working, and a crash leaves a readable terminal rather than a blank one.
//
// The status line borrows the field order Codex/opencode converged on: mode
// first (what the agent may do), then model, then cost so far.

import { formatDuration, formatTokens, toolSummary, wrapText } from './render.mjs';
import { stringWidth, clipToWidth } from './width.mjs';
import { sanitizeText } from './sanitize.mjs';
import { stringsFor } from './strings.mjs';

// Terminal CELLS, not code points: CJK and emoji are two cells wide. Counting
// them as one let the box and the status line overflow the terminal and wrap,
// which desynced the screen writer's erase height and ate committed scrollback.
const widthOf = stringWidth;
const clip = clipToWidth;

/**
 * A status field carries its own plain text alongside its painted form, so width
 * is measured from one source. Keeping two parallel arrays let them drift.
 */
const field = (text, paint) => ({ text: sanitizeText(text, { keepNewlines: false }), paint });

/**
 * The prompt box. It WRAPS rather than clipping: a prompt longer than the
 * terminal used to disappear as you typed it, which made the tool feel broken
 * before it did anything wrong. The box grows with the text and is capped so it
 * can never push the transcript off screen.
 */
export function renderInputBox(value, theme, width, options = {}) {
  const g = theme.glyph;
  const box = Math.max(20, width);
  const placeholder = options.placeholder ?? (options.str ?? stringsFor()).placeholder;
  const showPlaceholder = value === '' && !options.busy;
  const paint = showPlaceholder ? theme.faint : theme.text;
  // Newlines are kept — the value is multi-line — but escapes are not: the box is
  // drawn on every keystroke, so a bracketed paste is on screen long before enter.
  value = sanitizeText(value);
  const border = options.busy ? theme.border : theme.borderActive;
  const marker = g.user;
  const lead = 2 + widthOf(marker) + 1;              // "│ " + marker + " "
  const room = Math.max(1, box - lead - 2);          // ... + " │"
  const maxRows = Math.max(1, options.maxInputRows ?? 8);

  const text = showPlaceholder ? placeholder : value;
  let rows = wrapText(text, room);
  let truncated = false;
  if (rows.length > maxRows) {                       // keep the TAIL: that is where the cursor is
    rows = rows.slice(rows.length - maxRows);
    truncated = true;
  }

  const lines = [border(g.boxTL + g.boxH.repeat(box - 2) + g.boxTR)];
  rows.forEach((row, i) => {
    const shown = clip(row, room);
    const gap = ' '.repeat(Math.max(0, room - widthOf(shown)));
    // The marker sits on the first visible row; continuations align under the text.
    const lead2 = i === 0 ? theme.accent(marker) : ' '.repeat(widthOf(marker));
    lines.push(`${border(g.boxV)} ${lead2} ${paint(shown)}${gap} ${border(g.boxV)}`);
  });
  if (truncated) {
    const note = clip((options.str ?? stringsFor()).earlierLines(wrapText(text, room).length - maxRows), room);
    lines[1] = `${border(g.boxV)} ${theme.accent(marker)} ${theme.faint(note)}` +
      `${' '.repeat(Math.max(0, room - widthOf(note)))} ${border(g.boxV)}`;
  }
  lines.push(border(g.boxBL + g.boxH.repeat(box - 2) + g.boxBR));
  return lines;
}

// Narrow, unambiguous marks only. The obvious emoji picks (U+23F8 pause,
// U+26A1 zap) are East Asian Wide, so a status line that measured within budget
// actually overflowed and wrapped — the same class of bug as the CJK input box.
// Keys must cover driver/session-control.mjs MODES; 'auto' was missing, so an
// auto session fell through to the generic fallback.
const MODE_MARK = { plan: '=', build: '>>', edit: '~', yolo: '!!', auto: '@' };

export function statusFields(state, theme, options = {}) {
  const turn = state.turn;
  const str = options.str ?? stringsFor();
  const fields = [];

  if (turn?.active) {
    const spin = theme.glyph.spinner;
    const frame = spin[(options.spinnerFrame ?? 0) % spin.length];
    const elapsed = formatDuration(Math.max(0, (options.now ?? Date.now()) - turn.startedAt));
    fields.push(field(`${frame} ${options.activity ?? str.working}${elapsed ? ` ${elapsed}` : ''}`, theme.accent));
    fields.push(field(str.interrupt, theme.faint));
  } else {
    fields.push(field(`${MODE_MARK[options.mode] ?? '⏵'} ${options.mode ?? 'build'}`, theme.muted));
    if (options.model) fields.push(field(options.model, theme.faint));
    // The runtime's reasoning budget (low 8k / high 16k / max 32k) is a real
    // user-facing knob; the host hands it to us and /effort changes it.
    if (options.effort) fields.push(field(options.effort, theme.faint));
  }

  const queued = Array.isArray(options.queue) ? options.queue.length : 0;
  if (queued > 0) fields.push(field(str.queued(queued), theme.accent));
  if (options.goal) fields.push(field(str.goal(options.goal), theme.accent));
  const mcp = options.mcp;
  if (mcp && mcp.total > 0) {
    const text = mcp.failed > 0
      ? str.mcpFailed(mcp.connected, mcp.total, mcp.failed)
      : str.mcpOk(mcp.connected, mcp.total);
    fields.push(field(text, mcp.failed > 0 ? theme.warning : theme.faint));
  }

  const used = turn?.usage?.totalTokens ?? turn?.usage?.inputTokens;
  if (used) fields.push(field(str.tokens(formatTokens(used)), theme.faint));
  if (turn?.retries > 0) fields.push(field(str.retries(turn.retries), theme.warning));
  if (turn?.errors > 0) fields.push(field(str.failed(turn.errors), theme.error));
  return fields;
}

export function renderStatus(state, theme, width, options = {}) {
  const fields = statusFields(state, theme, options);
  const measure = (list) => 2 + list.reduce((n, f) => n + widthOf(f.text), 0) + Math.max(0, list.length - 1) * 3;
  // A single field can still exceed the budget on its own (a long model id, a
  // wide-glyph activity); clip the last survivor rather than let it wrap.
  // Drop trailing fields rather than wrap: the footer must stay exactly one line,
  // or the erase-and-redraw arithmetic in index.mjs walks over the transcript.
  while (fields.length > 1 && measure(fields) > width) fields.pop();
  if (fields.length === 1 && measure(fields) > width) fields[0].text = clip(fields[0].text, Math.max(1, width - 2));
  return [`  ${fields.map(f => f.paint(f.text)).join(theme.faint(' · '))}`];
}

export const QUEUE_ACTIONS = Object.freeze(['send now', 'edit', 'cancel']);

export function queueActionLabels(str) {
  const s = str ?? stringsFor();
  return [s.sendNow, s.editQueued, s.cancelQueued];
}

/**
 * Messages typed while a turn is running. Showing them (rather than only a count)
 * is what makes queueing trustworthy: you can see exactly what will be sent, in
 * order, and that nothing was swallowed. Each row carries [send now][edit][cancel].
 */
export function renderQueued(queue, theme, width, max = 3, options = {}) {
  const items = Array.isArray(queue) ? queue : [];
  if (items.length === 0) return [];
  const str = options.str ?? theme.str ?? stringsFor();
  const labels = queueActionLabels(str);
  const selected = Math.min(Math.max(0, options.selected | 0), items.length - 1);
  const action = Math.min(Math.max(0, options.action | 0), labels.length - 1);
  const chipPlain = labels.map(l => `[${l}]`).join('');
  const prefix = '  > ';
  const showChips = widthOf(prefix) + 1 + widthOf(chipPlain) + 4 <= width;
  const lines = [];
  for (const [offset, text] of items.slice(0, max).entries()) {
    const body = sanitizeText(text, { keepNewlines: false }).replace(/\s+/gu, ' ');
    if (!showChips) {
      lines.push(`  ${theme.faint('>')} ${theme.faint(clip(body, Math.max(8, width - 6)))}`);
      continue;
    }
    const room = Math.max(4, width - widthOf(prefix) - 1 - widthOf(chipPlain));
    const shown = clip(body, room);
    const pad = ' '.repeat(Math.max(0, room - widthOf(shown)));
    const chips = labels.map((label, ai) => {
      const token = `[${label}]`;
      return offset === selected && ai === action ? theme.accent(token) : theme.faint(token);
    }).join('');
    lines.push(`${prefix}${theme.faint(shown)}${pad} ${chips}`);
  }
  const hidden = items.length - Math.min(items.length, max);
  if (hidden > 0) lines.push(`  ${theme.faint((theme.str ?? str).moreQueued(hidden))}`);
  return lines;
}

/** Live peek of a user-prompt turn. Never rewrites committed scrollback. */
export function renderUserPeek(entries, index, theme, width, str) {
  const users = (entries ?? []).filter(e => e.kind === 'user');
  if (!Number.isInteger(index) || index < 0 || users.length === 0) return [];
  const at = Math.min(index, users.length - 1);
  const label = `${at + 1}/${users.length}`;
  const text = sanitizeText(users[at].text, { keepNewlines: false }).replace(/\s+/gu, ' ');
  const room = Math.max(8, width - widthOf(label) - 6);
  return [`  ${theme.faint(label)} ${theme.userMark('>')} ${theme.muted(clip(text, room))}`];
}

/**
 * Completion popup. Sits directly above the input box, capped so the footer stays
 * a predictable height; paint() measures rows now, but a popup taller than the
 * terminal would still push the transcript off screen.
 */
export function renderCompletions(completion, theme, width, max = 6) {
  const items = completion?.items ?? [];
  if (items.length === 0) return [];
  // Candidates are filenames from the workspace and command metadata from the
  // runtime — both untrusted. A repository containing a crafted filename would
  // otherwise paint escape sequences straight into this popup.
  const one = (v) => sanitizeText(v, { keepNewlines: false });
  const index = Math.min(Math.max(0, completion.index | 0), items.length - 1);
  // Keep the selection visible when the list is longer than the window.
  const start = Math.min(Math.max(0, index - max + 1), Math.max(0, items.length - max));
  const lines = [];
  for (const [offset, item] of items.slice(start, start + max).entries()) {
    const i = start + offset;
    const chosen = i === index;
    const prefix = ({ slash: '/', skill: '$', conversation: '#' })[completion.type] ?? '';
    const label = one(prefix + item.value);
    const detail = one(item.hint ?? (item.kind === 'directory' ? 'dir' : item.kind === 'file' ? '' : ''));
    const hint = detail ? ` ${clip(detail, Math.max(0, width - widthOf(label) - 8))}` : '';
    const text = clip(`${label}${hint}`, Math.max(8, width - 6));
    lines.push(`  ${chosen ? theme.accent('>') : ' '} ${chosen ? theme.accent(text) : theme.muted(text)}`);
  }
  const hidden = items.length - Math.min(items.length, start + max);
  if (hidden > 0) lines.push(`    ${theme.faint((completion.str ?? stringsFor()).moreCandidates(hidden))}`);
  return lines;
}

export function renderFooter(state, value, theme, width, options = {}) {
  return [
    ...renderUserPeek(state.entries, options.userTurn, theme, width, options.str),
    ...renderCompletions(options.completion, theme, width),
    ...renderQueued(options.queue, theme, width, 3, {
      selected: options.queueItem, action: options.queueAction, str: options.str,
    }),
    ...renderInputBox(value, theme, width, options),
    ...renderStatus(state, theme, width, options),
  ];
}

/** Shown once at startup: identity, workspace, hint. */
export function renderBanner(theme, width, info = {}) {
  const g = theme.glyph;
  // version, workspace and branch are host-supplied; a branch name or a directory
  // name is attacker-controllable in a cloned repository.
  const one = (v) => sanitizeText(v, { keepNewlines: false });
  const version = info.version ? theme.faint(` runtime ${one(info.version)}`) : '';
  const lines = [`${theme.accent(g.assistant)} ${theme.accent(theme.strong('zagent'))}${version}`];
  if (info.workspace) {
    const branch = info.branch ? theme.faint(` · ${one(info.branch)}`) : '';
    lines.push(`  ${theme.muted(clip(one(info.workspace), Math.max(10, width - 4)))}${branch}`);
  }
  // Clip: the hint is longer than a narrow terminal, and an overflowing banner
  // wraps into a row the screen writer did not count.
  lines.push(`  ${theme.faint(clip((info.str ?? stringsFor()).hint, Math.max(8, width - 2)))}`, '');
  return lines;
}

/**
 * Permission prompt.
 *
 * The runtime supplies the options AND the response object to return for each,
 * so the UI never invents a decision string: the chosen option's `response` is
 * handed back verbatim. Shape observed in the runtime's own consumer:
 *   request = { toolName, toolCallId|toolUseId|callId, input, options: [
 *     { optionId|kind, name|label, response } ] }
 */
export function permissionOptions(request) {
  const raw = Array.isArray(request?.options) ? request.options : [];
  const options = raw
    .filter(o => o && typeof o === 'object')
    .map((o, i) => ({
      value: (typeof o.optionId === 'string' && o.optionId) || (typeof o.kind === 'string' && o.kind) || String(i),
      // Option labels are host-supplied text rendered in a prompt the user approves.
      label: sanitizeText((typeof o.name === 'string' && o.name) || (typeof o.label === 'string' && o.label) || `option ${i + 1}`,
        { keepNewlines: false }),
      response: o.response,
    }));
  // A request with no usable options would trap the session with no way to answer.
  return options.length > 0 ? options : [{ value: 'deny', label: 'Deny', response: { decision: 'deny' } }];
}

/**
 * One list-with-a-selection surface. The permission prompt and the effort/model/
 * mode pickers are the same interaction — a title, a set of choices, arrows or
 * digits to pick — so they share a renderer rather than growing a second one.
 */
export function renderChooser({ title, detail, items, index, hint }, theme, width) {
  const g = theme.glyph;
  const list = Array.isArray(items) ? items : [];
  // Sanitise HERE, not only at the caller. Every string on this surface is
  // host-supplied and model-influenced, and this is the one prompt whose whole
  // job is to be trusted: an escape sequence could clear the screen and repaint a
  // forged "Allow" inside the real prompt. Newlines are collapsed as well, or a
  // row paints three lines while the screen writer counts one.
  const one = (v) => sanitizeText(v, { keepNewlines: false });
  const lines = [`${theme.warning(g.assistant)} ${theme.muted(clip(one(title), Math.max(8, width - 2)))}`];
  if (detail) lines.push(`  ${theme.faint(clip(one(detail), Math.max(10, width - 4)))}`);
  const at = Math.min(Math.max(0, index | 0), Math.max(0, list.length - 1));
  list.forEach((item, i) => {
    const chosen = i === at;
    const label = clip(one(`${i + 1}. ${item.label}${item.note ? `  ${item.note}` : ''}`), Math.max(8, width - 6));
    lines.push(`  ${chosen ? theme.accent('>') : ' '} ${chosen ? theme.accent(label) : theme.muted(label)}`);
  });
  lines.push(`  ${theme.faint(clip(one(hint ?? stringsFor().chooseHint), Math.max(8, width - 2)))}`);
  return lines;
}

export function renderPermission(request, selected, theme, width) {
  const options = permissionOptions(request);
  const tool = typeof request?.toolName === 'string' ? request.toolName : 'tool';
  // Same job as the transcript's tool header, so use the same picker. The inline
  // copy had a shorter key list and no fallback, so a Search/WebSearch or MCP
  // call showed NO detail at all — in the one place you most need to see what you
  // are approving.
  const detail = typeof request?.input === 'string' ? request.input : toolSummary(request);
  return renderChooser({
    title: (theme.str ?? stringsFor()).needsPermission(tool),
    detail,
    items: options.map(o => ({ label: o.label })),
    index: selected,
    hint: (theme.str ?? stringsFor()).denyHint,
  }, theme, width);
}
