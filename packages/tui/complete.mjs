// Inline completion for the prompt: slash commands and @-file references.
//
// Both are official runtime capabilities the host hands us and the TUI was not
// using — `slashCommands` (20 of them, with usage and summary) and
// `listWorkspacePathSuggestions`. Typing a command blind is the difference
// between "the runtime has 20 commands" and "the user can find them".
//
// The two share one mechanism: find the token under the cursor, rank candidates
// against it, replace the token on accept.

/**
 * What the cursor is sitting in, if anything completable.
 * Slash commands only complete at the very start of the input — mid-line "/" is
 * a path separator far more often than a command.
 * @returns {{type: 'slash'|'file'|'skill'|'conversation', query: string, start: number}|null}
 */
export function completionContext(value, cursor) {
  const text = String(value ?? '');
  const at = Math.max(0, Math.min(cursor ?? text.length, text.length));
  const head = text.slice(0, at);

  const slash = /^\/(\S*)$/u.exec(head);
  if (slash) return { type: 'slash', query: slash[1], start: 0 };

  const file = /(?:^|\s)@(\S*)$/u.exec(head);
  if (file) return { type: 'file', query: file[1], start: at - file[1].length - 1 };

  // Official GUI: `$` skills, `#` past conversations. Same token rules as `@`.
  const skill = /(?:^|\s)\$(\S*)$/u.exec(head);
  if (skill) return { type: 'skill', query: skill[1], start: at - skill[1].length - 1 };

  const conv = /(?:^|\s)#(\S*)$/u.exec(head);
  if (conv) return { type: 'conversation', query: conv[1], start: at - conv[1].length - 1 };

  return null;
}

/**
 * Rank candidates against a query. Prefix beats substring beats subsequence, so
 * "mod" puts /model above /compact even though both contain the letters.
 */
export function rankCandidates(candidates, query) {
  const q = String(query ?? '').toLowerCase();
  const valid = (candidates ?? []).filter(c => {
    const v = typeof c === 'string' ? c : c?.value;
    return typeof v === 'string' && v !== '';
  });
  // A bare "/" should show the runtime's own ordering (/help first), not ours.
  if (q === '') return valid;
  const scored = [];
  for (const candidate of valid) {
    // Return what the caller gave us: a string list ranks back to strings.
    const item = candidate;
    const value = typeof candidate === 'string' ? candidate : candidate.value;
    const lower = value.toLowerCase();
    const index = lower.indexOf(q);
    if (index === 0) scored.push({ item, value, rank: 0, at: 0 });
    else if (index > 0) scored.push({ item, value, rank: 1, at: index });
    else if (isSubsequence(q, lower)) scored.push({ item, value, rank: 2, at: 0 });
  }
  scored.sort((a, b) => a.rank - b.rank || a.at - b.at
    || a.value.length - b.value.length
    || a.value.localeCompare(b.value));
  return scored.map(s => s.item);
}

function isSubsequence(needle, haystack) {
  let i = 0;
  for (const ch of haystack) { if (ch === needle[i]) i += 1; if (i === needle.length) return true; }
  return needle.length === 0;
}

/** Replace the token being completed with `value`, returning the new input state. */
export function applyCompletion(input, context, value) {
  const text = String(input?.value ?? '');
  const cursor = Math.max(0, Math.min(input?.cursor ?? text.length, text.length));
  const prefix = ({ slash: '/', file: '@', skill: '$', conversation: '#' })[context.type] ?? '@';
  const replacement = `${prefix}${value}`;
  // A completed slash command wants a space; a completed directory wants to keep
  // completing, so only files get the trailing space — and never a second one
  // when the text after the cursor already starts with whitespace.
  const rest = text.slice(cursor);
  const wantsSpace = context.type === 'slash' || !value.endsWith('/');
  const trailing = wantsSpace && !/^\s/u.test(rest) ? ' ' : '';
  const next = text.slice(0, context.start) + replacement + trailing + rest;
  return { value: next, cursor: context.start + replacement.length + trailing.length };
}

/** Candidates for a slash context, from the host's own command list. */
export function slashCandidates(slashCommands) {
  const list = Array.isArray(slashCommands) ? slashCommands : [];
  return list
    .filter(c => c && typeof c.name === 'string' && c.name !== '')
    .map(c => ({
      value: c.name,
      // The runtime's usage line already says how to call it; the summary says why.
      hint: typeof c.summary === 'string' ? c.summary : '',
      usage: typeof c.usage === 'string' ? c.usage : `/${c.name}`,
    }));
}

/**
 * Candidates for a file context.
 *
 * The host's suggester is called as listWorkspacePathSuggestions({ token }) and
 * answers { items: [{ kind: 'file'|'directory', path }], truncated } — verified
 * live; passing a bare string throws inside the runtime.
 * A plain array is accepted too, so a different runtime build cannot break this.
 */
export function skillCandidates(skills) {
  const list = Array.isArray(skills) ? skills : [];
  return list
    .map((s) => {
      if (typeof s === 'string') return { value: s, hint: 'skill' };
      if (s && typeof s.value === 'string' && s.value) {
        return { value: s.value, hint: typeof s.hint === 'string' ? s.hint : 'skill' };
      }
      return null;
    })
    .filter(Boolean);
}

export function conversationCandidates(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .map((s) => {
      if (typeof s === 'string') return { value: s };
      if (s && typeof s.value === 'string' && s.value) {
        return { value: s.value, hint: typeof s.hint === 'string' ? s.hint : '' };
      }
      return null;
    })
    .filter(Boolean);
}

export function fileCandidates(suggestions) {
  const list = Array.isArray(suggestions) ? suggestions
    : Array.isArray(suggestions?.items) ? suggestions.items : [];
  return list
    .map(s => {
      if (typeof s === 'string') return { value: s };
      if (s && typeof s.path === 'string') return { value: s.path, kind: s.kind };
      return null;
    })
    .filter(Boolean);
}
