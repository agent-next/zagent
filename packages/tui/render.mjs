// Transcript -> terminal lines.
//
// Style follows Claude Code's terminal grammar rather than a framed dashboard:
// content streams into normal scrollback as prose, and a single glyph column
// carries state. Borrowed deliberately —
//   * Claude Code: the "* marker + \_ result" two-glyph grammar; muted, capped
//     tool output; prose over boxes.
//   * Codex CLI: one-line tool summaries with the significant argument inline.
//   * opencode / grok: status footer carrying model, tokens and elapsed.
//
// Everything here is pure: wrapping happens on PLAIN text before any color is
// applied, so no call site ever needs ANSI-aware width arithmetic.

import { renderMarkdown } from './markdown.mjs';
import { createScanner, paintSpans } from './syntax.mjs';
import { stringWidth, clipToWidth } from './width.mjs';
import { stringsFor } from './strings.mjs';
import { hhmm } from './events.mjs';

const CONTINUE_INDENT = '     ';
const RESULT_INDENT = '  ';

/**
 * Greedy word wrap in terminal CELLS, not code points. Preserves explicit
 * newlines; never loses a long unbreakable token.
 *
 * Cells matter here for the same reason as in the footer: the last line of a
 * streaming entry is live, so a line that measured within the width but rendered
 * wider would wrap and desync the screen writer's erase height.
 */
export function wrapText(text, width) {
  const limit = Math.max(8, Math.floor(width) || 80);
  const out = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    if (paragraph === '') { out.push(''); continue; }
    let line = '';
    let lineWidth = 0;
    for (const word of paragraph.split(/(\s+)/)) {
      if (word === '') continue;
      if (/^\s+$/.test(word)) { if (line !== '') { line += ' '; lineWidth += 1; } continue; }
      const wordWidth = stringWidth(word);
      if (wordWidth > limit) {
        // Hard-split an unbreakable token on cell boundaries — mid-line too, not
        // only at line start: a long token after other text must not overflow.
        if (line !== '') { out.push(line.trimEnd()); line = ''; lineWidth = 0; }
        let chunk = '';
        let chunkWidth = 0;
        for (const ch of word) {
          const w = stringWidth(ch);
          if (chunkWidth + w > limit) { out.push(chunk); chunk = ''; chunkWidth = 0; }
          chunk += ch;
          chunkWidth += w;
        }
        line = chunk;
        lineWidth = chunkWidth;
        continue;
      }
      if (lineWidth + wordWidth > limit) {
        out.push(line.trimEnd());
        line = word;
        lineWidth = wordWidth;
      } else {
        line += word;
        lineWidth += wordWidth;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/**
 * The argument a human scans for. Ordered by how the official runtime names them
 * (toolName + input shapes observed live: Bash{command}, file tools{file_path}).
 */
export function toolSummary(entry) {
  const input = entry?.input ?? {};
  const preferred = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description'];
  for (const key of preferred) {
    if (typeof input[key] === 'string' && input[key] !== '') return input[key];
  }
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

const STATUS_TOKEN = { ok: 'success', error: 'error', running: 'accent', scheduled: 'faint' };

/** theme.mjs only ever emits SGR — enough to measure a rendered line. */
const SGR = /\x1b\[[0-9;]*m/gu;
const visibleWidth = (line) => stringWidth(String(line ?? '').replace(SGR, ''));

/** @returns {string[]} rendered lines for one transcript entry */
export function renderEntry(entry, theme, width, options = {}) {
  const lines = renderEntryLines(entry, theme, width, options);
  // Config-gated audit trail: a faint HH:MM right-aligned on the entry's first
  // line — or its last when the header already fills the row (a wrapped prompt's
  // first line is greedy-full). A candidate line that fills the row keeps its
  // content whole: the stamp yields rather than clipping transcript text.
  const at = options.timestamps ? hhmm(entry?.at) : null;
  if (!at || lines.length === 0) return lines;
  const idx = [0, lines.length - 1].find(i => width - visibleWidth(lines[i]) - at.length >= 1);
  if (idx === undefined) return lines;
  const room = width - visibleWidth(lines[idx]) - at.length;
  return lines.map((l, i) => (i === idx ? `${l}${' '.repeat(room)}${theme.faint(at)}` : l));
}

/** @returns {string[]} rendered lines for one transcript entry, without the timestamp stamp */
export function renderEntryLines(entry, theme, width, options = {}) {
  const maxResultLines = options.maxResultLines ?? 6;
  const g = theme.glyph;
  const inner = Math.max(8, width - 2);

  if (entry.kind === 'user') {
    return wrapText(entry.text, inner).map((line, i) =>
      `${theme.userMark(i === 0 ? `${g.user} ` : '  ')}${theme.muted(line)}`);
  }

  if (entry.kind === 'notice') {
    const paint = theme[entry.level] ?? theme.muted;
    return wrapText(entry.text, inner).map(line => `  ${paint(line)}`);
  }

  // Reasoning is context, not the answer: dimmed, capped, and clearly labelled so
  // it can never be mistaken for what the model actually said.
  if (entry.kind === 'thinking') {
    const body = wrapText(entry.text.trim(), inner - 2).filter(l => l !== '');
    if (body.length === 0) return [];
    const str = options.str ?? stringsFor();
    const lines = [`${theme.thinking(g.bulletPending)} ${theme.thinking(str.thinking)}`];
    // Append-only: always the FIRST lines. Tail-following while streaming
    // contradicted the append-only screen writer — committed lines stayed put
    // while the live view scrolled, so the block rendered with stray gaps and
    // repeated fragments. Collapsed (Grok default) commits the header only;
    // expanding later appends the body. Undefined fold keeps the historical cap.
    const cap = options.fold === 'collapsed' ? 0
      : options.fold === 'expanded' ? body.length
      : options.maxThinkingLines ?? 3;
    const shown = body.slice(0, cap);
    for (const line of shown) lines.push(`  ${theme.faint(line)}`);
    const hidden = body.length - shown.length;
    // The phase duration (grok's "thought for Ns") rides the LAST line — the
    // only one still live once the header committed to scrollback; putting it
    // in the header would rewrite a committed line and re-print the block.
    const dur = entry.done === true ? formatDuration(entry.durationMs) : '';
    if (hidden > 0) {
      const count = str.reasoningHidden(hidden);
      // While the stream is open this is the LIVE line — the only one the
      // append-only writer repaints. Append the newest reasoning fragment so a
      // long thinking phase visibly moves instead of sitting behind a frozen
      // counter (the PTY-measured "screen shows only a spinner" defect). It
      // never commits: on settle the writer erases it and the count alone lands.
      const budget = inner - 2 - stringWidth(count);
      const tail = entry.done !== true && budget > 8 ? clipToWidth(body.at(-1), budget) : '';
      const suffix = dur !== '' ? ` · ${dur}` : '';
      lines.push(`  ${theme.faint(`${tail ? `${count}  ${tail}` : count}${suffix}`)}`);
    } else if (dur !== '') {
      lines.push(`  ${theme.faint(`· ${dur}`)}`);
    }
    return lines;
  }

  // Answers and slash-command output are the same shape — markdown under a mark —
  // and differ only in who is speaking: the model, or the runtime.
  // Model answers are markdown. Partial markdown mid-stream renders as literal
  // text (an unclosed ** never matches), so nothing already committed to
  // scrollback changes shape when the closing delimiter arrives.
  const mark = entry.kind === 'assistant' ? theme.accent(g.assistant)
    : entry.kind === 'command' ? theme.muted(g.result) : null;
  if (mark !== null) {
    if (String(entry.text ?? '').trim() === '') return [];
    return renderMarkdown(entry.text, theme, inner - 2)
      .map((line, i) => (i === 0 ? `${mark} ${line}` : `  ${line}`));
  }

  if (entry.kind === 'tool') {
    const paint = theme[STATUS_TOKEN[entry.status] ?? 'faint'];
    const summary = toolSummary(entry);
    const s2 = options.str ?? stringsFor();

    // Explore-group member (codex's exec cell): consecutive read/list/search
    // calls collapse under one `Explored` cell — the run's head carries the
    // header, every member one compact `Name args` line, and no per-call result
    // body (the noise is the point of the group). A failure still earns a
    // one-line excerpt; folded, the head collapses to header + call count.
    if (entry.explore === true) {
      if (options.fold === 'collapsed') {
        if (options.exploreHead !== true) return [];
        return [
          `${theme.accent(g.assistant)} ${theme.strong(s2.explored)}`,
          `${RESULT_INDENT}   ${theme.faint(s2.exploredCalls(options.exploreRun || 1))}`,
        ];
      }
      const member = clipToWidth(`${entry.name}${summary ? ` ${summary}` : ''}`, Math.max(4, inner - 5));
      const lines = [];
      // The header is a group label, not a status: a fixed paint keeps the
      // eagerly-committed line stable when the member settles (r1 MINOR).
      if (options.exploreHead === true) lines.push(`${theme.accent(g.assistant)} ${theme.strong(s2.explored)}`);
      lines.push(options.exploreHead === true
        ? `${RESULT_INDENT}${theme.faint(g.arm)} ${theme.muted(member)}`
        : `${RESULT_INDENT}  ${theme.muted(member)}`);
      if (entry.status === 'error') {
        const first = String(entry.resultText ?? '').split('\n').map(l => l.trim()).find(l => l !== '');
        if (first) lines.push(`${RESULT_INDENT}    ${theme.error(clipToWidth(first, Math.max(4, inner - 6)))}`);
      }
      return lines;
    }

    // The header must not wrap: a one-line summary is the whole point, and a
    // wrapped one would desync the screen writer while the tool is still live.
    // Budget in cells: glyph + space + name + "(args)" + timing must fit `inner`.
    const timingText = entry.durationMs != null && entry.durationMs > 0
      ? `  ${formatDuration(entry.durationMs)}` : '';
    const lead = stringWidth(g.assistant) + 1;
    const room = Math.max(4, inner - lead - stringWidth(timingText));
    const name = clipToWidth(entry.name, room);
    const argRoom = room - stringWidth(name);
    const args = argRoom >= 3 ? clipToWidth(`(${summary})`, argRoom) : '';
    const lines = [`${paint(g.assistant)} ${theme.strong(name)}${theme.muted(args)}${theme.faint(timingText)}`];

    if (entry.status === 'scheduled' || entry.status === 'running') {
      return lines;
    }
    // diff surface: a completed file-changing call paints the runtime's
    // recorded patch — colored +/- rows with the file's own syntax inside —
    // in place of the "updated successfully" prose (what every peer shows for
    // an edit). An error keeps its message; a call whose artifact never landed
    // keeps the prose. Rows are {text, paint?} so the head+tail budget and the
    // hidden counter measure plain text while the painter owns the styling.
    const diffRows = entry.status === 'ok' && entry.diff?.files?.some(f => f.lines.length > 0)
      ? flattenDiff(entry.diff, theme) : null;
    const rows = diffRows ?? String(entry.resultText ?? '').split('\n').map(text => ({ text }));
    if (rows.at(-1)?.text === '') rows.pop();   // a trailing newline, not blank lines inside the output
    if (rows.length === 0) return lines;
    const dropped = diffRows ? (entry.diff.dropped ?? 0) : (entry.resultDropped ?? 0);
    if (options.fold === 'collapsed') {
      const hidden = rows.length + dropped;
      if (hidden > 0) lines.push(`${RESULT_INDENT}   ${theme.faint(s2.linesHidden(hidden))}`);
      return lines;
    }
    // Head+tail (codex's head+tail exec split, opencode collapseToolOutput):
    // the conclusion of a long output — where an error or final result lands —
    // matters as much as its start, and a head-only cap hides exactly that.
    // The budget stays maxResultLines, split symmetric first-N + last-N around
    // one omission marker, so a flood costs the same rows as the old cap.
    const cellCap = Math.max(4, inner - 5);
    const paintRow = (row) => row.paint ? row.paint(cellCap) : theme.muted(clipToWidth(row.text, cellCap));
    const tailN = Math.floor(maxResultLines / 2);
    const overflow = rows.length > maxResultLines;
    const head2 = rows.slice(0, overflow ? maxResultLines - tailN : maxResultLines);
    // A multi-file patch tail must not open mid-file unattributed: back up to
    // that file's label row, as long as it neither eats into the shown head nor
    // blows the whole budget on one file's label.
    let tailStart = overflow && tailN > 0 ? rows.length - tailN : rows.length;
    if (diffRows && overflow && tailStart < rows.length) {
      const f0 = rows[tailStart]?.file;
      // Only multi-file patches carry label rows — a single file's rows have no
      // pathRow to land on and the walk would just grow the tail.
      if (rows.some(r => r.file === f0 && r.pathRow === true)) {
        let i = tailStart;
        while (i > head2.length && rows[i].file === f0
               && rows[i].pathRow !== true
               && rows.length - i < maxResultLines) i--;
        // Apply only when the walk actually reached the label — an unreachable
        // one must not cost extra rows for no attribution.
        if (rows[i]?.file === f0 && rows[i]?.pathRow === true) tailStart = i;
      }
    }
    const tail2 = overflow ? rows.slice(tailStart) : [];
    for (const [i, row] of head2.entries()) {
      lines.push(i === 0
        ? `${RESULT_INDENT}${theme.faint(g.result)}  ${paintRow(row)}`
        : `${RESULT_INDENT}   ${paintRow(row)}`);
    }
    const hidden = rows.length - head2.length - tail2.length + dropped;
    if (hidden > 0) lines.push(`${RESULT_INDENT}   ${theme.faint(s2.linesHidden(hidden))}`);
    else if (entry.truncated) lines.push(`${RESULT_INDENT}   ${theme.faint(s2.truncatedByRuntime)}`);
    for (const row of tail2) {
      lines.push(`${RESULT_INDENT}   ${paintRow(row)}`);
    }
    return lines;
  }

  return [];
}

// A tool call's recorded patch as {text, paint} rows. The scanner sees the code
// BODY of every +/-/' ' line in order — its cross-line state (block comments,
// triple strings) must stay right for rows the head+tail split hides — while
// the marker column is painted by diff semantics, not the file's grammar.
// Multi-file patches get a strong path row per file (the one-line header only
// names the first significant arg).
function flattenDiff(diff, theme) {
  const rows = [];
  const multi = diff.files.length > 1;
  for (const [fi, f] of diff.files.entries()) {
    const ext = /\.([A-Za-z0-9]+)$/.exec(f.path ?? '')?.[1];
    const scanFile = ext ? createScanner(ext) : null;
    if (multi && (f.lines ?? []).length) rows.push({ text: String(f.path ?? ''), file: fi, pathRow: true,
      paint: (c) => theme.strong(clipToWidth(String(f.path ?? ''), c)) });
    for (const raw of f.lines ?? []) {
      const text = String(raw);
      const tag = text.startsWith('@@') ? '@@'
        : (text[0] === '+' || text[0] === '-' || text[0] === ' ') ? text[0] : null;
      const spans = (tag === '+' || tag === '-' || tag === ' ') && scanFile ? scanFile(text.slice(1)) : null;
      rows.push({ text, file: fi, paint: (cells) => paintDiffRow(text, tag, spans, theme, cells) });
    }
  }
  return rows;
}

function paintDiffRow(text, tag, spans, theme, cells) {
  if (tag === '@@') return theme.synFunc(clipToWidth(text, cells));
  if (tag === null) return theme.synComment(clipToWidth(text, cells));  // diff/index/---/+++/'\' marker rows
  const mark = tag === '+' ? theme.success : tag === '-' ? theme.error : theme.faint;
  const body = spans ? paintSpans(spans, theme, Math.max(0, cells - 1))
    : theme.code(clipToWidth(text.slice(1), Math.max(0, cells - 1)));
  return mark(tag) + body;
}

export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  const minutes = Math.floor(n / 60_000);
  return `${minutes}m${String(Math.round((n % 60_000) / 1000)).padStart(2, '0')}s`;
}

export function formatTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

