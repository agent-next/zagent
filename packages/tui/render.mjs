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
import { stringWidth, clipToWidth } from './width.mjs';
import { stringsFor } from './strings.mjs';

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
      if (line === '' && wordWidth > limit) {
        // Hard-split an unbreakable token on cell boundaries.
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

/** @returns {string[]} rendered lines for one transcript entry */
export function renderEntry(entry, theme, width, options = {}) {
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
    const cap = options.maxThinkingLines ?? 3;
    const body = wrapText(entry.text.trim(), inner - 2).filter(l => l !== '');
    if (body.length === 0) return [];
    // Append-only: always the FIRST lines. Tail-following while streaming
    // contradicted the append-only screen writer — committed lines stayed put
    // while the live view scrolled, so the block rendered with stray gaps and
    // repeated fragments.
    const shown = body.slice(0, cap);
    const str = options.str ?? stringsFor();
    const lines = [`${theme.thinking(g.bulletPending)} ${theme.thinking(str.thinking)}`];
    for (const line of shown) lines.push(`  ${theme.faint(line)}`);
    const hidden = body.length - shown.length;
    if (hidden > 0) lines.push(`  ${theme.faint(str.reasoningHidden(hidden))}`);
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
    const body = String(entry.resultText ?? '').split('\n');
    if (body.at(-1) === '') body.pop();   // a trailing newline, not blank lines inside the output
    if (body.length === 0) return lines;
    const head2 = body.slice(0, maxResultLines);
    for (const [i, raw] of head2.entries()) {
      const text = clipToWidth(raw, Math.max(4, inner - 5));
      lines.push(i === 0
        ? `${RESULT_INDENT}${theme.faint(g.result)}  ${theme.muted(text)}`
        : `${RESULT_INDENT}   ${theme.muted(text)}`);
    }
    const hidden = body.length - head2.length + (entry.resultDropped ?? 0);
    const s2 = options.str ?? stringsFor();
    if (hidden > 0) lines.push(`${RESULT_INDENT}   ${theme.faint(s2.linesHidden(hidden))}`);
    else if (entry.truncated) lines.push(`${RESULT_INDENT}   ${theme.faint(s2.truncatedByRuntime)}`);
    return lines;
  }

  return [];
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

