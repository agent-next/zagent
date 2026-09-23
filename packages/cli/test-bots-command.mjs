#!/usr/bin/env node
// `zagent bots` — read-only view of the shared bot-config.v3/bot-state.v3
// store. Fresh machine = zero bots, never a created file; corrupt JSON is the
// same as absent; credential refs are presence booleans, never resolved.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = path.join(root, 'packages', 'cli', 'zagent-bots.mjs');
const home = mkdtempSync(path.join(tmpdir(), 'zagent-bots-cli-'));
const v2 = path.join(home, '.zcode', 'v2');
mkdirSync(v2, { recursive: true });

const writeBots = (bots, state) => {
  writeFileSync(path.join(v2, 'bot-config.v3.json'), JSON.stringify({ version: 3, bots }));
  writeFileSync(path.join(v2, 'bot-state.v3.json'), JSON.stringify({ version: 3, bots: state ?? {} }));
};
writeBots([
  { id: 'bot-alpha', name: 'Alpha', provider: 'telegram', enabled: true,
    credentialRef: 'bot:bot-alpha:credential', allowedWorkspaces: ['*'],
    allowedCommands: { status: true, new: true }, currentOptions: {},
    replyMode: 'assistant_changes', displayName: 'AlphaBot' },
  { id: 'bot-beta', name: 'Beta', provider: 'feishu', enabled: false,
    allowedWorkspaces: ['/w1'], allowedCommands: {}, currentOptions: {},
    replyMode: 'streaming_card' },
], { 'bot-alpha': { botId: 'bot-alpha', workspacePath: '/w1', mode: 'task', activeTaskId: 'task_1' } });

const env = { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home };
delete env.ZCODE_DATA_BASE_DIR;
const run = (args, e = env) =>
  spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 30000, env: e });

const extraDirs = [];
try {
  // --- list (bare + explicit + flag-first): both bots, no secret refs --------
  for (const args of [[], ['list'], ['--json'], ['list', '--json']]) {
    const r = run(args);
    assert.equal(r.status, 0, `${args}: ${r.stderr}`);
  }
  let r = run([]);
  assert.match(r.stdout, /\[on\]  bot-alpha {2}Alpha {2}telegram/);
  assert.match(r.stdout, /\[off\] bot-beta {2}Beta {2}feishu/);
  assert.ok(!r.stdout.includes('bot:bot-alpha:credential'), 'no credential ref in list');

  // --- --json envelope; credential refs scrubbed to presence booleans --------
  r = run(['--json']);
  let d = JSON.parse(r.stdout);
  assert.equal(d.count, 2);
  assert.equal(d.bots[0].id, 'bot-alpha');
  assert.equal(d.bots[0].credentialRef, true, 'ref scrubbed to presence');
  assert.equal(d.bots[1].credentialRef, false);
  assert.ok(!r.stdout.includes('bot:bot-alpha:credential'), 'no raw ref in JSON');

  // --- show: exact, unique substring, missing, ambiguous, hasOwn edge --------
  r = run(['show', 'bot-alpha']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /credential: {9}configured/);
  assert.match(r.stdout, /webhook secret: {5}none/);
  assert.match(r.stdout, /task task_1/);
  r = run(['show', 'beta']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bot-beta/);
  r = run(['show', 'bot-alpha', '--json']);
  d = JSON.parse(r.stdout);
  assert.equal(d.id, 'bot-alpha');
  assert.equal(d.state.mode, 'task');
  assert.equal(d.credentialRef, true);
  r = run(['show', 'nope']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no bot 'nope'/);
  writeBots([
    { id: 'bot-dup-1', name: 'd1', provider: 'telegram', enabled: true, allowedWorkspaces: ['*'] },
    { id: 'bot-dup-2', name: 'd2', provider: 'telegram', enabled: true, allowedWorkspaces: ['*'] },
  ]);
  r = run(['show', 'dup']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ambiguous id 'dup'/);

  // --- malformed-but-parseable entries degrade, never stack-trace ------------
  writeBots([{ id: 'bot-bad', name: 'B', provider: 'webhook', enabled: true, allowedWorkspaces: 'oops' },
             { id: 'constructor', name: 'C', provider: 'webhook', enabled: true, allowedWorkspaces: ['*'] }]);
  r = run(['show', 'bot-bad']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /allowed workspaces: -/);
  assert.ok(!r.stderr.includes('TypeError'), 'no crash on malformed entry');
  // a bot literally named 'constructor' must not read an inherited state
  r = run(['show', 'constructor', '--json']);
  d = JSON.parse(r.stdout);
  assert.equal(d.id, 'constructor');
  assert.equal(d.state, null, 'inherited Object props are not state');

  // --- status: counts + joined runtime state + orphan states -----------------
  writeBots([
    { id: 'bot-alpha', name: 'Alpha', provider: 'telegram', enabled: true, allowedWorkspaces: ['*'] },
    { id: 'bot-beta', name: 'Beta', provider: 'feishu', enabled: false, allowedWorkspaces: ['*'] },
  ], {
    'bot-alpha': { botId: 'bot-alpha', workspacePath: '/w1', mode: 'task', activeTaskId: 'task_1' },
    'bot-ghost': { botId: 'bot-ghost', workspacePath: '/w9', mode: 'draft' },
  });
  r = run(['status']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 bot\(s\), 1 enabled/);
  assert.match(r.stdout, /bot-alpha {2}telegram {2}task {2}task task_1/);
  assert.match(r.stdout, /bot-beta {2}feishu {2}no state/);
  assert.match(r.stdout, /bot-ghost {2}\? {2}draft {2}\(orphan state\)/);
  r = run(['status', '--json']);
  d = JSON.parse(r.stdout);
  assert.equal(d.botsCount, 2);
  assert.equal(d.enabledBotsCount, 1);
  assert.equal(d.contextsCount, 2);
  assert.equal(d.bots.length, 2, 'orphan state is not a configured bot');
  assert.equal(d.orphanStates[0].id, 'bot-ghost');

  // --- usage errors ----------------------------------------------------------
  for (const args of [['bogus'], ['list', '--bogus'], ['show'], ['show', 'a', 'b'], ['list', 'x']]) {
    r = run(args);
    assert.equal(r.status, 2, `${args}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: zagent bots/);
  }

  // --- absent store on a fresh machine: zero bots, nothing created ------------
  const fresh = mkdtempSync(path.join(tmpdir(), 'zagent-bots-fresh-'));
  extraDirs.push(fresh);
  const fenv = { ...env, HOME: fresh, USERPROFILE: fresh, ZAGENT_TEST_SANDBOX: fresh };
  r = run(['list'], fenv);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no bots configured/);
  r = run(['list', '--json'], fenv);
  assert.deepEqual(JSON.parse(r.stdout), { count: 0, bots: [] });
  assert.ok(!existsSync(path.join(fresh, '.zcode')), 'list must not create the store');

  // --- corrupt JSON (config AND state) = same as absent, never a stack trace --
  mkdirSync(path.join(fresh, '.zcode', 'v2'), { recursive: true });
  writeFileSync(path.join(fresh, '.zcode', 'v2', 'bot-config.v3.json'), 'not json{{{');
  writeFileSync(path.join(fresh, '.zcode', 'v2', 'bot-state.v3.json'), 'also not json');
  r = run(['list'], fenv);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no bots configured/);
  r = run(['status'], fenv);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 bot\(s\), 0 enabled/);

  // --- ZCODE_DATA_BASE_DIR replaces HOME (kernel root rule) -------------------
  const base = mkdtempSync(path.join(tmpdir(), 'zagent-bots-base-'));
  extraDirs.push(base);
  mkdirSync(path.join(base, '.zcode', 'v2'), { recursive: true });
  writeFileSync(path.join(base, '.zcode', 'v2', 'bot-config.v3.json'),
    JSON.stringify({ version: 3, bots: [{ id: 'bot-based', name: 'B', provider: 'webhook', enabled: true, allowedWorkspaces: ['*'] }] }));
  r = run(['list'], { ...env, ZCODE_DATA_BASE_DIR: base });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bot-based/);

  console.log('test-bots-command: all ok');
} finally {
  rmSync(home, { recursive: true, force: true });
  for (const d of extraDirs) rmSync(d, { recursive: true, force: true });
}
