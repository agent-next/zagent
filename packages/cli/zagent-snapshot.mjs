#!/usr/bin/env node
// zagent snapshot — inspect or disable the desktop app's workspace-snapshot
// upload staging (see packages/driver/snapshot-guard.mjs for what it is).
// zagent's own headless/TUI path never runs that pipeline — it lives in the
// desktop host bundle — but any logged-in desktop session on this machine
// does. `lock` wipes staged artifacts and makes the staging dir unwritable;
// `unlock` restores it. Each dispatched zagent command re-applies the lock —
// `unlock` records a persistent opt-out, `lock` opts back in.
import { snapshotStatus, lockSnapshots, unlockSnapshots, snapshotLine, humanBytes } from '../driver/snapshot-guard.mjs';

const USAGE = 'usage: zagent snapshot [status [--json]|lock|unlock]';
const args = process.argv.slice(2);
const json = args.includes('--json');
const positional = args.filter(a => !a.startsWith('-'));
const VERBS = new Set(['status', 'lock', 'unlock']);
if (args.some(a => a.startsWith('-') && a !== '--json') || positional.length > 1 || (positional[0] && !VERBS.has(positional[0]))) {
  console.error(USAGE);
  process.exit(2);
}
const verb = positional[0] ?? 'status';

if (verb === 'status') {
  const s = snapshotStatus();
  if (json) {
    process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
  } else {
    console.log(snapshotLine(s));
    console.log(`  root: ${s.root}`);
  }
  // A finding exits nonzero so `zagent snapshot status` works as a check.
  process.exit(s.state === 'pending' ? 1 : 0);
}

if (verb === 'lock') {
  const r = lockSnapshots();
  if (json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  if (!r.ok) {
    if (!json) console.error(`zagent: snapshot lock failed (${r.reason})`);
    process.exit(1);
  }
  if (!json) {
    console.log(`locked ${snapshotStatus().root} (${r.method === 'immutable' ? 'immutable flag' : r.method === 'already-locked' ? 'already locked' : r.method === 'not-a-directory' ? 'path is not a directory' : 'mode 0000'})`);
    if (r.removedFiles) console.log(`removed ${r.removedFiles} staged file${r.removedFiles === 1 ? '' : 's'} (${humanBytes(r.removedBytes)})`);
    // unlock refuses a foreign entry at the path — the remedy is manual.
    if (r.method === 'not-a-directory') console.log("a non-directory entry sits at the staging path — remove it manually ('zagent snapshot unlock' refuses foreign files)");
    else console.log("the desktop app's workspace-snapshot upload can no longer stage files; 'zagent snapshot unlock' restores");
  }
  process.exit(0);
}

const r = unlockSnapshots();
if (json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
if (!r.ok) {
  if (!json) console.error(`zagent: snapshot unlock failed (${r.reason === 'not-a-directory' ? 'staging path is a plain file — remove it manually' : r.reason})`);
  process.exit(1);
}
if (!json) console.log(`${r.changed ? 'unlocked' : 'staging was not locked'} — the desktop app can stage workspace uploads again; auto-guard stays off until 'zagent snapshot lock'`);
process.exit(0);
