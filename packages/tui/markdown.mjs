// Terminal markdown, sized for agent output rather than for documents.
//
// Model answers are markdown; printing them raw is the single most visible
// quality gap against Claude Code / ccz. This handles what agents actually emit
// — fenced code, headings, lists, blockquotes, rules, and inline emphasis/code/
// links — and deliberately not tables, footnotes, or reference links.
//
// Fences are tracked as state so a '#' or '-' inside a code block is never
// styled as a heading or a bullet.

import { wrapText } from './render.mjs';
import { clipToWidth } from './width.mjs';

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*(\S+)?/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})([.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

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
 * @param {string} text markdown source
 * @returns {string[]} terminal lines, already wrapped to `width`
 */
export function renderMarkdown(text, theme, width) {
  const inner = Math.max(8, width);
  const lines = [];
  let fence = null;

  for (const raw of String(text ?? '').split('\n')) {
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
