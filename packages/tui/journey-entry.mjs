#!/usr/bin/env node
// The TUI, wired to a scripted fake host, on the REAL process stdin/stdout.
//
// Run under a PTY by journey.mjs. This exists because the in-process fake-host
// test cannot see the terminal: it missed a regression where attaching a 'data'
// listener to host.stderr put the shared PTY handle into flowing mode and
// swallowed every keystroke. Only a real tty catches that class.
//
//   ZAGENT_JOURNEY='{"behaviour":"throw","error":"..."}' node journey-entry.mjs
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTui } from './index.mjs';
import { createFakeHost } from './fake-host.mjs';

const spec = JSON.parse(process.env.ZAGENT_JOURNEY || '{}');
// spec carries data, not functions: a fake quota report becomes the
// codingPlanStatus seam /quota consults (ctx.deps), so the J5 journeys see a
// real report without a network call.
const { quota, fault, ...hostSpec } = spec;
// fault === 'crash-on-key': an uncaught throw once the person types the
// tripwire — the "crash wedges the terminal" defect class. A 'data' listener
// throwing escapes through the stream's emit into uncaughtException, the same
// path a fault inside onKey/draw takes. A pty may split the typed string, so
// the check runs on a rolling window, not the chunk.
//
// fault === 'reject-on-key' / 'reject-on-key-unowned': an unhandled rejection
// on the tripwire — the event a slipped await produces. '-unowned' also drops
// the host-style printer below, so the TUI's own guard is what is under test;
// the owned leg keeps it and must survive (the guard defers to a host handler).
//
// fault === 'eof-on-key': push(null) — a synthesized end-of-stream. A real pty
// cannot deliver EOF (a keystroke is data, never an end-of-stream; closing the
// master delivers SIGHUP instead), so this raises the same 'end' event a dead
// pipe or a closed master would.
if (fault === 'crash-on-key' || fault === 'reject-on-key' || fault === 'reject-on-key-unowned' || fault === 'eof-on-key') {
  let seen = '';
  process.stdin.on('data', (chunk) => {
    seen = (seen + chunk).slice(-64);
    if (fault === 'crash-on-key' && seen.includes('JOURNEY-BOOM')) throw new Error('journey: injected crash');
    if ((fault === 'reject-on-key' || fault === 'reject-on-key-unowned') && seen.includes('JOURNEY-REJ')) {
      seen = '';                            // fire once, not per stray byte
      Promise.reject(new Error('journey: injected rejection'));
    }
    if (fault === 'eof-on-key' && seen.includes('JOURNEY-EOF')) {
      // Buffered chunks still emit 'data' while the post-EOF stream drains —
      // without clearing the window a leftover byte re-pushes past EOF and
      // the throw would take the uncaughtException path instead.
      seen = '';
      process.stdin.push(null);
      // ...and stop reading: a real keystroke completing an in-flight fs.read
      // after EOF would throw push-after-EOF inside onread. JOURNEY-EOF must
      // be the last bytes the journey writes.
      process.stdin.pause();
    }
  });
}
const { host } = createFakeHost({ ...hostSpec, stdin: process.stdin, stdout: process.stdout });
// Input history persists under <home>/.zcode/cli — a journey run outside the
// sandboxed test gate would otherwise read/write the developer's real file.
host.home ??= mkdtempSync(path.join(os.tmpdir(), 'zagent-journey-home-'));
// Always defined: the startup probe and /status now consult this seam too, so
// an absent fixture must fail fast — never reach for the real network.
const deps = { codingPlanStatus: quota
  ? async () => {
      // spec.quotaDelayMs makes the monitor slow — the cross-turn stale-verdict
      // journey needs a probe that resolves after the next turn has begun.
      if (spec.quotaDelayMs) await new Promise(r => setTimeout(r, spec.quotaDelayMs));
      return quota;
    }
  : async () => { throw new Error('journey: no quota fixture'); } };

// This printer doubles as the "host owns rejections" handler the TUI's guard
// defers to — 'reject-on-key-unowned' omits it so the guard itself fires.
if (fault !== 'reject-on-key-unowned') {
  process.on('unhandledRejection', (e) => {
    process.stdout.write(`\n[JOURNEY-UNHANDLED-REJECTION] ${e?.message ?? e}\n`);
  });
}
process.on('uncaughtException', (e) => {
  process.stdout.write(`\n[JOURNEY-UNCAUGHT] ${e?.message ?? e}\n`);
});

await runTui(host, { deps });
process.stdout.write('\n[JOURNEY-EXITED]\n');
process.exit(0);
