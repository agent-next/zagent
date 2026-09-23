// Footer tests. The footer's line COUNT is load-bearing: index.mjs erases exactly
// as many lines as it drew, so a footer that wraps would eat the transcript.
import { renderInputBox, renderStatus, renderFooter, renderBanner, statusFields, renderPermission, permissionOptions, renderQueued, renderCompletions, renderUserPeek, renderChooser, readContextMeter, COMPLETION_ROWS, inputBoxCursor, renderHintBar } from './chrome.mjs';
import { createTheme } from './theme.mjs';
import { createTranscript } from './events.mjs';
import { stringsFor } from './strings.mjs';
import { stringWidth } from './width.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const plain = createTheme({ enabled: false });
const idle = createTranscript();

// --- input box ---------------------------------------------------------------
let box = renderInputBox('', plain, 40);
ok(box.length === 3, 'input box is exactly 3 lines');
ok(box.every(l => stringWidth(l) === 40), `every box line is exactly the given width in CELLS (got ${box.map(stringWidth)})`);
ok(box[1].includes('Ask a task'), 'empty box shows the placeholder');
ok(!renderInputBox('typed', plain, 40)[1].includes('Ask a task'), 'typed text replaces the placeholder');
ok(renderInputBox('', plain, 40, { busy: true })[1].includes('  ') , 'busy box hides the placeholder');

const narrow = renderInputBox('x'.repeat(200), plain, 30);
ok(narrow.every(l => stringWidth(l) === 30), 'over-long input is clipped to the box, never wrapped');
ok(narrow[1].includes('…'), 'clipped input is marked with an ellipsis');
ok(renderInputBox('', plain, 4).every(l => stringWidth(l) >= 20), 'absurdly narrow terminal falls back to a floor');

// --- input cursor -------------------------------------------------------------
// The hardware cursor is parked inside the box: inputBoxCursor reports a line
// index into the rendered box and a 0-based cell column on it. At width 40 the
// text lead is "│ > " = 4 cells, the text room is 34.
{
  const lead = 4, room = 34;
  ok(inputBoxCursor('', plain, 40, { cursor: 0 }) !== null, 'an empty box still parks the cursor (placeholder)');
  const empty = inputBoxCursor('', plain, 40, { cursor: 0 });
  ok(empty.row === 1 && empty.col === lead && empty.rows === 3,
     `empty box cursor rests after the marker (got ${JSON.stringify(empty)})`);
  ok(inputBoxCursor('hello', plain, 40, { cursor: 5 }).col === lead + 5, 'cursor at end of typed text');
  ok(inputBoxCursor('hello', plain, 40, { cursor: 2 }).col === lead + 2, 'cursor moved left tracks the offset');
  ok(inputBoxCursor('hello', plain, 40) === null, 'no cursor option, no parking');
  // Wrapping: char 34 lands on row 2 of the box, column lead+1.
  const wrap = inputBoxCursor('a'.repeat(40), plain, 40, { cursor: room + 1 });
  ok(wrap.row === 2 && wrap.col === lead + 1, `cursor follows a hard split onto the next row (got ${JSON.stringify(wrap)})`);
  // Collapsed whitespace: "aa  bb" renders "aa bb"; cursor before 'b' sits at
  // cell 3 — a prefix-wrap of the source would say 4.
  ok(inputBoxCursor('aa  bb', plain, 40, { cursor: 4 }).col === lead + 3,
     'cursor stays exact where the wrap collapses whitespace');
  // CJK: two double-width chars then cursor — cells, not code points.
  ok(inputBoxCursor('你好x', plain, 40, { cursor: 2 }).col === lead + 4, 'CJK cursor counts cells');
  // The visible window follows the cursor instead of pinning to the tail.
  const long = 'x'.repeat(500);                    // 21 wrapped rows at room 24 (width 30)
  const top = inputBoxCursor(long, plain, 30, { cursor: 0 });
  ok(top.row === 1 && top.col === lead, `a cursor scrolled off the tail pulls the window up (got ${JSON.stringify(top)})`);
  const end = inputBoxCursor(long, plain, 30, { cursor: 500 });
  ok(end.row === 1 + 7, `a cursor at the end keeps the tail window (got ${JSON.stringify(end)})`);
  // The "earlier lines" note owns the first visible row — the window slides one
  // earlier so the cursor never parks on the note itself.
  const edge = inputBoxCursor(long, plain, 30, { cursor: 13 * 24 });
  ok(edge.row === 2, `cursor at the window top clears the note row (got ${JSON.stringify(edge)})`);
  ok(renderInputBox(long, plain, 30, { cursor: 13 * 24 })[1].includes('earlier'),
     'the note is still shown for the hidden rows above');
  // Busy box: no placeholder, cursor still parks on the first row.
  ok(inputBoxCursor('', plain, 40, { busy: true, cursor: 0 }).col === lead,
     'busy box parks at the text start');
  // The painted box IS the marked layout: a cursor that wraps onto a fresh row
  // grows the box by that row — the measured spot and the painted rows can never
  // disagree (the draw path passes cursor through renderFooter too).
  const edge2 = inputBoxCursor('a'.repeat(room), plain, 40, { cursor: room });
  ok(edge2.row === 2 && edge2.col === lead && edge2.rows === 4,
     `a cursor at the wrap boundary lands on the grown row (got ${JSON.stringify(edge2)})`);
  ok(renderInputBox('a'.repeat(room), plain, 40, { cursor: room }).length === 4,
     'the painted box grows the same row the cursor parks on');
  // A pasted sentinel char can never collide with the mark or leak into the box.
  const hostile2 = renderInputBox('abcd', plain, 40, { cursor: 2 });
  ok(!hostile2.join('').includes(''), 'a literal sentinel in the input is stripped, never rendered');
  ok(inputBoxCursor('abcd', plain, 40, { cursor: 2 }).col === lead + 2,
     'the mark still lands after the stripped char');
}

// --- status ------------------------------------------------------------------
let st = renderStatus(idle, plain, 60, { mode: 'build', model: 'zai/glm-5.3' });
ok(st.length === 1, 'status is exactly 1 line');
ok(st[0].includes('>> build') && st[0].includes('zai/glm-5.3'), 'idle status shows mode then model');

const busy = createTranscript();
busy.turn = { active: true, startedAt: Date.now() - 1500, usage: null, retries: 0, errors: 0, toolCalls: 0 };
st = renderStatus(busy, plain, 60, { spinnerFrame: 0, now: Date.now() });
ok(/waiting 1\.5s/.test(st[0]), 'a turn with no output yet shows the waiting phase and elapsed');
ok(st[0].includes('esc to interrupt'), 'busy status advertises the interrupt key');
st = renderStatus(busy, plain, 60, { spinnerFrame: 0, now: Date.now(), escArmed: true });
ok(st[0].includes('esc again to interrupt'), 'an armed esc swaps the hint');
ok(!st[0].includes('esc to interrupt'), 'the armed hint replaces rather than appends');

// Turn-status phases: 'waiting' until the first observable model output,
// 'responding' after, with a ⇣ received-bytes counter (other-harness parity). A turn
// object without the fields (older reducer shape) reads as waiting.
busy.turn.responded = true; busy.turn.streamBytes = 1536;
st = renderStatus(busy, plain, 60, { now: Date.now() });
ok(st[0].includes('responding') && st[0].includes('⇣1.5k'),
   `a turn with output shows the responding phase and received bytes (got ${JSON.stringify(st[0])})`);
ok(!st[0].includes('waiting'), 'the responding phase replaces waiting');

// Once the turn ends the per-turn counters are transcript history — the idle
// footer must not keep them (a previous review round: '· 2 retries' post-interrupt).
// The usage summary is the piece that stays.
const ended = createTranscript();
ended.turn = { active: false, startedAt: Date.now() - 40000, endedBy: 'interrupt',
  usage: { totalTokens: 15846 }, retries: 2, errors: 1, toolCalls: 0 };
st = renderStatus(ended, plain, 80, { mode: 'build', model: 'zai/glm-5.3' });
ok(!st[0].includes('retries') && !st[0].includes('failed'),
   `an ended turn drops the retries/failed counters from the footer (got ${JSON.stringify(st[0])})`);
ok(st[0].includes('16k tokens'), 'the usage summary survives the turn end');
st = renderStatus(busy, plain, 60, { now: Date.now(), activity: 'running command' });
ok(st[0].includes('running command') && !st[0].includes('responding'),
   'a host-named activity still wins over the phase label');
ok(st[0].includes('⇣1.5k'), 'the byte counter shows regardless of the activity label');
{
  const staleStr = { ...stringsFor('en-US') };
  delete staleStr.waiting; delete staleStr.responding;
  const unphased = createTranscript();
  unphased.turn = { active: true, startedAt: Date.now() - 1500, responded: true, streamBytes: 5 };
  ok(statusFields(unphased, plain, { now: Date.now(), str: staleStr })[0].text.includes('working'),
     'a host str that predates the phase keys falls back to working');
}
busy.turn.responded = false; busy.turn.streamBytes = 0;
{
  const asciiTheme = createTheme({ enabled: false, ascii: true });
  const streamed = createTranscript();
  streamed.turn = { active: true, startedAt: Date.now(), responded: true, streamBytes: 42 };
  ok(renderStatus(streamed, asciiTheme, 60, { now: Date.now() })[0].includes('v42'),
     'ascii mode swaps the ⇣ glyph');
}

busy.turn.usage = { totalTokens: 15846 };
busy.turn.retries = 2; busy.turn.errors = 1;
st = renderStatus(busy, plain, 80, { now: Date.now() });
ok(st[0].includes('16k tokens') && st[0].includes('2 retries') && st[0].includes('1 failed'),
   'status surfaces tokens, retries and failures');

const squeezed = renderStatus(busy, plain, 24, { now: Date.now() });
ok(squeezed.length === 1 && stringWidth(squeezed[0]) <= 24,
   `a narrow terminal drops trailing fields instead of wrapping (cells ${stringWidth(squeezed[0])})`);

ok(statusFields(idle, plain, { mode: 'plan' })[0].text.startsWith('='), 'plan mode has its own mark');
ok(statusFields(idle, plain, { mode: 'yolo' })[0].text.startsWith('!!'), 'yolo mode has its own mark');
ok(statusFields(idle, plain, {})[0].text.includes('build'), 'mode defaults to build');
ok(statusFields(idle, plain, { mode: 'build', goal: 'ship 0.1' }).some(f => f.text.includes('goal ship 0.1')),
   'status shows the current /goal objective');
ok(statusFields(idle, plain, { mode: 'build', mcp: { connected: 2, failed: 0, total: 2 } })
   .some(f => f.text.includes('mcp 2/2')), 'status shows connected MCP servers');
ok(statusFields(idle, plain, { mode: 'build', mcp: { connected: 1, failed: 1, total: 2 } })
   .some(f => /failed/.test(f.text)), 'status flags failed MCP servers');

// --- contextual hint bar -----------------------------------------------------
// One persistent row under the status line teaches the keys that are real in
// the CURRENT state: idle advertises send/newline, a running turn swaps to
// interrupt/exit. What it may never do is name a binding that does not exist —
// the spec's own note: shift+tab only steps queue items, so it is not a "mode"
// hint until the binding lands.
{
  const foot = renderFooter(idle, '', plain, 60, { mode: 'build' });
  const hint = foot.at(-1);
  ok(/enter send/.test(hint) && /alt\+enter newline/.test(hint), 'idle hint bar teaches send + newline');
  ok(/\? shortcuts/.test(hint), 'idle hint bar names the one-keystroke help');
  ok(!/shift\+tab/i.test(hint), 'no shift+tab hint — it only steps queue items');

  const busyFoot = renderFooter(busy, '', plain, 60, { busy: true, now: Date.now() });
  const busyHint = busyFoot.at(-1);
  ok(/esc to interrupt/.test(busyHint) && /ctrl\+c/.test(busyHint), 'busy hint bar swaps to interrupt + exit');
  ok(!/alt\+enter/.test(busyHint), 'the busy hint replaces rather than appends');

  const armedFoot = renderFooter(busy, '', plain, 60, { busy: true, escArmed: true, now: Date.now() });
  ok(/esc again to interrupt/.test(armedFoot.at(-1)), 'an armed esc swaps the hint bar too');

  // zh-CN rides theme.str like every other chrome surface.
  const zh = createTheme({ enabled: false });
  zh.str = stringsFor('zh-CN');
  ok(/发送/.test(renderFooter(idle, '', zh, 60, { mode: 'build' }).at(-1)), 'zh-CN idle hint is localized');
  ok(/中断/.test(renderFooter(busy, '', zh, 60, { busy: true }).at(-1)), 'zh-CN busy hint is localized');

  // Exactly one row at any width — a wrapping hint would desync the erase
  // ledger the same way a wrapped status line did.
  for (const w of [10, 24, 40]) {
    const f = renderFooter(idle, '', plain, w, { mode: 'build' });
    ok(stringWidth(f.at(-1)) <= w, `hint bar stays inside ${w} cells (got ${stringWidth(f.at(-1))})`);
  }
  // A host-supplied str from before the keys existed must not blank the row.
  const stale = { placeholder: 'x', interrupt: 'esc to interrupt', interruptAgain: 'esc again to interrupt' };
  ok(/enter send/.test(renderFooter(idle, '', plain, 60, { mode: 'build', str: stale }).at(-1)),
     'a stale host str falls back instead of blanking the hint');
  const quietBusy = createTranscript();
  quietBusy.turn = { active: true, startedAt: Date.now() - 500, usage: null, retries: 0, errors: 0 };
  ok(/ctrl\+c twice to exit/.test(renderFooter(quietBusy, '', plain, 60, { busy: true, str: stale, now: Date.now() }).at(-1)),
     'a stale host str still gets the busy hint');
}

// --- footer / banner ---------------------------------------------------------
ok(renderFooter(idle, '', plain, 50, { mode: 'build' }).length === 5, 'footer is 5 lines (3 box + status + hint)');
// The honest version line: zagent's own version, the runtime's product version,
// then the model. "zagent runtime 0.16.5" was the bug — that string is the
// kernel's internal build, not the installed product's.
const banner = renderBanner(plain, 80, { version: '0.0.202', runtime: 'desktop-bundle 3.11.2', model: 'zai/glm-5.3',
  workspace: '~/p', branch: 'main' });
ok(banner[0].includes('zagent 0.0.202') && banner[0].includes('runtime desktop-bundle 3.11.2') && banner[0].includes('zai/glm-5.3'),
   'banner first line is "zagent <pkg> · runtime <kind> <version> · <model>"');
ok(renderBanner(plain, 60, { version: '0.0.202' })[0].includes('zagent 0.0.202'),
   'the banner works without runtime or model info');
ok(renderBanner(plain, 60, { version: '0.0.202', runtime: 'explicit (kernel 0.16.5)' })[0].includes('runtime explicit (kernel 0.16.5)'),
   'an unversioned install keeps the kernel string labelled, never the product version');
ok(renderBanner(plain, 60, { version: '0.0.202', runtime: 'desktop-bundle' })[0].includes('runtime desktop-bundle'),
   'the runtime kind stands in when no version is exposed');
ok(banner.some(l => l.includes('~/p') && l.includes('main')), 'banner shows workspace and branch');
ok(renderBanner(plain, 60, {}).length >= 2, 'banner survives missing workspace info');

// no-color mode must emit zero escape sequences anywhere in the footer
const all = [...renderFooter(busy, 'hi', plain, 60, { now: Date.now() }), ...renderBanner(plain, 60, {})].join('');
ok(!all.includes('\x1b'), 'color-disabled theme emits no ANSI in any chrome');

// --- CJK and emoji must not overflow the terminal -----------------------------
// Regression: widths were counted in CODE POINTS. A CJK input line measured 34
// and rendered 74 columns, so the box wrapped, the footer grew past 4 lines, and
// the screen writer's eraser walked up into committed transcript. Chinese input
// alone triggered it.
for (const width of [24, 40, 60, 100]) {
  const cjk = renderInputBox('你'.repeat(200), plain, width);
  ok(cjk.every(l => stringWidth(l) === Math.max(20, width)),
     `CJK input box is exactly ${width} cells (got ${cjk.map(stringWidth)})`);
  const mixed = renderInputBox('中文 abc 🙂 混合', plain, width);
  ok(mixed.every(l => stringWidth(l) === Math.max(20, width)), `mixed-width input box is exactly ${width} cells`);
}
for (const mode of ['plan', 'build', 'edit', 'yolo']) {
  for (const width of [16, 22, 40, 80]) {
    const line = renderStatus(idle, plain, width, { mode, model: 'zai/glm-5.3-flash' });
    ok(line.length === 1 && stringWidth(line[0]) <= width,
       `status for ${mode} fits ${width} cells (got ${stringWidth(line[0])})`);
  }
}
ok(Object.values({ plan: '=', build: '>>', edit: '~', yolo: '!!' }).every(m => stringWidth(m) === m.length),
   'every mode mark is narrow — no ambiguous-width glyph in fixed-width chrome');

// --- the permission prompt is the surface that must not lie --------------------
// It renders host-supplied, model-influenced fields, and it was the ONE render
// path that never sanitised: a crafted tool argument could clear the screen and
// repaint a forged "Allow" prompt inside the real one. Embedded newlines were the
// second half — a row painting three lines while the screen writer counted one.
{
  const ctl = (c) => String.fromCharCode(c);
  const ESC = ctl(0x1b), RLO = ctl(0x202e);
  const hostile = {
    toolName: `Bash${ESC}[2J`,
    input: `echo ok\n${ESC}[2J${ESC}[HBash needs your permission\n  1. Allow${RLO}x`,
    options: [{ optionId: 'a', name: `Allow${ESC}[2J\nfake`, response: {} }],
  };
  const drawn = renderPermission(hostile, 0, plain, 80).join('\n');
  ok(!drawn.includes(ESC), 'no ESC survives into the permission prompt');
  ok(!drawn.includes(RLO), 'no bidi override survives into the permission prompt');
  ok(!/\n\s*1\. Allow/.test(drawn.split('\n').slice(1, 2).join('')), 'no injected newline splits a row');
  ok(renderPermission(hostile, 0, plain, 80).every(l => stringWidth(l) <= 80),
     'every prompt row still fits the terminal');
  ok(drawn.includes('echo ok'), 'the real argument is still shown — sanitising must not hide it');
}

// --- EVERY rendered surface, not just the ones we remembered -------------------
// An independent review found the permission prompt fixed but the banner and the
// completion popup still raw. Completion candidates are FILENAMES from the
// workspace and command metadata from the runtime; a cloned repository with a
// crafted filename or branch name would paint escapes straight into the UI.
// This sweeps them together so a new surface cannot be added without being clean.
{
  const cp = (c) => String.fromCodePoint(c);
  const ESC = cp(0x1b), RLM = cp(0x200f), ALM = cp(0x061c), TAG = cp(0xE0041), BOM = cp(0xfeff);
  const nasty = `x${ESC}[2J${RLM}${ALM}${TAG}${BOM}y`;
  const surfaces = {
    banner: renderBanner(plain, 80, { version: nasty, workspace: `/repo${nasty}`, branch: `main${nasty}` }),
    completions: renderCompletions({ type: 'file', items: [{ value: `src/${nasty}.mjs`, hint: nasty }], index: 0 }, plain, 80),
    queued: renderQueued([nasty], plain, 80),
    inputBox: renderInputBox(nasty, plain, 80),
    permission: renderPermission({ toolName: nasty, input: nasty, options: [{ name: nasty, response: {} }] }, 0, plain, 80),
    status: renderStatus(idle, plain, 80, { mode: 'build', model: nasty }),
    hintBar: renderHintBar(plain, 80, { str: { hintIdle: nasty, hintBusy: () => nasty } }),
  };
  for (const [name, lines] of Object.entries(surfaces)) {
    const joined = lines.join('');
    for (const [ch, label] of [[ESC, 'ESC'], [RLM, 'RLM'], [ALM, 'ALM'], [TAG, 'tag char'], [BOM, 'BOM']]) {
      ok(!joined.includes(ch), `${name}: no ${label} reaches the terminal`);
    }
    ok(lines.every(l => stringWidth(l) <= 80), `${name}: every row still fits the terminal`);
  }
}

// --- queued input -------------------------------------------------------------
// Typing during a turn must never be dropped, and showing the actual text (not
// just a count) is what makes queueing trustworthy.
ok(renderQueued([], plain, 60).length === 0, 'an empty queue renders nothing');
ok(renderQueued(undefined, plain, 60).length === 0, 'a missing queue renders nothing');
const q = renderQueued(['first task', 'second task'], plain, 60);
ok(q.length === 2 && q[0].includes('first task') && q[1].includes('second task'),
   'queued messages are listed in order');
ok(q[0].includes('[send now]') && q[0].includes('[edit]') && q[0].includes('[cancel]'),
   'queued follow-ups show [send now][edit][cancel]');
ok(q.every(l => stringWidth(l) <= 60), 'queued rows with action chips still fit the terminal');
const qSel = renderQueued(['only'], plain, 80, 3, { selected: 0, action: 1 });
ok(qSel[0].includes('[edit]'), 'the selected queue action is visible');
const many = renderQueued(['a', 'b', 'c', 'd', 'e'], plain, 60, 3);
ok(many.length === 4 && many.at(-1).includes('+2 more queued'), 'a long queue is capped and counted');
ok(renderQueued(['x'.repeat(200)], plain, 40)[0].length <= 40, 'a long queued line is clipped to the width');
ok(renderQueued(['multi\nline\ntext'], plain, 60)[0].includes('multi line text'),
   'a multi-line queued message is flattened to one line');

st = renderStatus(busy, plain, 80, { now: Date.now(), queue: ['a', 'b'] });
ok(st[0].includes('2 queued'), 'the status counts queued messages');
ok(renderStatus(busy, plain, 80, { now: Date.now(), queue: [] })[0].includes('queued') === false,
   'an empty queue adds no status field');

const footerQ = renderFooter(idle, '', plain, 50, { mode: 'build', queue: ['one'] });
ok(footerQ.length === 6, 'the footer grows by exactly one line per shown queue entry');
ok(footerQ[0].includes('one'), 'queued entries render above the input box');
ok(footerQ[0].includes('[send now]'), 'queued footer rows carry follow-up actions');

ok(renderUserPeek([], 0, plain, 60).length === 0, 'no peek without user turns');
ok(renderUserPeek([{ kind: 'user', text: 'hello' }], -1, plain, 60).length === 0,
   'no peek until a user turn is selected');
const peek = renderUserPeek(
  [{ kind: 'user', text: 'alpha' }, { kind: 'assistant', text: 'x' }, { kind: 'user', text: 'beta' }],
  0, plain, 60);
ok(peek.length === 1 && peek[0].includes('1/2') && peek[0].includes('alpha'),
   'shift+up peeks the selected user turn without rewriting history');
ok(stringWidth(peek[0]) <= 60, 'the peek row fits the terminal');
// The single-entry fold cursor: while a turn is selected the peek also
// names which foldable `o` would toggle — a bare position would not be aimable.
const peekFold = renderUserPeek(
  [{ kind: 'user', text: 'alpha' },
   { kind: 'tool', name: 'Read', input: { file_path: 'a.txt' } }],
  0, plain, 60, null, { index: 0, count: 2, entry: { kind: 'tool', name: 'Read', input: { file_path: 'a.txt' } } });
ok(peekFold.length === 1 && peekFold[0].includes('fold 1/2'), 'the peek shows the fold cursor position');
ok(peekFold[0].includes('Read'), 'the foldable under the cursor is named');
ok(stringWidth(peekFold[0]) <= 60, 'the peek row still fits with the fold tag');
const peekThink = renderUserPeek(
  [{ kind: 'user', text: 'alpha' }, { kind: 'thinking', text: 'x' }],
  0, plain, 60, null, { index: 0, count: 1, entry: { kind: 'thinking', text: 'x' } });
ok(peekThink[0].includes('thinking'), 'a thinking foldable is labelled with the locale word');
// Untrusted tool input must not paint escapes into the footer.
const peekBad = renderUserPeek(
  [{ kind: 'user', text: 'a' }], 0, plain, 60, null,
  { index: 0, count: 1, entry: { kind: 'tool', name: 'B', input: { command: 'x\x1b[2Jy' } } });
ok(!peekBad[0].includes('\x1b'), 'a hostile tool arg cannot inject escapes through the fold tag');
const footerPeek = renderFooter(idle, '', plain, 50, { mode: 'build', userTurn: 0 });
ok(footerPeek.length === 5, 'a missing selected turn does not grow the footer');
idle.entries.push({ kind: 'user', text: 'saved prompt' });
ok(renderFooter(idle, '', plain, 50, { mode: 'build', userTurn: 0 }).length === 6,
   'a selected user turn adds exactly one peek line');
idle.entries.length = 0;

// --- completion popup ---------------------------------------------------------
const items = Array.from({ length: 20 }, (_, i) => ({ value: `cmd${i}`, hint: `does thing ${i}` }));
ok(renderCompletions(null, plain, 60).length === 0, 'no completion renders nothing');
ok(renderCompletions({ type: 'slash', items: [], index: 0 }, plain, 60).length === 0, 'an empty list renders nothing');

const pop = renderCompletions({ type: 'slash', items, index: 0 }, plain, 60, 6);
ok(pop.length === 7, 'the popup is capped at 6 rows plus an overflow line');
ok(pop[0].includes('/cmd0') && pop[0].includes('does thing 0'), 'slash items show the command and its runtime summary');
ok(pop.at(-1).includes('+14 more'), 'hidden candidates are counted');

// the selection must stay visible when it scrolls past the window
const deep = renderCompletions({ type: 'slash', items, index: 19 }, plain, 60, 6);
ok(deep.some(l => l.includes('cmd19')), 'a selection past the window scrolls into view');
ok(renderCompletions({ type: 'slash', items, index: 99 }, plain, 60, 6).some(l => l.includes('cmd19')),
   'an out-of-range index is clamped');
ok(renderCompletions({ type: 'file', items: [{ value: 'src/a.mjs' }], index: 0 }, plain, 60)[0].includes('src/a.mjs'),
   'file items show the path without a slash prefix');
ok(!renderCompletions({ type: 'file', items: [{ value: 'src/a.mjs' }], index: 0 }, plain, 60)[0].includes('/src'),
   'file items are not prefixed like commands');
for (const width of [24, 40, 80]) {
  const narrow = renderCompletions({ type: 'slash', items: [{ value: 'x'.repeat(60), hint: 'y'.repeat(60) }], index: 0 }, plain, width);
  ok(narrow.every(l => stringWidth(l) <= width), `popup fits ${width} cells`);
}
ok(renderFooter(idle, '', plain, 50, { mode: 'build', completion: { type: 'slash', items: items.slice(0, 2), index: 0 } }).length === 8,
   'the popup adds its rows above the input box, including the status line');

// The default page is COMPLETION_ROWS (10) rows + the status line, and the
// footer's completionRows option is the terminal-height guard index.mjs passes.
{
  const many = Array.from({ length: 25 }, (_, i) => ({ value: `c${i}`, hint: `h${i}` }));
  const page = renderCompletions({ type: 'slash', items: many, index: 0 }, plain, 60);
  ok(page.length === COMPLETION_ROWS + 1, `the default window is ${COMPLETION_ROWS} rows + status`);
  ok(/1\/25/.test(page.at(-1)), 'the status line counts position/total');
  const tall = renderFooter(idle, '', plain, 50,
    { mode: 'build', completion: { type: 'slash', items: many, index: 0 }, completionRows: 4 });
  ok(tall.length === 4 + 6, 'a small terminal shrinks the popup to the guarded row count');
}

// --- permission prompt --------------------------------------------------------
const req = { toolName: 'Bash', input: { command: 'rm -rf build' }, options: [
  { optionId: 'allow_once', name: 'Allow once', response: { decision: 'allow' } },
  { optionId: 'allow_always', name: 'Allow for this session', response: { decision: 'allow', scope: 'session' } },
  { optionId: 'deny', name: 'Deny', response: { decision: 'deny' } },
] };
const opts = permissionOptions(req);
ok(opts.length === 3 && opts[0].value === 'allow_once', 'options are read from the request');
ok(opts[1].response.scope === 'session', 'each option keeps the runtime-supplied response verbatim');
ok(permissionOptions({}).length === 1 && permissionOptions({})[0].response.decision === 'deny',
   'a request with no options still offers a way out (deny), never traps the session');
ok(permissionOptions({ options: [null, 'x', { name: 'Ok' }] }).length === 1, 'malformed option entries are skipped');
ok(permissionOptions({ options: [{ kind: 'allow' }] })[0].value === 'allow', 'kind is accepted as the option id');

// 3.12.1 TUI-bridge shape (live-captured): no `options` — the card used to render
// Deny-only so NO mutating tool could be approved. permissionOptions synthesizes
// the answerable set; {decision:'allow'} is the proven response contract.
const req312 = { toolName: 'Write', input: { file_path: '/tmp/x' }, mode: 'build',
  reason: 'Tool has side effects and requires approval', riskLevel: 'medium',
  ruleId: 'mode.build.sideEffect', sideEffectScope: 'workspace',
  suggestedPermissionUpdates: [{ behavior: 'allow',
    rules: [{ toolName: 'Write', ruleContent: '/tmp/x' }], type: 'addRules' }],
  requestId: 'perm_1', requestedAt: 't', traceId: 'tr', sessionId: 'sess_1',
  toolCallId: 'call_1', turnId: 'turn_1' };
const o312 = permissionOptions(req312);
ok(o312.length === 3, 'options-less 3.12.1 request gets the full allow/deny set');
ok(o312[0].value === 'allow_once' && o312[0].response.decision === 'allow',
   'synthesized allow_once answers {decision:allow}');
ok(o312[1].value === 'allow_always' &&
   o312[1].response.permissionUpdates.length === 1 &&
   o312[1].response.permissionUpdates[0] === req312.suggestedPermissionUpdates[0],
   'synthesized allow_always carries the host-suggested permissionUpdates verbatim');
ok(o312[2].value === 'deny' && o312[2].response.decision === 'deny', 'deny stays available');
const o312b = permissionOptions({ toolName: 'Write', input: {}, mode: 'build' });
ok(o312b.length === 2 && o312b.every(o => o.value !== 'allow_always'),
   'no suggestedPermissionUpdates means no allow_always to persist');
ok(permissionOptions({ toolName: 'Write', options: [] }).length === 2,
   'an empty options array on a named tool still synthesizes allow+deny');
const o312c = permissionOptions({ toolName: 'Write', suggestedPermissionUpdates: [null, 'x', { type: 'addRules' }] });
ok(o312c[1].response.permissionUpdates.length === 1,
   'malformed suggestedPermissionUpdates entries are filtered, not replayed');
ok(renderPermission({ toolName: 'Bash', input: { command: 'rm x' }, riskLevel: 'high',
  reason: 'High risk tools require explicit approval' }, 0, plain, 80)
  .some(l => l.includes('high') && l.includes('High risk')),
   'the card surfaces the host-supplied riskLevel + reason');

// The detail picker is shared with the transcript's tool header; an inline copy
// with a shorter key list showed NO detail for Search/WebSearch or MCP calls —
// exactly where you most need to see what you are approving.
for (const [input, want] of [[{ query: 'search me' }, 'search me'], [{ prompt: 'mcp arg' }, 'mcp arg'],
                             [{ command: 'rm -rf x' }, 'rm -rf x'], ['a raw string input', 'a raw string input']]) {
  const p = renderPermission({ toolName: 'T', input, options: [{ optionId: 'a', name: 'Allow', response: {} }] }, 0, plain, 60);
  ok(p.some(l => l.includes(want)), `permission shows the detail for ${JSON.stringify(input).slice(0, 24)}`);
}
for (const width of [30, 40, 80]) {
  const wide = renderPermission({ toolName: 'mcp__server__' + 'x'.repeat(60), input: { command: 'y'.repeat(80) },
    options: [{ optionId: 'a', name: 'Allow this specific invocation once for the session', response: {} }] }, 0, plain, width);
  ok(wide.every(l => stringWidth(l) <= width),
     `every permission line fits ${width} cells (got ${wide.map(stringWidth)})`);
}
// The runtime's reasoning budget is one of its real differentiators (low 8k /
// high 16k / max 32k); it was written to ui state and never displayed.
ok(statusFields(idle, plain, { mode: 'build', model: 'm', effort: 'max' }).some(f => f.text === 'max'),
   'the effort level is shown in the status line');
ok(!statusFields(idle, plain, { mode: 'build', model: 'm' }).some(f => f.text === 'max'),
   'no effort field when the runtime did not report one');

ok(statusFields(idle, plain, { mode: 'auto' })[0].text.startsWith('@'),
   'auto mode has its own mark (it is in driver MODES and was missing here)');

// --- running subagent count ----------------------------------------------------
// events.mjs tracks in-flight Agent tool calls (state.subagents); index.mjs hands
// the count over as options.agents. Before this, a turn with running children
// looked identical to one working alone.
ok(statusFields(busy, plain, { now: Date.now(), agents: 2 }).some(f => f.text === 'agents 2'),
   'status shows the running subagent count');
ok(statusFields(idle, plain, { mode: 'build', agents: 3 }).some(f => f.text === 'agents 3'),
   'the count shows while idle too');
ok(!statusFields(busy, plain, { now: Date.now() }).some(f => f.text.includes('agents')),
   'no agents field when none are running');
ok(!statusFields(busy, plain, { now: Date.now(), agents: 0 }).some(f => f.text.includes('agents')),
   'a zero count adds no field');
ok(!statusFields(busy, plain, { now: Date.now(), agents: 'x' }).some(f => f.text.includes('agents')),
   'a non-numeric count is junk-safe');
const staleStr = { ...stringsFor('en-US') };
delete staleStr.agents;
ok(statusFields(busy, plain, { now: Date.now(), agents: 1, str: staleStr }).some(f => f.text === 'agents 1'),
   'a str that predates the key still renders the count');
const withAgents = renderStatus(busy, plain, 24, { now: Date.now(), agents: 2 });
ok(withAgents.length === 1 && stringWidth(withAgents[0]) <= 24,
   'the agents field still drops rather than wrap a narrow terminal');

// --- the official context meter ----------------------------------------------
{
  const metered = createTranscript();
  metered.projection = { contextUsed: 12_000, contextWindow: 1_000_000 };
  ok(statusFields(metered, plain, { mode: 'build' }).some(f => f.text === '12k/1M'),
     'status shows contextUsed/contextWindow as 12k/1M');
  ok(!statusFields(idle, plain, { mode: 'build' }).some(f => f.text === '12k/1M'),
     'no context meter when the runtime did not report one');
  const both = createTranscript();
  both.turn = { active: false, usage: { totalTokens: 15846 }, retries: 0, errors: 0, toolCalls: 0 };
  both.projection = { contextUsed: 12_000, contextWindow: 1_000_000 };
  const line = renderStatus(both, plain, 80, { mode: 'build' })[0];
  ok(line.includes('12k/1M') && line.includes('16k tokens'),
     'session meter and turn tokens can both show');
  ok(renderStatus(metered, plain, 24, { mode: 'build' }).length === 1
     && stringWidth(renderStatus(metered, plain, 24, { mode: 'build' })[0]) <= 24,
     'the context meter still fits a narrow terminal');
  metered.projection = { contextUsed: 0, contextWindow: 1_000_000 };
  ok(statusFields(metered, plain, { mode: 'build' }).some(f => f.text === '0/1M'),
     'a zero used still shows against the window');
  metered.projection = { contextUsed: 12_000 };
  ok(!statusFields(metered, plain, { mode: 'build' }).some(f => f.text.includes('12k/')),
     'used without a window is not a meter');
}

// The pair rides usage.delta payloads, snapshot.projection events and
// snapshot-bearing command replies at different nesting depths; the reader must
// find each and refuse junk instead of painting 0.
ok(readContextMeter({ type: 'usage.delta', payload: { contextUsed: 12000, contextWindow: 1000000 } })
   ?.contextUsed === 12000, 'usage.delta payload carries the meter directly');
ok(readContextMeter({ payload: { snapshot: { projection: { contextUsed: 1, contextWindow: 2 } } } })
   ?.contextWindow === 2, 'snapshot.projection nested shape is read');
ok(readContextMeter({ payload: { projection: { contextUsed: 3, contextWindow: 4 } } })
   ?.contextUsed === 3, 'a bare projection on the payload is read');
ok(readContextMeter({ snapshot: { projection: { contextUsed: 5, contextWindow: 6 } } })
   ?.contextUsed === 5, 'a snapshot-bearing command reply is read at top level');
ok(readContextMeter({ kind: 'v4/telemetry/event', params: { kind: 'usage.delta', contextUsed: 7, contextWindow: 8 } })
   ?.contextWindow === 8, 'telemetry params carry the meter too');
ok(readContextMeter({ payload: { contextWindow: 1_000_000 } })?.contextWindow === 1_000_000,
   'a window alone latches so a later used completes the meter');
ok(readContextMeter({ payload: { contextUsed: 'x' } }) === null,
   'a non-finite used is junk, not zero');
ok(readContextMeter({ payload: { contextUsed: 1, contextWindow: 0 } })?.contextWindow === undefined,
   'a zero window is not a usable meter half');
ok(readContextMeter(null) === null && readContextMeter({}) === null && readContextMeter('x') === null,
   'missing or scalar sources are junk-safe');

const prompt = renderPermission(req, 1, plain, 60);
ok(prompt[0].includes('Bash') && prompt[0].includes('needs permission'), 'permission names the tool');
ok(prompt.some(l => l.includes('rm -rf build')), 'permission shows the significant argument');
// The selection marker is the same '>' the completion popup uses — one marker
// for "this is the current choice" across every list surface.
ok(prompt.some(l => l.trimStart().startsWith('>') && l.includes('Allow for this session')), 'the selected option is marked');
ok(renderPermission(req, 99, plain, 60).some(l => l.trimStart().startsWith('>') && l.includes('Deny')),
   'an out-of-range selection is clamped to the last option');
ok(renderPermission(req, -5, plain, 60).some(l => l.trimStart().startsWith('>') && l.includes('Allow once')),
   'a negative selection is clamped to the first option');
ok(!renderPermission(req, 0, plain, 60).join('').includes('\x1b'), 'permission prompt honors no-color');
ok(prompt.some(l => /tab/.test(l)), 'the permission card advertises tab cycling');

// --- locale: zh-CN must reach every fallback surface ---------------------------
// theme.str is the seam index.mjs attaches; it was never set, so a zh-CN host
// still saw English on the permission prompt, chooser hint and completion status
// (the orphaned zh-CN strings finding).
{
  const zh = createTheme({ enabled: false });
  zh.str = stringsFor('zh-CN');
  const zhPrompt = renderPermission({ toolName: 'Bash', input: 'rm -rf x',
    options: [{ name: 'Allow', response: {} }] }, 0, zh, 60);
  ok(zhPrompt[0].includes('需要授权'), 'zh-CN permission title is localized');
  ok(zhPrompt.some(l => l.includes('拒绝')), 'zh-CN permission hint is localized');
  ok(renderChooser({ title: 't', items: [{ label: 'a' }], index: 0 }, zh, 60)
     .some(l => l.includes('上下键')), 'zh-CN chooser default hint is localized');
  const many = Array.from({ length: 15 }, (_, i) => ({ value: `c${i}` }));
  ok(renderCompletions({ type: 'slash', items: many, index: 0 }, zh, 60)
     .some(l => l.includes('输入筛选')), 'zh-CN completion status line is localized');
  ok(renderCompletions({ type: 'slash', items: many, index: 0 }, plain, 60)
     .some(l => l.includes('type to filter')), 'no theme.str still falls back to English');
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
