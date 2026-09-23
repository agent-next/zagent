// Screen tests. The load-bearing property is that the eraser never walks up into
// committed transcript — that would silently delete a user's scrollback.
import { createScreen, composeFrame, isSettled, rowsFor } from './screen.mjs';
import { renderPermission } from './chrome.mjs';
import { createTheme } from './theme.mjs';
import { createTranscript, applyEvent, addUserEntry } from './events.mjs';

// These oracles pin the float writer's bytes; the pinned strategy is covered
// by test-screen-pinned.mjs. Pin the mode so a host TERM cannot flip the
// default and invalidate the byte-level assertions.
process.env.ZAGENT_TUI_SCROLL = 'float';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const plain = createTheme({ enabled: false });

const sink = () => { const chunks = []; return { chunks, write: (s) => { chunks.push(s); return true; }, get text() { return chunks.join(''); } }; };
// Every paint write is wrapped in DEC ?2026 sync markers (h opens, l closes);
// stripping them leaves the pre-wrap byte stream the oracles below pin.
const unsync = (t) => t.replace(/\x1b\[\?2026[hl]/g, '');

// --- settled ------------------------------------------------------------------
ok(isSettled({ kind: 'assistant', done: false }) === false, 'streaming assistant is unsettled');
ok(isSettled({ kind: 'assistant', done: true }) === true, 'finished assistant is settled');
ok(isSettled({ kind: 'tool', status: 'running' }) === false, 'running tool is unsettled');
ok(isSettled({ kind: 'tool', status: 'ok' }) === true, 'finished tool is settled');
ok(isSettled({ kind: 'user' }) === true && isSettled({ kind: 'notice' }) === true, 'user and notice are settled on arrival');

// --- committing ---------------------------------------------------------------
const s = createTranscript();
addUserEntry(s, 'hi');
let frame = composeFrame(s, plain, 60);
ok(frame.commit.length === 1 && frame.commit[0].startsWith('> hi'), 'a settled entry commits immediately');
ok(frame.live.length === 0, 'a settled entry leaves nothing live');

frame = composeFrame(s, plain, 60);
ok(frame.commit.length === 0, 'a second compose does not re-print committed lines');

applyEvent(s, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: 'one two' } });
frame = composeFrame(s, plain, 60);
ok(frame.live.length === 1 && frame.live[0].includes('one two'), 'a streaming entry stays live, not committed');
ok(frame.commit.length === 1 && frame.commit[0] === '', 'a blank separator is committed before a new entry');

// growing text: terminated lines commit; the whole unterminated tail SOURCE
// line stays live (a later delta can still re-shape its render)
applyEvent(s, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: ' three four five six seven' } });
frame = composeFrame(s, plain, 24);
ok(frame.live.length >= 2, 'the whole unterminated tail line stays live while streaming');
ok(!frame.commit.join('\n').includes('one two'), 'no fragment of the tail line commits before its newline');

applyEvent(s, { type: 'model_complete', payload: { assistantMessageId: 'm', content: null } });
frame = composeFrame(s, plain, 24);
ok(frame.live.length === 0, 'completing the stream releases the live tail');
frame = composeFrame(s, plain, 24);
ok(frame.commit.length === 0 && frame.live.length === 0, 'a settled transcript composes to nothing');

// --- rows, not array elements -------------------------------------------------
// paint used to trust the caller's array length, which made "one element = one
// terminal row" a convention five producers had to uphold independently. It was
// already broken: renderPermission emitted 75- and 54-cell lines at width 40.
ok(rowsFor('abc', 40) === 1, 'a short line is one row');
ok(rowsFor('x'.repeat(80), 40) === 2, 'an 80-cell line is two rows at width 40');
ok(rowsFor('x'.repeat(81), 40) === 3, 'an 81-cell line is three rows at width 40');
ok(rowsFor('', 40) === 1, 'an empty line still occupies one row');
ok(rowsFor('\x1b[38;5;173mabc\x1b[0m', 40) === 1, 'SGR is stripped before measuring, not counted');
ok(rowsFor('你'.repeat(30), 40) === 2, 'CJK is measured in cells: 60 cells is two rows at width 40');
ok(rowsFor('abc', 0) >= 1, 'a zero width does not divide by zero');

{
  const out2 = sink();
  const screen2 = createScreen(out2, { columns: () => 40 });
  screen2.paint([], ['x'.repeat(80), 'short']);
  ok(screen2.eraseHeight === 3, `a wrapped live line counts its real rows (got ${screen2.eraseHeight})`);
  out2.chunks.length = 0;
  screen2.paint([], ['short']);
  ok(unsync(out2.text).startsWith('\x1b[3A'), 'the eraser moves up the ROWS it drew, not the array length');

  // the exact case that was live-broken
  const req = { toolName: 'mcp__some_very_long_server__a_very_long_tool_name_indeed',
    input: { command: 'x' }, options: [{ optionId: 'a', name: 'Allow this specific invocation once for the session', response: {} }] };
  const perm = renderPermission(req, 0, plain, 40);
  ok(perm.every(l => rowsFor(l, 40) === 1),
     `every permission line fits one row at width 40 (got ${perm.map(l => rowsFor(l, 40))})`);
}

// --- erase arithmetic ---------------------------------------------------------
const out = sink();
const screen = createScreen(out, { columns: () => 40 });
ok(screen.eraseHeight === 0, 'nothing to erase before the first paint');
screen.paint(['committed line'], ['live a', 'live b']);
ok(!unsync(out.text).startsWith('\x1b['), 'first paint does not emit a cursor-up (there is nothing above)');
ok(screen.eraseHeight === 2, 'erase height tracks the live region exactly');

out.chunks.length = 0;
screen.paint([], ['live a', 'live b']);
ok(out.text === '', 'an identical repaint emits nothing — no row changed');
// six rows make the one-row diff strictly cheaper than a repaint — the cost
// model rightly prefers the classic path for tiny regions
screen.paint([], ['h0', 'h1', 'h2', 'h3', 'live a', 'live b']);
out.chunks.length = 0;
screen.paint([], ['h0', 'h1', 'h2', 'h3', 'live a', 'live c']);
ok(!unsync(out.text).includes('\x1b[0J') && out.text.includes('live c') && !out.text.includes('h0'),
   'a changed repaint rewrites only the changed row, no whole-region erase');

out.chunks.length = 0;
screen.paint([], ['only one']);
ok(screen.eraseHeight === 1, 'a shrinking live region updates the erase height');
out.chunks.length = 0;
screen.paint([], []);
ok(unsync(out.text) === '\x1b[1A\r\x1b[0J' && screen.eraseHeight === 0, 'an empty live region erases and leaves nothing');

out.chunks.length = 0;
screen.clearLive();
ok(out.text === '', 'clearLive with nothing live writes nothing');
screen.paint([], ['x']); out.chunks.length = 0;
screen.clearLive();
ok(out.text === '\x1b[1A\r\x1b[0J' && screen.eraseHeight === 0, 'clearLive removes the footer before exit');

// --- parked hardware cursor ---------------------------------------------------
// paint(commit, live, {line, col}) leaves the cursor inside the live region;
// the next erase must subtract the rows it already climbed, or it walks into
// committed scrollback.
{
  const out3 = sink();
  const s3 = createScreen(out3, { columns: () => 40 });
  s3.paint([], ['aaa', 'bbb', 'ccc'], { line: 1, col: 2 });
  ok(unsync(out3.text).endsWith('\x1b[2A\x1b[3G'), `parking moves up to the line and across to the column (got ${JSON.stringify(out3.text.slice(-20))})`);
  out3.chunks.length = 0;
  s3.paint([], ['x']);
  ok(unsync(out3.text).startsWith('\x1b[1A') && unsync(out3.text).includes('\x1b[0J'),
     'the next repaint only climbs what the parked cursor left, then erases the surplus rows');
  // No cursor: nothing is parked, erase climbs the full height again.
  out3.chunks.length = 0;
  s3.paint([], ['x', 'y'], { line: 1, col: 0 });
  ok(unsync(out3.text).endsWith('\x1b[1G'), 'parking on the last line lands on its row and column');
  out3.chunks.length = 0;
  s3.clearLive();
  ok(out3.text === '\x1b[1A\r\x1b[0J', `clearLive un-parks first, then erases (got ${JSON.stringify(out3.text)})`);
  // A cursor on the FIRST line: the whole region lies below it; erase is \x1b[0J only.
  const out4 = sink();
  const s4 = createScreen(out4, { columns: () => 40 });
  s4.paint([], ['one', 'two'], { line: 0, col: 0 });
  out4.chunks.length = 0;
  s4.paint([], ['x']);
  ok(!/^\x1b\[\d+A/.test(unsync(out4.text)) && unsync(out4.text).includes('\x1b[0J'),
     'a cursor parked at the region top needs no climb, only repaint/erase-below');
  // A wrapped live line above the parked row counts its real rows.
  const out5 = sink();
  const s5 = createScreen(out5, { columns: () => 40 });
  s5.paint([], ['x'.repeat(80), 'tail'], { line: 1, col: 0 });
  ok(unsync(out5.text).endsWith('\x1b[1A\x1b[1G'), 'parking below a two-row line climbs one row');
  s5.paint([], ['x'.repeat(80), 'tail'], { line: 0, col: 4 });
  ok(unsync(out5.text).endsWith('\x1b[2A\x1b[5G'), 're-parking from the last parked row climbs the difference, not the height');
  // An out-of-range line index clamps to the last line instead of wandering.
  const out6 = sink();
  const s6 = createScreen(out6, { columns: () => 40 });
  s6.paint([], ['a', 'b'], { line: 99, col: 0 });
  ok(unsync(out6.text).endsWith('\x1b[1A\x1b[1G'), 'a stale line index clamps to the last painted line');
}

// a closed pipe must not crash the TUI
const broken = { write() { throw new Error('EPIPE'); } };
let threw = null;
try { createScreen(broken).paint(['a'], ['b']); } catch (e) { threw = e; }
ok(threw === null, 'a write to a closed stdout is swallowed, not fatal');

ok(createScreen(out, { columns: () => 0 }).width === 80, 'an unknown terminal width (0) falls back to the 80-column default');
ok(createScreen(out, { columns: () => 5 }).width === 20, 'an absurdly narrow terminal is floored at 20 columns');

ok(!out.text.includes('\x1b[?1049h') && !out.text.includes('\x1b[?47h'),
   'the screen writer never enters the alternate screen');

// --- synchronized output (DEC ?2026) ------------------------------------------
// Every paint is one write wrapped `?2026h`..`?2026l`: supporting terminals
// (kitty/iTerm2/foot/wezterm/recent xterm) hold the frame until the close
// marker, so a streaming repaint never tears mid-frame; the rest ignore the
// private mode. The cursor park stays INSIDE the wrap so the hardware cursor
// jumps with the frame, not after it.
{
  const outS = sink();
  const sS = createScreen(outS, { columns: () => 40 });
  sS.paint([], ['x']);
  ok(outS.text === '\x1b[?2026hx\n\x1b[?2026l',
     `a paint write is wrapped in ?2026 sync markers (got ${JSON.stringify(outS.text)})`);
  sS.paint([], ['a', 'b'], { line: 1, col: 0 });
  ok(/\x1b\[1G\x1b\[\?2026l$/.test(outS.chunks.at(-1)),
     'the parked cursor move lands inside the sync region');
  const opens = outS.text.split('\x1b[?2026h').length - 1;
  const closes = outS.text.split('\x1b[?2026l').length - 1;
  ok(opens === closes, `sync markers are balanced (${opens} opens, ${closes} closes)`);
  // A paint with nothing to emit writes nothing — no dangling sync region.
  const outE = sink();
  createScreen(outE, { columns: () => 40 }).paint([], []);
  ok(outE.text === '', 'an empty paint does not emit an empty sync region');
}

{
  const t = createTranscript();
  applyEvent(t, { type: 'model_streaming', payload: { assistantMessageId: 'm', kind: 'reasoning_delta', delta: 'one\ntwo\nthree\nfour' } });
  applyEvent(t, { type: 'model_streaming', payload: { assistantMessageId: 'm', kind: 'finish', done: true, delta: '' } });
  const foldOf = () => 'collapsed';
  const first = composeFrame(t, plain, 60, { foldOf });
  ok(first.commit.some(l => /thinking/.test(l)), 'collapsed thinking commits a header');
  ok(!first.commit.some(l => /\bfour\b/.test(l)), 'collapsed thinking does not dump the body');
  const again = composeFrame(t, plain, 60, { foldOf });
  ok(again.commit.length === 0, 'a second collapsed compose does not rewrite scrollback');
  const expanded = composeFrame(t, plain, 60, { foldOf: () => 'expanded' });
  ok(expanded.commit.some(l => /\bfour\b/.test(l)), 'expanding appends the hidden body');
  const collapsedAgain = composeFrame(t, plain, 60, { foldOf });
  ok(collapsedAgain.commit.length === 0, 'collapsing after expand does not un-print committed lines');
}

// --- resize: eraser + commit ledger re-measure at the new width ---------------
// A terminal resize reflows everything still on screen, so the live region's
// on-screen height changes underneath us. The height recorded at paint time is
// stale one resize later: erasing too many rows climbs into committed
// scrollback and deletes it; too few leaves residue behind.
{
  let cols = 40;
  const out3 = sink();
  const s3 = createScreen(out3, { columns: () => cols });
  s3.paint([], ['x'.repeat(80)]);            // two rows at 40 columns
  out3.chunks.length = 0;
  cols = 80;                                 // reflowed down to one row
  s3.paint([], ['after']);
  ok(unsync(out3.text).startsWith('\x1b[1A'),
     `a wider reflow shrinks the live region; the eraser must follow (got ${JSON.stringify(out3.text.slice(0, 10))})`);
  cols = 40;
  s3.paint([], ['y'.repeat(80)]);            // two rows at 40
  out3.chunks.length = 0;
  cols = 20;                                 // reflowed up to four rows
  s3.paint([], ['after']);
  ok(unsync(out3.text).startsWith('\x1b[4A'), 'a narrower reflow grows the live region; the eraser must follow');
}

// `printed` counts lines of the render it was taken from. After a re-wrap that
// count indexes the wrong lines — keeping it re-commits text already in
// scrollback (narrower) or drops the uncommitted tail entirely (wider).
{
  const s4 = createTranscript();
  applyEvent(s4, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: 'one two three four five six seven eight nine ten eleven twelve' } });
  composeFrame(s4, plain, 20);
  applyEvent(s4, { type: 'model_complete', payload: { assistantMessageId: 'm', content: null } });
  composeFrame(s4, plain, 20);               // fully committed + retired at 20 cols
  const f4 = composeFrame(s4, plain, 10);    // resize narrower: re-wraps to ~2x lines
  ok(f4.commit.length === 0, `a settled entry never re-commits after a resize (got ${f4.commit.length} lines)`);

  const strip = (l) => l.replace(/\x1b\[[0-9;]*m/g, '');
  const s5 = createTranscript();
  applyEvent(s5, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu' } });
  const committed = [];
  let f5 = composeFrame(s5, plain, 20);
  committed.push(...f5.commit.map(strip));
  f5 = composeFrame(s5, plain, 10);          // mid-stream resize narrower
  committed.push(...f5.commit.map(strip));
  ok(f5.live.length >= 2, 'the live tail repaints at the new width');
  // the unterminated source line never committed, so a mid-stream resize only
  // ever commits the separator — never a re-print of the tail's fragments
  ok(f5.commit.length <= 4,
     `a mid-stream resize commits only the tail's worth of lines (got ${f5.commit.length})`);
  applyEvent(s5, { type: 'model_complete', payload: { assistantMessageId: 'm', content: null } });
  f5 = composeFrame(s5, plain, 10);
  committed.push(...f5.commit.map(strip));
  const scrollback = committed.join(' ');
  for (const w of ['alpha', 'gamma', 'iota', 'mu'])
    ok(scrollback.includes(w), `scrollback keeps '${w}' across a mid-stream resize`);
  // The boundary line commits whole (a <1-line re-print, never a hole), so a
  // word AT the wrap boundary may appear twice; early text must never.
  const alphaCount = (scrollback.match(/alpha/g) || []).length;
  const betaCount = (scrollback.match(/beta/g) || []).length;
  ok(alphaCount === 1 && betaCount === 1,
     `committed text never re-prints wholesale after a resize ('alpha' x${alphaCount} 'beta' x${betaCount})`);

  // wider: the tail must not be dropped when the re-wrap produces fewer lines
  const s6 = createTranscript();
  applyEvent(s6, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu' } });
  const committed6 = [];
  let f6 = composeFrame(s6, plain, 10);
  committed6.push(...f6.commit.map(strip));
  f6 = composeFrame(s6, plain, 40);          // mid-stream resize wider
  committed6.push(...f6.commit.map(strip));
  applyEvent(s6, { type: 'model_complete', payload: { assistantMessageId: 'm', content: null } });
  f6 = composeFrame(s6, plain, 40);
  committed6.push(...f6.commit.map(strip));
  const scrollback6 = committed6.join(' ');
  for (const w of ['alpha', 'gamma', 'iota', 'mu'])
    ok(scrollback6.includes(w), `scrollback keeps '${w}' across a widening resize`);

  // an entry settling in the same frame as the resize still commits its tail —
  // the uncommitted prefix is measured by text, not by the old line count
  const s7 = createTranscript();
  applyEvent(s7, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu' } });
  const committed7 = [];
  committed7.push(...composeFrame(s7, plain, 20).commit.map(strip));
  applyEvent(s7, { type: 'model_complete', payload: { assistantMessageId: 'm', content: null } });
  committed7.push(...composeFrame(s7, plain, 10).commit.map(strip));   // resize + settle, one frame
  const scrollback7 = committed7.join(' ');
  for (const w of ['alpha', 'gamma', 'iota', 'mu'])
    ok(scrollback7.includes(w), `scrollback keeps '${w}' when resize and settle share a frame`);

  // back-to-back resizes mid-stream: each re-anchors on the committed prefix
  const s8 = createTranscript();
  applyEvent(s8, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi' } });
  const committed8 = [];
  committed8.push(...composeFrame(s8, plain, 20).commit.map(strip));
  committed8.push(...composeFrame(s8, plain, 10).commit.map(strip));
  committed8.push(...composeFrame(s8, plain, 30).commit.map(strip));
  applyEvent(s8, { type: 'model_complete', payload: { assistantMessageId: 'm', content: null } });
  committed8.push(...composeFrame(s8, plain, 30).commit.map(strip));
  const scrollback8 = committed8.join(' ');
  for (const w of ['alpha', 'gamma', 'iota', 'mu', 'xi'])
    ok(scrollback8.includes(w), `scrollback keeps '${w}' across back-to-back resizes`);

  // an entry retired across the resize keeps an OLD-width `printed`; when it
  // un-retires later (here: fold toggle), the ledger must re-anchor on the
  // committed text — not mis-slice the new render by the stale count
  const s9 = createTranscript();
  applyEvent(s9, { type: 'model_streaming', payload: { assistantMessageId: 'm', kind: 'reasoning_delta', delta: 'one\ntwo\nthree\nfour\nfive\nsix' } });
  applyEvent(s9, { type: 'model_streaming', payload: { assistantMessageId: 'm', kind: 'finish', done: true, delta: '' } });
  const committed9 = [];
  const foldC = () => 'collapsed';
  committed9.push(...composeFrame(s9, plain, 40, { foldOf: foldC }).commit.map(strip));
  committed9.push(...composeFrame(s9, plain, 100, { foldOf: foldC }).commit.map(strip));  // resize: stays retired
  const wide = composeFrame(s9, plain, 100, { foldOf: () => 'expanded' });               // un-retires at new width
  committed9.push(...wide.commit.map(strip));
  const scrollback9 = committed9.join(' ');
  for (const w of ['one', 'two', 'three', 'four', 'five', 'six'])
    ok(scrollback9.includes(w), `expanding a retired entry after a resize prints hidden body line '${w}'`);
  const thinkingCount = (scrollback9.match(/thinking/g) || []).length;
  ok(thinkingCount === 1, `the committed header is not re-printed on un-retire ('thinking' x${thinkingCount})`);

  // a wholesale text replace (model_complete's authoritative content) flips the
  // fingerprint while only part of the render is committed — the ledger must
  // re-anchor on the committed text, not slice the new render by a stale count
  const sA = createTranscript();
  applyEvent(sA, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu' } });
  const committedA = [];
  committedA.push(...composeFrame(sA, plain, 20).commit.map(strip));   // partial commits mid-stream
  applyEvent(sA, { type: 'model_complete', payload: { assistantMessageId: 'm', content: 'REWRITTEN alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu' } });
  committedA.push(...composeFrame(sA, plain, 20).commit.map(strip));   // same width, new fingerprint
  ok(committedA.join(' ').includes('REWRITTEN'),
     'a wholesale text replace re-anchors and prints the new head, not just the stale tail');

  // a blank line has no characters for the shape prefix to match — without a
  // sentinel the walk counts an uncommitted blank as covered and it never
  // reaches scrollback
  const sB = createTranscript();
  applyEvent(sB, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: 'aaa\nbbb\nccc' } });
  const committedB = [];
  committedB.push(...composeFrame(sB, plain, 40).commit.map(strip));   // commits 'aaa','bbb'; 'ccc' stays live
  applyEvent(sB, { type: 'model_complete', payload: { assistantMessageId: 'm', content: 'aaa\n\nbbb\nccc tail' } });
  const fB = composeFrame(sB, plain, 40);
  committedB.push(...fB.commit.map(strip));
  ok(fB.commit.map(strip)[0].trim() === '',
     `an uncommitted blank line in a revised render is committed, not skipped (got ${JSON.stringify(fB.commit.map(strip)[0])})`);
}

// --- Explored grouping --------------------------------------------------------
// Reference terminal-render behavior: consecutive read/list/search calls
// collapse under one `Explored` header as one-line members — no per-call
// result body, no blank separators between members.
{
  const strip2 = (l) => l.replace(/\x1b\[[0-9;]*m/g, '');
  const tool = (g, id, name, input, okResult = true, content = 'member body hidden') => {
    applyEvent(g, { type: 'tool_call_scheduled', payload: { toolCallId: id, toolName: name, input } });
    applyEvent(g, { type: 'tool_call_result', payload: { toolCallId: id, duration: 5, result: { success: okResult, content } } });
  };

  // A run of explore calls, broken by a Bash, then a second run.
  const g1 = createTranscript();
  tool(g1, 'a', 'Read', { file_path: 'a.txt' });
  tool(g1, 'b', 'Grep', { pattern: 'needle' });
  tool(g1, 'c', 'Bash', { command: 'ls' }, true, 'ls output shown');
  tool(g1, 'd', 'LS', { path: 'src' });
  const lines1 = composeFrame(g1, plain, 60).commit.map(strip2);
  const joined1 = lines1.join('\n');
  const heads = lines1.filter(l => l.includes('Explored'));
  ok(heads.length === 2, `each unbroken run gets exactly one Explored header (got ${heads.length})`);
  ok(/⏺ Explored/.test(joined1), 'the header is the turn glyph + Explored');
  ok(lines1.some(l => /└\s+Read a\.txt/.test(l)), 'the head member opens with the result-arm connector');
  ok(lines1.some(l => /^\s{4}Grep needle/.test(l)), 'later members indent under the arm');
  ok(!joined1.includes('member body hidden'), 'explore members never print result bodies');
  ok(lines1.some(l => /Bash\(ls\)/.test(l)) && joined1.includes('ls output shown'),
     'a non-explore call keeps its own line and result body');
  ok(lines1.some(l => /LS src/.test(l)), 'a run after the break still groups');

  // No blank separators between members of a run — the cell is compact.
  const memberIdx = lines1.findIndex(l => l.includes('Explored'));
  ok(lines1[memberIdx + 1]?.trim() !== '' && lines1[memberIdx + 2]?.trim() !== '',
     'member lines are not separated by blanks');

  // An explore member's line is known at schedule time, so it commits eagerly —
  // holding it live would let a following entry's separator land mid-cell.
  const g2 = createTranscript();
  applyEvent(g2, { type: 'tool_call_scheduled', payload: { toolCallId: 'x', toolName: 'Read', input: { file_path: 'a.txt' } } });
  const mid = composeFrame(g2, plain, 60);
  const midCommit = mid.commit.map(strip2);
  ok(midCommit.some(l => l.includes('Explored')), 'the header commits while the member runs');
  ok(midCommit.some(l => /Read a\.txt/.test(l)), 'the running member line commits eagerly');
  ok(mid.live.length === 0, 'a running explore member leaves nothing live');

  // A following entry while a member runs: its separator lands AFTER the
  // member's already-committed line — never inside the cell.
  const g2b = createTranscript();
  applyEvent(g2b, { type: 'tool_call_scheduled', payload: { toolCallId: 'x', toolName: 'Read', input: { file_path: 'a.txt' } } });
  applyEvent(g2b, { type: 'tool_call_scheduled', payload: { toolCallId: 'y', toolName: 'Bash', input: { command: 'ls' } } });
  const ord = composeFrame(g2b, plain, 60).commit.map(strip2);
  const memberIdx2 = ord.findIndex(l => /Read a\.txt/.test(l));
  ok(ord[memberIdx2 + 1] === '', 'the separator lands after the member line, not inside the cell');

  // Errors still surface: the member paints an excerpt under its line.
  const g3 = createTranscript();
  tool(g3, 'x', 'Read', { file_path: 'a.txt' }, false, 'ENOENT: no such file');
  const lines3 = composeFrame(g3, plain, 60).commit.map(strip2);
  ok(lines3.some(l => l.includes('ENOENT')), 'a failed member keeps a one-line error excerpt');

  // Folded turn: the cell collapses to header + call count (h on a user turn
  // applies `collapsed` to every foldable in it).
  const g4 = createTranscript();
  tool(g4, 'a', 'Read', { file_path: 'a.txt' });
  tool(g4, 'b', 'Grep', { pattern: 'needle' });
  const lines4 = composeFrame(g4, plain, 60, { foldOf: () => 'collapsed' }).commit.map(strip2);
  const joined4 = lines4.join('\n');
  ok(joined4.includes('Explored') && /\+\s*2 calls|2 calls/.test(joined4),
     `a folded cell shows the call count (got ${JSON.stringify(lines4)})`);
  ok(!joined4.includes('a.txt') && !joined4.includes('needle'), 'a folded cell hides member lines');

  // A run that grows AFTER its folded head retired must re-render the count:
  // the exploreRun fingerprint term exists for exactly this.
  const g5 = createTranscript();
  tool(g5, 'a', 'Read', { file_path: 'a.txt' });
  tool(g5, 'b', 'Grep', { pattern: 'needle' });
  const foldAll = { foldOf: () => 'collapsed' };
  composeFrame(g5, plain, 60, foldAll);
  tool(g5, 'c', 'LS', { path: 'src' });
  const lines5 = composeFrame(g5, plain, 60, foldAll).commit.map(strip2);
  ok(lines5.some(l => /3 calls/.test(l)),
     `a folded run that grows re-renders its count (got ${JSON.stringify(lines5)})`);
}

// --- stream-commit gating -----------------------------------------------------
// Newline gate: the unterminated tail SOURCE line stays fully live — wrapping
// it mid-stream must not commit its early fragments, since the line's render
// can still change as it grows (newline-gated commit, as in other streaming
// markdown renderers).
{
  const g = createTranscript();
  applyEvent(g, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: `intro\n${'word '.repeat(30)}` } });
  const f = composeFrame(g, plain, 40);
  ok(!f.commit.join('\n').includes('word'),
     `a wrapped tail line commits no fragments before its newline (got ${JSON.stringify(f.commit)})`);
  ok(f.live.length >= 2, 'the whole wrapped tail stays live, not just its last fragment');
  applyEvent(g, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: ' tail.\nnext' } });
  const f2 = composeFrame(g, plain, 40);
  ok(f2.commit.join('\n').includes('word') && !f2.commit.join('\n').includes('next'),
     'the terminated line commits whole once its newline lands');
}

// Table holdback: a streamed table pins from its header into the live tail —
// every new row can re-width columns, so committing the header as a plain
// paragraph (or a row at an early width) leaves a frozen stale copy in
// scrollback next to the re-rendered table.
{
  const g = createTranscript();
  const committed = [];
  const feed = (delta) => {
    applyEvent(g, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta } });
    committed.push(...composeFrame(g, plain, 60).commit);
  };
  feed('| a | b |\n');
  ok(!committed.join('\n').includes('| a | b |'),
     'a would-be table header is not committed as a paragraph');
  feed('|---|---|\n| 1 | 2 |\n');
  ok(!committed.join('\n').includes('a │ b'), 'an open table stays live while rows can still arrive');
  feed('| wider | 2 |\nafter.\n');
  ok(committed.join('\n').includes('a'), 'a terminated non-table line closes and commits the table');
  applyEvent(g, { type: 'model_complete', payload: { content: null } });
  committed.push(...composeFrame(g, plain, 60).commit);
  const scroll = committed.join('\n');
  ok(!scroll.includes('| a | b |'), 'the raw pipe source never reaches scrollback');
  ok((scroll.match(/a +│ +b/g) ?? []).length === 1,
     `the header row commits exactly once, as a table (got ${JSON.stringify(scroll)})`);
}

// The timestamp stamp lands on whichever of {first,last} line has room — a
// first line that fills the row pushes it to the live tail, and the shorter
// safe-prefix render would stamp a DIFFERENT line. The gate compares content,
// not that chrome (a previous review round: timestamps:true silently defeated
// the pin).
{
  const g = createTranscript();
  const committed = [];
  const feed = (delta) => {
    applyEvent(g, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta } });
    committed.push(...composeFrame(g, plain, 60, { timestamps: true }).commit);
  };
  feed(`${'x'.repeat(70)}\n| a | b |\n`);
  feed('|---|---|\n| 1 | 2 |\n');
  applyEvent(g, { type: 'model_complete', payload: { content: null } });
  committed.push(...composeFrame(g, plain, 60, { timestamps: true }).commit);
  ok(!committed.join('\n').includes('| a | b |'),
     'timestamps on: the raw pipe source still never commits');
}

// Regression from a previous review round: a consumed delimiter ('| - |')
// must not false-pair with a following rule line ('---') ahead of the
// genuinely open table — the prefix check then failed, the fallback committed
// the open table at narrow widths, and the next row's re-width left a torn
// header in scrollback forever.
{
  const g = createTranscript();
  const committed = [];
  const feed = (d) => {
    applyEvent(g, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: d } });
    committed.push(...composeFrame(g, plain, 60).commit);
  };
  feed('| a |\n| - |\n---\n| x | y |\n| - | - |\n| 1 | 2 |\n');
  feed('| veryverywide | 2 |\ndone.\n');
  applyEvent(g, { type: 'model_complete', payload: { content: null } });
  committed.push(...composeFrame(g, plain, 60).commit);
  const scroll = committed.join('\n');
  ok(!/x {3}│/.test(scroll), `no narrow-width table header survives the re-width (got ${JSON.stringify(scroll)})`);
  ok(/veryverywide +│ +2/.test(scroll), 'the re-widened table commits at its final width');
}

// --- cell-diff repaint --------------------------------------------------------
// paint() keeps a cell grid of the painted live region (cells.mjs) and, on a
// commit-free same-width frame, rewrites only the ROWS that changed instead of
// erasing and redrawing the region. The byte vocabulary stays inside what
// replayScreen — and every real terminal — implements: CUU/CUD, CR, LF, SGR,
// EL, ED. A diff that would cost more bytes than the repaint falls back.
{
  // One changed row out of three: no whole-region erase, no unchanged text.
  const outR = sink();
  const sR = createScreen(outR, { columns: () => 40 });
  sR.paint([], ['KEEP', 'OLD', 'KEEP2']);
  const firstPaint = outR.text;
  outR.chunks.length = 0;
  sR.paint([], ['KEEP', 'NEW', 'KEEP2']);
  const diff = unsync(outR.text);
  ok(!diff.includes('\x1b[0J'), 'a mid-region change never erases below the region top');
  ok(diff.startsWith('\x1b[3A'), 'the diff climbs the three painted rows');
  ok(outR.text.includes('NEW') && !outR.text.includes('KEEP'),
     'only the changed row is serialized, unchanged rows are never rewritten');
  // The honest oracle: replay the whole byte stream — the screen a human sees
  // must show exactly the new lines.
  const { replayScreen } = await import('./screen-replay.mjs');
  ok(replayScreen(firstPaint + outR.text, 40) === 'KEEP\nNEW\nKEEP2',
     `replayed, the diff lands on the right row (got ${JSON.stringify(replayScreen(firstPaint + outR.text, 40))})`);

  // Region growth without a commit: new rows are appended with '\n' — it
  // scrolls at the screen bottom like the classic stream; CUD would clamp.
  // (Six unchanged rows make the diff strictly cheaper than a repaint — the
  // cost model picks the full path for tiny regions, correctly.)
  const outG = sink();
  const sG = createScreen(outG, { columns: () => 40 });
  sG.paint([], ['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
  const grownFrom = outG.text;
  outG.chunks.length = 0;
  sG.paint([], ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'g6', 'g7']);
  ok(!unsync(outG.text).includes('\x1b[0J') && unsync(outG.text).includes('\ng6'),
     'a growing region appends rows instead of repainting it whole');
  ok(replayScreen(grownFrom + outG.text, 40) === 'r0\nr1\nr2\nr3\nr4\nr5\ng6\ng7',
     `replayed, the grown region shows all eight rows (got ${JSON.stringify(replayScreen(grownFrom + outG.text, 40))})`);

  // Region shrink: surplus rows die to one erase-below, not a repaint.
  // (Long survivors make the diff cheaper — the classic erase+redraw wins the
  // byte comparison when the surviving head is short, correctly.)
  const outH = sink();
  const sH = createScreen(outH, { columns: () => 40 });
  sH.paint([], ['stay-long-line-content-aaa', 'stay2-long-line-content-bb', 'gone1', 'gone2', 'gone3', 'gone4']);
  const shrinkFrom = outH.text;
  outH.chunks.length = 0;
  sH.paint([], ['stay-long-line-content-aaa', 'stay2-long-line-content-bb']);
  ok(unsync(outH.text).includes('\x1b[0J') && !outH.text.includes('stay'),
     'a shrinking region erases the surplus rows without repainting the head');
  ok(replayScreen(shrinkFrom + outH.text, 40) === 'stay-long-line-content-aaa\nstay2-long-line-content-bb',
     'replayed, only the surviving rows are on screen');

  // Every row changed: the diff costs more than the repaint — fall back to the
  // classic erase+redraw, which is strictly cheaper.
  const outF = sink();
  const sF = createScreen(outF, { columns: () => 40 });
  sF.paint([], ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee']);
  outF.chunks.length = 0;
  sF.paint([], ['WWWW', 'XXXX', 'YYYY', 'ZZZZ', 'QQQQ']);
  ok(unsync(outF.text).includes('\x1b[0J') && unsync(outF.text).includes('WWWW\nXXXX'),
     'an all-rows-changed frame keeps the cheaper whole-region repaint');

  // A styled row diffs on SGR state, not just text.
  const outT = sink();
  const sT = createScreen(outT, { columns: () => 40 });
  sT.paint([], ['h0', 'h1', 'h2', 'h3', '\x1b[31mRED\x1b[0m', 'h5']);
  const styledFrom = outT.text;
  outT.chunks.length = 0;
  sT.paint([], ['h0', 'h1', 'h2', 'h3', '\x1b[32mGRN\x1b[0m', 'h5']);
  ok(outT.text.includes('32') && !outT.text.includes('h2'),
     'a color-only change repaints that row with the new SGR, not the unchanged ones');
  ok(replayScreen(styledFrom + outT.text, 40) === 'h0\nh1\nh2\nh3\nGRN\nh5',
     'replayed, the restyled row lands on its own line');

  // A full-width repainted row: EL0 erases from the cursor INCLUSIVE, and a
  // payload that paints the last column leaves the cursor on that cell in the
  // deferred-wrap state — emitting the EL after the text deletes the last
  // glyph on xterm/VTE/iTerm2 (reviewer-found: input-box rows are padded to
  // exactly `width`, so every keystroke would have eaten the right border).
  // The erase goes before the repaint.
  {
    const outFW = sink();
    const sFW = createScreen(outFW, { columns: () => 40 });
    sFW.paint([], ['x'.repeat(40), 'k'.repeat(39), 'tail', 'end', 'last', 'six']);
    const fwFrom = outFW.text;
    outFW.chunks.length = 0;
    sFW.paint([], ['y'.repeat(40), 'k'.repeat(39), 'tail', 'end', 'last', 'six']);
    ok(unsync(outFW.text).includes(`\x1b[K${'y'.repeat(40)}`),
       `a full-width row is erased before it is repainted, never after (got ${JSON.stringify(unsync(outFW.text).slice(0, 40))})`);
    ok(replayScreen(fwFrom + outFW.text, 40) === `${'y'.repeat(40)}\n${'k'.repeat(39)}\ntail\nend\nlast\nsix`,
       `replayed, the full-width row keeps its last cell (got ${JSON.stringify(replayScreen(fwFrom + outFW.text, 40).slice(0, 50))})`);
    // The replay model itself must catch the old order — the oracle has teeth:
    ok(replayScreen('a'.repeat(40) + '\x1b[K', 40) === 'a'.repeat(39),
       'replayScreen models deferred-wrap: EL0 after a full row erases its last cell');
  }

  // A wide-char line that did not change is not repainted — its cells compare
  // equal, continuation tails included.
  const outW = sink();
  const sW = createScreen(outW, { columns: () => 40 });
  sW.paint([], ['你'.repeat(20), 'tail']);
  outW.chunks.length = 0;
  sW.paint([], ['你'.repeat(20), 'tail2']);
  ok(!outW.text.includes('你'), 'an unchanged wrapped wide-char line is not repainted');
  ok(replayScreen('你'.repeat(20) + '\ntail\n' + outW.text, 40).includes('tail2'),
     'replayed, the changed tail lands under the wide-char row');

  // A commit still takes the erase+redraw path — the region must make room for
  // lines entering scrollback.
  const outC = sink();
  const sC = createScreen(outC, { columns: () => 40 });
  sC.paint([], ['live']);
  outC.chunks.length = 0;
  sC.paint(['new-commit'], ['live']);
  ok(unsync(outC.text).includes('\x1b[0J') && outC.text.includes('new-commit\nlive'),
     'a committing frame keeps the classic erase-commit-redraw order');

  // A resize reflows the painted rows — the grid is stale, full repaint.
  let cols2 = 40;
  const outZ = sink();
  const sZ = createScreen(outZ, { columns: () => cols2 });
  sZ.paint([], ['live']);
  outZ.chunks.length = 0;
  cols2 = 80;
  sZ.paint([], ['live']);
  ok(unsync(outZ.text).includes('\x1b[0J'), 'a width change repaints the whole region');

  // writeRaw can clear the screen (ctrl-l) — the grid is invalidated, so the
  // next paint cannot diff against a screen that no longer shows it.
  const outX = sink();
  const sX = createScreen(outX, { columns: () => 40 });
  sX.paint([], ['live']);
  outX.chunks.length = 0;
  sX.writeRaw('\x1b[2J\x1b[H');
  sX.paint([], ['live']);
  ok(unsync(outX.text).includes('\x1b[0J'), 'a cleared screen forces a full repaint');

  // clearLive drops the grid: the next paint is a first paint again.
  const outL = sink();
  const sL = createScreen(outL, { columns: () => 40 });
  sL.paint([], ['live']);
  sL.clearLive();
  outL.chunks.length = 0;
  sL.paint([], ['live']);
  ok(outL.text === '\x1b[?2026hlive\n\x1b[?2026l',
     `after clearLive the next paint draws fresh, no diff (got ${JSON.stringify(outL.text)})`);

  // Cursor park after a diff is relative to the last painted row, and still
  // lands on the logical line's grid row.
  const outP = sink();
  const sP = createScreen(outP, { columns: () => 40 });
  sP.paint([], ['l0', 'l1', 'l2', 'l3', 'l4', 'l5'], { line: 5, col: 3 });
  const parkedFrom = outP.text;
  outP.chunks.length = 0;
  sP.paint([], ['l0', 'l1', 'l2', 'l3', 'l4', 'l5X'], { line: 0, col: 1 });
  ok(unsync(outP.text).endsWith('\x1b[5A\x1b[2G'),
     `the park climbs from the last touched row to the target row (got ${JSON.stringify(unsync(outP.text).slice(-16))})`);
  ok(replayScreen(parkedFrom + outP.text, 40) === 'l0\nl1\nl2\nl3\nl4\nl5X',
     `replayed with a parked cursor, the diff still lands on the right row (got ${JSON.stringify(replayScreen(parkedFrom + outP.text, 40))})`);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
