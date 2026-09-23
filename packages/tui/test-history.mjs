// Persistent input history — ~/.zcode/cli/history.jsonl, last HISTORY_CAP kept,
// corrupt lines dropped (and the file rewritten clean once it has drifted).
import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { appendHistory, HISTORY_CAP, historyPath, loadHistory } from './history.mjs';
import { createFakeHost } from './fake-host.mjs';

let passed = 0;
const ok = (cond, name) => { assert(cond, name); passed += 1; console.log(`ok ${passed} ${name}`); };
const texts = (entries) => entries.map((e) => e.text);

const home = mkdtempSync(path.join(tmpdir(), 'zagent-hist-'));
try {
  // --- missing file is empty history, not an error ---------------------------
  assert.deepStrictEqual(loadHistory({ home }), []);
  ok(true, 'a missing history file loads as []');
  ok(historyPath({ home }).endsWith(path.join('.zcode', 'cli', 'history.jsonl')),
     'historyPath lands under <home>/.zcode/cli');

  // --- append creates the dir and round-trips --------------------------------
  appendHistory({ text: 'first prompt' }, { home });
  appendHistory({ text: 'second /slash', chips: [{ token: '[Pasted ~2 lines]', text: 'a\nb' }] }, { home });
  const round = loadHistory({ home });
  assert.deepStrictEqual(texts(round), ['first prompt', 'second /slash']);
  ok(true, 'append + load round-trips in order');
  assert.deepStrictEqual(round[1].chips, [{ token: '[Pasted ~2 lines]', text: 'a\nb' }]);
  ok(true, 'paste chips survive the round-trip so a recalled token re-expands');
  ok(readFileSync(historyPath({ home }), 'utf8').trim().split('\n').length === 2,
     'one JSON line per entry');
  if (process.platform !== 'win32') {
    ok((statSync(historyPath({ home })).mode & 0o777) === 0o600,
       'history.jsonl is 0600 — prompts can carry pasted secrets');
  }

  // --- newline / quote payloads survive JSON encoding -------------------------
  appendHistory({ text: 'line one\nline "two"' }, { home });
  const loaded = loadHistory({ home });
  ok(loaded[2].text === 'line one\nline "two"', 'multi-line input round-trips as one entry');

  // --- corrupt lines are dropped, not fatal -----------------------------------
  const file = historyPath({ home });
  writeFileSync(file, '{"text":"good"}\nnot-json\n{"nope":1}\n{"text":"also good","chips":[{"token":"t"}],"extra":9}\n');
  const healed = loadHistory({ home });
  assert.deepStrictEqual(texts(healed), ['good', 'also good']);
  ok(true, 'corrupt and wrong-shape lines are dropped');
  assert.deepStrictEqual(healed[1].chips, [], 'malformed chips are filtered, not trusted');
  // self-heal: the corrupt file was rewritten clean
  assert.deepStrictEqual(
    readFileSync(file, 'utf8').trim().split('\n'),
    ['{"text":"good","chips":[]}', '{"text":"also good","chips":[]}']);
  ok(true, 'a corrupt file is rewritten clean at load');

  // --- the cap trims to the newest HISTORY_CAP --------------------------------
  writeFileSync(file, Array.from({ length: HISTORY_CAP + 20 }, (_, i) => JSON.stringify({ text: `cmd-${i}` })).join('\n') + '\n');
  if (process.platform !== 'win32') chmodSync(file, 0o644); // drift: prove load re-tightens
  const capped = loadHistory({ home });
  ok(capped.length === HISTORY_CAP, `load keeps the newest ${HISTORY_CAP} (got ${capped.length})`);
  ok(capped[0].text === 'cmd-20' && capped.at(-1).text === `cmd-${HISTORY_CAP + 19}`, 'the oldest entries are the ones dropped');
  // an oversized file is compacted back to the cap
  ok(readFileSync(file, 'utf8').trim().split('\n').length === HISTORY_CAP,
     'an oversized file is compacted at load');
  if (process.platform !== 'win32') {
    ok((statSync(file).mode & 0o777) === 0o600, 'a drifted 0644 file is re-tightened at load');
  }

  // --- a drifted 0644 file is healed to 0600 on the next append ---------------
  if (process.platform !== 'win32') {
    chmodSync(file, 0o644);
    appendHistory({ text: 'after drift' }, { home });
    ok((statSync(file).mode & 0o777) === 0o600, 'an append heals drifted 0644 perms to 0600');
    // isolate the create path — no prior heal can mask a loose mode
    rmSync(file, { force: true });
    appendHistory({ text: 'fresh' }, { home });
    ok((statSync(file).mode & 0o777) === 0o600, 'append lands 0600 on create');
  }

  // --- the cap binds the file between loads, not just at load -----------------
  writeFileSync(file, '');
  for (let i = 0; i < HISTORY_CAP + 5; i++) appendHistory({ text: `n-${i}` }, { home });
  ok(readFileSync(file, 'utf8').trim().split('\n').length === HISTORY_CAP,
     'append compacts once the file drifts over the cap');

  // --- a credential-carrying command never lands on disk ----------------------
  writeFileSync(file, '');
  appendHistory({ text: '/login sk-test-secret' }, { home });
  appendHistory({ text: '/LOGIN sk-upper' }, { home });
  appendHistory({ text: '/auth token-abc' }, { home });
  appendHistory({ text: '/login' }, { home });        // bare command carries no arg — persists
  appendHistory({ text: 'plain prompt' }, { home });
  assert.deepStrictEqual(texts(loadHistory({ home })), ['/login', 'plain prompt']);
  ok(true, '/login <key>-style entries stay in-session only, bare /login persists');
  ok(!readFileSync(file, 'utf8').match(/sk-test-secret|sk-upper|token-abc/),
     'no credential string is anywhere in the file');

  // --- a read-only directory fails closed, never throws -----------------------
  appendHistory({ text: 'x' }, { home: path.join(home, 'does', 'not', 'exist', '\0bad') });
  assert.deepStrictEqual(loadHistory({ home: path.join(home, 'nope', '\0bad') }), []);
  ok(true, 'unwritable/impossible paths fail closed');
} finally {
  rmSync(home, { recursive: true, force: true });
}

// --- a bare fake host can never reach the developer's real home -------------
{
  const { host: fh } = createFakeHost({});
  ok(fh.home.startsWith(tmpdir()) && fh.home !== homedir(),
     'createFakeHost defaults home to a throwaway tmp dir');
  rmSync(fh.home, { recursive: true, force: true });
}

console.log(`all ${passed} history checks passed`);
