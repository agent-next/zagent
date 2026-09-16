// Persistent input history. The runtime keeps its own recall (host.recallPreviousInput)
// but a fresh session — or a host without it — left up-arrow dead. One JSON line
// per submitted input under the usual cli dir; the newest HISTORY_CAP are kept.
// Entries carry their paste chips so a recalled `[Pasted ~N lines]` token still
// expands. Corrupt lines are dropped at load, and a file that drifted is
// rewritten clean — the file can only heal if something rewrites it.
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HISTORY_CAP = 50;
const HISTORY_MODE = 0o600;
// A `/login <key>`-style command carries its credential in the typed line.
// It stays recallable in-session but never lands on disk.
const NEVER_PERSIST = /^\/(?:login|logout|auth)\s+\S/i;

const rewrite = (file, keptLines) => {
  // tmp+rename: a plain rewrite could leave a truncated file on a mid-write
  // crash. The tmp carries HISTORY_MODE — the rename keeps it, not the target's.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, keptLines.join('\n') + '\n', { mode: HISTORY_MODE });
    // mode only applies at creation — a leftover tmp could carry a loose mode
    // through the rename.
    try { chmodSync(tmp, HISTORY_MODE); } catch {}
    renameSync(tmp, file);
  } catch { try { rmSync(tmp, { force: true }); } catch {} }
};

export function historyPath({ home = os.homedir() } = {}) {
  return path.join(home, '.zcode', 'cli', 'history.jsonl');
}

const cleanChips = (list) => (Array.isArray(list) ? list : [])
  .filter((c) => c && typeof c.token === 'string' && typeof c.text === 'string')
  .map(({ token, text }) => ({ token, text }));

export function loadHistory({ home } = {}) {
  let file;
  try { file = historyPath({ home }); } catch { return []; }   // a non-string home fails closed like appendHistory
  let lines;
  try { lines = readFileSync(file, 'utf8').split('\n'); } catch { return []; }
  // A drifted 0644 file stays readable by group/others even when it needs no
  // rewrite — tighten on every load like the credential store does.
  try { chmodSync(file, HISTORY_MODE); } catch {}
  const entries = [];
  let corrupt = false;
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.text === 'string' && parsed.text.trim() !== '') {
        entries.push({ text: parsed.text, chips: cleanChips(parsed.chips) });
      } else corrupt = true;
    } catch { corrupt = true; }
  }
  const kept = entries.slice(-HISTORY_CAP);
  if (corrupt || kept.length < entries.length) {
    // tmp+rename: a plain rewrite could lose a concurrent TUI's append landing
    // between our read and write, or leave a truncated file on a mid-write crash.
    rewrite(file, kept.map((e) => JSON.stringify(e)));
  }
  return kept;
}

export function appendHistory(entry, { home } = {}) {
  try {
    if (NEVER_PERSIST.test(entry.text)) return;
    const file = historyPath({ home });
    mkdirSync(path.dirname(file), { recursive: true });
    // 0600 like config.json: prompts can carry pasted secrets and paths.
    appendFileSync(file, JSON.stringify({ text: entry.text, chips: cleanChips(entry.chips) }) + '\n', { mode: HISTORY_MODE });
    chmodSync(file, HISTORY_MODE); // the mode arg only applies at creation — heal a drifted file
    // The cap is enforced at LOAD — without this a long session grows the file
    // without bound until the next launch. Trim the tail when it drifts over.
    let lines;
    try { lines = readFileSync(file, 'utf8').split('\n'); } catch { return; }
    // Same predicate as load: a whitespace-only line is dropped, not capped.
    const nonEmpty = lines.filter((l) => l.trim() !== '');
    if (nonEmpty.length > HISTORY_CAP) rewrite(file, nonEmpty.slice(-HISTORY_CAP));
  } catch {}
}
