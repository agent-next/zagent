#!/usr/bin/env node
// zagent diff [sessionId] — E3 surface: per-turn +A -D · N files + per-file hunks,
// rendered from the runtime's own change artifacts. No sessionId: list sessions that have them.
import { sessionDiffArtifacts, sessionsWithDiffs, renderDiff } from '../driver/diffs.mjs';
const argv = process.argv.slice(2);
if (argv.length > 1) { console.error('usage: zagent diff [sessionId]'); process.exit(2); } // r6 #5
const sid = argv[0];
if (!sid) {
  const s = sessionsWithDiffs();
  if (!s.length) console.log('no sessions with file changes');
  else for (const id of s) console.log(id, `(${sessionDiffArtifacts(id).length} edits)`);
} else {
  const arts = sessionDiffArtifacts(sid);
  if (!arts.length) { console.error(`no change artifacts for session ${sid}`); process.exit(1); }
  console.log(renderDiff(arts));
}
