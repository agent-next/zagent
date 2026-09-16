// Frame-request coalescer.
//
// Draw sources — every streaming delta, the spinner tick, each key echo,
// resize — used to paint synchronously per call. Under a fast stream that is
// one full erase+repaint per event: flicker the ?2026 wrap cannot fix (whole
// frames still arrive faster than the eye), and CPU spent composing frames
// nobody sees. codex's FrameRequester caps at 120 fps; opencode batches SSE
// deltas into one render per 16 ms. We take the same shape: requests name a
// deadline, collapse to the earliest, and never paint faster than `frameMs`
// after the previous paint.
//
// The paint callback runs at FIRE time, not request time — a deferred frame
// composes the latest state, so collapsing never shows stale output. A
// deadline in the past still obeys the rate limit; the only synchronous path
// is a request made while the frame window is idle (or flush()).
export function createFrameScheduler({
  paint, frameMs = 16,
  now = Date.now, setTimeout: schedule = setTimeout, clearTimeout: unschedule = clearTimeout,
} = {}) {
  let timer = null;              // the pending deferred paint, if any
  let deadline = Infinity;       // earliest requested paint-by (ms epoch)
  let fireAt = 0;                // when the pending timer fires
  let lastPaint = -Infinity;     // last actual paint (ms epoch)
  let dead = false;              // cancel() is terminal — the TUI is exiting

  const paintNow = () => { lastPaint = now(); deadline = Infinity; paint(); };

  const fire = () => { timer = null; paintNow(); };

  /**
   * Request a paint by `at` (ms epoch, defaults to now). Repeated requests
   * inside a frame window collapse to one paint at the earliest deadline,
   * clamped below by the rate limit (lastPaint + frameMs).
   */
  const scheduleFrame = (at) => {
    if (dead) return;
    const want = at ?? now();
    if (want < deadline) deadline = want;
    const target = Math.max(deadline, lastPaint + frameMs);
    if (timer) {
      if (target >= fireAt) return;      // the pending frame is already soon enough
      unschedule(timer);                 // an earlier request: fire sooner
      timer = null;
    }
    const wait = target - now();
    if (wait <= 0) { paintNow(); return; }
    fireAt = target;
    timer = schedule(fire, wait);
    if (typeof timer?.unref === 'function') timer.unref();
  };

  /**
   * Fire the pending frame now, if any. Exit paths call this BEFORE their
   * terminal flag goes up: a held frame can carry un-painted scrollback
   * commits (the tail of a stream, the "interrupted" notice), and discarding
   * it would drop that text entirely.
   */
  const flush = () => {
    if (!timer) return;
    unschedule(timer);
    timer = null;
    paintNow();
  };

  /** Disarm the pending frame; nothing paints after this (the TUI is gone). */
  const cancel = () => {
    dead = true;
    if (timer) unschedule(timer);
    timer = null;
    deadline = Infinity;
  };

  return { scheduleFrame, flush, cancel, get pending() { return timer !== null; } };
}
