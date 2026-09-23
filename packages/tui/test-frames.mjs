// Frame-request coalescer (W5 spec row): many draw sources — streaming deltas,
// the 90 ms spinner, key echoes, resize — must collapse into at most one paint
// per frame window. The oracles run on a fake clock so cadence is exact.
import assert from 'node:assert/strict';
import { createFrameScheduler } from './frames.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

/** Fake clock + timer registry: advance(ms) fires every timer due by then. */
function rig(frameMs = 16) {
  let now = 1000;
  const timers = new Set();
  const paints = [];
  const setT = (fn, wait) => {
    const t = { fn, at: now + wait, unref() { return this; } };
    timers.add(t); return t;
  };
  const clearT = (t) => { timers.delete(t); };
  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      let next = null;
      for (const t of timers) if (t.at <= until && (next === null || t.at < next.at)) next = t;
      if (!next) break;
      now = next.at; timers.delete(next); next.fn();
    }
    now = until;
  };
  const sched = createFrameScheduler({
    paint: () => paints.push(now), frameMs,
    now: () => now, setTimeout: setT, clearTimeout: clearT,
  });
  return { sched, paints, advance, timers, now: () => now };
}

// An isolated request paints synchronously — key echo keeps zero added latency.
{
  const { sched, paints } = rig();
  sched.scheduleFrame();
  assert.deepEqual(paints, [1000]);
  ok(true, 'idle request paints synchronously');
}

// A burst inside one frame window collapses to ONE deferred paint.
{
  const { sched, paints, advance } = rig();
  sched.scheduleFrame();                 // sync paint at t=1000
  sched.scheduleFrame(); sched.scheduleFrame(); sched.scheduleFrame();
  assert.equal(paints.length, 1);
  assert.equal(sched.pending, true);
  advance(15);
  assert.equal(paints.length, 1);        // still inside the window: held
  advance(1);                            // t=1016 — the window boundary
  assert.deepEqual(paints, [1000, 1016]);
  assert.equal(sched.pending, false);
  ok(true, 'burst collapses to one paint at the frame boundary');
}

// Continuous requests paint at the frame cadence, never faster.
{
  const { sched, paints, advance } = rig(20);
  sched.scheduleFrame();                 // t=1000 sync
  for (let i = 0; i < 20; i++) { advance(5); sched.scheduleFrame(); }
  // t=1100; paints expected at 1000, 1020, 1040, 1060, 1080, 1100
  assert.deepEqual(paints, [1000, 1020, 1040, 1060, 1080, 1100]);
  ok(true, 'continuous requests paint at frame cadence (rate cap)');
}

// An explicit later deadline is honored; an earlier one pulls the frame in.
{
  const { sched, paints, advance, timers } = rig(10);
  sched.scheduleFrame();                 // sync at 1000
  sched.scheduleFrame(1100);             // deadline in the future
  assert.equal(paints.length, 1);
  advance(50);                           // t=1050 — not yet
  assert.equal(paints.length, 1);
  sched.scheduleFrame(1060);             // earlier request pulls it in
  advance(10);                           // t=1060
  assert.deepEqual(paints, [1000, 1060]);
  assert.equal(timers.size, 0);
  ok(true, 'requests collapse to the earliest deadline');
}

// A request arriving while a frame is pending does not push it later.
{
  const { sched, paints, advance } = rig(10);
  sched.scheduleFrame();                 // sync at 1000
  sched.scheduleFrame();                 // deferred to 1010
  sched.scheduleFrame(1050);             // later deadline must NOT delay it
  advance(10);
  assert.deepEqual(paints, [1000, 1010]);
  ok(true, 'later deadline never delays a pending frame');
}

// flush() fires a held frame immediately — exit() uses it so a coalesced
// frame's scrollback commits are not discarded; a no-op when nothing is held.
{
  const { sched, paints, advance } = rig();
  sched.scheduleFrame();                 // sync at 1000
  sched.scheduleFrame();                 // held
  sched.flush();
  assert.deepEqual(paints, [1000, 1000]); // fired now, not at the boundary
  assert.equal(sched.pending, false);
  advance(50);
  assert.equal(paints.length, 2);        // nothing left to fire later
  sched.flush();                         // idle flush is a no-op
  sched.scheduleFrame(); sched.flush();
  assert.equal(paints.length, 3);        // sync paint means flush had nothing to do
  ok(true, 'flush fires a held frame now and is a no-op when idle');
}

// cancel() disarms a pending frame and refuses further requests (exit path).
{
  const { sched, paints, advance } = rig();
  sched.scheduleFrame();
  sched.scheduleFrame();
  assert.equal(sched.pending, true);
  sched.cancel();
  assert.equal(sched.pending, false);
  sched.scheduleFrame();
  advance(100);
  assert.deepEqual(paints, [1000]);      // the coalesced paint never lands
  ok(true, 'cancel disarms the pending frame and stays dead');
}

// frameMs 0 is the test seam: every request paints synchronously.
{
  const { sched, paints } = rig(0);
  sched.scheduleFrame(); sched.scheduleFrame(); sched.scheduleFrame();
  assert.equal(paints.length, 3);
  assert.equal(sched.pending, false);
  ok(true, 'frameMs 0 keeps paints fully synchronous');
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
