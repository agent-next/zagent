// E3 diff surfaces — read the per-tool-call change artifacts the runtime already writes.
//
// Every file-editing tool call drops `~/.zcode/cli/artifacts/<sessionId>/call_<id>-tool-result-<uuid>.json`
// with the GUI's diff shape (live-verified 2026-09-05, runtime 2.1.0):
//   {version:1, kind:'workspace_file_before_change', toolCallId, toolName,
//    createdAt, files:[{path, existedBefore, beforeContent,
//      structuredPatch:[{oldStart, oldLines, newStart, newLines, lines:[' ctx','-old','+new']}]}]}
// That artifact IS the diff surface: before-content (E4 rewind input) plus a unified-ish patch.

import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';

export function sessionDiffArtifacts(sessionId, { home = os.homedir() } = {}) {
  // Traversal guard (r2 #9, tightened r6 #3): single component, and never '.'/'..' —
  // the slug regex alone accepted '..' (resolves to ~/.zcode/cli).
  const sid = String(sessionId ?? '');
  if (!/^[\w.-]+$/.test(sid) || sid === '.' || sid === '..') return [];
  const dir = `${home}/.zcode/cli/artifacts/${sessionId}`;
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.includes('-tool-result-') || !n.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(`${dir}/${n}`, 'utf8'));
      if (d?.kind === 'workspace_file_before_change') out.push(d);
    } catch {} // a torn/corrupt artifact must not hide the others
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

// Per-file summary with +/- counts from the structured patch.
export function diffSummary(artifacts) {
  const byPath = new Map();
  for (const a of artifacts ?? []) for (const f of a.files ?? []) {
    const s = byPath.get(f.path) ?? { path: f.path, edits: 0, added: 0, removed: 0, tools: new Set(), existedBefore: f.existedBefore };
    s.edits++; s.tools.add(a.toolName);
    for (const h of f.structuredPatch ?? []) for (const l of h.lines ?? []) {
      if (l.startsWith('+')) s.added++;
      else if (l.startsWith('-')) s.removed++;
    }
    if (!f.structuredPatch?.length && f.afterContent != null) // r6 #2: new-file creations count their lines
      s.added += f.afterContent === '' ? 0 : (f.afterContent.endsWith('\n') ? f.afterContent.slice(0, -1) : f.afterContent).split('\n').length;
    byPath.set(f.path, s);
  }
  return [...byPath.values()].map(s => ({ ...s, tools: [...s.tools] }));
}

// One-liner: "calc.py +1/-1 (Edit)" — the TUI status form.
export function diffLine(artifacts) {
  const s = diffSummary(artifacts);
  if (!s.length) return 'no file changes';
  return s.map(x => `${x.path.split('/').pop()} +${x.added}/-${x.removed} (${x.tools.join('/')})`).join(' · ');
}

// --- E3 undo: preview → apply, with external-modification safety ---
// Undo restores beforeContent, but ONLY if the file on disk still matches what the edit
// produced. We reconstruct the expected after-state by applying the structuredPatch to
// beforeContent (line-based, GUI hunk shape: {oldStart, oldLines, newStart, newLines,
// lines}); a mismatch means someone else touched the file since → external_modified,
// apply stays 'ignored', never clobbers foreign work.

function applyHunks(before, hunks) { // → after-state per the patch, or null if hunks don't fit
  // Sequential line-by-line applier with verification: ' ' matches+keeps, '-' matches+drops,
  // '+' emits. '\\'-prefixed records are newline METADATA (git's "\ No newline at end of
  // file"), not source lines (review r2 #5). Bounded pushes only — no argument spreading,
  // which stack-overflows on ~200k-line files (review r2 #8).
  const src = before === '' ? [] : before.split('\n');
  const out = [];
  let si = 0, prevOldStart = -1;
  for (const raw of hunks ?? []) {
    const h = { ...raw, oldStart: raw.oldStart === 0 ? 1 : raw.oldStart }; // 0 = new-file marker
    if (h.oldStart <= prevOldStart) return null; // unsorted/overlapping hunks
    prevOldStart = h.oldStart;
    if (h.oldStart - 1 < si) return null;
    for (let k = si; k < h.oldStart - 1; k++) out.push(src[k]); // untouched gap, bounded
    si = h.oldStart - 1;
    for (const l of h.lines ?? []) {
      if (l.startsWith('\\')) continue; // newline marker: metadata, consumes nothing
      const tag = l[0], text = l.slice(1);
      if (tag === '+') { out.push(text); continue; }
      if (si >= src.length || src[si] !== text) return null; // ' ' or '-' must match source
      si++;
      if (tag === ' ') out.push(text);
      else if (tag !== '-') return null;
    }
  }
  for (let k = si; k < src.length; k++) out.push(src[k]); // tail, bounded
  return out.join('\n');
}

// Newline-agnostic comparison: the runtime LF-normalizes artifact content while the file
// on disk may keep CRLF (review r2 #6) — compare after LF normalization, and restore in
// the DISK file's dominant ending when it differs from the recorded one.
const lf = s => s.replace(/\r\n/g, '\n');
function restoreFor(diskContent, restore) {
  if (!diskContent || !restore || !restore.includes('\n')) return restore;
  const crlf = (diskContent.match(/\r\n/g) ?? []).length;
  const lfOnly = (diskContent.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lfOnly ? restore.replace(/\n/g, '\r\n') : restore;
}

// artifacts → per-file undo verdict. readCurrent(path) returns current content or null.
export function undoPreview(artifacts, readCurrent) {
  const plans = [];
  const byPath = new Map();
  for (const a of artifacts ?? []) for (const f of a.files ?? []) byPath.set(f.path, f); // LAST artifact per file wins
  for (const [path, f] of byPath) {
    const cur = readCurrent(path);
    if (cur === null) { plans.push({ path, canApply: false, state: 'file_missing' }); continue; }
    // Write-tool artifacts for NEW files: beforeContent null, empty patch, truth in
    // afterContent (review r2 #7) — verify via afterContent; undo = delete the file.
    if (f.beforeContent == null && f.structuredPatch?.length === 0) {
      if (typeof f.afterContent !== 'string') {
        plans.push({ path, canApply: false, state: 'unsafe', reason: 'creation artifact has no afterContent to verify' });
      } else if (lf(cur) !== lf(f.afterContent)) {
        plans.push({ path, canApply: false, state: 'external_modified', reason: 'file changed since creation; refusing to clobber' });
      } else plans.push({ path, canApply: true, state: 'safe', delete: true, restore: null, expectedAfter: cur });
      continue;
    }
    const after = applyHunks(f.beforeContent ?? '', f.structuredPatch);
    if (after === null) {
      plans.push({ path, canApply: false, state: 'unsafe', reason: 'patch does not reconstruct (hunks do not fit beforeContent)' });
      continue;
    }
    if (lf(cur) !== lf(after)) { plans.push({ path, canApply: false, state: 'external_modified', reason: 'file changed since the edit; refusing to clobber' }); continue; }
    plans.push({ path, canApply: true, state: 'safe', restore: restoreFor(cur, f.beforeContent ?? ''), expectedAfter: after });
  }
  return plans;
}

// Apply the previewed plans — RE-VERIFIED at write time against the live file (review r2
// #2): a stale preview must never overwrite later edits. delete plans remove the file.
export function undoApply(plans, writeCurrent, { readCurrent, removeCurrent } = {}) {
  return plans.map(p => {
    if (!p.canApply) return { path: p.path, state: p.state, reverted: false };
    try {
      if (p.delete) {
        if (!removeCurrent) return { path: p.path, state: 'unsafe', reverted: false, error: 'deletion requires removeCurrent' };
        if (!readCurrent || typeof p.expectedAfter !== 'string')
          return { path: p.path, state: 'unsafe', reverted: false, error: 'deletion requires readCurrent and verified creation content' };
        const current = readCurrent(p.path);
        if (current === null) return { path: p.path, state: 'file_missing', reverted: false };
        if (current !== p.expectedAfter) return { path: p.path, state: 'external_modified', reverted: false };
        removeCurrent(p.path); return { path: p.path, state: 'reverted', reverted: true, deleted: true };
      }
      if (readCurrent && p.expectedAfter !== undefined && lf(readCurrent(p.path) ?? '') !== lf(p.expectedAfter))
        return { path: p.path, state: 'external_modified', reverted: false };
      writeCurrent(p.path, p.restore);
      return { path: p.path, state: 'reverted', reverted: true };
    } catch (e) { return { path: p.path, state: 'write_failed', reverted: false, error: String(e?.message ?? e) }; }
  });
}

// --- E3 CLI surface: per-turn aggregate + per-file hunks, rendered from artifacts ---

export function sessionsWithDiffs({ home = os.homedir() } = {}) {
  const root = `${home}/.zcode/cli/artifacts`;
  let names; try { names = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  // r6 #4: real directories with at least one valid change artifact — '(0 edits)' ghosts removed
  return names.filter(e => e.isDirectory() && /^[\w.-]+$/.test(e.name) && e.name !== '.' && e.name !== '..')
              .map(e => e.name).filter(id => sessionDiffArtifacts(id, { home }).length > 0);
}

export function renderDiff(artifacts) {
  const summary = diffSummary(artifacts);
  if (!summary.length) return 'no file changes';
  const totalA = summary.reduce((s, x) => s + x.added, 0), totalD = summary.reduce((s, x) => s + x.removed, 0);
  const lines = [`+${totalA} -${totalD} · ${summary.length} file${summary.length > 1 ? 's' : ''}`];
  for (const a of artifacts) for (const f of a.files ?? []) {
    lines.push(`\n${f.path} (${a.toolName})`);
    const hunks = f.structuredPatch ?? [];
    if (!hunks.length && f.afterContent != null) { // r6 #2: Write-tool new files render as a creation hunk
      const body = f.afterContent.endsWith('\n') ? f.afterContent.slice(0, -1) : f.afterContent; // git convention: one trailing newline is not a line
      const rows = body === '' ? [] : body.split('\n');
      lines.push(`@@ -0,0 +1,${rows.length} @@`);
      for (const l of rows) lines.push(`+${l}`);
    }
    for (const h of hunks) {
      lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
      for (const l of h.lines ?? []) lines.push(l);
    }
  }
  return lines.join('\n');
}
