// zagent client commands + the merged palette. Everything here is in-process:
// a scripted ctx stands in for the TUI, temp dirs stand in for HOME, and no
// network is touched (deps.exec / deps.codingPlanStatus are stubs).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { mergeCommands, CLIENT_COMMANDS, matchClientCommand, renderHelp,
  zagentVersion, runtimeLabel, estimateCost, priceFor, formatQuota, isNewerVersion,
  exportMarkdown, lastTurnToolCallIds, doctorLines } from './commands.mjs';
import { createTranscript } from './events.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const tmp = mkdtempSync(path.join(os.tmpdir(), 'zcmd-'));
// findRuntime() probes the real fs: pin ZCODE_RUNTIME to nothing installed so
// the version assertions below do not depend on what this machine has.
const savedRuntimeEnv = process.env.ZCODE_RUNTIME;
process.env.ZCODE_RUNTIME = path.join(tmp, 'no-runtime');

// --- the merged palette ------------------------------------------------------
const KERNEL = [
  { name: 'help', summary: 'Show this slash command help.', usage: '/help [command]' },
  { name: 'new', summary: 'Start a new session', usage: '/new' },
  { name: 'model', summary: 'Switch model', usage: '/model' },
  { name: 'mode', summary: 'Switch mode', usage: '/mode' },
  { name: 'mcp', summary: 'Manage MCP', usage: '/mcp' },
  { name: 'goal', summary: 'Session goal', usage: '/goal' },
  null, { name: '' }, { summary: 'no name' },
];
const merged = mergeCommands(KERNEL);
ok(merged.some(c => c.name === 'exit' && c.source === 'zagent'), 'client /exit joins the palette');
ok(merged.some(c => c.name === 'model' && c.source === 'kernel'), 'kernel /model stays');
ok(merged.filter(c => c.name === 'help').length === 1, 'the client /help shadows the kernel one');
ok(merged.find(c => c.name === 'help').source === 'zagent', 'shadowed /help is the zagent one');
ok(!merged.some(c => c.name === undefined || c.name === ''), 'malformed kernel entries are skipped');
ok(mergeCommands(null).length === CLIENT_COMMANDS.length, 'a missing kernel list still yields the client commands');
const groupIdx = merged.map(c => ['Session', 'Model', 'Project', 'Tools', 'zagent'].indexOf(c.group));
ok(groupIdx.every((g, i) => g !== -1 && (i === 0 || groupIdx[i - 1] <= g)), 'the list is ordered Session..zagent');
ok(merged.find(c => c.name === 'new').group === 'Session' && merged.find(c => c.name === 'model').group === 'Model'
   && merged.find(c => c.name === 'init' || c.name === 'goal').group === 'Project' && merged.find(c => c.name === 'mcp').group === 'Tools',
   'kernel commands land in their groups');

// /help renders the merged list, grouped, one line each
const help = renderHelp(merged);
ok(/Session/.test(help) && /Model/.test(help) && /zagent/.test(help), '/help shows the group headers');
ok(/\/exit/.test(help) && /\/model/.test(help), '/help lists client and kernel commands');
ok(/\(runtime\)/.test(help), '/help marks kernel commands as runtime-owned');

// --- exact-match dispatch ------------------------------------------------------
ok(matchClientCommand('/exit')?.command.name === 'exit', '/exit resolves');
ok(matchClientCommand('/q')?.command.name === 'exit', '/q resolves through the alias');
ok(matchClientCommand('/quit')?.command.name === 'quit', '/quit resolves');
ok(matchClientCommand('/theme dark')?.args === 'dark', 'arguments are passed through');
ok(matchClientCommand('/mode') === null, 'a kernel-only name is left for the runtime');
ok(matchClientCommand('hello') === null && matchClientCommand('/nope') === null, 'non-commands and unknown commands are safe');
ok(matchClientCommand(null) === null, 'junk input is safe');

// --- a scripted TUI context ----------------------------------------------------
const mkCtx = (over = {}) => {
  const state = createTranscript();
  const out = [];
  const ctx = {
    host: { version: '0.16.5', workspaceDirectory: tmp, workspaceGitBranch: 'main' },
    state,
    ui: { mode: 'build', model: 'zai/glm-5.3', effort: 'max', busy: false, mcp: null },
    version: '0.0.202', commands: merged,
    workspace: tmp, cwd: tmp, home: tmp, env: {},
    // /status and /quota consult deps.codingPlanStatus; a null seam would fall
    // through to the real monitor endpoint (a dev host HAS the key file).
    deps: { codingPlanStatus: async () => { throw new Error('test: no quota fixture'); } },
    print: (t) => out.push(String(t)),
    notice: (t, l) => out.push(`[${l ?? 'muted'}] ${t}`),
    draw() {},
    quit: () => out.push('QUIT'),
    interrupt: () => out.push('INTERRUPT'),
    send: (t) => out.push(`SEND:${t}`),
    sendRuntime: (t) => out.push(`RUNTIME:${t}`),
    openPicker: async (k) => (out.push(`PICKER:${k}`), true),
    choose: (c) => (out.push(`CHOOSE:${c.title}`), true),
    confirm: async () => true,
    setTheme: (s) => out.push(`THEME:${s}`),
    setMode: async (m) => (out.push(`MODE:${m}`), true),
    clearView: () => out.push('CLEAR'),
    out,
    ...over,
  };
  return ctx;
};
const run = (name, ctx, args = '') => {
  const cmd = CLIENT_COMMANDS.find(c => c.name === name || (c.aliases ?? []).includes(name));
  return cmd.run(ctx, args);
};

// --- /exit, /quit, /stop ---------------------------------------------------------
{
  const ctx = mkCtx(); await run('exit', ctx);
  ok(ctx.out.includes('QUIT'), '/exit quits the TUI');
  const q = mkCtx(); await run('quit', q);
  ok(q.out.includes('QUIT'), '/quit quits the TUI');
  const s = mkCtx(); await run('stop', s);
  ok(s.out.some(l => l.includes('nothing is running')), '/stop with no turn says so');
  const b = mkCtx(); b.ui.busy = true; await run('stop', b);
  ok(b.out.includes('INTERRUPT'), '/stop interrupts the running turn');
}

// --- /clear ----------------------------------------------------------------------
{
  const ctx = mkCtx();
  ctx.state.entries.push({ kind: 'user', text: 'old' });
  await run('clear', ctx);
  ok(ctx.out.includes('CLEAR') && ctx.out.includes('SEND:/new'), '/clear clears the view and asks the kernel for /new');
}

// --- /status ----------------------------------------------------------------------
{
  const ctx = mkCtx();
  ctx.state.sessionId = 'sess_abc123';
  ctx.state.totals = { inputTokens: 15810, outputTokens: 36, cacheReadTokens: 400, cacheWriteTokens: 0, cacheCreationTokens: 0 };
  ctx.ui.mcp = { connected: 1, failed: 0, total: 2 };
  await run('status', ctx);
  const text = ctx.out.join('\n');
  ok(/zagent 0\.0\.202/.test(text), '/status shows the zagent package version');
  ok(/kernel build 0\.16\.5/.test(text), '/status shows the kernel build, labelled');
  ok(/zai\/glm-5\.3/.test(text) && /effort max/.test(text) && /mode build/.test(text), '/status shows model, effort, mode');
  ok(/sess_abc123/.test(text), '/status shows the session id');
  // The workspace sits under the ctx home here, so /status renders
  // it home-relative like the doctor surfaces — never the absolute path.
  ok(/cwd: ~ · branch main/.test(text) && !text.includes(tmp), '/status shows cwd home-relative + branch');
  ok(/mcp: 1\/2/.test(text), '/status shows MCP counts');
  ok(/16k in/.test(text) && /36 out/.test(text), '/status shows tokens so far');
  ok(/elapsed:/.test(text), '/status shows elapsed time');
}

// --- /version ---------------------------------------------------------------------
{
  const ctx = mkCtx();
  await run('version', ctx);
  ok(/zagent 0\.0\.202/.test(ctx.out[0]), '/version names the package version');
  ok(!/zagent 0\.16\.5/.test(ctx.out[0]), '/version never reports the kernel version as zagent');
  ok(/runtime kernel 0\.16\.5/.test(ctx.out[0]), '/version labels the kernel build when nothing is installed');
  ok(zagentVersion() !== 'unknown' && /^\d+\.\d+\.\d+/.test(zagentVersion()), 'zagentVersion reads package.json');

  // runtimeLabel: the driver's product version wins; an install the driver
  // cannot version keeps the kernel string labelled; nothing found keeps the
  // pre-change fallback. Fixture layouts as in packages/driver/test-runtime-xplat.mjs.
  ok(runtimeLabel({ version: '0.16.5' }) === 'kernel 0.16.5', 'no runtime found: the kernel string is labelled');
  const cliBin = path.join(tmp, 'opt', 'node_modules', 'zcode-app-cli', 'bin');
  mkdirSync(cliBin, { recursive: true });
  writeFileSync(path.join(cliBin, 'zcode.js'), '');
  writeFileSync(path.join(cliBin, '..', 'package.json'), '{"version":"3.10.2-19"}');
  process.env.ZCODE_RUNTIME = path.join(cliBin, 'zcode.js');
  ok(runtimeLabel({ version: '0.16.5' }) === 'explicit 3.10.2-19',
     'the driver product version renders as "<kind> <version>"');
  const vctx = mkCtx();
  await run('status', vctx);
  ok(/runtime: explicit 3\.10\.2-19 · kernel build 0\.16\.5/.test(vctx.out.join('\n')),
     '/status names the product version AND the labelled kernel build');
  const lone = path.join(tmp, 'lone-kernel.cjs');
  writeFileSync(lone, '');
  process.env.ZCODE_RUNTIME = lone;
  ok(runtimeLabel({ version: '0.16.5' }) === 'explicit (kernel 0.16.5)',
     'an unversioned install labels the kernel build');
  ok(runtimeLabel({}) === 'explicit', 'no kernel string either: the kind alone remains');
  process.env.ZCODE_RUNTIME = path.join(tmp, 'no-runtime');
}

// --- /usage, /cost ------------------------------------------------------------------
{
  const ctx = mkCtx();
  ctx.state.totals = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 100_000, cacheWriteTokens: 0, cacheCreationTokens: 0 };
  await run('usage', ctx);
  const text = ctx.out.join('\n');
  ok(/1M in/.test(text) && /500k out/.test(text) && /100k cached/.test(text), '/usage prints the token totals');
  ok(/list-price estimate/.test(text) && /subscription/.test(text), '/usage labels the estimate honestly');
  // 1M in at $1.40 + 500k out at $4.40 + 100k cached at $0.26 = $3.6260
  ok(/\$3\.6260/.test(text), '/usage computes the GLM-5.3 list price');
  const c = mkCtx(); await run('cost', c);
  ok(/list-price estimate/.test(c.out.join('\n')), '/cost resolves to the same report');
  ok(Math.abs(estimateCost('zai/glm-5.3', { inputTokens: 1e6, outputTokens: 0 })) - 1.40 < 1e-9,
     'estimateCost uses the GLM-5.3 table');
  ok(Math.abs(estimateCost('zai/glm-5.3-flash', { inputTokens: 1e6, outputTokens: 0 })) - 0.15 < 1e-9,
     'estimateCost uses the Flash table for flash models');
  ok(priceFor('other') === priceFor('glm-5.3'), 'unknown models price at the flagship table');
}

// --- /context ----------------------------------------------------------------------
{
  const ctx = mkCtx();
  ctx.state.projection = { contextUsed: 12_000, contextWindow: 1_000_000 };
  ctx.state.contextBreakdown = { system: 100, tools: 50 };
  await run('context', ctx);
  ok(/12k \/ 1M/.test(ctx.out.join('\n')), '/context shows the meter');
  ok(/system: 100/.test(ctx.out.join('\n')), '/context shows the baseline breakdown');
  const none = mkCtx(); await run('context', none);
  ok(/not reported/.test(none.out.join('\n')), '/context says "not reported" when nothing is known');
}

// --- /diff + /undo against real artifacts in a temp HOME ------------------------------
{
  const sid = 'sess_diff1';
  const dir = path.join(tmp, '.zcode', 'cli', 'artifacts', sid);
  mkdirSync(dir, { recursive: true });
  const target = path.join(tmp, 'calc.py');
  writeFileSync(target, 'def add(a, b):\n    return a + b\n');
  writeFileSync(path.join(dir, 'call_a-tool-result-1.json'), JSON.stringify({
    version: 1, kind: 'workspace_file_before_change', toolCallId: 'c1', toolName: 'Edit',
    createdAt: '2026-09-05T02:44:46.015Z',
    files: [{ path: target, existedBefore: true, beforeContent: 'def add(a, b):\n    return a - b\n',
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
        lines: [' def add(a, b):', '-    return a - b', '+    return a + b'] }] }] }));

  const noSid = mkCtx(); await run('diff', noSid);
  ok(/no session yet/.test(noSid.out.join('\n')), '/diff before the first turn explains itself');

  const ctx = mkCtx();
  ctx.state.sessionId = sid;
  await run('diff', ctx);
  ok(/calc\.py \(Edit\)/.test(ctx.out.join('\n')) && /\+1 -1/.test(ctx.out.join('\n')),
     '/diff renders the session changes');

  // /undo: no last-turn tool calls -> refuses politely
  const empty = mkCtx(); empty.state.sessionId = sid; await run('undo', empty);
  ok(/nothing to undo/.test(empty.out.join('\n')), '/undo with no tracked edits says so');

  // lastTurnToolCallIds picks up only tool entries since the turn started
  const undoCtx = mkCtx();
  undoCtx.state.sessionId = sid;
  undoCtx.state.entries.push({ kind: 'user', text: 'x' }, { kind: 'tool', id: 'c1', name: 'Edit' });
  undoCtx.state.turn = { entryStart: 1 };
  ok(lastTurnToolCallIds(undoCtx.state).has('c1'), 'lastTurnToolCallIds finds the turn tool calls');

  let asked = null;
  undoCtx.confirm = async (q) => { asked = q; return false; };
  await run('undo', undoCtx);
  ok(/revert 1 file/.test(asked), '/undo asks before reverting');
  ok(readFileSync(target, 'utf8').includes('a + b'), '/undo declined leaves the file alone');
  ok(/left unchanged/.test(undoCtx.out.join('\n')), 'declining /undo says so');

  const yes = mkCtx();
  yes.state.sessionId = sid;
  yes.state.entries.push({ kind: 'user', text: 'x' }, { kind: 'tool', id: 'c1', name: 'Edit' });
  yes.state.turn = { entryStart: 1 };
  await run('undo', yes);
  ok(readFileSync(target, 'utf8').includes('a - b'), '/undo confirmed reverts the file');
  ok(/reverted/.test(yes.out.join('\n')), '/undo reports the revert');
}

// --- /export ------------------------------------------------------------------------
{
  const ctx = mkCtx();
  ctx.state.sessionId = 'sess_abcdef123456';
  ctx.state.entries.push(
    { kind: 'user', text: 'hi' },
    { kind: 'assistant', text: 'hello back', done: true },
    { kind: 'command', text: 'cmd out', done: true },
  );
  await run('export', ctx);
  const file = path.join(tmp, 'zagent-sess_abc.md');
  ok(existsSync(file), '/export wrote the transcript file');
  const md = readFileSync(file, 'utf8');
  ok(md.includes('> hi') && md.includes('hello back'), '/export content covers the transcript');
  ok(ctx.out.join('\n').includes('zagent-sess_abc.md'), '/export prints the path');
  ok(exportMarkdown(ctx.state).startsWith('# zagent session sess_abcdef123456'), 'exportMarkdown titles the session');
}

// --- /copy -----------------------------------------------------------------------------
{
  const ctx = mkCtx();
  let copied = null;
  ctx.host.writeClipboardText = async (t) => { copied = t; };
  ctx.state.entries.push({ kind: 'assistant', text: 'the answer', done: true });
  await run('copy', ctx);
  ok(copied === 'the answer', '/copy hands the last answer to the host clipboard');
  const noClip = mkCtx();
  noClip.state.entries.push({ kind: 'assistant', text: 'x', done: true });
  await run('copy', noClip);
  ok(/not available/.test(noClip.out.join('\n')), '/copy without clipboard support says so');
  const empty = mkCtx(); await run('copy', empty);
  ok(/nothing to copy/.test(empty.out.join('\n')), '/copy with no answer says so');
}

// --- /rename /archive /delete — session records without leaving the TUI ---------
{
  // A seeded runtime task store under a throwaway HOME — the same schema
  // tasks-index.mjs was verified against (workspace_key, task_id PK).
  const taskHome = mkdtempSync(path.join(os.tmpdir(), 'zcmd-tasks-'));
  const tasksDbFile = path.join(taskHome, '.zcode', 'v2', 'tasks-index.sqlite');
  const seedTasks = (rows) => {
    mkdirSync(path.dirname(tasksDbFile), { recursive: true });
    const db = new DatabaseSync(tasksDbFile);
    db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      workspace_key TEXT, task_id TEXT, title TEXT, task_status TEXT,
      pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0,
      title_overridden INTEGER DEFAULT 0, updated_at INTEGER,
      PRIMARY KEY (workspace_key, task_id))`);
    for (const r of rows) {
      db.prepare('INSERT OR REPLACE INTO tasks (workspace_key, task_id, title, task_status, updated_at) VALUES (?,?,?,?,?)')
        .run(r.ws ?? taskHome, r.id, r.title ?? 'untitled', r.status ?? 'completed', Date.now());
    }
    db.close();
  };
  const readTask = (id) => {
    const db = new DatabaseSync(tasksDbFile, { readOnly: true });
    const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(id);
    db.close();
    return row;
  };
  const tctx = (over = {}) => { const c = mkCtx({ home: taskHome, ...over }); return c; };

  const noSession = tctx(); await run('rename', noSession, 'x');
  ok(/no session yet/.test(noSession.out.join('\n')), '/rename before the first turn explains itself');
  const noStore = tctx(); noStore.state.sessionId = 'sess_nostore';
  await run('rename', noStore, 'x');
  ok(/no task store yet/.test(noStore.out.join('\n')), '/rename without a store file never creates one');
  ok(!existsSync(tasksDbFile), 'the store file was not created by the probe');

  seedTasks([{ id: 'sess_self1', title: 'old title' }, { id: 'sess_other2' }]);

  const noArgs = tctx(); noArgs.state.sessionId = 'sess_self1'; await run('rename', noArgs, '');
  ok(/usage: \/rename/.test(noArgs.out.join('\n')), '/rename without a title prints usage');
  ok(readTask('sess_self1').title === 'old title', 'a bare /rename changed nothing');

  const ren = tctx(); ren.state.sessionId = 'sess_self1'; await run('rename', ren, 'my bug hunt');
  ok(/renamed sess_self1 → my bug hunt/.test(ren.out.join('\n')), '/rename reports the new title');
  const renamed = readTask('sess_self1');
  ok(renamed.title === 'my bug hunt' && renamed.title_overridden === 1, '/rename wrote title + title_overridden');

  const arch = tctx(); arch.state.sessionId = 'sess_self1'; await run('archive', arch);
  ok(/archived sess_self1/.test(arch.out.join('\n')) && readTask('sess_self1').archived === 1,
     '/archive defaults to the current session');
  await run('archive', tctx(), 'other2');
  ok(readTask('sess_other2').archived === 1, '/archive <id-suffix> resolves a unique suffix');

  const missing = tctx(); await run('archive', missing, 'sess_missing');
  ok(/no task 'sess_missing'/.test(missing.out.join('\n')), '/archive names an unknown id');
  const absent = tctx(); absent.state.sessionId = 'sess_notstored'; await run('archive', absent);
  ok(/no task record yet/.test(absent.out.join('\n')), '/archive on an unrecorded session says so');

  seedTasks([{ id: 'sess_del1' }, { id: 'sess_del2' }]);
  const delNo = tctx(); delNo.state.sessionId = 'sess_del1';
  delNo.confirm = async () => false;
  await run('delete', delNo);
  ok(/left unchanged/.test(delNo.out.join('\n')) && readTask('sess_del1').deleted === 0,
     'declining /delete keeps the record');
  const delYes = tctx(); delYes.state.sessionId = 'sess_del1';
  await run('delete', delYes);
  ok(/deleted sess_del1/.test(delYes.out.join('\n')) && readTask('sess_del1').deleted === 1,
     '/delete confirmed flags the record');
  const gone = tctx(); await run('archive', gone, 'sess_del1');
  ok(/no task 'sess_del1'/.test(gone.out.join('\n')), 'a deleted record is no longer a target');

  seedTasks([{ id: 'sess_xa1' }, { id: 'sess_ya1' }]);
  const amb = tctx(); await run('archive', amb, 'a1');
  ok(/ambiguous id 'a1'/.test(amb.out.join('\n')), '/archive reports an ambiguous suffix');

  // A session id resolves its OWN row only: a foreign task whose id merely
  // ENDS with the session id is never the target of the bare commands.
  seedTasks([{ id: 'foreign_sess_only1' }]);
  const foreign = tctx(); foreign.state.sessionId = 'sess_only1';
  await run('rename', foreign, 'nope');
  ok(/no task record yet/.test(foreign.out.join('\n')) && readTask('foreign_sess_only1').title === 'untitled',
     'a suffix-matching foreign row is not renamed for the current session');
}

// --- /doctor ---------------------------------------------------------------------------
{
  const ctx = mkCtx();
  await run('doctor', ctx);
  const text = ctx.out.join('\n');
  ok(/runtime:/.test(text) && /config:/.test(text) && /credential:/.test(text), '/doctor prints the three check lines');
  ok(Array.isArray(doctorLines({ env: {}, home: tmp, cwd: tmp })), 'doctorLines is callable for tests');
  const dtext = doctorLines({ env: {}, home: tmp, cwd: tmp }).join('\n');
  ok(dtext.includes('~/.zcode/cli/config.json') && !dtext.includes(`${tmp}/.zcode`), '/doctor renders home paths as ~/...');
}

// --- /quota -------------------------------------------------------------------------------
{
  const ctx = mkCtx();
  ctx.deps = { codingPlanStatus: async () => ({
    level: 'pro', pools: [
      { type: 'TOKENS_LIMIT', number: 5, usedPercent: 42, nextResetAt: new Date('2099-01-01T15:30:00Z').toISOString() },
      { type: 'TIME_LIMIT', used: 140, limit: 4000, usedPercent: 3, nextResetAt: '2099-10-03T00:00:00Z' },
    ] }) };
  await run('quota', ctx);
  const text = ctx.out.join('\n');
  ok(/5-hour window: 42% used · resets \d{2}:\d{2}/.test(text), '/quota shows the 5-hour window with a reset time');
  ok(/monthly tool calls: 140 \/ 4000/.test(text), '/quota shows the monthly tool-call pool');
  const unknown = formatQuota({ pools: [{ type: 'TOKENS_LIMIT' }] });
  ok(/not reported/.test(unknown), '/quota says "not reported" for unknown amounts');
  const err = mkCtx(); err.deps = { codingPlanStatus: async () => { throw new Error('offline'); } };
  await run('quota', err);
  ok(/quota: offline/.test(err.out.join('\n')), '/quota failure is a notice, not a crash');
}

// --- /update -----------------------------------------------------------------------------------
{
  const exec = async (cmd, args) => ({ code: 0, stdout: '0.0.202\n', stderr: '' });
  const ctx = mkCtx(); ctx.deps = { exec };
  await run('update', ctx);
  ok(/is current/.test(ctx.out.join('\n')), '/update reports up-to-date without prompting');

  const calls = [];
  const newer = mkCtx();
  newer.deps = { exec: async (c, a) => { calls.push(a.join(' ')); return { code: 0, stdout: '0.0.300\n', stderr: '' }; } };
  newer.confirm = async () => false;
  await run('update', newer);
  ok(!calls.some(a => a.includes('i -g')), '/update never installs without the y/N confirm');

  const yes = mkCtx();
  yes.deps = { exec: async (c, a) => { calls.push(a.join(' ')); return { code: 0, stdout: a.includes('view') ? '0.0.300\n' : 'ok\n', stderr: '' }; } };
  yes.confirm = async () => true;
  await run('update', yes);
  ok(calls.some(a => a === 'i -g zagent@latest'), '/update confirmed installs latest');
  ok(/updated zagent/.test(yes.out.join('\n')), '/update reports the result');

  ok(isNewerVersion('0.0.300', '0.0.202') && !isNewerVersion('0.0.202', '0.0.202')
     && !isNewerVersion('0.0.202', '0.0.300') && !isNewerVersion('beta', '0.0.202'),
     'isNewerVersion is a strict numeric compare');
}

// --- /theme --------------------------------------------------------------------------------------
{
  const ctx = mkCtx();
  await run('theme', ctx, 'dark');
  ok(ctx.out.includes('THEME:dark'), '/theme dark applies directly');
  const picker = mkCtx(); await run('theme', picker, '');
  ok(picker.out.some(l => l.startsWith('CHOOSE:')), 'bare /theme opens the chooser');
  const bad = mkCtx(); await run('theme', bad, 'purple');
  ok(/usage: \/theme/.test(bad.out.join('\n')), 'a bad theme name prints usage');
}

// --- /hooks, /agents, /permissions, /memory ---------------------------------------------------------
{
  const ctx = mkCtx();
  await run('hooks', ctx);
  ok(/hook|no hooks/i.test(ctx.out.join('\n')), '/hooks prints the hooks report');
  const a = mkCtx();
  a.state.subagents = new Set(['call_agent_1']);
  a.state.entries.push({ kind: 'tool', id: 'call_agent_1', name: 'Agent', input: { prompt: 'review the diff' } });
  await run('agents', a);
  ok(/1 running subagent/.test(a.out.join('\n')) && /review the diff/.test(a.out.join('\n')), '/agents lists the running child');
  const none = mkCtx(); await run('agents', none);
  ok(/no running subagents/.test(none.out.join('\n')), '/agents with none says so');

  mkdirSync(path.join(tmp, '.zcode', 'cli'), { recursive: true });
  writeFileSync(path.join(tmp, '.zcode', 'cli', 'grants.json'),
    JSON.stringify({ grants: {
      'Bash:ls': { toolName: 'Bash', optionId: 'allow_once', pattern: 'npm install: *' },
      'Write:x': { toolName: 'Write', optionId: 'allow_always' },
    } }));
  const p = mkCtx(); await run('permissions', p);
  ok(/Bash\(npm install: \*\) — allow_once/.test(p.out.join('\n')),
    '/permissions lists what each grant covers');
  ok(/Write — allow_always/.test(p.out.join('\n')), 'a pre-pattern grant still lists');
  ok(/revoke with: zagent permissions revoke/.test(p.out.join('\n')),
    '/permissions names the revoke path');
  ok(p.out.includes('PICKER:permissions'), '/permissions opens the in-TUI revoke picker');
  const emptyP = mkCtx(); emptyP.home = mkdtempSync(path.join(os.tmpdir(), 'zcmd-empty-'));
  await run('permissions', emptyP);
  ok(/no persisted permission grants/.test(emptyP.out.join('\n')), '/permissions with none says so');
  ok(!emptyP.out.includes('PICKER:permissions'), 'an empty store never opens the picker');

  const m = mkCtx(); await run('memory', m);
  ok(/project memory:/.test(m.out.join('\n')) && /global memory:/.test(m.out.join('\n')),
     '/memory prints both sections');
}

// --- /feedback, /bug, /approvals, /plan -------------------------------------------------------------
{
  const f = mkCtx(); await run('feedback', f);
  ok(f.out.join('\n').includes('https://github.com/agent-next/zagent/issues/new'), '/feedback prints the issues URL');
  const b = mkCtx(); await run('bug', b);
  ok(b.out.join('\n').includes('issues/new'), '/bug prints the issues URL');
  const ap = mkCtx(); await run('approvals', ap);
  ok(ap.out.includes('PICKER:mode'), '/approvals opens the /mode picker');
  const noPicker = mkCtx(); noPicker.openPicker = async () => false;
  await run('approvals', noPicker);
  ok(noPicker.out.includes('SEND:/mode'), '/approvals falls back to the kernel command');
  const pl = mkCtx(); await run('plan', pl);
  ok(pl.out.includes('MODE:plan'), '/plan switches to plan mode');
}

// --- /workflow stop -------------------------------------------------------------
// The kernel owns `/workflow <args>`; the client command adds only the `stop`
// subcommand (host.stopWorkflow({runId}) -> rebuilt /workflows panel).
{
  const fwd = mkCtx(); await run('workflow', fwd, 'nightly-build --fast');
  ok(fwd.out.includes('RUNTIME:/workflow nightly-build --fast'), '/workflow <args> forwards to the runtime verbatim');
  const bare = mkCtx(); await run('workflow', bare, '');
  ok(bare.out.includes('RUNTIME:/workflow'), 'a bare /workflow forwards to the runtime');

  const calls = [];
  const s = mkCtx({ host: { version: '0.16.5',
    stopWorkflow: async ({ runId } = {}) => { calls.push(runId);
      return { title: '/workflows', selectedRunId: runId, updatedAt: '2026-09-15T00:00:00Z',
        runs: [{ runId, kind: 'goal', status: 'cancelled' }] }; } } });
  await run('workflow', s, 'stop run-1');
  ok(calls.join() === 'run-1', '/workflow stop passes {runId} to the host');
  const panel = s.out.join('\n');
  ok(/\/workflows/.test(panel) && /run-1/.test(panel) && /cancelled/.test(panel), 'the rebuilt panel is printed');

  const noHost = mkCtx({ host: { version: '0.16.5' } });
  await run('workflow', noHost, 'stop run-1');
  ok(/not available/i.test(noHost.out.join('\n')), 'a missing stopWorkflow member says it is unavailable');

  const none = mkCtx(); await run('workflow', none, 'stop');
  ok(/usage/i.test(none.out.join('\n')), '/workflow stop with no tracked run explains usage');

  const pick = mkCtx();
  pick.ui.workflows = new Map([
    ['run-abc', { status: 'running', kind: 'goal' }],
    ['run-done', { status: 'completed', kind: 'goal' }],
  ]);
  let chooser = null;
  pick.choose = (c) => { chooser = c; return true; };
  await run('workflow', pick, 'stop');
  ok(chooser !== null && chooser.items.length === 1 && chooser.items[0].value === 'run-abc',
    '/workflow stop with no runId offers only the running workflow');

  const p = mkCtx({ host: { version: '0.16.5',
    stopWorkflow: async ({ runId } = {}) => { calls.push(runId); return { title: '/workflows', runs: [] }; } } });
  p.ui.workflows = new Map([['run-abcdef', { status: 'running' }]]);
  await run('workflow', p, 'stop run-a');
  ok(calls.at(-1) === 'run-abcdef', 'a unique runId prefix resolves against the tracker');

  const amb = mkCtx();
  amb.ui.workflows = new Map([['run-abc', { status: 'running' }], ['run-abd', { status: 'running' }]]);
  await run('workflow', amb, 'stop run-a');
  ok(/ambiguous/i.test(amb.out.join('\n')), 'an ambiguous runId prefix is reported, not sent to the kernel');

  const fin = mkCtx();
  fin.ui.workflows = new Map([['run-fin', { status: 'completed' }]]);
  await run('workflow', fin, 'stop run-fin');
  ok(/already completed/i.test(fin.out.join('\n')), 'stopping a finished run explains itself locally');
}

if (savedRuntimeEnv === undefined) delete process.env.ZCODE_RUNTIME;
else process.env.ZCODE_RUNTIME = savedRuntimeEnv;
rmSync(tmp, { recursive: true, force: true });
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
