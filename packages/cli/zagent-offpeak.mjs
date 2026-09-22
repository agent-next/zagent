#!/usr/bin/env node
// zagent offpeak — campaign time window; does not verify billing eligibility.
//
// packages/driver/offpeak.mjs has implemented this since C1-C5 and ships in the
// package, but nothing could invoke it: no bin entry, no subcommand. A scheduler
// a user cannot ask is dead weight in the tarball.
//
//   zagent offpeak            what the window is doing now
//   zagent offpeak --refresh  ask the server for the window first
//   zagent offpeak --json     machine-readable, for scripts and cron
//   zagent offpeak tools on|off  enable the kernel's off-peak tool port for new
//                                sessions (desktop 3.12.x+), or read the stored
//                                policy with bare `tools`
//
// Exit code is the answer, so `zagent offpeak && run-the-batch` works in a shell:
// 0 when the configured campaign window is open, 1 otherwise; neither proves cost.

import path from 'node:path';
import { defaultWindow, inOffPeak, campaignActive, minutesUntilWindow, routeToFlash,
  fetchWindow, cachedWindow, readToolPolicy, writeToolPolicy } from '../driver/offpeak.mjs';

const args = process.argv.slice(2);
const USAGE = 'usage: zagent offpeak [--refresh] [--json] | zagent offpeak tools [on|off] [--json]';
const positional = [];
for (const a of args) {
  if (a === '--json' || a === '--refresh') continue;
  if (a.startsWith('-')) { console.error(USAGE); process.exit(2); }
  positional.push(a);
}
// `tools` is the only positional — a stray word silently running the window
// check would answer a question that was never asked.
if (positional.length && positional[0] !== 'tools') { console.error(USAGE); process.exit(2); }
const asJson = args.includes('--json');
const refresh = args.includes('--refresh');

// --- tools: the 3.12.x workspace/updateOffPeakToolPolicy RPC ------------------
// The kernel stores offPeakToolEnabled in app-server memory; the GUI re-sends
// its saved preference every launch. zagent keeps its own store
// (~/.zcode/cli/offpeak-tools.json) which session/create applies on runtimes
// that accept the field. The RPC call here is the official surface — it also
// serves as the capability check, so the store is only written when the
// connected runtime actually honored the toggle.
if (positional[0] === 'tools') {
  const rest = positional.slice(1);
  if (refresh) { console.error('usage: zagent offpeak tools [on|off] [--json]'); process.exit(2); }
  if (rest.length > 1 || (rest.length === 1 && rest[0] !== 'on' && rest[0] !== 'off')) {
    console.error('usage: zagent offpeak tools [on|off] [--json]');
    process.exit(2);
  }
  const sub = rest[0];
  if (sub === undefined) {
    const enabled = readToolPolicy();
    if (asJson) console.log(JSON.stringify({ enabled }, null, 2));
    else console.log(`off-peak tool: ${enabled ? 'on' : 'off'} — 'zagent offpeak tools on|off' to change`);
    process.exit(0);
  }
  const enabled = sub === 'on';
  const { ZCodeProtocolClient } = await import('../driver/zcode-protocol.mjs');
  const key = path.normalize(process.cwd());
  let client, code = 0;
  try {
    client = new ZCodeProtocolClient({ cwd: process.cwd() });
    await client.ready;
    const res = await client.call('workspace/updateOffPeakToolPolicy', {
      workspace: { workspaceKey: key, workspacePath: key }, enabled,
    });
    const applied = res?.enabled === true;
    if (applied !== enabled) console.error('warning: runtime echoed a different policy than requested');
    writeToolPolicy(applied);
    if (asJson) console.log(JSON.stringify({ enabled: applied, workspace: key }, null, 2));
    else console.log(`off-peak tool: ${applied ? 'on' : 'off'} — applies to new sessions on this runtime`);
  } catch (e) {
    code = 1;
    console.error(e?.code === -32601
      ? 'this ZCode runtime does not support the off-peak tool (workspace/updateOffPeakToolPolicy arrived in desktop 3.12.x)'
      : `offpeak tools failed: ${e?.message ?? e}`);
  } finally {
    try { client?.close(); } catch {}
  }
  process.exit(code);
}

const humanDuration = (minutes) => {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};

/** The window is expressed in SGT; show it in the reader's own zone too. */
const localHour = (sgtHour, on = new Date()) => {
  // Anchor on TODAY, not a fixed date: a winter anchor reports the wrong hour all
  // summer, which is exactly the kind of quietly-wrong number this command exists
  // to avoid.
  const utc = new Date(Date.UTC(on.getUTCFullYear(), on.getUTCMonth(), on.getUTCDate(),
    (sgtHour - 8 + 24) % 24, 0));
  return utc.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

const now = new Date();
const window = refresh ? await fetchWindow() : cachedWindow() ?? defaultWindow();
const open = inOffPeak(now, window) && campaignActive(now, window);
const active = campaignActive(now, window);
const route = routeToFlash(now, { win: window });
const untilOpen = minutesUntilWindow(now, window);

if (asJson) {
  console.log(JSON.stringify({
    open, campaignActive: active, campaignEnd: window.campaignEnd,
    windowSGT: { start: window.startHourSGT, end: window.endHourSGT },
    source: window.source, allowedModels: window.allowedModels ?? null,
    minutesUntilOpen: open ? 0 : untilOpen,
    routeMechanicalToFlash: route.flash, reason: route.reason,
  }, null, 2));
} else {
  const span = `${String(window.startHourSGT).padStart(2, '0')}:00-${String(window.endHourSGT).padStart(2, '0')}:00 SGT`;
  const localSpan = `${localHour(window.startHourSGT)}-${localHour(window.endHourSGT)} local`;
  console.log(`off-peak window: ${localSpan} (${span})`);
  if (!active) {
    console.log(`status: closed — campaign ended ${window.campaignEnd}`);
  } else if (open) {
    console.log(`status: open — campaign ends ${window.campaignEnd}`);
  } else {
    console.log(`status: closed — opens in ${humanDuration(untilOpen)} · campaign ends ${window.campaignEnd}`);
  }
  // Z.ai's published campaign terms, not something zagent measured. Said plainly,
  // because the plan's own rolling usage window is enforced independently of it:
  // a 1308 ("Usage limit reached for 5 hour") was observed DURING an open window
  // on 2026-09-07. Off-peak routing is not a licence to ignore the window.
  console.log('Billing for this window is not verified by zagent.');
}

// The exit code is the useful part in a script; a closed window is not an error
// condition, so nothing is written to stderr.
process.exit(route.flash ? 0 : 1);
