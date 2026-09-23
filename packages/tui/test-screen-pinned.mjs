// Pinned-scroll (DECSTBM) writer oracles — the pinned strategy of
// createScreen, replayed through replayTerminal (the bounded
// model with scrollback + margins). Every assertion is discriminating: it
// fails on the float writer (which emits no DECSTBM, no SU/RI, and erases
// the live region instead of repainting it in place).
//
// Pinned layout (1-based rows): scroll region 1..H-n-1, live rows H-n..H-1,
// bottom row H left blank — the float writer's trailing '\n' already parks
// the hardware cursor there, so the pin transition moves nothing.
import { createScreen } from './screen.mjs';
import { replayTerminal } from './screen-replay.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const sink = () => {
  const chunks = [];
  return { chunks, write: (s) => { chunks.push(s); return true; }, get text() { return chunks.join(''); } };
};
const unsync = (t) => t.replace(/\x1b\[\?2026[hl]/g, '');

const W = 60, H = 12;
const mkScreen = () => {
  const out = sink();
  const screen = createScreen(out, { columns: () => W, rows: () => H });
  return { out, screen };
};
const replay = (out) => replayTerminal(unsync(out.text), { columns: W, rows: H });

// --- scroll-mode resolution (auto default + blocklist) -------------------------
// wantPinned is decided per createScreen from env: 'pinned' forces the writer,
// 'float' refuses it, and anything else — the 'auto' default — pins unless the
// terminal is blocklisted (unset/dumb TERM, zellij). Each case fills the
// screen past the arm point and looks for the DECSTBM margin.
{
  const KEYS = ['ZAGENT_TUI_SCROLL', 'TERM', 'TERM_PROGRAM', 'ZELLIJ', 'INSIDE_EMACS'];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const setEnv = (o) => {
    for (const k of KEYS) {
      if (o[k] === undefined) delete process.env[k];
      else process.env[k] = o[k];
    }
  };
  const arms = () => {
    const { out, screen } = mkScreen();
    for (let i = 0; i < 15; i++) screen.paint([`line ${i}`], ['> input'], { line: 0, col: 1 });
    return /\x1b\[\d*;\d*r/.test(out.text);
  };
  try {
    setEnv({ TERM: 'xterm-256color' });
    ok(arms(), 'auto pins on a scroll-region-capable terminal');
    setEnv({ TERM: 'dumb' });
    ok(!arms(), 'auto stays float on a dumb terminal');
    setEnv({});
    ok(!arms(), 'auto stays float without TERM');
    setEnv({ TERM: 'xterm-256color', ZELLIJ: '1' });
    ok(!arms(), 'auto stays float inside zellij (ZELLIJ marker)');
    setEnv({ TERM: 'xterm-256color', TERM_PROGRAM: 'zellij' });
    ok(!arms(), 'auto stays float under TERM_PROGRAM=zellij');
    setEnv({ TERM: 'xterm-256color', ZAGENT_TUI_SCROLL: 'float' });
    ok(!arms(), 'ZAGENT_TUI_SCROLL=float opts out');
    setEnv({ TERM: 'dumb', ZAGENT_TUI_SCROLL: 'pinned' });
    ok(arms(), 'ZAGENT_TUI_SCROLL=pinned forces past the blocklist');
    setEnv({ TERM: 'xterm-256color', ZAGENT_TUI_SCROLL: 'pinned' });
    ok(arms(), 'ZAGENT_TUI_SCROLL=pinned arms as before');
    setEnv({ TERM: 'xterm-256color', INSIDE_EMACS: '1' });
    ok(!arms(), 'auto stays float inside Emacs term/vterm');
    setEnv({ TERM: 'vt52' });
    ok(!arms(), 'auto stays float on a vt52-class TERM');
    setEnv({ TERM: 'xterm-256color', ZAGENT_TUI_SCROLL: 'float ' });
    ok(!arms(), 'ZAGENT_TUI_SCROLL trims whitespace before matching');
  } finally {
    setEnv(saved);
  }
}

process.env.ZAGENT_TUI_SCROLL = 'pinned';

// --- offset above the transcript: an unsaturated count must not arm -----------
// Rows the writer never emitted (the boot banner, prior shell output) push the
// visible transcript deeper than its row count. A margin armed on the count
// alone strands the real tail inside the live region — the live repro: a '/'
// palette growing live to 16 rows armed [1;13r] over a tail at row 21 and the
// palette repaint erased a committed error block. The arm waits for the cap
// to clamp (scrolling has then pushed the offset rows into scrollback).
{
  const { out, screen } = mkScreen();
  out.write('banner one\r\nbanner two\r\n');   // prior rows the oracle cannot see
  for (let i = 0; i < 5; i++) screen.paint([`line ${i}`], ['> input'], { line: 0, col: 1 });
  // 5 counted commits + a live region grown to 8: the old arm fired
  // (5+8+1 >= 12) with margin [1;4r] over a tail whose real rows are 3-7 —
  // stranding transcript rows 6-7 inside the repainted live region.
  screen.paint([], ['> input', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], { line: 0, col: 1 });
  ok(!/\x1b\[\d*;\d*r/.test(out.text),
    'an unsaturated count never arms a margin over an offset transcript');
  // The live-growth scroll saturated the count (5 commits vs cap 4): the next
  // frame arms at the TRUE tail — row 4 = H-n, not the counted 5.
  screen.paint([], ['> input', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], { line: 0, col: 1 });
  ok(/\x1b\[1;4r/.test(out.text), 'once saturated the margin hugs the real tail, not the count');
}

// --- float until the transcript fills the screen ------------------------------
{
  const { out, screen } = mkScreen();
  screen.paint(['a1', 'a2'], ['> box'], { line: 0, col: 1 });
  ok(!/\x1b\[\d+;\d+r/.test(out.text), 'no margin while committed+live rows < height');
  const r = replay(out);
  ok(r.screen[0] === 'a1' && r.screen[1] === 'a2' && r.screen[2].startsWith('> box'),
    'float paint lands commit rows then the live row');

  // 5 committed + 1 live < 12 still floats.
  screen.paint(['a3', 'a4', 'a5'], ['> box'], { line: 0, col: 1 });
  ok(!/\x1b\[\d+;\d+r/.test(out.text), 'still no margin at 5 committed + 1 live row');
}

// --- pin transition once the transcript fills the region ------------------------
{
  const { out, screen } = mkScreen();
  // Frames 1-10 float (transcript 10 rows + live + cursor row < H). Frame 11
  // fills the screen: the margin arms on that very frame and its commit is
  // the first region scroll — t1 leaves for scrollback.
  for (let i = 1; i <= 10; i++) screen.paint([`t${i}`], ['> box'], { line: 0, col: 1 });
  ok(!/\x1b\[\d+;\d+r/.test(out.text), 'no margin while transcript+live has not filled the screen');
  screen.paint(['t11'], ['> box'], { line: 0, col: 1 });
  ok(out.text.includes(`\x1b[1;${H - 2}r`), 'margin [1;transcriptRows] arms on the frame that fills the screen');
  let r = replay(out);
  ok(r.scrollback.length === 1 && r.scrollback[0] === 't1', 'the pin frame\'s commit was the first region scroll');
  ok(r.screen[H - 3] === 't11', 'the transcript tail sits at the region bottom');
  ok(r.screen[H - 2].startsWith('> box'), 'the live row keeps its row above the blank bottom row');
  ok(r.screen[H - 1] === '', 'the bottom row stays the blank cursor row');

  // The next commit scrolls exactly the region: top line to scrollback, tail
  // stays anchored, live row untouched in place.
  const mark = out.text.length;
  screen.paint(['t12'], ['> box'], { line: 0, col: 1 });
  const delta = out.text.slice(mark);
  ok(delta.includes(`\x1b[${H - 2};1H\n`), 'commit writes scroll-first at the region bottom');
  ok(!delta.includes('\x1b[0J'), 'a pinned commit never erases the live region');
  r = replay(out);
  ok(r.scrollback.length === 2 && r.scrollback[1] === 't2', 'the region top line moved to native scrollback');
  ok(r.screen[H - 3] === 't12' && r.screen[H - 4] === 't11', 'the region tail holds the newest commits');
  ok(r.screen[H - 2].startsWith('> box'), 'the live row is still on its row');

  // Five more commits: five more scrollback lines, order preserved.
  for (let i = 13; i <= 17; i++) screen.paint([`t${i}`], ['> box'], { line: 0, col: 1 });
  r = replay(out);
  ok(r.scrollback.length === 7 && r.scrollback.join(' ') === 't1 t2 t3 t4 t5 t6 t7',
    'scrollback grows one region-row per commit row, oldest first');
  ok(r.screen[H - 3] === 't17', 'tail tracks the latest commit');
}

// --- live-region grow: pre-scroll + margin shrink -----------------------------
{
  const { out, screen } = mkScreen();
  for (let i = 1; i <= 10; i++) screen.paint([`t${i}`], ['> box'], { line: 0, col: 1 });
  // transcriptRows=10 saturated (cap-clamped) and 10+3+1 >= 12: the 3-row
  // live frame arms [1;10], SU-scrolls the overflow (t1), and re-arms [1;9]
  // with the margin hugging the tail — the live rows fill to the bottom.
  screen.paint([], ['> box', 'status', 'hint'], { line: 0, col: 1 });
  ok(out.text.includes(`\x1b[1;${H - 3}r`), 'pin arms the margin around the transcript tail');
  let r = replay(out);
  ok(r.scrollback.join(' ') === 't1', 'the arm pre-scrolled the overflow to scrollback');
  ok(r.screen[H - 4] === 't10', 'the transcript tail sits at the region bottom');
  ok(r.screen[H - 1].startsWith('hint') && r.screen[H - 3].startsWith('> box'),
    'the live rows fill to the screen bottom');

  // Grow to 5 live rows: two transcript rows must move to scrollback.
  const mark = out.text.length;
  screen.paint([], ['> box', 'status', 'hint', 'extra1', 'extra2'], { line: 0, col: 1 });
  ok(out.text.slice(mark).includes('\x1b[2S'), 'grow pre-scrolls the covered transcript rows');
  r = replay(out);
  ok(r.scrollback.join(' ') === 't1 t2 t3', 'the covered transcript rows went to scrollback, not lost');
  ok(r.screen[H - 6] === 't10', 'the tail re-anchored at the new region bottom');
  ok(r.screen[H - 1].startsWith('extra2') && r.screen[H - 5].startsWith('> box'),
    'the grown live region repainted at the bottom');
}

// --- live-region shrink: margin grow + RI re-anchor ---------------------------
{
  const { out, screen } = mkScreen();
  for (let i = 1; i <= 10; i++) screen.paint([`t${i}`], ['> box'], { line: 0, col: 1 });
  // transcriptRows=10 saturated; the 5-row live frame arms [1;10], SU3s the
  // overflow (t1-t3), and re-arms [1;7] around the re-anchored tail.
  screen.paint([], ['> box', 'status', 'hint', 'x', 'y'], { line: 0, col: 1 });
  ok(out.text.includes(`\x1b[1;${H - 5}r`), 'pin arms the margin for the 5-row live region');
  const mark = out.text.length;
  screen.paint([], ['> box', 'status'], { line: 0, col: 1 });
  const delta = out.text.slice(mark);
  ok(delta.includes(`\x1b[1;${H - 2}r`), 'shrink grows the margin over the freed rows');
  ok(delta.includes('\x1bM'), 'shrink reverse-indexes to re-anchor the tail');
  const r = replay(out);
  ok(r.screen[H - 3] === 't10', 'the transcript tail sits at the grown region bottom');
  ok(r.screen[H - 1].startsWith('status') && r.screen[H - 2].startsWith('> box'),
    'the shrunken live region repainted at the bottom');
  ok(r.scrollback.join(' ') === 't1 t2 t3',
    'only the arm overflow scrolled — the RIs dropped blank freed rows');
  ok(r.screen[0] === '' && r.screen[3] === 't4',
    'the transcript shifted down behind blanks at the region top');
}

// --- streaming repaint: same-height live diff paints in place ------------------
{
  const { out, screen } = mkScreen();
  for (let i = 1; i <= 11; i++) screen.paint([`t${i}`], ['> '], { line: 0, col: 2 });
  screen.paint([], ['> '], { line: 0, col: 2 });   // steady-state frame: arms the margin
  const mark = out.text.length;
  screen.paint([], ['> hello'], { line: 0, col: 7 });
  const delta = out.text.slice(mark);
  ok(delta.includes(`\x1b[${H - 1};1H`), 'a live-row change repaints by absolute CUP');
  ok(!delta.includes('\x1b[0J') && !delta.includes('\n'), 'the repaint emits no feed and no erase-below');
  const r = replay(out);
  ok(r.scrollback.length === 1, 'a pure live repaint adds nothing to scrollback');
  ok(r.screen[H - 2].startsWith('> hello'), 'the new live text is on screen');
  ok(r.screen[H - 3] === 't11', 'the transcript tail is undisturbed');
}

// --- clearLive restores the full margin ----------------------------------------
{
  const { out, screen } = mkScreen();
  for (let i = 1; i <= 11; i++) screen.paint([`t${i}`], ['> box'], { line: 0, col: 1 });
  screen.paint([], ['> box'], { line: 0, col: 1 });
  const mark = out.text.length;
  screen.clearLive();
  const delta = out.text.slice(mark);
  ok(delta.includes('\x1b[r'), 'teardown restores the full-screen margin');
  ok(delta.includes('\x1b[0J'), 'teardown erases the live rows');
  const r = replay(out);
  ok(r.screen[H - 2] === '' && r.screen[H - 1] === '', 'the live row is gone after teardown');
  ok(r.screen[H - 3] === 't11', 'the transcript survives teardown');
}

// --- writeRaw disarms the region ------------------------------------------------
{
  const { out, screen } = mkScreen();
  for (let i = 1; i <= 11; i++) screen.paint([`t${i}`], ['> box'], { line: 0, col: 1 });
  screen.paint([], ['> box'], { line: 0, col: 1 });
  screen.writeRaw('\x1b[2J');
  ok(out.text.includes(`\x1b[r\x1b[${H};1H\x1b[2J`),
    'a raw write restores margins and parks the cursor at the bottom first');
}

// --- arm across the pin boundary: live growth pre-scrolls, never overshoots ---
{
  const { out, screen } = mkScreen();
  // transcriptRows caps at 10 under the 1-row live region. A frame that
  // grows it to 3 must not arm marginBot=10 (rows 11,12,13 — row 13 does
  // not exist): it arms [1;10], SU-scrolls the overflow, then re-arms [1;9].
  for (let i = 1; i <= 10; i++) screen.paint([`t${i}`], ['> box'], { line: 0, col: 1 });
  const mark = out.text.length;
  screen.paint([], ['> box', 'status', 'hint'], { line: 0, col: 1 });
  const delta = out.text.slice(mark);
  ok(delta.includes(`\x1b[1;${H - 2}r\x1b[1S\x1b[1;${H - 3}r`),
    'a live region grown across the boundary pre-scrolls instead of overshooting');
  const r = replay(out);
  ok(r.scrollback.join(' ') === 't1', 'the overflow row moved to native scrollback');
  ok(r.screen[H - 3].startsWith('> box') && r.screen[H - 2].startsWith('status')
    && r.screen[H - 1].startsWith('hint'),
    'all three live rows repaint on distinct rows — no clamped collision');
  ok(r.screen[H - 4] === 't10', 'the transcript tail sits at the corrected region bottom');

  // A later shrink keeps marginBot+liveN inside the screen (the overshoot
  // used to break that invariant permanently): [1;9] grows to [1;11], the
  // RIs re-anchor the tail at row 11, and the single live row lands at 12.
  screen.paint([], ['> box'], { line: 0, col: 1 });
  const r2 = replay(out);
  ok(r2.screen[H - 2] === 't10' && r2.screen[H - 1].startsWith('> box'),
    'the margin bottom stays valid after a subsequent shrink');
}

// --- overgrow unpin: the transcript is never wiped --------------------------
{
  const { out, screen } = mkScreen();
  for (let i = 1; i <= 10; i++) screen.paint([`t${i}`], ['> box'], { line: 0, col: 1 });
  screen.paint([], ['> box'], { line: 0, col: 1 });          // arms [1;10]
  // An 11-row live region leaves <2 scroll-region rows: the writer must
  // unpin. `\x1b[r` homes the cursor to 1;1 — if the float erase then ran
  // from there it would ED0-wipe every transcript row off the screen (and
  // they are append-only: nothing would repaint them, they are not in
  // scrollback either).
  screen.paint([], Array.from({ length: 11 }, (_, i) => `live${i}`), { line: 0, col: 1 });
  const r = replay(out);
  const everywhere = [...r.scrollback, ...r.screen].join('\n');
  ok(everywhere.includes('t1') && everywhere.includes('t10'),
    'an overgrow unpin preserves the transcript (scrolled, not erased)');
  ok(!r.screen.every((row) => row === ''), 'the screen was not wiped by the unpin');
  ok(r.scrollback.length === 0 || r.scrollback[0] === 't1',
    'transcript order survives the unpin');
}

// --- resize while pinned: drop the region without wiping the transcript -----
{
  const dims = { w: W, h: H };
  const out = sink();
  const screen = createScreen(out, { columns: () => dims.w, rows: () => dims.h });
  for (let i = 1; i <= 11; i++) screen.paint([`t${i}`], ['> box'], { line: 0, col: 1 });
  screen.paint([], ['> box'], { line: 0, col: 1 });          // arms the margin
  ok(/\x1b\[1;\d+r/.test(out.text), 'margin armed before the resize');
  dims.h = 10;                                              // SIGWINCH
  const mark = out.text.length;
  screen.paint([], ['> box'], { line: 0, col: 1 });
  const delta = out.text.slice(mark);
  ok(delta.includes('\x1b[r'), 'a height resize drops the armed region');
  // Replayed at the pre-resize height: the park must land the cursor below
  // the live region so the float erase starts there — not at 1;1, where
  // ED0 would take every transcript row.
  const r = replay(out);
  ok(r.screen[0] === 't2', 'the transcript survives a resize unpin (t1 scrolled at the arm)');
  ok(r.screen.slice(0, 8).join(' ').includes('t8'),
    'only the bottom rows are erased, not the whole screen');
  // The clamped park (live zone taller than the rows left below the margin
  // after the shrink) must still not let the float erase climb above the
  // live-zone top — t10/t11 sit on the last two transcript rows.
  ok(r.screen[8] === 't10' && r.screen[9] === 't11',
    'the erase never climbs into the transcript tail (t10/t11 survive)');
}

// --- width-only resize also disarms (the transcript reflows) -----------------
{
  const dims = { w: W, h: H };
  const out = sink();
  const screen = createScreen(out, { columns: () => dims.w, rows: () => dims.h });
  for (let i = 1; i <= 11; i++) screen.paint([`t${i}`], ['> box'], { line: 0, col: 1 });
  screen.paint([], ['> box'], { line: 0, col: 1 });          // arms the margin
  const mark = out.text.length;
  dims.w = 40;                                              // narrower: reflow
  screen.paint([], ['> box'], { line: 0, col: 1 });
  ok(out.text.slice(mark).includes('\x1b[r'), 'a width-only resize drops the armed region');
  const r = replay(out);
  ok(r.screen[0] === 't2', 'the transcript survives a width-resize unpin');
}

// --- clearLive leaves the cursor at the live top, not 1;1 -------------------
{
  const { out, screen } = mkScreen();
  for (let i = 1; i <= 11; i++) screen.paint([`t${i}`], ['> box'], { line: 0, col: 1 });
  screen.paint([], ['> box'], { line: 0, col: 1 });          // arms [1;10]
  screen.clearLive();
  const r = replay(out);
  ok(r.cursor.row === H - 2, 'teardown leaves the cursor at the live top for the exit summary');
  ok(r.screen[0] === 't2', 'the transcript survives teardown');
}

// --- writeRaw parks before raw bytes ----------------------------------------
{
  const { out, screen } = mkScreen();
  for (let i = 1; i <= 11; i++) screen.paint([`t${i}`], ['> box'], { line: 0, col: 1 });
  screen.paint([], ['> box'], { line: 0, col: 1 });
  screen.writeRaw('RAWLINE');
  const r = replay(out);
  ok(r.screen[0] === 't2', 'a non-clearing raw write does not overprint the transcript');
  ok(r.screen[H - 1].startsWith('RAWLINE'), 'the raw write lands at the screen bottom');
}

// --- the first frame after a resize never arms on the stale count -----------
{
  const dims = { w: W, h: H };
  const out = sink();
  const screen = createScreen(out, { columns: () => dims.w, rows: () => dims.h });
  // transcriptRows=9 counted at 60x12 — not pinned yet (9+1+1 < 12).
  for (let i = 0; i < 9; i++) screen.paint([`t${i}`], ['> box'], { line: 0, col: 1 });
  // Resize, then grow the live region in the same frame: 9+3+1 >= 12 would
  // arm on the stale count, but the transcript reflowed — the count means
  // nothing under the new geometry. The frame must float and reset it.
  dims.h = 10;
  const mark = out.text.length;
  screen.paint([], ['> box', 'status', 'hint'], { line: 0, col: 1 });
  ok(!/\x1b\[\d+;\d+r/.test(out.text.slice(mark)),
    'the first frame after a resize floats — the counted tail is stale');
  // The count rebuilds against the new geometry: enough new commits re-arm.
  for (let i = 10; i <= 18; i++) screen.paint([`t${i}`], ['> box'], { line: 0, col: 1 });
  ok(/\x1b\[1;\d+r/.test(out.text.slice(mark)),
    'the margin re-arms once the count is proven under the new geometry');
}

// --- grow into the free cursor row: no SU, no margin move -------------------
{
  const { out, screen } = mkScreen();
  for (let i = 1; i <= 11; i++) screen.paint([`t${i}`], ['> box'], { line: 0, col: 1 });
  screen.paint([], ['> box'], { line: 0, col: 1 });          // arms [1;10], live at 11
  // Grow 1 -> 2 rows: row 12 is the free cursor row (marginBot+n = H, no
  // overflow) — the region takes it without touching the transcript.
  const mark = out.text.length;
  screen.paint([], ['> box', 'status'], { line: 0, col: 1 });
  const delta = out.text.slice(mark);
  ok(!/\x1b\[\d+S/.test(delta) && !/\x1b\[\d+;\d+r/.test(delta),
    'a grow into the free bottom row needs no scroll and no margin move');
  let r = replay(out);
  ok(r.screen[H - 3] === 't11' && r.screen[H - 2].startsWith('> box')
    && r.screen[H - 1].startsWith('status'),
    'the live region extends over the cursor row, transcript untouched');
  ok(r.scrollback.length === 1, 'nothing scrolled — only the free row was consumed');

  // Shrink back: the freed row rejoins the region ([1;10] -> [1;11]) and
  // the RI re-anchors the tail at row 11 with the live row on 12.
  screen.paint([], ['> box'], { line: 0, col: 1 });
  r = replay(out);
  ok(r.screen[H - 2] === 't11' && r.screen[H - 1].startsWith('> box'),
    'the shrink re-anchors the tail after a free-row grow');
}

// --- an unfit arm stays float ------------------------------------------------
{
  const { out, screen } = mkScreen();
  // Nine commits keep the pin disarmed (9+1+1 < 12); the 10th would arm.
  for (let i = 0; i < 9; i++) screen.paint([`t${i}`], ['> box'], { line: 0, col: 1 });
  // transcriptRows=9 with an 11-row live region: 9+11+1 >= 12 fires the
  // arm check but no valid margin (>=2 rows) exists — the frame must float.
  screen.paint([], Array.from({ length: 11 }, (_, i) => `live${i}`), { line: 0, col: 1 });
  ok(!/\x1b\[\d+;\d+r/.test(out.text), 'an unfit live region never arms a margin');
  const r = replay(out);
  const everywhere = [...r.scrollback, ...r.screen].join('\n');
  ok(everywhere.includes('t0') && everywhere.includes('live10'),
    'the float fallback keeps transcript and live rows');
}

if (fails > 0) { console.error(`${fails} FAIL`); process.exit(1); }
console.log('test-screen-pinned: all ok');
