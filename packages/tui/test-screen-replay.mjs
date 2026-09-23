// replayTerminal oracles — the bounded terminal model the DECSTBM
// scroll-region writer is verified against.
// Every assertion is discriminating: it fails on the unbounded replayScreen
// semantics and on any model that scrolls outside the margins.
import { replayTerminal } from './screen-replay.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

// 8x40 terminal. 'head' sits at row 0, then DECSTBM `\x1b[2;5r` makes rows
// 2-5 (1-based) the scroll region; rows 6-8 stay live chrome. The set homes
// the cursor to 1;1, so a fixture that fills the region CUPs to its top row
// first and leaves the last line unterminated (a '\n' there would scroll).
const boot = '\x1b[2;5r';
const fill = '\x1b[2;1Hr1\nr2\nr3\nr4'; // region rows: r1 r2 r3 r4, cursor on r4

{
  // A full region commits with scroll-BEFORE-write: '\n' at the last row
  // scrolls the region (top line to scrollback), the text lands on the fresh
  // bottom row, and the live rows below are untouched.
  const { screen, scrollback } = replayTerminal(
    boot + fill + '\x1b[6;1Hlive\n' + '\x1b[5;1H\nnew',
    { columns: 40, rows: 8 });
  ok(scrollback.join('\n') === 'r1', `the region's top line retires to scrollback (got ${JSON.stringify(scrollback)})`);
  ok(screen[1] === 'r2' && screen[4].startsWith('new'), 'the region shifted up inside itself');
  ok(screen[5] === 'live', 'rows below the scroll region are never scrolled');
}

{
  // Inside the region but NOT at its last row, '\n' just moves down — no scroll.
  const { screen, scrollback } = replayTerminal(
    boot + '\x1b[3;1Haa\nbb', { columns: 40, rows: 8 });
  ok(scrollback.length === 0, 'a newline mid-region moves the cursor, nothing scrolls');
  ok(screen[2] === 'aa' && screen[3] === 'bb', 'mid-region lines land on consecutive rows');
}

{
  // Below the region, '\n' walks down to the screen edge and stops there —
  // it can never scroll the transcript away.
  const { screen, scrollback } = replayTerminal(
    boot + '\x1b[7;1Hx\ny\nz\nw', { columns: 40, rows: 8 });
  ok(scrollback.length === 0, 'below the region newlines never scroll');
  ok(screen[7] === 'w', 'the feed clamps at the last screen row');
}

{
  // Auto-wrap at the region's last row scrolls the region exactly like a
  // newline — one scroll per wrapped row.
  const wide = 'w'.repeat(81); // 3 rows at width 40
  const { screen, scrollback } = replayTerminal(
    boot + fill + '\x1b[5;1H\n' + wide,
    { columns: 40, rows: 8 });
  ok(scrollback.filter((l) => l.startsWith('r')).length === 3,
     `a wrapped line at the region bottom scrolls per row (scrollback: ${JSON.stringify(scrollback)})`);
  ok(screen[4] === 'w', 'the wrap lands on the region bottom row, not below it');
}

{
  // ESC M (reverse index) at the region top scrolls DOWN: blank in at the
  // top, the region's bottom line dropped — never into scrollback.
  const { screen, scrollback } = replayTerminal(
    boot + fill + '\x1b[2;1H\x1bM', { columns: 40, rows: 8 });
  ok(screen[1] === '' && screen[2] === 'r1' && screen[4] === 'r3',
     `reverse index opens a blank at the region top (got ${JSON.stringify(screen.slice(0, 6))})`);
  ok(!scrollback.includes('r4'), 'a line pushed out of the region bottom by RI is dropped, not scrolled back');
}

{
  // Absolute CUP addresses rows regardless of margins — the pinned writer's
  // only cursor primitive.
  const { screen } = replayTerminal(
    boot + '\x1b[6;3Hab\x1b[2;1Hcd', { columns: 40, rows: 8 });
  ok(screen[5] === '  ab' && screen[1] === 'cd', 'CUP row;col lands absolutely inside or outside the region, gaps pad with blanks');
}

{
  // A bare `\x1b[r` restores full-screen margins; a region with bottom above
  // top is ignored wholesale, and an overlarge bottom clamps to the screen.
  const { screen, scrollback } = replayTerminal(
    boot + '\x1b[2;1Hr1\nr2\n' + '\x1b[r' + '\x1b[8;1Hedge\n' + '\x1b[8;1Hmore\n',
    { columns: 40, rows: 8 });
  ok(screen[6] === 'more' && scrollback.includes('r1') && screen[0] === 'r2',
     `reset margins scroll the full screen again at the bottom row (${JSON.stringify({ screen, scrollback })})`);
  const bad = replayTerminal('x\n' + '\x1b[4;2r' + 'y\n', { columns: 40, rows: 8 });
  ok(bad.screen[0] === 'x' && bad.screen[1] === 'y' && bad.scrollback.length === 0,
     'an invalid DECSTBM leaves the screen, cursor and margins alone');
  const clamped = replayTerminal('\x1b[2;30r' + '\x1b[8;1Hx\n', { columns: 40, rows: 8 });
  ok(clamped.scrollback.length === 1, 'an overlarge bottom margin clamps to the screen edge (xterm), not rejected');
}

{
  // CUU/CUD clamp at the region edge only from inside it — the pinned writer
  // can never walk its diff into scrollback or chrome by overshooting.
  const { screen } = replayTerminal(
    boot + fill + '\x1b[4;1H\x1b[9Aup\x1b[4;1H\x1b[9Bdn',
    { columns: 40, rows: 8 });
  ok(screen[1].startsWith('up'), 'CUU clamps at the region top');
  ok(screen[4].startsWith('dn'), 'CUD clamps at the region bottom');
  const outside = replayTerminal(
    boot + fill + '\x1b[7;1H\x1b[9Afree', { columns: 40, rows: 8 });
  ok(outside.screen[0].startsWith('free'), 'CUU from below the region is not margin-clamped');
}

{
  // `\x1b[2J` clears the screen but keeps scrollback and margins — ctrl-l
  // must not resurrect transcript or reset the region.
  const cleared = replayTerminal(
    boot + fill + '\x1b[5;1H\nr5' + '\x1b[2J\x1b[H', { columns: 40, rows: 8 });
  ok(cleared.screen.every((l) => l === ''), 'a full erase clears every screen row');
  ok(cleared.scrollback.includes('r1'), 'scrollback survives the clear');
  const after = replayTerminal(
    boot + fill + '\x1b[2J\x1b[H' + '\x1b[5;1Hnew\n',
    { columns: 40, rows: 8 });
  ok(after.screen[3] === 'new' && after.scrollback.length === 1,
     'margins persist across the erase — the newline still scrolls inside the region');
}

{
  // Mode-1 erases go THROUGH the cursor cell inclusive (EL1/ED1), and ED3
  // clears scrollback while leaving the screen — the inverse of ED2.
  const el1 = replayTerminal('abcd' + '\x1b[3G\x1b[1K', { columns: 40, rows: 8 });
  ok(el1.screen[0] === '   d', `EL1 erases through the cursor cell inclusive (got ${JSON.stringify(el1.screen[0])})`);
  const ed3 = replayTerminal(boot + fill + '\x1b[5;1H\nr5' + '\x1b[3J', { columns: 40, rows: 8 });
  ok(ed3.scrollback.length === 0 && ed3.screen[4] === 'r5',
     'ED3 clears scrollback and leaves the screen');
  const priv = replayTerminal(boot + fill + '\x1b[>1;2T\x1b[>5r', { columns: 40, rows: 8 });
  ok(priv.screen[1] === 'r1' && priv.scrollback.length === 0,
     'private >-param CSIs never reach the scroll-region handlers');
}

{
  // SGR leaves the deferred wrap armed and carries no cells.
  const { screen } = replayTerminal(
    'x'.repeat(40) + '\x1b[31my', { columns: 40, rows: 8 });
  ok(screen[1] === 'y', 'a full-width row arms the wrap; the next printable resolves it');
  const still = replayTerminal('x'.repeat(40) + '\x1b[31m\x1b[K', { columns: 40, rows: 8 });
  ok(still.screen[0] === 'x'.repeat(39), 'EL0 under a pending wrap erases the last cell inclusive');
}

if (fails > 0) { console.error(`${fails} FAIL`); process.exit(1); }
console.log('test-screen-replay: all oracles pass');
