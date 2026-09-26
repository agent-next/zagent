// E1: @-mention extraction — the TUI's mention sugar for headless/bot surfaces.
// Pure function: pull @tokens from a prompt, resolve each against the workspace root
// (existsSync check), and report found/missing/rejected. NO content injection here —
// callers decide how to attach (the runtime's own tools read files); this validates
// and rewrites each resolved token to its canonical (real) path. Tokens that
// resolve outside the workspace root are refused (@/etc/passwd, @../x, and
// symlinks pointing out of the workspace), not resolved.
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
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
  const found = [], missing = [], rejected = [];
  const root = path.resolve(workspaceRoot);
  // Containment is checked twice: lexically on the joined path (cheap reject for
  // `..` and absolute tokens), then on the REAL path — statSync follows links,
  // so a symlink inside the workspace could otherwise point a bot's mention at
  // any file on the filesystem.
  const inside = (p, base) => p.startsWith(base + path.sep); // a file is always strictly under root
  let realRoot = root;
  try { realRoot = realpathSync(root); } catch {}
  const cache = new Map(); // r15 #3: duplicate tokens resolved once
  let budget = MAX_MENTIONS;
  const rewritten = String(prompt ?? '').replace(TOKEN, (full, boundary, tok) => {
    if (budget <= 0) return full;
    let p;
    if (cache.has(tok)) p = cache.get(tok);
    else {
      p = path.resolve(root, tok);
      cache.set(tok, p);
    }
    budget--; // r16 #4: budget consumes on EVERY probe (missing mentions are also fs work)
    if (!inside(p, root)) { rejected.push({ token: tok, path: p }); return full; }
    let real = null;
    try { real = realpathSync(p); } catch {}
    if (real === null) {
      // Missing — or a dangling symlink: read the link itself so a planted link
      // pointing outside the workspace is refused rather than quietly missing.
      try {
        if (lstatSync(p).isSymbolicLink()
            && !inside(path.resolve(realpathSync(path.dirname(p)), readlinkSync(p)), realRoot)) {
          rejected.push({ token: tok, path: p });
          return full;
        }
      } catch {}
      missing.push({ token: tok, path: p });
      return full;
    }
    if (!inside(real, realRoot)) { rejected.push({ token: tok, path: p }); return full; } // symlink escape
    let ok = false;
    try { ok = real !== null && statSync(real).isFile(); } catch {}
    if (ok) { found.push({ token: tok, path: real }); return `${boundary}@${real}`; } // r15 #1: boundary preserved EXACTLY
    missing.push({ token: tok, path: p });
    return full;
  });
  return { found, missing, rejected, rewritten };
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
  const parts = [];
  if (r.missing.length) parts.push(`unresolved mention(s): ${r.missing.map(m => '@' + m.token).join(', ')} — not found under ${workspaceRoot}`);
  if (r.rejected.length) parts.push(`refused mention(s) outside the workspace: ${r.rejected.map(m => '@' + m.token).join(', ')}`);
  if (parts.length) return { prompt: null, note: parts.join('; ') };
  if (r.found.length) return { prompt: `${r.rewritten}\n(referenced: ${r.found.map(f => f.path).join(', ')})`, note: null };
  return { prompt, note: null };
}
