// `zagent commit-msg` contract — workspace/generateText with querySource
// 'git_commit_message' driven against a fake NDJSON app-server + a real git
// fixture repo, so the payload shape, selection resolution, fence stripping,
// diff scoping, refusal and failure paths are all verified on the wire.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(root, 'packages', 'cli', 'zagent-commit-msg.mjs');
const home = mkdtempSync(path.join(tmpdir(), 'zagent-commit-msg-'));

// Runtime layout the catalog discovery anchors on (same as test-models-test).
const resources = path.join(home, 'ZCode', 'Resources');
mkdirSync(path.join(resources, 'glm'), { recursive: true });
mkdirSync(path.join(resources, 'config', 'provider'), { recursive: true });
const runtime = path.join(resources, 'glm', 'zcode.cjs');
const logFile = path.join(home, 'fake.log');

// Fake app-server: answers session/list (ready probe), echoes the
// provider/updateAccountConfig registry push, and replies to
// workspace/generateText with a fenced commit message like the real kernel.
// FAKE_DENY=1 -> -32601 (pre-3.12.x runtime); FAKE_FAIL=1 -> provider failure
// carrying error.data.providerRequestId; FAKE_EMPTY=1 -> empty text.
writeFileSync(runtime, `
const fs = require('fs'), rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', l => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id === undefined || !m.method) return;
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(m) + '\\n');
  const reply = o => process.stdout.write(JSON.stringify({ id: m.id, ...o }) + '\\n');
  if (m.method === 'session/list') return reply({ result: { sessions: [] } });
  if (m.method === 'provider/updateAccountConfig') {
    return reply({ result: { receivedRevision: m.params.revision,
      providerCount: Object.keys(m.params.providers ?? {}).length, status: 'received' } });
  }
  if (m.method === 'workspace/generateText') {
    if (process.env.FAKE_DENY === '1') return reply({ error: { code: -32601, message: 'method not found' } });
    if (process.env.FAKE_FAIL === '1') return reply({ error: { code: -32000, message: 'provider exploded', data: { providerRequestId: 'req_fake_9' } } });
    if (process.env.FAKE_EMPTY === '1') return reply({ result: { text: '', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 0, totalTokens: 3 } } });
    if (process.env.FAKE_32603 === '1') return reply({ error: { code: -32603, message: 'Provider Registry 中不存在 Provider' } });
    if (process.env.FAKE_32603 === 'generic') return reply({ error: { code: -32603, message: 'internal fault elsewhere' } });
    if (process.env.FAKE_UNFENCED === '1') return reply({ result: { text: '  plain one-liner  ', finishReason: 'stop', usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } } });
    const fence = String.fromCharCode(96).repeat(3);
    return reply({ result: { text: fence + '\\nAdd empty hello.txt file\\n' + fence,
      finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } } });
  }
  reply({ error: { code: -32601, message: 'method not found' } });
});`);

// Configured-provider store + the builtin catalog (account rule for the
// builtin:zai-coding-plan -> account:zai-individual-coding-plan mapping).
const v2 = path.join(home, '.zcode', 'v2');
mkdirSync(v2, { recursive: true });
// The real host's store keys providers builtin:* only — a bare family name
// like model.main's 'zai' is not a registry id; it aliases to the configured
// builtin key and then maps to the account rule (verified live 2026-09-16:
// 'zai' → -32603 without this).
writeFileSync(path.join(v2, 'config.json'), JSON.stringify({ provider: {
  'builtin:zai-coding-plan': { enabled: true, options: { apiKey: 'fake-test-key' }, models: { 'GLM-5.3': {} } },
  // A directly-configured non-builtin provider must pass through un-aliased.
  'fixture-provider': { enabled: true, models: { 'Fixture-1': {} } },
} }));
mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
writeFileSync(path.join(home, '.zcode', 'cli', 'config.json'),
  JSON.stringify({ model: { main: 'zai/glm-5.3' } }));
writeFileSync(path.join(resources, 'config', 'provider', 'zcode-builtin.json'), JSON.stringify({
  schemaVersion: 1, revision: 7, config: { providerConfigRules: {
    providerRules: [
      { providerId: 'account:zai-individual-coding-plan', providerName: 'ZAI Plan',
        config: { access: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai' },
          builtinModelIds: ['GLM-5.3'] } },
    ],
    templateRules: [] },
    modelConfigRules: { modelRules: [
      // Fixture-1 declares a non-plan vocabulary — --effort must accept it.
      { modelMatch: 'Fixture-1', config: { optionSpecs: { reasoningLevel: { values: ['enabled', 'off'] } } } },
    ] } },
}));

// A real git repo fixture: one staged file.
const repo = mkdtempSync(path.join(tmpdir(), 'zagent-commit-repo-'));
const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
git(['init', '-q']);
git(['config', 'user.email', 't@t']);
git(['config', 'user.name', 't']);
writeFileSync(path.join(repo, 'hello.txt'), '');
git(['add', 'hello.txt']);

const env = extra => ({
  ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home,
  ZCODE_RUNTIME: runtime, FAKE_LOG: logFile, ...extra,
});
const run = (args, extra, cwd = repo) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30000, env: env(extra), cwd });
const requests = () => existsSync(logFile)
  ? readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
const genCalls = () => requests().filter(m => m.method === 'workspace/generateText');

try {
  // --- staged diff: the verified {workspace, selection, querySource} envelope
  let r = run(['--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.message, 'Add empty hello.txt file', 'fence stripped');
  assert.equal(out.scope, 'staged');
  let calls = genCalls();
  assert.equal(calls.length, 1, 'exactly one generateText RPC');
  const ws = path.normalize(repo);
  assert.deepEqual(calls[0].params.workspace, { workspaceKey: ws, workspacePath: ws });
  assert.equal(calls[0].params.querySource, 'git_commit_message');
  assert.equal(typeof calls[0].params.maxOutputTokens, 'number');
  assert.deepEqual(calls[0].params.selection,
    { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3',
      options: { reasoningLevel: 'low' } },
    'bare model.main family aliases builtin: -> account:');
  assert.match(calls[0].params.prompt, /hello\.txt/, 'prompt carries the diff');
  assert.match(calls[0].params.prompt, /staged/);

  // --- human output prints the bare message ----------------------------------
  r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'Add empty hello.txt file');

  // --- --model / --effort overrides, builtin -> account mapping --------------
  rmSync(logFile);
  r = run(['--model', 'builtin:zai-coding-plan/glm-5.3', '--effort', 'high', '--json']);
  assert.equal(r.status, 0, r.stderr);
  calls = genCalls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params.selection, {
    providerId: 'account:zai-individual-coding-plan',
    modelId: 'GLM-5.3',
    options: { reasoningLevel: 'high' },
  });

  // --- --effort outside the resolved vocabulary is a usage error -----------
  // (GLM-5.3 resolves no levels in this fixture -> low|high|max fallback bound)
  r = run(['--effort', 'bogus', '--json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: zagent commit-msg/);
  r = run(['--effort=MAX', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(genCalls().at(-1).params.selection.options.reasoningLevel, 'max', '--effort=MAX normalized');
  // A model-declared non-plan level is accepted — the static low|high|max
  // gate must not veto the model's own vocabulary.
  r = run(['--model', 'fixture-provider/Fixture-1', '--effort', 'enabled', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(genCalls().at(-1).params.selection.options.reasoningLevel, 'enabled',
    'non-plan level accepted when the model declares it');
  r = run(['--model', 'fixture-provider/Fixture-1', '--effort', 'low', '--json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a valid level for Fixture-1/);

  // --- unstaged fallback -----------------------------------------------------
  git(['commit', '-qm', 'x']);
  writeFileSync(path.join(repo, 'hello.txt'), 'changed\n');
  rmSync(logFile);
  r = run(['--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).scope, 'unstaged');
  assert.match(genCalls()[0].params.prompt, /unstaged/);

  // --- nothing to describe: fails before any RPC -----------------------------
  git(['checkout', 'hello.txt']);
  rmSync(logFile);
  r = run(['--json']);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).ok, false);
  assert.equal(genCalls().length, 0, 'no RPC when there is no diff');

  // --- not a git repo ---------------------------------------------------------
  r = run([], {}, home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a git repository/);

  // --- dubious ownership: a refusal on a REAL repo, never "not a git repo" ---
  // GIT_TEST_ASSUME_DIFFERENT_OWNER makes git treat the fixture as
  // foreign-owned; gate the oracle on the facility producing the refusal.
  const dub = spawnSync('git', ['rev-parse', '--is-inside-work-tree'],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' } });
  if (dub.status === 128 && /dubious ownership|unsafe repository|safe\.directory/i.test(dub.stderr ?? '')) {
    r = run([], { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /dubious ownership/i);
    assert.doesNotMatch(r.stderr, /not a git repository/);
    assert.match(r.stderr, /safe\.directory/, 'names the remedy');
    r = run(['--json'], { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' });
    assert.equal(r.status, 1);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false);
    assert.match(j.error, /dubious ownership|safe\.directory/i);
    assert.doesNotMatch(j.error, /not a git repository/);
  }

  // --- old runtime: -32601 maps to a clear sentence ----------------------------
  writeFileSync(path.join(repo, 'again.txt'), 'y\n');
  git(['add', 'again.txt']);
  r = run([], { FAKE_DENY: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /3\.12/);

  // --- provider failure surfaces providerRequestId ---------------------------
  r = run([], { FAKE_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /req_fake_9/);

  // --- -32603: provider-not-found wording only when the kernel says so -------
  r = run([], { FAKE_32603: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not found in the runtime registry/);
  r = run([], { FAKE_32603: 'generic' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /internal fault elsewhere/);
  assert.doesNotMatch(r.stderr, /not found in the runtime registry/);

  // --- configured non-builtin provider passes through un-aliased -------------
  rmSync(logFile);
  r = run(['--model', 'fixture-provider/fixture-1', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(genCalls()[0].params.selection, {
    providerId: 'fixture-provider', modelId: 'Fixture-1',
    options: { reasoningLevel: 'low' },
  });

  // --- --flag=value form + unfenced reply ------------------------------------
  rmSync(logFile);
  r = run(['--model=builtin:zai-coding-plan/glm-5.3', '--effort=max'], { FAKE_UNFENCED: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'plain one-liner');
  assert.deepEqual(genCalls()[0].params.selection, {
    providerId: 'account:zai-individual-coding-plan',
    modelId: 'GLM-5.3',
    options: { reasoningLevel: 'max' },
  });

  // --- empty text is a failure, not a silent success -------------------------
  r = run(['--json'], { FAKE_EMPTY: '1' });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).ok, false);

  // --- usage errors -----------------------------------------------------------
  r = run(['--bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
  r = run(['extra']);
  assert.equal(r.status, 2);
  r = run(['--model']);
  assert.equal(r.status, 2);

  console.log('test-commit-msg: ALL PASS');
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}
