#!/usr/bin/env node
// zagent offpeak — is GLM-5.3-Flash free right now, and if not, when?
//
// packages/driver/offpeak.mjs has implemented this since C1-C5 and ships in the
// package, but nothing could invoke it: no bin entry, no subcommand. A scheduler
// a user cannot ask is dead weight in the tarball.
//
//   zagent offpeak            what the window is doing now
//   zagent offpeak --refresh  ask the server for the window first
//   zagent offpeak --json     machine-readable, for scripts and cron
//
// Exit code is the answer, so `zagent offpeak && run-the-batch` works in a shell:
// 0 when flash is free right now, 1 when it is not.

import { defaultWindow, inOffPeak, campaignActive, minutesUntilWindow, routeToFlash,
  fetchWindow, cachedWindow } from '../driver/offpeak.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const refresh = args.includes('--refresh');

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
const open = inOffPeak(now, window);
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
  console.log(`off-peak window: ${span}  (${localSpan})   source: ${window.source}`);
  if (!active) {
    console.log(`campaign: ENDED ${window.campaignEnd} — flash costs quota at all hours now`);
  } else if (open) {
    console.log(`status: OPEN — mechanical work routed to GLM-5.3-Flash costs zero quota`);
    console.log(`campaign runs through ${window.campaignEnd}`);
  } else {
    console.log(`status: closed — opens in ${humanDuration(untilOpen)}`);
    console.log(`campaign runs through ${window.campaignEnd}`);
  }
  if (window.allowedModels?.length) console.log(`allowed models: ${window.allowedModels.join(', ')}`);
  console.log(`routing now: ${route.flash ? 'flash' : 'main'} — ${route.reason}`);
}

// The exit code is the useful part in a script; a closed window is not an error
// condition, so nothing is written to stderr.
process.exit(route.flash ? 0 : 1);
