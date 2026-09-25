// E1: @-mention extraction — the TUI's mention sugar for headless/bot surfaces.
// Pure function: pull @tokens from a prompt, resolve each against the workspace root
// (existsSync check), and report found/missing. NO content injection here — callers
// decide how to attach (the runtime's own tools read files); this only validates and
// rewrites the token to the resolved path.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const TOKEN = /(^|\s)@([^\s@]+)/gu; // r15 #2: full token + unicode mode (no 200-char surrogate splits)
const MAX_MENTIONS = 32;             // r15 #3: bounded sync-fs work in bot handlers

export function extractMentions(prompt) {
  const out = [];
  for (const m of String(prompt ?? '').matchAll(TOKEN)) {
    if (out.length >= MAX_MENTIONS) break; // capped: an unbounded list blocks webhook handling
    out.push(m[2]);
  }
  return out;
}

export function resolveMentions(prompt, workspaceRoot = process.cwd()) {
  const found = [], missing = [];
  const cache = new Map(); // r15 #3: duplicate tokens resolved once
  let budget = MAX_MENTIONS;
  const rewritten = String(prompt ?? '').replace(TOKEN, (full, boundary, tok) => {
    if (budget <= 0) return full;
    let p;
    if (cache.has(tok)) p = cache.get(tok);
    else {
      p = path.resolve(workspaceRoot, tok);
      cache.set(tok, p);
    }
    let ok = false;
    try { ok = existsSync(p) && statSync(p).isFile(); } catch {}
    budget--; // r16 #4: budget consumes on EVERY probe (missing mentions are also fs work)
    if (ok) { found.push({ token: tok, path: p }); return `${boundary}@${tok}`; } // r15 #1: boundary preserved EXACTLY
    missing.push({ token: tok, path: p });
    return full;
  });
  return { found, missing, rewritten };
}

export function mentionsLine(r) {
  if (!r?.found?.length) return 'no file mentions';
  return r.found.map(f => `@${f.token} → ${f.path}`).join('\n') + (r.missing?.length ? `\nmissing: ${r.missing.map(m => '@' + m.token).join(', ')}` : '');
}

// Bot wiring helper: validate mentions before spending a turn; missing files get an
// immediate reply instead of the model guessing. Returns {prompt, note} — callers
// send `note` as the reply when set and skip the turn.
export function preprocessForBot(prompt, workspaceRoot) {
  const r = resolveMentions(prompt, workspaceRoot);
  if (r.missing.length) return { prompt: null,
    note: `unresolved mention(s): ${r.missing.map(m => '@' + m.token).join(', ')} — not found under ${workspaceRoot}` };
  if (r.found.length) return { prompt: `${r.rewritten}\n(referenced: ${r.found.map(f => f.path).join(', ')})`, note: null };
  return { prompt, note: null };
}
