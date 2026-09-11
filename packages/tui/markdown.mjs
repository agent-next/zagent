// Terminal markdown, sized for agent output rather than for documents.
//
// Model answers are markdown; printing them raw is the single most visible
// quality gap against Claude Code / ccz. This handles what agents actually emit
// — fenced code, headings, lists, blockquotes, rules, GFM tables, and inline
// emphasis/code/links — and deliberately not footnotes or reference links.
//
// Fences are tracked as state so a '#' or '-' inside a code block is never
// styled as a heading or a bullet.

import { wrapText } from './render.mjs';
import { charWidth, clipToWidth, stringWidth } from './width.mjs';

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*(\S+)?/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})([.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

const DELIM_CELL = /^:?-+:?$/;
const COL_SEP = ' │ ';
const COL_SEP_WIDTH = 3;
const COL_MIN = 3;

/**
 * Inline spans. Applied in one pass over a plain line so nested ANSI never
 * needs re-parsing; code spans win because their content is literal.
 */
export function renderInline(text, theme) {
  const source = String(text ?? '');
  let out = '';
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);

    const code = /^`([^`\n]+)`/.exec(rest);
    if (code) { out += theme.code(code[1]); i += code[0].length; continue; }

    const link = /^\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      out += link[1] ? `${theme.accent(link[1])} ${theme.faint(link[2])}` : theme.accent(link[2]);
      i += link[0].length; continue;
    }

    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) { out += theme.strong(renderInline(strong[2], theme)); i += strong[0].length; continue; }

    // Single * or _ only when it actually closes; a bare asterisk stays literal.
    // '_' additionally may not open or close INSIDE a word (CommonMark), or
    // snake_case_name renders as emphasis — very common in agent output.
    const em = /^([*_])(?=\S)([^\n]*?\S)\1/.exec(rest);
    if (em && !/^\s/.test(em[2])) {
      const intraword = em[1] === '_'
        && (/\w/.test(source[i - 1] ?? '') || /\w/.test(source[i + em[0].length] ?? ''));
      if (!intraword) { out += theme.strong(renderInline(em[2], theme)); i += em[0].length; continue; }
    }

    out += source[i];
    i += 1;
  }
  return out;
}

/**
 * One table row -> trimmed cell texts. Splits on unescaped pipes only: a literal
 * pipe inside a cell — including inside a code span — is written '\|' per GFM.
 */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && s[s.length - 2] !== '\\') s = s.slice(0, -1);
  const cells = [''];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cells[cells.length - 1] += '|'; i++; }
    else if (s[i] === '|') cells.push('');
    else cells[cells.length - 1] += s[i];
  }
  return cells.map(c => c.trim());
}

/** True when a line can join a table: it has a pipe and opens no other block. */
function isTableLine(line) {
  return line.includes('|') && line.trim() !== ''
    && !FENCE.test(line) && !HEADING.test(line) && !QUOTE.test(line)
    && !RULE.test(line) && !BULLET.test(line) && !ORDERED.test(line);
}

/**
 * A delimiter row -> per-column alignment ('left' | 'right' | 'center'), or
 * null when the line is not one.
 */
function tableAligns(line) {
  const aligns = [];
  for (const cell of splitRow(line)) {
    if (!DELIM_CELL.test(cell)) return null;
    aligns.push(cell.startsWith(':') && cell.endsWith(':') ? 'center'
      : cell.endsWith(':') ? 'right' : 'left');
  }
  return aligns;
}

/** Clip, then pad one cell to exactly `width` cells on the given alignment. */
function alignCell(text, width, align) {
  const clipped = clipToWidth(text, width);
  const gap = width - stringWidth(clipped);
  if (gap <= 0) return clipped;
  if (align === 'right') return ' '.repeat(gap) + clipped;
  if (align === 'center') {
    const lead = Math.floor(gap / 2);
    return ' '.repeat(lead) + clipped + ' '.repeat(gap - lead);
  }
  return clipped + ' '.repeat(gap);
}

/**
 * wrapText floors at 8 cells; a column squeezed narrower must still wrap rather
 * than clip, so narrow cells hard-split on exact cell boundaries.
 */
function wrapCell(text, width) {
  if (width >= 8) return wrapText(text, width);
  const out = [''];
  let used = 0;
  for (const ch of String(text)) {
    const w = charWidth(ch.codePointAt(0));
    if (used > 0 && used + w > width) { out.push(''); used = 0; }
    out[out.length - 1] += ch;
    used += w;
  }
  return out;
}

/**
 * Header, divider and body rows for one table, every line <= inner cells.
 * Rendered as pipe-separated rows over a '─┼─' divider — the same light chrome
 * as quotes and rules, not a boxed grid.
 *
 * Columns take their natural width, then shrink widest-first until cells plus
 * separators fit. Cells wrap inside their column instead of clipping, so a
 * squeezed table loses no characters; a row that still cannot fit (more
 * columns than the terminal has cells) is clipped whole.
 */
function renderTable(header, aligns, rows, theme, inner) {
  const cols = header.length;
  const out = [];
  const widths = header.map((h, c) => {
    let w = stringWidth(h);
    for (const row of rows) w = Math.max(w, stringWidth(row[c] ?? ''));
    return Math.max(COL_MIN, w);
  });
  let over = widths.reduce((a, b) => a + b, 0) + COL_SEP_WIDTH * (cols - 1) - inner;
  while (over > 0) {
    let widest = -1;
    for (let c = 0; c < cols; c++) {
      if (widths[c] > COL_MIN && (widest < 0 || widths[c] > widths[widest])) widest = c;
    }
    if (widest < 0) break;
    widths[widest]--;
    over--;
  }

  const emitRow = (cells, strong) => {
    const wrapped = widths.map((w, c) => wrapCell(cells[c] ?? '', w));
    const height = Math.max(...wrapped.map(w => w.length));
    for (let r = 0; r < height; r++) {
      const parts = wrapped.map((frags, c) => alignCell(frags[r] ?? '', widths[c], aligns[c]));
      const plain = parts.join(COL_SEP);
      // Width is proven on the PLAIN line before ANSI goes in — escapes count
      // as cells to stringWidth, so a styled line can never be re-clipped.
      out.push(stringWidth(plain) <= inner
        ? parts.map(p => strong ? theme.strong(renderInline(p, theme)) : renderInline(p, theme))
            .join(theme.faint(COL_SEP))
        : renderInline(clipToWidth(plain, inner), theme));
    }
  };

  emitRow(header, true);
  out.push(theme.faint(clipToWidth(widths.map(w => '─'.repeat(w)).join('─┼─'), inner)));
  for (const row of rows) emitRow(row, false);
  return out;
}

/**
 * @param {string} text markdown source
 * @returns {string[]} terminal lines, already wrapped to `width`
 */
export function renderMarkdown(text, theme, width) {
  const inner = Math.max(8, width);
  const lines = [];
  let fence = null;
  const source = String(text ?? '').split('\n');

  for (let i = 0; i < source.length; i++) {
    const raw = source[i];
    const fenceMatch = FENCE.exec(raw);
    if (fenceMatch && (fence === null || raw.trimStart().startsWith(fence))) {
      if (fence === null) {
        fence = fenceMatch[1];
        const lang = fenceMatch[2];
        if (lang) lines.push(theme.faint(lang));
      } else {
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      // Code is never wrapped: broken indentation is worse than a truncated line.
      lines.push(`  ${theme.code(clipToWidth(raw, Math.max(4, inner - 2)))}`);
      continue;
    }

    if (raw.trim() === '') { lines.push(''); continue; }

    // GFM table: a pipe-bearing paragraph line followed by a delimiter row of
    // the same cell count. Once matched, rows are consumed whole — anything
    // that is not a table line resumes normal block parsing.
    if (isTableLine(raw) && i + 1 < source.length) {
      const header = splitRow(raw);
      const aligns = tableAligns(source[i + 1]);
      if (aligns !== null && aligns.length === header.length) {
        const rows = [];
        let j = i + 2;
        while (j < source.length && isTableLine(source[j])) rows.push(splitRow(source[j++]));
        lines.push(...renderTable(header, aligns, rows, theme, inner));
        i = j - 1;
        continue;
      }
    }

    if (RULE.test(raw)) { lines.push(theme.faint('─'.repeat(Math.min(inner, 40)))); continue; }

    const heading = HEADING.exec(raw);
    if (heading) {
      for (const line of wrapText(heading[2], inner)) lines.push(theme.strong(theme.accent(line)));
      continue;
    }

    const quote = QUOTE.exec(raw);
    if (quote) {
      for (const line of wrapText(quote[1], inner - 2)) lines.push(`${theme.faint('│')} ${theme.muted(renderInline(line, theme))}`);
      continue;
    }

    // Bulleted and numbered items differ only in their marker; the bullet case's
    // constants are the same arithmetic with marker length 1.
    const bullet = BULLET.exec(raw);
    const ordered = bullet ? null : ORDERED.exec(raw);
    const item = bullet ? { indent: bullet[1], marker: '•', text: bullet[3] }
      : ordered ? { indent: ordered[1], marker: `${ordered[2]}${ordered[3]}`, text: ordered[4] } : null;
    if (item) {
      const pad = ' '.repeat(item.indent.length);
      const body = wrapText(item.text, Math.max(8, inner - item.indent.length - item.marker.length - 1));
      lines.push(`${pad}${theme.accent(item.marker)} ${renderInline(body[0] ?? '', theme)}`);
      for (const cont of body.slice(1)) lines.push(`${pad}${' '.repeat(item.marker.length + 1)}${renderInline(cont, theme)}`);
      continue;
    }

    for (const line of wrapText(raw, inner)) lines.push(renderInline(line, theme));
  }

  // An unterminated fence is the model being cut off, not a parse failure.
  return lines;
}
