// E3 tests — fixture copied verbatim from the live artifact (sess_b1669172, 2026-09-05).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { sessionDiffArtifacts, diffSummary, diffLine, artifactPatch } from './diffs.mjs';
import path from 'node:path';
import os from 'node:os';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const LIVE = { version: 1, kind: 'workspace_file_before_change', toolCallId: 'c1', toolName: 'Edit',
  createdAt: '2026-09-05T02:44:46.015Z',
  files: [{ path: '/tmp/x/calc.py', existedBefore: true, beforeContent: 'def add(a, b):\n    return a - b\n',
    structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
      lines: [' def add(a, b):', '-    return a - b', '+    return a + b'] }] }] };

// reader: filters by kind, ignores non-tool-result + torn json
const home = mkdtempSync(path.join(os.tmpdir(), 'zdiff-'));
const dir = `${home}/.zcode/cli/artifacts/s1`; mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/call_a-tool-result-1.json`, JSON.stringify(LIVE));
writeFileSync(`${dir}/call_b-tool-result-2.json`, JSON.stringify({ ...LIVE, kind: 'other_kind' }));
writeFileSync(`${dir}/call_c-tool-result-3.json`, '{torn');
writeFileSync(`${dir}/notes.txt`, 'not json');
let arts = sessionDiffArtifacts('s1', { home });
ok(arts.length === 1 && arts[0].toolName === 'Edit', 'reads only workspace_file_before_change artifacts, skips torn/other');
ok(sessionDiffArtifacts('missing', { home }).length === 0, 'missing session dir -> []');

// summary: +/- counts, tool dedupe, multi-artifact same file
const s = diffSummary([{ ...LIVE, toolName: 'Edit' }, { ...LIVE, createdAt: '2026-09-05T03:00:00.000Z', toolName: 'Write', files: LIVE.files }]);
ok(s.length === 1 && s[0].edits === 2 && s[0].added === 2 && s[0].removed === 2, 'same-file artifacts aggregate');
ok(s[0].tools.join(',') === 'Edit,Write', 'tools unioned');
ok(diffLine([{ ...LIVE }]) === 'calc.py +1/-1 (Edit)', 'diffLine exact');
ok(diffLine([]) === 'no file changes', 'empty line');

// multi-file artifact
const two = { ...LIVE, files: [LIVE.files[0], { ...LIVE.files[0], path: '/tmp/x/other.py' }] };
ok(diffSummary([two]).length === 2, 'files[] plural handled');

rmSync(home, { recursive: true, force: true });
console.log('interim:', fails ? `FAIL (${fails})` : 'ok');

// --- E3 undo: preview/apply oracle tests ---
import { undoPreview, undoApply } from './diffs.mjs';
const A = (files) => [{ version: 1, kind: 'workspace_file_before_change', toolCallId: 'c', toolName: 'Edit',
  createdAt: '2026-09-05T02:44:46.015Z', files }];

const BEFORE = 'def add(a, b):\n    return a - b\n';
const HUNK = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
  lines: [' def add(a, b):', '-    return a - b', '+    return a + b'] }];
const AFTER = 'def add(a, b):\n    return a + b\n';
const store = { '/tmp/x/calc.py': AFTER };
const rd = p => (p in store ? store[p] : null);
const wr = (p, c) => { store[p] = c; };

let plans = undoPreview(A([{ path: '/tmp/x/calc.py', existedBefore: true, beforeContent: BEFORE, structuredPatch: HUNK }]), rd);
ok(plans.length === 1 && plans[0].canApply === true && plans[0].state === 'safe', 'unmodified file → safe');
ok(plans[0].restore === BEFORE, 'restore = beforeContent');

// external modification → refused, never clobbers
store['/tmp/x/calc.py'] = 'totally different\n';
plans = undoPreview(A([{ path: '/tmp/x/calc.py', existedBefore: true, beforeContent: BEFORE, structuredPatch: HUNK }]), rd);
ok(plans[0].canApply === false && plans[0].state === 'external_modified', 'externally-modified → external_modified, no apply');

// missing file
delete store['/tmp/x/calc.py'];
plans = undoPreview(A([{ path: '/tmp/x/calc.py', existedBefore: true, beforeContent: BEFORE, structuredPatch: HUNK }]), rd);
ok(plans[0].state === 'file_missing', 'missing file → file_missing');

// patch that doesn't fit beforeContent → unsafe (reconstruction mismatch)
store['/tmp/x/calc.py'] = AFTER;
const badHunk = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-nope', '+x'] }];
plans = undoPreview(A([{ path: '/tmp/x/calc.py', existedBefore: true, beforeContent: BEFORE, structuredPatch: badHunk }]), rd);
ok(plans[0].state === 'unsafe' && plans[0].canApply === false, 'unusable patch → unsafe');

// interleaved multi-hunk apply reconstructs correctly
const TWO = 'a\nb\nc\nd\ne\n';
const h2 = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', '+a2'] },
            { oldStart: 4, oldLines: 2, newStart: 5, newLines: 1, lines: ['-d', ' e', '+e9'] }];
const rebuilt = (() => { // expected: a→a,a2 ; d dropped ; e→e9
  // old=[a..e,''], h1 keeps a +adds a2; h2 drops d, keeps e, adds e9
const src = TWO.split('\n'); return ['a','a2','b','c','e','e9',''].join('\n'); })();
store['/tmp/x/multi.py'] = 'PLACEHOLDER';
plans = undoPreview(A([{ path: '/tmp/x/multi.py', existedBefore: true, beforeContent: TWO, structuredPatch: h2 }]), () => rebuilt);
ok(plans[0].state === 'safe' && plans[0].restore === TWO, 'multi-hunk interleaved reconstruction verified');

// apply → reverted state + file restored
store['/tmp/x/calc.py'] = AFTER;
plans = undoPreview(A([{ path: '/tmp/x/calc.py', existedBefore: true, beforeContent: BEFORE, structuredPatch: HUNK }]), rd);
const res = undoApply(plans, wr);
ok(res[0].state === 'reverted' && res[0].reverted === true, 'apply → reverted');
ok(store['/tmp/x/calc.py'] === BEFORE, 'file content restored to beforeContent');
const res2 = undoApply([{ path: '/tmp/x/y', canApply: false, state: 'external_modified' }], wr);
ok(res2[0].reverted === false && res2[0].state === 'external_modified', 'non-applicable plan passes through untouched');
const res3 = undoApply([{ path: '/tmp/x/z', canApply: true, state: 'safe', restore: 'r' }], () => { throw new Error('disk full'); });
ok(res3[0].state === 'write_failed' && res3[0].reverted === false, 'write failure → write_failed, no crash');

rmSync(home, { recursive: true, force: true });
console.log('interim2:', fails ? `FAIL (${fails})` : 'ok');

// new-file undo (existedBefore:false): before='' reconstructs from '+' hunks
plans = undoPreview(A([{ path: '/tmp/x/new.py', existedBefore: false, beforeContent: '',
  structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+print(1)'] }] }]), () => 'print(1)');
ok(plans[0].state === 'safe' && plans[0].restore === '', 'new-file undo safe, restores empty');

// --- cx review r2 fixes ---
// traversal sessionId rejected (r2 #9)
ok(sessionDiffArtifacts('../../../../etc', { home }).length === 0, 'traversal sessionId -> [] (no read outside root)');

// \\ No newline marker is metadata, not a source line (r2 #5)
store['/tmp/x/nn.py'] = 'A';
plans = undoPreview(A([{ path: '/tmp/x/nn.py', existedBefore: true, beforeContent: 'a',
  structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A', '\\ No newline at end of file'] }] }]), rd);
ok(plans[0].state === 'safe', 'no-newline marker tolerated');

// CRLF disk vs LF-normalized artifact -> safe, restore keeps CRLF (r2 #6)
store['/tmp/x/crlf.py'] = 'def f():\r\n    return 1\r\n';
plans = undoPreview(A([{ path: '/tmp/x/crlf.py', existedBefore: true, beforeContent: 'def f():\n    return 2\n',
  structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-    return 2', '+    return 1'] }] }]), rd);
ok(plans[0].state === 'safe', 'CRLF disk not misjudged external_modified');
ok(plans[0].restore.includes('\r\n'), 'restore preserves disk CRLF');

// Write-tool new file: beforeContent null + empty patch + afterContent -> delete plan (r2 #7)
store['/tmp/x/created.py'] = 'brand new\n';
plans = undoPreview(A([{ path: '/tmp/x/created.py', existedBefore: false, beforeContent: null, structuredPatch: [], afterContent: 'brand new\n' }]), rd);
ok(plans[0].canApply === true && plans[0].delete === true, 'new-file undo plans deletion');
store['/tmp/x/created2.py'] = 'edited after creation\n';
plans = undoPreview(A([{ path: '/tmp/x/created2.py', existedBefore: false, beforeContent: null, structuredPatch: [], afterContent: 'brand new\n' }]), rd);
ok(plans[0].state === 'external_modified', 'new-file changed since creation -> refuse');

// stale preview cannot overwrite later edits (r2 #2)
store['/tmp/x/stale.py'] = 'after\n';
plans = undoPreview(A([{ path: '/tmp/x/stale.py', existedBefore: true, beforeContent: 'before\n',
  structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+after'] }] }]), rd);
ok(plans[0].state === 'safe', 'preview fresh -> safe');
store['/tmp/x/stale.py'] = 'user edit after preview\n'; // foreign write between preview and apply
const resR2 = undoApply(plans, wr, { readCurrent: rd });
ok(resR2[0].state === 'external_modified' && resR2[0].reverted === false, 'stale preview refused at apply time');

// delete plan requires removeCurrent (r2 #7 safety)
store['/tmp/x/del.py'] = 'x\n';
plans = undoPreview(A([{ path: '/tmp/x/del.py', existedBefore: false, beforeContent: null, structuredPatch: [], afterContent: 'x\n' }]), rd);
const resD1 = undoApply(plans, wr);
ok(resD1[0].state === 'unsafe' && resD1[0].reverted === false, 'delete without removeCurrent refused');
const deleted = [];
const remove = p => { deleted.push(p); delete store[p]; };
const withoutRead = undoApply(plans, wr, { removeCurrent: remove });
ok(withoutRead[0].state === 'unsafe' && deleted.length === 0, 'delete without live readCurrent refused');
store['/tmp/x/del.py'] = 'later user edits\n';
const staleDelete = undoApply(plans, wr, { readCurrent: rd, removeCurrent: remove });
ok(staleDelete[0].state === 'external_modified' && store['/tmp/x/del.py'] === 'later user edits\n' && deleted.length === 0,
   'stale creation preview cannot delete later user edits');
store['/tmp/x/del.py'] = 'x\r\n';
ok(undoApply(plans, wr, { readCurrent: rd, removeCurrent: remove })[0].state === 'external_modified',
   'delete checks the exact bytes seen at preview, including line endings');
delete store['/tmp/x/del.py'];
ok(undoApply(plans, wr, { readCurrent: rd, removeCurrent: remove })[0].state === 'file_missing' && deleted.length === 0,
   'file removed after preview is not reported as successfully reverted');
store['/tmp/x/del.py'] = 'x\n';
const resD2 = undoApply(plans, wr, { readCurrent: rd, removeCurrent: remove });
ok(resD2[0].state === 'reverted' && resD2[0].deleted === true && deleted[0] === '/tmp/x/del.py', 'verified unchanged creation is deleted');
store['/tmp/x/no-after.py'] = 'unverified';
const noAfter = undoPreview(A([{ path: '/tmp/x/no-after.py', beforeContent: null, structuredPatch: [] }]), rd);
ok(noAfter[0].state === 'unsafe' && !noAfter[0].canApply, 'creation without afterContent cannot authorize deletion');
store['/tmp/x/empty.py'] = '';
const emptyCreation = undoPreview(A([{ path: '/tmp/x/empty.py', beforeContent: null, structuredPatch: [], afterContent: '' }]), rd);
ok(undoApply(emptyCreation, wr, { readCurrent: rd, removeCurrent: remove })[0].deleted === true,
   'verified empty-file creation can still be undone');

// 200k-line file: no RangeError (r2 #8)
{
  const big = Array.from({ length: 200000 }, (_, i) => 'line ' + i).join('\n');
  const cur = big.replace('line 5\n', 'LINE5\n');
  const p = undoPreview(A([{ path: '/tmp/x/big.py', existedBefore: true, beforeContent: big,
    structuredPatch: [{ oldStart: 6, oldLines: 1, newStart: 6, newLines: 1, lines: ['-line 5', '+LINE5'] }] }]), () => cur);
  ok(p[0].state === 'safe', '200k-line file previews without RangeError');
}

rmSync(home, { recursive: true, force: true });
console.log('interim3:', fails ? `FAIL (${fails})` : 'ok');


// --- E3 CLI: sessionsWithDiffs guard + renderDiff format ---
import { sessionsWithDiffs, renderDiff } from './diffs.mjs';
const homeR = mkdtempSync(path.join(os.tmpdir(), 'zdiff-cli-'));
mkdirSync(`${homeR}/.zcode/cli/artifacts/sess_good`, { recursive: true });
mkdirSync(`${homeR}/.zcode/cli/artifacts/../../evil`, { recursive: true });
writeFileSync(`${homeR}/.zcode/cli/artifacts/sess_good/call_a-tool-result-1.json`, JSON.stringify(LIVE));
ok(JSON.stringify(sessionsWithDiffs({ home: homeR })) === '["sess_good"]', 'sessions list, safe ids only');
ok(sessionsWithDiffs({ home: '/nonexistent' }).length === 0, 'no artifacts dir -> []');
const R = renderDiff([LIVE]);
ok(R.startsWith('+1 -1 · 1 file'), 'aggregate header');
ok(R.includes('/tmp/x/calc.py (Edit)'), 'file header with tool');
ok(R.includes('@@ -1,2 +1,2 @@') && R.includes('-    return a - b') && R.includes('+    return a + b'), 'hunk + lines rendered');
ok(renderDiff([]) === 'no file changes', 'empty render');
// homeR still in scope from the earlier block; recreated if cleaned
try { mkdirSync(`${homeR}/.zcode/cli/artifacts`, { recursive: true }); } catch {}
console.log('interim4:', fails ? `FAIL (${fails})` : 'ok');

// --- r6: '..' traversal, new-file render, ghost sessions ---
ok(sessionDiffArtifacts('..', { home: homeR }).length === 0, "'..' rejected (r6 #3)");
ok(sessionDiffArtifacts('.', { home: homeR }).length === 0, "'.' rejected");
const NEWF = [{ version: 1, kind: 'workspace_file_before_change', toolCallId: 'c2', toolName: 'Write',
  createdAt: '2026-09-05T03:00:00.000Z', files: [{ path: '/tmp/x/new.py', existedBefore: false,
  beforeContent: null, structuredPatch: [], afterContent: 'a\nb\n' }] }];
const R2 = renderDiff(NEWF);
ok(R2.includes('@@ -0,0 +1,2 @@') && R2.includes('+a') && R2.includes('+b'), 'new-file creation hunk rendered (r6 #2)');
const s2 = diffSummary(NEWF);
ok(s2.length === 1 && s2[0].added === 2, 'diffSummary counts afterContent additions');
mkdirSync(`${homeR}/.zcode/cli/artifacts/sess_empty`, { recursive: true });
ok(!sessionsWithDiffs({ home: homeR }).includes('sess_empty'), 'ghost session filtered (r6 #4)');

// --- artifactPatch: the bounded per-call patch the TUI attaches to a tool entry ---
{
  const p = artifactPatch(LIVE);
  ok(p.files.length === 1 && p.files[0].path === '/tmp/x/calc.py' && p.dropped === 0,
     'artifactPatch maps files and reports no drop');
  ok(p.files[0].lines.includes('@@ -1,2 +1,2 @@') && p.files[0].lines.includes('+    return a + b'),
     'artifactPatch keeps the hunk rows verbatim');
  const creation = artifactPatch(NEWF[0]);
  ok(creation.files[0].lines.includes('@@ -0,0 +1,2 @@') && creation.files[0].lines.includes('+a'),
     'a creation artifact still yields its creation hunk');
  const big = { ...LIVE, files: [{ ...LIVE.files[0], structuredPatch: [
    { oldStart: 1, oldLines: 0, newStart: 1, newLines: 400,
      lines: Array.from({ length: 400 }, (_, i) => `+line${i}`) }] }] };
  const capped = artifactPatch(big, { maxLines: 10 });
  ok(capped.files[0].lines.length === 10 && capped.dropped === 391,
     `artifactPatch bounds the kept rows and counts the drop (got ${capped.files[0].lines.length}/${capped.dropped})`);
  ok(artifactPatch(null).files.length === 0 && artifactPatch({}).files.length === 0,
     'a missing/malformed artifact yields an empty patch, never a throw');
  // Parseable-but-malformed shapes degrade to fewer lines, never throw — the
  // TUI attaches this on a timer where a throw would crash the process.
  const malformed = artifactPatch({ files: [
    { path: 'n.js', afterContent: 42 },
    { path: 'p.js', structuredPatch: 'nope' },
    { path: 'q.js', structuredPatch: [null, { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] },
  ] });
  ok(malformed.files.length === 3 && malformed.files[2].lines.includes('+b'),
     'malformed file entries degrade to fewer lines, never throw');
}
console.log(fails ? `FAIL (${fails})` : 'PASS diffs-e3-full');
rmSync(homeR, { recursive: true, force: true });
process.exitCode = fails ? 1 : 0;
