// `zagent models test` contract — the 3.12.x provider/testModelConnectivity RPC
// (the GUI's connection check) driven against a fake NDJSON app-server, so the
// payload shape, configured-provider resolution, refusal and failure paths are
// all verified on the wire.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(root, 'packages', 'cli', 'zagent-models.mjs');
const home = mkdtempSync(path.join(tmpdir(), 'zagent-models-test-'));

// Runtime layout the catalog discovery anchors on: <Resources>/glm/zcode.cjs is
// both the spawn target and the anchor for config/provider/zcode-builtin.json.
const resources = path.join(home, 'ZCode', 'Resources');
mkdirSync(path.join(resources, 'glm'), { recursive: true });
mkdirSync(path.join(resources, 'config', 'provider'), { recursive: true });
const runtime = path.join(resources, 'glm', 'zcode.cjs');
const logFile = path.join(home, 'fake.log');

// Fake app-server: answers the session/list ready probe; success for
// provider/testModelConnectivity is an empty result like the kernel's
// await-only handler. FAKE_DENY=1 -> -32601 like a pre-3.12.x runtime;
// FAKE_FAIL=1 -> a provider failure carrying error.data.providerRequestId.
// provider/updateAccountConfig is the GUI's registry push: the fake
// echoes the kernel's {receivedRevision, providerCount, status} result.
writeFileSync(runtime, `
const fs = require('fs'), rl = require('readline').createInterface({ input: process.stdin });
let pendingConn = null, authReply = null;
const finishConn = () => {
  if (!pendingConn) return;
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ runtimeAuth: authReply }) + '\\n');
  const m = pendingConn; pendingConn = null;
  process.stdout.write(JSON.stringify({ id: m.id, result: null }) + '\\n');
};
rl.on('line', l => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id === 9999 && pendingConn) { authReply = m; return finishConn(); }
  if (m.id === undefined || !m.method) return;
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(m) + '\\n');
  const reply = o => process.stdout.write(JSON.stringify({ id: m.id, ...o }) + '\\n');
  if (m.method === 'session/list') return reply({ result: { sessions: [] } });
  if (m.method === 'provider/updateAccountConfig') {
    if (process.env.FAKE_DENY === '1') return reply({ error: { code: -32601, message: 'method not found' } });
    if (process.env.FAKE_PUSH_FAIL === '1') return reply({ error: { code: -32602, message: 'invalid params' } });
    return reply({ result: { receivedRevision: m.params.revision,
      providerCount: Object.keys(m.params.providers ?? {}).length, status: 'received' } });
  }
  if (m.method === 'provider/testModelConnectivity') {
    if (process.env.FAKE_DENY === '1') return reply({ error: { code: -32601, message: 'method not found' } });
    if (process.env.FAKE_FAIL === '1') return reply({ error: { code: -32000, message: 'provider unreachable', data: { providerRequestId: 'req_fake_123' } } });
    if (process.env.FAKE_PNF === '1') return reply({ error: { code: -32603, message: 'Provider Registry 中不存在 Provider: ' + m.params.selection.providerId } });
    if (process.env.FAKE_32603) return reply({ error: { code: -32603, message: process.env.FAKE_32603 } });
    const authMode = process.env.FAKE_AUTH;
    if (authMode) {
      // Like the real kernel: request runtime auth from the host first.
      // FAKE_AUTH selects the accountAccess the kernel would send.
      const access = authMode === 'nonzhipu' ? { type: 'api-key' }
        : authMode === 'start' ? { type: 'zhipu-account', accountType: 'zai', mode: 'start-plan', entitled: true }
        : { type: 'zhipu-account', accountType: 'zai', mode: 'individual-coding-plan', entitled: true };
      pendingConn = m;
      process.stdout.write(JSON.stringify({ id: 9999, method: 'interaction/requestProviderRuntimeHeaders',
        params: { requestId: 'r1', sessionId: 's1', workspace: m.params.workspace,
          modelSelection: m.params.selection, providerId: m.params.selection.providerId,
          accountAccess: access, reason: 'provider-connectivity' } }) + '\\n');
      return;
    }
    return reply({ result: null });
  }
  reply({ error: { code: -32601, message: 'method not found' } });
});`);

// The configured-provider store the GUI pushes to the app-server — bare model
// resolution reads these keys. models is a map keyed by model id.
// builtin:zai-coding-plan stands in for the account:zai-individual-coding-plan
// rule (enabled + apiKey => the push must mark that account provider entitled).
const v2 = path.join(home, '.zcode', 'v2');
mkdirSync(v2, { recursive: true });
writeFileSync(path.join(v2, 'config.json'), JSON.stringify({ provider: {
  'fixture-provider': { models: { 'fixture-model': {}, 'shared-model': {} } },
  'fixture-alt': { models: { 'shared-model': {} } },
  'fixture-disabled': { enabled: false, models: { 'disabled-model': {} } },
  'builtin:zai-coding-plan': { enabled: true, options: { apiKey: 'fake-test-key' }, models: { 'GLM-5.3': {} } },
  'builtin:zai': { enabled: true, models: { 'GLM-5.3': {} } },
  'builtin:bigmodel-coding-plan': { enabled: false, options: { apiKey: 'fake-test-key' }, models: { 'BM-1': {} } },
} }));

// Catalog fixture for the plain `models` regression checks + the account rule
// the updateAccountConfig push is built from.
writeFileSync(path.join(resources, 'config', 'provider', 'zcode-builtin.json'), JSON.stringify({
  schemaVersion: 1, revision: 7, config: { providerConfigRules: {
    providerRules: [
      { providerId: 'fixture-provider', providerName: 'Fixture',
        config: { api: { type: 'anthropic-messages', baseUrl: 'https://fixture.invalid/api' },
          builtinModelIds: ['fixture-model', 'shared-model'] } },
      { providerId: 'account:zai-individual-coding-plan', providerName: 'ZAI Plan',
        config: { access: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai' },
          builtinModelIds: ['account-model'] } },
      { providerId: 'account:zai-start-plan', providerName: 'ZAI Start',
        config: { access: { type: 'zhipu-account', mode: 'start-plan', accountType: 'zai' },
          builtinModelIds: ['start-model'] } },
    ],
    templateRules: [] },
    modelConfigRules: { modelRules: [
      { modelMatch: '.*', config: { properties: { contextWindow: 200000,
          inputFormat: { supportsText: true } } } }] } },
}));

const env = extra => {
  const { ZCODE_DATA_BASE_DIR: _drop, ...base } = process.env; // fixture HOME must own the v2 mirror
  return {
    ...base, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home,
    ZCODE_RUNTIME: runtime, FAKE_LOG: logFile, ...extra,
  };
};
const run = (args, extra) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30000, env: env(extra) });
const requests = () => existsSync(logFile)
  ? readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
const connectivityCalls = () => requests().filter(m => m.method === 'provider/testModelConnectivity');
const pushCalls = () => requests().filter(m => m.method === 'provider/updateAccountConfig');

try {
  // --- explicit provider/model: the verified {workspace, selection} envelope --
  let r = run(['test', 'fixture-provider/fixture-model', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
  let calls = connectivityCalls();
  assert.equal(calls.length, 1, 'exactly one connectivity RPC');
  assert.deepEqual(calls[0].params.selection, { providerId: 'fixture-provider', modelId: 'fixture-model' });
  const cwd = path.normalize(process.cwd());
  assert.deepEqual(calls[0].params.workspace, { workspaceKey: cwd, workspacePath: cwd });
  assert.ok(!('workspacePath' in calls[0].params), 'the 3.12.1 schema rejects a top-level workspacePath');

  // --- the GUI's provider/updateAccountConfig registry push -------------------
  // It must precede the connectivity call, carry the strict push keys, mark the
  // configured coding-plan account provider entitled+current, and push the
  // unconfigured start-plan fail-closed. Non-account rules are not pushed.
  const pushes = pushCalls();
  assert.equal(pushes.length, 1, 'exactly one account-config push per spawn');
  {
    const all = requests();
    const iPush = all.findIndex(m => m.method === 'provider/updateAccountConfig');
    const iConn = all.findIndex(m => m.method === 'provider/testModelConnectivity');
    assert.ok(iPush >= 0 && iConn > iPush, 'push precedes the connectivity call');
  }
  assert.deepEqual(Object.keys(pushes[0].params).sort(),
    ['basedOnZCodeBuiltinRevision', 'providers', 'revision', 'states'], 'push params are a strict key set');
  assert.match(pushes[0].params.revision, /^account:/);
  // The kernel's zcodeBuiltinRevision = zcode-builtin:<rev>:<sha256(resolve(active path))>
  // where the app-server's effective builtin path is the managed runtime file.
  const { kernelActiveBuiltinPath } = await import(pathToFileURL(path.join(root, 'packages', 'driver', 'account-config.mjs')).href);
  const expectedBasedOn = `zcode-builtin:7:${(await import('node:crypto')).createHash('sha256')
    .update(path.resolve(kernelActiveBuiltinPath({ env: {}, home }))).digest('hex')}`;
  assert.equal(pushes[0].params.basedOnZCodeBuiltinRevision, expectedBasedOn);
  assert.deepEqual(Object.keys(pushes[0].params.providers).sort(),
    ['account:zai-individual-coding-plan', 'account:zai-start-plan']);
  assert.deepEqual(pushes[0].params.providers['account:zai-individual-coding-plan'],
    { builtinModelIds: ['account-model'], access: { type: 'zhipu-account', entitled: true } });
  assert.deepEqual(pushes[0].params.providers['account:zai-start-plan'],
    { builtinModelIds: ['start-model'], access: { type: 'zhipu-account', entitled: false } });
  assert.deepEqual(pushes[0].params.states,
    { 'account:zai-individual-coding-plan': { availability: 'available', entitled: true, current: true } },
    'states[id].current is required for entitled zhipu-account providers');

  // --- bare model resolves against configured providers, case-insensitively ---
  rmSync(logFile, { force: true });
  r = run(['test', 'FIXTURE-Model']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fixture-provider\/fixture-model: reachable/);
  assert.equal(connectivityCalls().length, 1);
  assert.deepEqual(connectivityCalls()[0].params.selection,
    { providerId: 'fixture-provider', modelId: 'fixture-model' },
    'the canonical configured id goes on the wire, not the typed casing');

  // --- a typed catalog/rule id remaps to the configured carrier ---------------
  rmSync(logFile, { force: true });
  r = run(['test', 'catalog-only/fixture-model']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /not a configured provider/);
  assert.deepEqual(connectivityCalls()[0].params.selection,
    { providerId: 'fixture-provider', modelId: 'fixture-model' });

  // --- canonical casing inside a configured provider ---------------------------
  rmSync(logFile, { force: true });
  r = run(['test', 'fixture-provider/FIXTURE-MODEL', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(connectivityCalls()[0].params.selection,
    { providerId: 'fixture-provider', modelId: 'fixture-model' });

  // --- configured builtin:* key tests through its account:* registry id --------
  rmSync(logFile, { force: true });
  r = run(['test', 'builtin:zai-coding-plan/GLM-5.3']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /account:zai-individual-coding-plan/);
  assert.deepEqual(connectivityCalls()[0].params.selection,
    { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3' },
    'builtin plan key -> the account registry provider it entitles');

  // --- bare family name aliases to its builtin:* coding-plan key ---------------
  // `zagent models` prints the CLI Coding Plan key ('zai/glm-5.3'), but the v2
  // store keys it 'builtin:zai-coding-plan'. The printed spec must round-trip:
  // before the alias, 'zai' missed `configured` and 'glm-5.3' had two carriers
  // (builtin:zai-coding-plan + builtin:zai), so the command failed ambiguous.
  rmSync(logFile, { force: true });
  r = run(['test', 'zai/glm-5.3']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /'zai' resolves as 'builtin:zai-coding-plan'/);
  assert.deepEqual(connectivityCalls()[0].params.selection,
    { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3' },
    "the CLI's own 'zai' key must reach the coding-plan account provider");

  // --- alias under --json: notes suppressed, stdout stays pure JSON --------------
  rmSync(logFile, { force: true });
  r = run(['test', 'zai/glm-5.3', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const aliasJson = JSON.parse(r.stdout); // throws if a note leaked to stdout
  assert.deepEqual({ providerId: aliasJson.providerId, modelId: aliasJson.modelId },
    { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3' });
  assert.ok(!r.stderr.includes('resolves as'), 'resolution notes are suppressed under --json');

  // --- alias onto a disabled builtin: diagnostic names the resolved provider -----
  rmSync(logFile, { force: true });
  r = run(['test', 'bigmodel/BM-1', '--json']);
  assert.equal(r.status, 1);
  {
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.providerId, 'builtin:bigmodel-coding-plan',
      'a JSON caller must see which provider was diagnosed, not null');
    assert.match(out.error, /disabled/);
  }
  assert.equal(connectivityCalls().length, 0, 'a disabled alias must not ping the runtime');

  // --- registry-native account:* ids pass through without remapping ------------
  rmSync(logFile, { force: true });
  r = run(['test', 'account:zai-start-plan/GLM-5.2', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(connectivityCalls()[0].params.selection,
    { providerId: 'account:zai-start-plan', modelId: 'GLM-5.2' });

  // --- a disabled provider is a clear diagnostic, never a carrier --------------
  rmSync(logFile, { force: true });
  r = run(['test', 'fixture-disabled/disabled-model']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /disabled in the CLI config/);
  assert.equal(connectivityCalls().length, 0, 'a disabled provider must not ping the runtime');
  r = run(['test', 'disabled-model']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no configured provider carries 'disabled-model'/,
    'a disabled provider is not a carrier for bare-model resolution');

  // --- ambiguous bare model lists candidates and never reaches the runtime ----
  rmSync(logFile, { force: true });
  r = run(['test', 'shared-model']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fixture-provider\/shared-model/);
  assert.match(r.stderr, /fixture-alt\/shared-model/);
  assert.equal(connectivityCalls().length, 0, 'resolution failure must not ping the runtime');

  // --- an unconfigured provider id with no carriers must -------------------
  // fail BEFORE the runtime is even spawned — forwarding was a guaranteed
  // -32603 whose kernel message arrives unlocalized ("Provider Registry
  // 中不存在 Provider: zai" on the documented `models test zai/glm-5.3`
  // example run on a fresh machine). requests() empty = never spawned.
  rmSync(logFile, { force: true });
  r = run(['test', 'unconfigured/some-model']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /provider 'unconfigured' is not configured/);
  assert.match(r.stderr, /zagent login/, 'names the sign-in next step');
  assert.equal(requests().length, 0, 'an unconfigured provider must not spawn the runtime');
  r = run(['test', 'unconfigured/some-model', '--json']);
  assert.equal(r.status, 1);
  {
    const out = JSON.parse(r.stdout); // throws if a note leaked to stdout
    assert.equal(out.ok, false);
    assert.equal(out.providerId, 'unconfigured');
    assert.match(out.error, /not configured/);
  }
  assert.equal(requests().length, 0, 'still no spawn under --json');

  // --- the same class answered by the kernel (a registry-native id that -----
  // passed through, or a push that dropped it): the unlocalized -32603 is
  // translated to an English registry miss, not relayed verbatim.
  rmSync(logFile, { force: true });
  r = run(['test', 'account:zai-start-plan/GLM-5.2'], { FAKE_PNF: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not know this provider/);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /不存在/, 'kernel registry text must not leak verbatim');
  r = run(['test', 'account:zai-start-plan/GLM-5.2', '--json'], { FAKE_PNF: '1' });
  assert.equal(r.status, 1);
  {
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.match(out.error, /does not know this provider/);
  }
  // A -32603 that is NOT a registry miss keeps the kernel's own message —
  // the gate must require provider/registry context, not just "not found".
  for (const m of ['internal error', 'model GLM-5.2 not found', 'workspace 不存在']) {
    rmSync(logFile, { force: true });
    r = run(['test', 'fixture-provider/fixture-model'], { FAKE_32603: m });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `non-registry -32603 '${m}' must pass through unchanged`);
    assert.doesNotMatch(r.stderr, /does not know this provider/, `'${m}' must not be mislabeled a registry miss`);
  }
  rmSync(logFile, { force: true });
  r = run(['test', 'fixture-provider/fixture-model'], { FAKE_FAIL: '1' });
  assert.match(r.stderr, /provider unreachable/, 'generic kernel errors pass through unchanged');

  // --- unknown bare model — human and --json both report it --------------------
  r = run(['test', 'no-such-model']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no configured provider carries 'no-such-model'/);
  r = run(['test', 'no-such-model', '--json']);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).ok, false, 'a JSON caller still gets a result object');

  // --- usage errors -------------------------------------------------------------
  for (const bad of [['test'], ['test', 'a', 'b'], ['test', 'p/'], ['test', 'p/m', '--bogus-flag']]) {
    r = run(bad);
    assert.equal(r.status, 2, `${bad.join(' ')} should be a usage error`);
    assert.match(r.stderr, /usage: zagent models test/);
  }

  // --- capability refusal: -32601 (pre-3.12.x runtime) -------------------------
  // The push is attempted and swallowed — the connectivity call must still run.
  rmSync(logFile, { force: true });
  r = run(['test', 'fixture-provider/fixture-model'], { FAKE_DENY: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /3\.12/);
  assert.equal(pushCalls().length, 1, 'the push is attempted even on old runtimes');
  assert.equal(connectivityCalls().length, 1, 'a refused push does not block the connectivity call');

  // --- kernel runtime-auth round-trip (3.12.x) ---------------------------------
  // The real kernel pauses a provider attempt on
  // interaction/requestProviderRuntimeHeaders; our handler must answer the
  // runtime-auth result union with the configured sibling plan key, and the connectivity call must
  // still complete.
  rmSync(logFile, { force: true });
  r = run(['test', 'fixture-provider/fixture-model', '--json'], { FAKE_AUTH: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
  {
    const auth = requests().find(m => m.runtimeAuth)?.runtimeAuth;
    assert.ok(auth, 'the client answered the runtime-headers request');
    assert.deepEqual(auth.result, { headersApplied: true, requestAuth: { apiKey: 'fake-test-key' } },
      'zhipu-account auth resolves to the configured coding-plan key');
  }

  // --- runtime-auth fail-closed oracles --------------------------------------
  // No matching configured key -> headersApplied:false, never a key on the wire.
  rmSync(logFile, { force: true });
  r = run(['test', 'fixture-provider/fixture-model'], { FAKE_AUTH: 'start' });
  assert.equal(r.status, 0, r.stderr);
  {
    const auth = requests().find(m => m.runtimeAuth)?.runtimeAuth;
    assert.equal(auth.result.headersApplied, false);
    assert.match(auth.result.errorMessage, /no configured key/);
    assert.ok(!('requestAuth' in auth.result), 'fail-closed never carries requestAuth');
  }
  // Non-zhipu-account access kinds get no headless auth.
  rmSync(logFile, { force: true });
  r = run(['test', 'fixture-provider/fixture-model'], { FAKE_AUTH: 'nonzhipu' });
  assert.equal(r.status, 0, r.stderr);
  {
    const auth = requests().find(m => m.runtimeAuth)?.runtimeAuth;
    assert.deepEqual(auth.result,
      { headersApplied: false, errorMessage: 'no headless runtime auth for this provider kind' });
  }
  // Missing config.json -> fixed 'provider config unreadable', no fs paths on the wire.
  // (A registry-native account:* id is used so resolution still reaches the
  // runtime on an empty home — an unconfigured id now fails before spawn.)
  const emptyHome = mkdtempSync(path.join(tmpdir(), 'zagent-models-test-empty-'));
  rmSync(logFile, { force: true });
  r = run(['test', 'account:zai-start-plan/GLM-5.2'],
    { HOME: emptyHome, USERPROFILE: emptyHome, ZAGENT_TEST_SANDBOX: emptyHome, FAKE_AUTH: '1' });
  assert.equal(r.status, 0, r.stderr);
  {
    const auth = requests().find(m => m.runtimeAuth)?.runtimeAuth;
    assert.deepEqual(auth.result, { headersApplied: false, errorMessage: 'provider config unreadable' });
  }
  rmSync(emptyHome, { recursive: true, force: true });

  // --- a refused push that is NOT benign is surfaced, not swallowed -----------
  rmSync(logFile, { force: true });
  r = run(['test', 'fixture-provider/fixture-model'], { FAKE_PUSH_FAIL: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /account-config push failed/, 'non-benign push failures are reported');
  assert.equal(connectivityCalls().length, 1, 'a failed push does not block the connectivity call');

  // --- provider failure surfaces the request id (human and --json) --------------
  r = run(['test', 'fixture-provider/fixture-model'], { FAKE_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /provider unreachable/);
  assert.match(r.stderr, /provider request id: req_fake_123/);
  r = run(['test', 'fixture-provider/fixture-model', '--json'], { FAKE_FAIL: '1' });
  assert.equal(r.status, 1);
  const failed = JSON.parse(r.stdout);
  assert.equal(failed.ok, false);
  assert.equal(failed.requestId, 'req_fake_123');

  // --- regression: the plain catalog paths are untouched ------------------------
  r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fixture-provider\s+2 models/);
  r = run(['fixture-model']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fixture-provider\/fixture-model/);

  // --- `models query <term>`: the help's [query|test …] reads as two keyword ---
  // forms, so the literal keyword must search exactly like a bare <term>.
  r = run(['query', 'fixture-model']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fixture-provider\/fixture-model/,
    "'query <term>' searches the catalog like a bare <term>");
  const bare = run(['fixture-model']);
  assert.equal(r.stdout, bare.stdout, "'query <term>' output is identical to '<term>'");
  r = run(['query', 'no-such-zz']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no model matching 'no-such-zz'/);
  // A bare 'query' is NOT the keyword: the dispatcher consumes `--`, so
  // `models -- query` arrives here as the same argv — it must stay a search
  // for a model literally named 'query' (pre-keyword behavior), not a usage
  // error.
  r = run(['query']);
  assert.equal(r.status, 1, `models query should search, not refuse: ${r.stderr}`);
  assert.match(r.stderr, /no model matching 'query'/);
  // `query` with an empty term, extra args, or a flag-shaped term is a usage
  // error — and the usage line must name the keyword form it accepts.
  for (const bad of [['query', ''], ['query', 'a', 'b'], ['query', '--json']]) {
    r = run(bad);
    assert.equal(r.status, 2, `models ${bad.join(' ')} should be a usage error`);
    assert.match(r.stderr, /usage: zagent models/);
    assert.match(r.stderr, /query <term>/, 'the usage line names the keyword form');
  }

  console.log('ALL PASS');
} finally {
  rmSync(home, { recursive: true, force: true });
}
