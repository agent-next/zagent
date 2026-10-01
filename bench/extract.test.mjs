#!/usr/bin/env node
// Hermetic unit test for extractAnswer/extractUsage — NO live runtime, NO network.
// Feeds mock `session/read` objects shaped like the real ZCode runtime response
// (verified by a live probe on 2026-09-04) and asserts
// the transcript text is extracted, not JSON.stringify'd (which would defeat the
// downstream ```code-fence regex) and never silently emitted as the 2-char "".
import { extractAnswer, extractUsage } from './run.mjs';

let failed = 0;
const eq = (got, want, msg) => {
  const pass = got === want;
  console.log(`${pass ? 'ok  -' : 'FAIL-'} ${msg}`);
  if (!pass) { console.log(`      got:  ${JSON.stringify(got)}`); console.log(`      want: ${JSON.stringify(want)}`); failed++; }
};
const ok = (cond, msg) => { console.log(`${cond ? 'ok  -' : 'FAIL-'} ${msg}`); if (!cond) failed++; };

// Real runtime shape: read.messages[] of {info:{role,tokens}, parts:[{type,text}]}.
const realRead = {
  messages: [
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'do it' }] },
    { info: { role: 'assistant',
        tokens: { input: 100, output: 5, total: 105, reasoning: 0, cache: { read: 50, write: 0 } } },
      parts: [
        { type: 'step-start' },
        { type: 'text', text: '```python\ndef rot13(s):\n    return s\n```' },
        { type: 'step-finish', tokens: { total: 105 } },
      ] },
  ],
  session: { sessionId: 'sess_x', status: 'idle' }, // no messages/usage here (matches runtime)
};

// (real shape) assistant text is pulled from parts[], fences preserved, regex-recoverable
const a = extractAnswer(realRead);
ok(a.includes('def rot13'), 'real parts shape: assistant code extracted');
ok(a.startsWith('```python'), 'real parts shape: code fence preserved');
ok(!a.startsWith('[') && !a.startsWith('"'), 'real parts shape: NOT a JSON.stringify of blocks');
const fenced = (a.match(/```(?:python|py)?\s*\n([\s\S]*?)```/) ?? [])[1];
ok(!!fenced && fenced.includes('def rot13'), 'real parts shape: fence regex recovers code body');

// (a) string content shape
eq(extractAnswer({ messages: [{ role: 'assistant', content: 'hello' }] }), 'hello', 'string content returns text');

// (b) block-array content shape — must JOIN text, NOT JSON.stringify
eq(extractAnswer({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'foo' }, { type: 'text', text: 'bar' }] }] }),
   'foobar', 'block-array content joins text (not JSON.stringify)');

// parts: only type:text joined (in order); reasoning/step parts excluded
eq(extractAnswer({ messages: [{ info: { role: 'assistant' }, parts: [
  { type: 'reasoning', text: 'THINK' }, { type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }] }),
  'AB', 'parts: only type:text joined, reasoning excluded');

// picks the LAST assistant message, not a trailing user/tool message
eq(extractAnswer({ messages: [
  { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'first' }] },
  { info: { role: 'user' }, parts: [{ type: 'text', text: 'q' }] },
  { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'final' }] },
] }), 'final', 'picks last assistant message');

// (c) empty/missing transcript -> '' (length 0), NEVER the old 2-char '""'
eq(extractAnswer({ messages: [] }), '', 'empty messages -> "" (length 0)');
eq(extractAnswer({}), '', 'missing messages -> ""');
eq(extractAnswer(null), '', 'null read -> ""');
ok(extractAnswer({ messages: [] }).length === 0, 'empty is length 0, not the old 2-char string');

// extractUsage from assistant info.tokens (not read.session.usage).
// Shape = run.mjs's return: {firstTurn, inputSum, outputSum, cacheSum, projectionUsed}.
const u = extractUsage(realRead);
eq(u?.firstTurn?.inputTokens, 100, 'firstTurn.inputTokens from info.tokens');
eq(u?.firstTurn?.outputTokens, 5, 'firstTurn.outputTokens from info.tokens');
eq(u?.firstTurn?.cacheReadTokens, 50, 'firstTurn.cacheReadTokens from info.tokens');
eq(u?.firstTurn?.totalTokens, 105, 'firstTurn.totalTokens from info.tokens');
eq(u?.inputSum, 100, 'inputSum sums all token-bearing messages');
eq(u?.outputSum, 5, 'outputSum');
eq(u?.cacheSum, 50, 'cacheSum');
eq(extractUsage({ messages: [] }), null, 'no tokens -> null usage');

console.log(failed ? `\nFAILED ${failed} assertion(s)` : '\nPASS extract.test (all assertions)');
process.exit(failed ? 1 : 0);
