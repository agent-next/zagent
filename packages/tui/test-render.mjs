// Renderer tests. Color is disabled so assertions read the literal glyph grammar
// a user sees; the theme's ANSI wrapping is covered in test-theme.mjs.
import { wrapText, toolSummary, renderEntry, formatDuration, formatTokens } from './render.mjs';
import { stringWidth } from './width.mjs';
import { composeFrame } from './screen.mjs';
import { createTheme } from './theme.mjs';
import { createTranscript, applyEvent, addUserEntry,
  COLLAPSED, EXPANDED, createFold, foldStateFor, collapse, expand,
  toggleAllThinking, userIndices, foldablesInTurn, stepUserTurn,
} from './events.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const plain = createTheme({ enabled: false });

// --- wrapText ----------------------------------------------------------------
ok(wrapText('a b c', 80).join('|') === 'a b c', 'short text unwrapped');
ok(wrapText('aaa bbb ccc', 7).join('|') === 'aaa bbb|ccc', 'greedy wrap at width');
ok(wrapText('one\n\ntwo', 80).join('|') === 'one||two', 'blank lines preserved');
const long = wrapText('x'.repeat(25), 10);
ok(long.every(l => l.length <= 10) && long.join('') === 'x'.repeat(25),
   'unbreakable token is split, never lost');
// The same split must fire mid-line: a long token after other text used to
// overflow the row, and renderInputBox clipped the tail of the user's input.
const mid = wrapText('hello ' + 'A'.repeat(30), 20);
ok(mid.every(l => stringWidth(l) <= 20) && mid.join('') === 'hello' + 'A'.repeat(30) && mid[0] === 'hello',
   'a long token after other text is hard-split, not clipped');
ok(wrapText('', 80).join('|') === '', 'empty text yields one empty line');
ok(wrapText(null, 80).length === 1, 'null text does not throw');
ok(wrapText('a b', 0).length >= 1, 'zero width falls back to a sane minimum');

// --- toolSummary -------------------------------------------------------------
ok(toolSummary({ input: { command: 'ls -la', description: 'List files' } }) === 'ls -la',
   'command wins over description (the runtime sends both for Bash)');
ok(toolSummary({ input: { file_path: '/tmp/a.txt' } }) === '/tmp/a.txt', 'file_path used for file tools');
ok(toolSummary({ input: { weird: 'v' } }) === 'v', 'unknown shape falls back to first string');
ok(toolSummary({ input: {} }) === '' && toolSummary({}) === '' && toolSummary(null) === '',
   'missing input never throws');

// --- formatters --------------------------------------------------------------
ok(formatDuration(36) === '36ms' && formatDuration(1500) === '1.5s' && formatDuration(90_000) === '1m30s',
   'duration scales ms -> s -> m');
ok(formatDuration(-1) === '' && formatDuration('x') === '', 'bad duration yields empty, not NaN');
ok(formatTokens(36) === '36' && formatTokens(15846) === '16k' && formatTokens(1_000_000) === '1M',
   'tokens scale');
ok(formatTokens(null) === '0', 'null tokens render as 0, never NaN');

// --- entry rendering ---------------------------------------------------------
const user = renderEntry({ kind: 'user', text: 'reply with exactly: PONG' }, plain, 60);
ok(user[0].startsWith('> '), 'user entry carries the > prompt marker');

const assistant = renderEntry({ kind: 'assistant', text: 'PONG', done: true }, plain, 60);
ok(assistant[0] === '⏺ PONG', 'assistant text is marked with the turn glyph');

// Answers are markdown: printing it raw is the most visible gap against other CLI harnesses.
const rich = renderEntry({ kind: 'assistant', done: true,
  text: '## Files\n\n- `alpha.txt` (empty)\n- **beta.md**\n\n```sh\nls -la\n```' }, plain, 60);
ok(rich[0] === '⏺ Files', 'headings are rendered, not printed with hashes');
ok(rich.some(l => l.includes('• alpha.txt')), 'bullets and code spans are rendered');
ok(rich.some(l => l.includes('beta.md')) && !rich.some(l => l.includes('**')),
   'emphasis markers are consumed, not shown');
ok(rich.some(l => l.includes('ls -la')) && !rich.some(l => l.includes('```')),
   'fenced code is rendered without its fence markers');

// Mid-stream partial markdown must stay literal so committed lines never reshape.
const partial = renderEntry({ kind: 'assistant', text: 'this is **bo', done: false }, plain, 60);
ok(partial[0].includes('**bo'), 'an unclosed emphasis delimiter stays literal while streaming');
ok(renderEntry({ kind: 'assistant', text: '', done: true }, plain, 60).length === 0,
   'an empty assistant entry renders nothing (streams open before the first delta)');

const wrapped = renderEntry({ kind: 'assistant', text: 'aaa bbb ccc ddd', done: true }, plain, 12);
ok(wrapped.length > 1 && wrapped[1].startsWith('  '), 'assistant continuation lines are indented under the glyph');

// tool: header + capped result
const toolEntry = { kind: 'tool', id: 'c', name: 'Bash', input: { command: 'ls -la' },
  status: 'ok', resultText: Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n'),
  durationMs: 36, truncated: false };
const tool = renderEntry(toolEntry, plain, 60, { maxResultLines: 6 });
ok(tool[0].startsWith('⏺ Bash(ls -la)'), 'tool header is one line: Name(significant arg)');
ok(tool[0].includes('36ms'), 'tool header carries duration');
ok(tool[1].includes('⎿') && tool[1].includes('line0'), 'first result line uses the result glyph');
ok(tool.filter(l => /line\d/.test(l)).length === 6, 'result body capped at maxResultLines');
// Head+tail (the long-output split other harnesses use): the end of
// a long output is where the error or final result lands — a head-only cap
// hides exactly that. The budget stays maxResultLines, split first-N + last-N
// around one omission marker.
const omittedAt = tool.findIndex(l => l.includes('+14 lines'));
ok(omittedAt > 0, 'the omitted middle is counted, not silently dropped');
ok(tool[omittedAt - 1].includes('line2') && tool[omittedAt + 1].includes('line17'),
   'overflow keeps first-N and last-N around the omission marker');
ok(tool.at(-1).includes('line19'), 'the tail survives to the last row');
ok(!tool.some(l => /line10\b/.test(l)), 'middle lines are omitted');

const atCap = renderEntry({ ...toolEntry,
  resultText: Array.from({ length: 6 }, (_, i) => `row${i}`).join('\n') }, plain, 60, { maxResultLines: 6 });
ok(atCap.filter(l => /row\d/.test(l)).length === 6 && !atCap.some(l => l.includes('+')),
   'a body exactly at the cap shows every line, no marker');
const headOnly = renderEntry(toolEntry, plain, 60, { maxResultLines: 1 });
ok(headOnly.filter(l => /line\d/.test(l)).length === 1 && headOnly.at(-1).includes('+19 lines')
   && !headOnly.some(l => l.includes('line19')),
   'a one-line budget degrades to head-only, never a negative tail');

const running = renderEntry({ ...toolEntry, status: 'running', resultText: '', durationMs: null }, plain, 60);
ok(running.length === 1, 'a running tool renders only its header');

const longHead = renderEntry({ kind: 'tool', name: 'Bash', input: { command: 'x'.repeat(200) },
  status: 'ok', resultText: '' }, plain, 60);
ok(longHead[0].length <= 60 && longHead[0].includes('…'), 'over-long tool header is truncated, never wrapped');

const truncated = renderEntry({ ...toolEntry, resultText: 'only line', truncated: true }, plain, 60);
ok(truncated.at(-1).includes('truncated by the runtime'), 'runtime-side truncation is disclosed');

// --- slash-command output ----------------------------------------------------
// Regression: command envelopes are {mode, response, ...}. 'response' was absent
// from the surfaced-key list, so every slash command ran and printed nothing.
const cmd = renderEntry({ kind: 'command', done: true,
  text: 'Current mode: build. Available modes: plan, build, edit, yolo.' }, plain, 70);
ok(cmd.length >= 1 && cmd[0].includes('Current mode: build'), 'command output is rendered');
ok(cmd[0].startsWith('⎿'), 'command output is marked as the runtime, not the model');
ok(renderEntry({ kind: 'command', text: '', done: true }, plain, 60).length === 0,
   'an empty command response renders nothing');
const cmdMd = renderEntry({ kind: 'command', done: true, text: '- /help\n- /goal' }, plain, 60);
ok(cmdMd.some(l => l.includes('• /help')), 'command output is markdown-rendered too');

// --- thinking ----------------------------------------------------------------
const think = renderEntry({ kind: 'thinking', id: 'm', done: true,
  text: 'line one\nline two\nline three\nline four\nline five' }, plain, 60, { maxThinkingLines: 3 });
ok(think[0].includes('thinking'), 'reasoning is labelled, never mistaken for the answer');
ok(think.filter(l => /line \w+/.test(l)).length === 3, 'reasoning is capped');
ok(think.at(-1).includes('+2 lines of reasoning'), 'hidden reasoning lines are counted');
ok(renderEntry({ kind: 'thinking', text: '   ', done: true }, plain, 60).length === 0,
   'empty reasoning renders nothing');
// Append-only: the screen writer commits lines permanently, so a streaming view
// that scrolled (tail-following) left stray gaps and repeated fragments on screen.
const liveThink = renderEntry({ kind: 'thinking', done: false, text: 'a\nb\nc\nd\ne' }, plain, 60, { maxThinkingLines: 2 });
ok(liveThink.some(l => /\ba\b/.test(l)) && !liveThink.slice(0, -1).some(l => /\be\b/.test(l)),
   'streaming reasoning shows the FIRST lines, so committed lines never move');
ok(/\be\b/.test(liveThink.at(-1)) && /\+3 lines of reasoning/.test(liveThink.at(-1)),
   'the live tail carries a preview of the newest reasoning');
const doneThink = renderEntry({ kind: 'thinking', done: true, text: 'a\nb\nc\nd\ne' }, plain, 60, { maxThinkingLines: 2 });
ok(!/\be\b/.test(doneThink.at(-1)), 'the preview disappears once the stream settles');
ok(doneThink.slice(0, 3).join('|') === liveThink.slice(0, 3).join('|'),
   'settling reasoning does not rewrite lines already on screen');

const collapsedThink = renderEntry({ kind: 'thinking', done: true, text: 'line one\nline two\nline three\nline four' },
  plain, 60, { fold: 'collapsed' });
ok(collapsedThink[0].includes('thinking') && !collapsedThink.some(l => /line two/.test(l)),
   'collapsed thinking is a header, not the body');
ok(collapsedThink.at(-1).includes('+4 lines of reasoning'), 'collapsed thinking counts every hidden line');
const expandedThink = renderEntry({ kind: 'thinking', done: true, text: 'line one\nline two\nline three\nline four' },
  plain, 60, { fold: 'expanded' });
ok(expandedThink.filter(l => /line \w+/.test(l)).length === 4, 'expanded thinking shows the full body');

// The elapsed figure rides the block's LAST line — the only one still live —
// because the header commits to scrollback before the duration exists.
const timedThink = renderEntry({ kind: 'thinking', done: true, durationMs: 2500,
  text: 'a\nb\nc\nd\ne' }, plain, 60, { maxThinkingLines: 2 });
ok(timedThink.at(-1).includes('+3 lines of reasoning') && timedThink.at(-1).includes('2.5s'),
   'settled reasoning shows the phase duration on its trailing line');
ok(!timedThink[0].includes('2.5s'), 'the committed header line is never rewritten');
ok(!renderEntry({ kind: 'thinking', done: false, durationMs: 2500, text: 'a\nb\nc\nd\ne' }, plain, 60, { maxThinkingLines: 2 })
    .some(l => /2\.5s/.test(l)), 'streaming reasoning shows no duration yet');
const timedExpanded = renderEntry({ kind: 'thinking', done: true, durationMs: 2500, text: 'a\nb' },
  plain, 60, { fold: 'expanded' });
ok(timedExpanded.at(-1).includes('2.5s'), 'fully-shown reasoning still ends on its duration');

const collapsedTool = renderEntry({ ...toolEntry, resultText: 'a\nb\nc' }, plain, 60, { fold: 'collapsed' });
ok(collapsedTool.length === 2 && collapsedTool[0].includes('Bash') && collapsedTool[1].includes('+3 lines'),
   'collapsed tool keeps the header and hides the result body');

// --- diff surface: a file-changing call paints its recorded patch -------------
// The runtime writes a per-call workspace_file_before_change artifact; the TUI
// attaches it as entry.diff (bounded {files:[{path, lines}], dropped}) and the
// row renders colored +/- lines in place of the "updated" prose.
{
  const diffEntry = { kind: 'tool', id: 'c9', name: 'Edit', input: { file_path: 'a.js' },
    status: 'ok', resultText: 'The file a.js has been updated successfully.',
    durationMs: 12, truncated: false,
    diff: { dropped: 0, files: [{ path: 'a.js', lines: [
      '@@ -1,3 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
    ] }] } };
  const d = renderEntry(diffEntry, plain, 60, { maxResultLines: 6 });
  ok(d[0].includes('Edit(a.js)'), 'diff tool header is unchanged');
  ok(d[1].includes('⎿') && d.some(l => l.includes('@@ -1,3 +1,3 @@')), 'the hunk header renders under the result glyph');
  ok(d.some(l => l.includes('-const b = 2;')) && d.some(l => l.includes('+const b = 3;')),
     'the +/- rows render verbatim');
  ok(!d.some(l => /updated successfully/.test(l)), 'the patch replaces the prose, not appends to it');

  // Marker column by diff semantics + the file's own syntax inside the row.
  const colored = createTheme({ enabled: true });
  const cd = renderEntry(diffEntry, colored, 60, { maxResultLines: 6 });
  ok(cd.some(l => l.includes('\x1b[38;5;71m+')), 'the + marker is painted success');
  ok(cd.some(l => l.includes('\x1b[38;5;167m-')), 'the - marker is painted error');
  ok(cd.some(l => l.includes('\x1b[38;5;176mconst')), 'the row body keeps the filetype syntax colors');
  ok(cd.some(l => l.includes('\x1b[38;5;110m@@')), 'the hunk header is accented');

  // Head+tail applies to diff rows exactly like tool output.
  const longDiff = { ...diffEntry, diff: { dropped: 0, files: [{ path: 'a.js', lines: [
    '@@ -1,20 +1,20 @@', ...Array.from({ length: 20 }, (_, i) => `+row${i}`)] }] } };
  const ld = renderEntry(longDiff, plain, 60, { maxResultLines: 6 });
  ok(ld.some(l => l.includes('+15 lines')) && ld.some(l => l.includes('+row19')),
     'a long patch keeps head+tail around the omission marker');

  // Fold and error states behave like any tool body.
  const cdiff = renderEntry(diffEntry, plain, 60, { fold: 'collapsed' });
  ok(cdiff.length === 2 && cdiff[1].includes('+4 lines'), 'collapsed diff counts its rows');
  const errDiff = renderEntry({ ...diffEntry, status: 'error', resultText: 'edit refused' }, plain, 60);
  ok(errDiff.some(l => l.includes('edit refused')) && !errDiff.some(l => l.includes('@@')),
     'a failed call shows its error, not the patch');
  const noLines = renderEntry({ ...diffEntry, diff: { dropped: 0, files: [{ path: 'a.js', lines: [] }] } }, plain, 60);
  ok(noLines.some(l => /updated successfully/.test(l)), 'an empty patch falls back to the result prose');
  const multi = renderEntry({ ...diffEntry, diff: { dropped: 0, files: [
    { path: 'a.js', lines: ['@@ -1,1 +1,1 @@', '-x', '+y'] },
    { path: 'b.js', lines: ['@@ -1,1 +1,1 @@', '-p', '+q'] }] } }, plain, 60);
  ok(multi.some(l => l.includes('a.js') && l !== multi[0]) && multi.some(l => l.includes('b.js')),
     'a multi-file patch labels each file');

  // When the head+tail split would open the tail mid-file, the tail backs up
  // to that file's label row instead of showing unattributed hunks.
  const tailLabel = renderEntry({ ...diffEntry, diff: { dropped: 0, files: [
    { path: 'a.js', lines: ['@@ -1,1 +1,1 @@', '-x', '+y'] },
    { path: 'b.js', lines: ['@@ -1,4 +1,4 @@', '-p', '+q', '-r', '+s'] }] } },
    plain, 60, { maxResultLines: 6 });
  const bLabel = tailLabel.findIndex(l => l === '     b.js' || l.trim() === 'b.js');
  ok(bLabel > 0 && tailLabel.slice(bLabel).some(l => l.includes('+s')),
     `the shown tail re-labels its file when the split ate the label (got ${JSON.stringify(tailLabel)})`);
}

{
  const fold = createFold();
  const thinkE = { kind: 'thinking', id: 'm' };
  const toolE = { kind: 'tool', id: 'c' };
  ok(fold.thinkingAll === COLLAPSED && foldStateFor(fold, thinkE, 1) === COLLAPSED, 'thinking starts collapsed');
  ok(foldStateFor(fold, toolE, 2) === EXPANDED, 'tools start expanded');
  collapse(fold, toolE, 2);
  expand(fold, thinkE, 1);
  ok(foldStateFor(fold, thinkE, 1) === EXPANDED && foldStateFor(fold, toolE, 2) === COLLAPSED, 'h/l set per-entry fold');
  ok(toggleAllThinking(fold) === EXPANDED, 'ctrl+e expands all thinking');
  ok(foldStateFor(fold, thinkE, 1) === EXPANDED, 'ctrl+e clears a thinking override');
  const entries = [
    { kind: 'user', text: 'one' }, { kind: 'thinking', id: 'a' }, { kind: 'tool', id: 't' },
    { kind: 'user', text: 'two' }, { kind: 'thinking', id: 'b' },
  ];
  ok(userIndices(entries).join() === '0,3', 'userIndices lists user-prompt turns');
  ok(foldablesInTurn(entries, 0).map(([, i]) => i).join() === '1,2', 'h/l target the selected turn');
  ok(stepUserTurn(entries, -1, -1) === 1 && stepUserTurn(entries, 1, -1) === 0,
     'shift+up walks from the latest user turn toward older ones');
}

// --- untrusted text may never reach the terminal as control bytes ------------
// Everything rendered is untrusted: model output, tool results (the agent reads
// attacker-controllable files), tool arguments, and pasted input. Raw ESC would
// let a poisoned file clear the screen, forge a permission prompt, or corrupt the
// screen writer's line arithmetic and delete committed scrollback.
{
  const ch = (c) => String.fromCharCode(c);
  const evil = `benign${ch(0x1b)}[2J${ch(0x1b)}[H CLEARED ${ch(0x1b)}]0;pwned${ch(0x07)} end`;
  const t = createTranscript();
  addUserEntry(t, evil);
  applyEvent(t, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: evil, kind: 'text_delta' } });
  applyEvent(t, { type: 'tool_call_scheduled', payload: { toolCallId: 'c', toolName: 'Read', input: { file_path: evil } } });
  applyEvent(t, { type: 'tool_call_result', payload: { toolCallId: 'c', result: { success: true, content: evil } } });
  applyEvent(t, { type: 'session_title_updated', payload: { title: evil } });
  // Asserted through composeFrame — the path the product actually renders. The
  // previous target, renderTranscript, had no production call site, so this
  // regression could not have caught an escape reaching a real terminal.
  applyEvent(t, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: '', done: true, kind: 'finish' } });
  const frame = composeFrame(t, plain, 70);
  const rendered = [...frame.commit, ...frame.live].join('\n');
  ok(!rendered.includes(ch(0x1b)), 'no ESC byte survives into the rendered transcript');
  ok(!rendered.includes(ch(0x07)), 'no BEL byte survives into the rendered transcript');
  ok(rendered.includes('benign'), 'the surrounding text is still shown');
  ok(!t.title.includes(ch(0x1b)), 'the session title is sanitised too');

  // A CR must not survive either: it would return the cursor to column 0 and
  // overwrite a line the screen writer has already counted.
  const cr = createTranscript();
  applyEvent(cr, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: 'a\rOVERWRITE', kind: 'text_delta' } });
  ok(!cr.entries[0].text.includes('\r'), 'a bare CR is normalised out of streamed text');
}

// --- per-entry timestamps (config-gated) --------------------------------------
// With the option on, an entry carrying `at` gets a faint HH:MM right-aligned on
// its first line; every other case is byte-identical to today.
{
  const on = renderEntry({ kind: 'user', text: 'stamp me', at: '2026-09-16T14:32:00' }, plain, 40, { timestamps: true });
  ok(on[0].startsWith('> stamp me') && /14:32$/.test(on[0]) && stringWidth(on[0]) === 40,
     `the stamp right-aligns HH:MM on the first line (got ${JSON.stringify(on[0])})`);
  const off = renderEntry({ kind: 'user', text: 'stamp me', at: '2026-09-16T14:32:00' }, plain, 40);
  ok(off[0] === '> stamp me', 'no stamp without the option');
  ok(renderEntry({ kind: 'user', text: 'stamp me' }, plain, 40, { timestamps: true })[0] === '> stamp me',
     'no stamp without entry.at');
  ok(renderEntry({ kind: 'user', text: 'stamp me', at: 'not-a-date' }, plain, 40, { timestamps: true })[0] === '> stamp me',
     'an unparseable at yields no stamp');
  // Every candidate line filling the row keeps its content whole — the stamp
  // yields rather than clipping transcript text (exactly-full edge case).
  const full = renderEntry({ kind: 'user', text: 'x'.repeat(76), at: '2026-09-16T14:32:00' }, plain, 40, { timestamps: true });
  ok(full.length > 1 && full.every(l => !/14:32/.test(l)) && full.every(l => stringWidth(l) <= 40),
     'an entry with no free cell on either edge yields the stamp, never clips');
  // A wrapped block's greedy-full first line cannot host the stamp, so it lands
  // on the last line instead — exactly one stamp per entry.
  const wrapped = renderEntry({ kind: 'user', text: 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk', at: '2026-09-16T14:32:00' }, plain, 40, { timestamps: true });
  ok(wrapped.length > 1 && /14:32$/.test(wrapped.at(-1)) && !/14:32/.test(wrapped[0]),
     `a wrapped block stamps its last line (got ${JSON.stringify(wrapped)})`);
  // When BOTH edge lines have room the stamp lands on the first — exactly once.
  const room = renderEntry({ kind: 'assistant', text: 'one\ntwo', at: '2026-09-16T14:32:00' }, plain, 40, { timestamps: true });
  ok(room.length > 1 && /14:32$/.test(room[0]) && room.filter(l => /14:32/.test(l)).length === 1,
     `both edges free stamps the first line exactly once (got ${JSON.stringify(room)})`);
}

// --- whole transcript --------------------------------------------------------
const s = createTranscript();
addUserEntry(s, 'hi');
applyEvent(s, { type: 'turn_started', turnId: 't', payload: {} });
applyEvent(s, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: 'hello' } });
applyEvent(s, { type: 'model_streaming', payload: { assistantMessageId: 'm', delta: '', done: true, kind: 'finish' } });
const frame = composeFrame(s, plain, 60);
const out = [...frame.commit, ...frame.live];
ok(out.some(l => l.startsWith('> hi')) && out.some(l => l.includes('hello')), 'transcript renders user then assistant');
ok(out.includes(''), 'entries are separated by a blank line');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
