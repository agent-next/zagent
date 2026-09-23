// Completion tests. Both sources are official runtime capabilities the TUI was
// not using: host.slashCommands (20 commands with usage + summary) and
// host.listWorkspacePathSuggestions.
import { completionContext, rankCandidates, applyCompletion, slashCandidates, fileCandidates, skillCandidates, conversationCandidates } from './complete.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

// --- context detection ---------------------------------------------------------
const ctx = (v, c = v.length) => completionContext(v, c);
ok(ctx('/')?.type === 'slash' && ctx('/').query === '', 'a bare slash opens the command list');
ok(ctx('/mod')?.query === 'mod', 'the slash query is the typed text');
ok(ctx('/mod')?.start === 0, 'a slash completion replaces from column 0');
ok(ctx('hello') === null, 'plain text completes nothing');
ok(ctx('') === null, 'empty input completes nothing');

// A mid-line slash is a path separator far more often than a command.
ok(ctx('run /usr/bin/thing') === null, 'a mid-line slash is NOT a command context');
ok(ctx('/mode plan') === null, 'once the command is typed and spaced, completion closes');

ok(ctx('@')?.type === 'file' && ctx('@').query === '', 'a bare @ opens the file list');
ok(ctx('look at @src/i')?.query === 'src/i', 'the file query is the text after @');
ok(ctx('look at @src/i')?.start === 8, 'a file completion replaces from the @');
ok(ctx('a@b') === null, 'an @ inside a word (an email, a handle) is not a file context');
ok(ctx('@a @b')?.query === 'b', 'the LAST @ token is the one being completed');

ok(ctx('$')?.type === 'skill' && ctx('$').query === '', 'a bare $ opens the skill list');
ok(ctx('use $rev')?.query === 'rev' && ctx('use $rev')?.start === 4, '$ skill tokens replace from the $');
ok(ctx('a$b') === null, 'a $ inside a word is not a skill context');
ok(ctx('#')?.type === 'conversation' && ctx('see #sess')?.query === 'sess', '# opens past conversations');

// the cursor, not the end of the string, decides
ok(completionContext('/mod extra', 4)?.query === 'mod', 'context is taken at the cursor, not at end of line');
ok(completionContext('/mod', 0) === null, 'a cursor before the slash is not a context');

// --- ranking -------------------------------------------------------------------
const cmds = ['compact', 'model', 'mode', 'mcp', 'new', 'goal'];
ok(rankCandidates(cmds, 'mod')[0] === 'model' || rankCandidates(cmds, 'mod')[0] === 'mode',
   'a prefix match ranks first');
ok(rankCandidates(cmds, 'mode')[0] === 'mode', 'an exact prefix wins over a longer one');
ok(rankCandidates(cmds, '')[0] === 'compact', 'an empty query keeps the given order');
ok(rankCandidates(cmds, 'zzz').length === 0, 'no match yields nothing');
ok(rankCandidates(cmds, 'cmt').includes('compact'), 'a subsequence still matches');
ok(rankCandidates(cmds, 'MOD').length > 0, 'matching is case-insensitive');
ok(rankCandidates(null, 'a').length === 0 && rankCandidates([null, '', 5], 'a').length === 0,
   'malformed candidate lists are safe');
const prefixFirst = rankCandidates(['xmodel', 'model'], 'model');
ok(prefixFirst[0] === 'model', 'a prefix match outranks a substring match');

// --- applying ------------------------------------------------------------------
let out = applyCompletion({ value: '/mod', cursor: 4 }, ctx('/mod'), 'model');
ok(out.value === '/model ' && out.cursor === 7, 'accepting a command replaces the token and adds a space');
out = applyCompletion({ value: 'see @src/i', cursor: 10 }, ctx('see @src/i'), 'src/index.mjs');
ok(out.value === 'see @src/index.mjs ', 'accepting a file replaces from the @');
out = applyCompletion({ value: '@src', cursor: 4 }, ctx('@src'), 'src/');
ok(out.value === '@src/' && out.cursor === 5, 'a directory keeps completing — no trailing space');
out = applyCompletion({ value: '/mod tail', cursor: 4 }, completionContext('/mod tail', 4), 'model');
ok(out.value === '/model tail', 'text after the cursor is preserved');

// --- candidate shaping ---------------------------------------------------------
const slash = slashCandidates([
  { name: 'help', summary: 'Show this slash command help.', usage: '/help [command]' },
  { name: 'goal', summary: 'Show or set the current session goal.', usage: '/goal [action]' },
  null, { name: '' }, { summary: 'no name' },
]);
ok(slash.length === 2, 'malformed command entries are skipped');
ok(slash[0].value === 'help' && slash[0].hint.startsWith('Show'), 'the runtime summary is carried as the hint');
ok(slash[0].usage === '/help [command]', 'the runtime usage line is carried');
ok(slashCandidates(null).length === 0, 'a missing command list is safe');

// The real shape, verified live: {items:[{kind,path}], truncated}
const real = { items: [{ kind: 'directory', path: 'packages/' }, { kind: 'file', path: 'package.json' }], truncated: false };
ok(fileCandidates(real).map(c => c.value).join() === 'packages/,package.json', 'the runtime {items} envelope is unwrapped');
ok(fileCandidates(real)[0].kind === 'directory', 'the file/directory kind is carried through');
ok(fileCandidates(['a.mjs', 'b/']).map(c => c.value).join() === 'a.mjs,b/', 'a plain array still works (other runtime builds)');
ok(fileCandidates([{ path: 'x.mjs' }])[0].value === 'x.mjs', 'object suggestions are accepted');
ok(fileCandidates({ items: 'not an array' }).length === 0, 'a malformed envelope is safe');
ok(fileCandidates([null, 42, {}]).length === 0, 'malformed suggestions are skipped');
ok(fileCandidates(undefined).length === 0, 'a missing suggestion list is safe');

ok(skillCandidates([{ value: 'reviewer', hint: 'skill' }])[0].value === 'reviewer', 'skill objects keep their name');
ok(skillCandidates(['quota']).map(s => s.value).join() === 'quota', 'plain skill names work');
ok(skillCandidates([null, {}, { value: '' }]).length === 0, 'malformed skills are skipped');
ok(conversationCandidates([{ value: 'sess_1', hint: 'fix login' }])[0].hint === 'fix login',
   'conversation hints carry the GUI title');
out = applyCompletion({ value: '$re', cursor: 3 }, ctx('$re'), 'reviewer');
ok(out.value === '$reviewer ', 'accepting a skill replaces from $ and adds a space');
out = applyCompletion({ value: '#se', cursor: 3 }, ctx('#se'), 'sess_abc');
ok(out.value === '#sess_abc ', 'accepting a conversation replaces from #');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
