// Personal provider config provisioning — 3.14.x kernel parity.
//
// Oracle: the file the 3.14.4 kernel itself writes when its own -p path
// migrates ~/.zcode/cli/config.json into ~/.zcode/v2/provider_config.json
// (measured live on a fresh HOME; kernel Cpe.#f -> qL, JSON.stringify(...,2)).
// The app-server registry reads personal providers ONLY from that file and
// never runs the legacy import (runZCodeProtocolAgent -> Ykt(env), no
// standalone options), which is why `-p --model` failed on fresh hosts.
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  importLegacyCliConfig, personalProviderConfigDocument, personalProviderConfigPath, legacyCliConfigPath,
  provisionPersonalProviderConfig, planPersonalProviderConfig, modelResolutionCheck, UnsupportedLegacyCliProviderConfigError,
} from '../driver/personal-provider.mjs';
import { runPrintOnce } from './zagent-print.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const throws = (fn, re, m) => { try { fn(); ok(false, `${m} (no throw)`); } catch (e) { ok(re.test(e.message), `${m} (${e.message.slice(0, 60)})`); } };

// The public-acceptance cli config shape (fake key — the real one never enters
// the repo) that reproduces the fresh-host model-not-found bug.
const KEY = 'sk-test-zagent-000';
const CLI_FIXTURE = {
  provider: {
    zai: {
      kind: 'anthropic',
      name: 'Z.AI Coding Plan',
      options: { apiKeyRequired: true, apiKey: KEY, baseURL: 'https://api.z.ai/api/anthropic' },
      models: {
        'glm-5.3': { name: 'GLM-5.3' },
        'glm-5.3-flash': { name: 'GLM-5.3-Flash', limit: { context: 1000000, output: 128000 },
          modalities: { input: ['text', 'image', 'video'], output: ['text'] } },
      },
    },
  },
  model: { main: 'zai/glm-5.3', lite: 'zai/glm-5.3-flash' },
};

// What the 3.14.4 kernel wrote on its first -p run against CLI_FIXTURE's real
// twin ( apiKey redacted there, fake here): same keys, same order, same
// indent — byte parity with the kernel's own migration output.
const KERNEL_SEEDED = {
  schemaVersion: 1,
  config: {
    providerConfigRules: { providerRules: [{
      providerId: 'zai',
      providerName: 'Z.AI Coding Plan',
      config: {
        group: 'standard-personal',
        access: { type: 'api-key', apiKey: KEY },
        api: { type: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic' },
        personalModelIds: ['glm-5.3', 'glm-5.3-flash'],
        modelOrder: ['glm-5.3', 'glm-5.3-flash'],
      },
    }] },
    modelConfigRules: { providerModelRules: [
      { modelId: 'glm-5.3-flash', config: { properties: { contextWindow: 1000000 } }, providerId: 'zai' },
    ], manualProviderModelRules: [] },
    defaultModelSelection: { providerId: 'zai', modelId: 'glm-5.3' },
  },
};
const KERNEL_SEEDED_BYTES = JSON.stringify(KERNEL_SEEDED, null, 2);

// --- importLegacyCliConfig: kernel NHa/MHa/FHa/LHa parity ---
ok(JSON.stringify(personalProviderConfigDocument(importLegacyCliConfig(CLI_FIXTURE))) === JSON.stringify(KERNEL_SEEDED),
  'repro cli config converts to the kernel-measured personal provider document');
throws(() => importLegacyCliConfig({ provider: { x: { options: { apiKeyRequired: false } } } }),
  /cannot express/, 'apiKeyRequired:false provider refuses the whole import (kernel Gkt parity)');
ok(importLegacyCliConfig({ provider: {} }) === null, 'nothing importable -> null (nothing written)');
ok(importLegacyCliConfig(null) === null, 'missing config -> null');
{
  const r = importLegacyCliConfig({ provider: {
    'builtin:zai': { options: { apiKey: ' k ' } },       // -> zai-api family rule (aee parity)
    'builtin:other': { options: { apiKey: 'k' } },        // unrelated builtin id -> skipped
    'account:zai-individual-coding-plan': {},             // account id -> skipped
    gui: { source: 'gui', options: { apiKey: 'k' } },     // non-custom source -> skipped
    openai: { kind: 'openai', models: { m1: {}, m2: { deleted: true }, ' m3 ': {} } },
  } });
  const ids = r.providers.map(p => p.providerId);
  ok(JSON.stringify(ids) === JSON.stringify(['zai-api', 'openai']), `builtin/source/account skips applied (got ${ids})`);
  const fam = r.providers[0];
  ok(fam.templateId === 'zai-api' && fam.config.access.apiKey === 'k' && !('api' in fam.config),
    'builtin:zai maps to the zai-api family rule, key trimmed, no api block');
  const oi = r.providers[1];
  ok(oi.config.api.type === 'openai-responses' && JSON.stringify(oi.config.personalModelIds) === JSON.stringify(['m1', 'm3']),
    'kind->api type, deleted+blank model entries skipped');
  ok(!('providerName' in oi), 'providerName omitted when equal/absent');
  ok(importLegacyCliConfig({ provider: { x: {} }, model: { main: 'builtin:zapi/m' } }).defaultModelSelection === null,
    'builtin:zapi default (OHa) is not imported');
}

// --- provisioning on a temp home ---
const tempHome = (cli = CLI_FIXTURE) => {
  const home = mkdtempSync(path.join(tmpdir(), 'zagent-pp-'));
  if (cli) {
    mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
    writeFileSync(path.join(home, '.zcode', 'cli', 'config.json'), JSON.stringify(cli), { mode: 0o600 });
  }
  return home;
};
{
  const home = tempHome();
  const r = provisionPersonalProviderConfig({ home, env: {} });
  const target = personalProviderConfigPath({ home, env: {} });
  ok(r.provisioned && r.path === target, `fresh home provisions (${r.reason ?? 'written'})`);
  ok(readFileSync(target, 'utf8') === KERNEL_SEEDED_BYTES, 'written file is byte-identical to the kernel migration output');
  ok((statSync(target).mode & 0o777) === 0o600, 'provisioned file is 0600');
  ok(!existsSync(`${target}.lock`), 'lock dir cleaned up after provisioning');
  rmSync(home, { recursive: true, force: true });
}
{
  const home = tempHome();
  const target = personalProviderConfigPath({ home, env: {} });
  mkdirSync(path.dirname(target), { recursive: true });
  const desktop = '{"schemaVersion":1,"config":{"providerConfigRules":{"providerRules":[]}}}';
  writeFileSync(target, desktop, { mode: 0o600 });
  const r = provisionPersonalProviderConfig({ home, env: {} });
  ok(!r.provisioned && /already present/.test(r.reason), 'an existing (desktop-written) file is authoritative');
  ok(readFileSync(target, 'utf8') === desktop, 'existing file bytes untouched');
  rmSync(home, { recursive: true, force: true });
}
{
  const home = tempHome(null);
  const r = provisionPersonalProviderConfig({ home, env: {} });
  ok(!r.provisioned && !existsSync(personalProviderConfigPath({ home, env: {} })),
    `no cli config -> nothing written (${r.reason})`);
  rmSync(home, { recursive: true, force: true });
}
{
  const home = tempHome({ provider: { x: { options: { apiKeyRequired: false } } } });
  const r = provisionPersonalProviderConfig({ home, env: {} });
  ok(!r.provisioned && !existsSync(personalProviderConfigPath({ home, env: {} })),
    `unsupported provider -> nothing written (${r.reason})`);
  rmSync(home, { recursive: true, force: true });
}
{
  const home = tempHome();
  const custom = path.join(home, 'personal.json');
  const r = provisionPersonalProviderConfig({ home, env: { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: custom } });
  ok(r.provisioned && r.path === custom && existsSync(custom),
    'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE preset targets the write (dQi passthrough parity)');
  ok(personalProviderConfigPath({ home: '/nope', env: { ZCODE_DATA_BASE_DIR: home } })
    === path.join(home, '.zcode', 'v2', 'provider_config.json'), 'ZCODE_DATA_BASE_DIR relocates the default target');
  rmSync(home, { recursive: true, force: true });
}

// --- the CLI -p --model path seeds the registry BEFORE the app-server spawn ---
// This is the fresh-host bug's oracle: before the fix runPrintOnce had no
// provisioning step, so the file did not exist when the client opened.
{
  const home = tempHome();
  const target = personalProviderConfigPath({ home, env: {} });
  let existedAtCreate = null;
  const client = {
    onNotify() {}, close() {}, child: new EventEmitter(), dead: false,
    async call(method) {
      if (method === 'session/create') return { session: { sessionId: 'sess_pp' } };
      if (method === 'session/read') return { messages: [] };
      if (method === 'session/send') {
        client.onNotify({ method: 'computer-use/operation-event',
          params: { sessionId: 'sess_pp', turnId: 't1', kind: 'turn-started' } });
        client.onNotify({ method: 'computer-use/operation-event',
          params: { sessionId: 'sess_pp', turnId: 't1', kind: 'turn-completed' } });
        return { turnId: 't1' };
      }
      return {};
    },
  };
  await runPrintOnce({ prompt: 'hi', model: 'zai/glm-5.3', cwd: '/tmp' }, {
    createClient: async () => { existedAtCreate = existsSync(target); return client; },
    provision: () => provisionPersonalProviderConfig({ home, env: {} }),
  });
  ok(existedAtCreate === true, 'runPrintOnce seeds the personal provider config before opening the app-server client');
  ok(readFileSync(target, 'utf8') === KERNEL_SEEDED_BYTES, 'seeded file matches the kernel migration output');
  rmSync(home, { recursive: true, force: true });
}
{
  // An injected client (tests, daemon reuse) owns its own setup: the default
  // provision step must not fire against the host's real home.
  let called = false;
  const client = {
    onNotify() {}, close() {}, child: new EventEmitter(), dead: false,
    async call(method) {
      if (method === 'session/create') return { session: { sessionId: 'sess_np' } };
      if (method === 'session/read') return { messages: [] };
      if (method === 'session/send') {
        client.onNotify({ method: 'computer-use/operation-event',
          params: { sessionId: 'sess_np', turnId: 't1', kind: 'turn-started' } });
        client.onNotify({ method: 'computer-use/operation-event',
          params: { sessionId: 'sess_np', turnId: 't1', kind: 'turn-completed' } });
        return { turnId: 't1' };
      }
      return {};
    },
  };
  await runPrintOnce({ prompt: 'hi' }, { client, provision: () => { called = true; } });
  ok(!called, 'injected client path skips provisioning');
}

// --- doctor's read-only resolution check ---
{
  const home = tempHome();
  const env = {};
  const r = modelResolutionCheck({ env, home, config: CLI_FIXTURE });
  ok(r?.ok === true && r.detail === 'zai/glm-5.3' && /cli config/.test(r.source),
    'derivable selection resolves (source names the cli-config derivation)');
  const target = personalProviderConfigPath({ home, env });
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({
    schemaVersion: 1,
    config: { providerConfigRules: { providerRules: [
      { providerId: 'other', config: { personalModelIds: ['x'] } },
      { providerId: 'zai', config: { personalModelIds: ['glm-5.3-flash'] } },
    ] } },
  }), { mode: 0o600 });
  const miss = modelResolutionCheck({ env, home, config: CLI_FIXTURE });
  ok(miss?.ok === false && /not in the provider's model list/.test(miss.detail),
    `existing file wins: a missing model is flagged (${miss?.detail})`);
  ok(modelResolutionCheck({ env, home, config: { model: { main: 'other/m' } } })?.ok === false,
    'provider absent from the existing file is flagged');
  ok(modelResolutionCheck({ env, home, config: { model: { main: 'account:zai-individual-coding-plan/glm-5.3' } } }) === null,
    'account/builtin selections cannot be judged statically -> null');
  ok(modelResolutionCheck({ env, home, config: { model: { main: 'builtin:zapi/m' } } }) === null,
    'builtin:zapi default -> null');
  const bad = modelResolutionCheck({ env, home: tempHome({ provider: { x: { options: { apiKeyRequired: false } } } }),
    config: { provider: { x: { options: { apiKeyRequired: false } } }, model: { main: 'x/m' } } });
  ok(bad?.ok === false && /not expressible/.test(bad.detail), `unimportable provider flagged (${bad?.detail})`);
  ok(modelResolutionCheck({ env, home, config: {} }) === null, 'no model.main -> nothing to check');
  rmSync(home, { recursive: true, force: true });
}

// --- never persist an unusable selected key (OAuth apiKey:'' window) ---
// ensureConfig writes apiKey:'' until the kernel provisions the real key; a
// create-if-missing seed of that config would be permanent (nothing rewrites
// an existing personal file), so the provisioner must abstain instead.
{
  const withKey = apiKey => {
    const c = JSON.parse(JSON.stringify(CLI_FIXTURE));
    if (apiKey === undefined) delete c.provider.zai.options.apiKey;
    else c.provider.zai.options.apiKey = apiKey;
    return c;
  };
  for (const bad of ['', '   ', undefined, 5, {}]) {
    const home = tempHome(withKey(bad));
    const r = provisionPersonalProviderConfig({ home, env: {} });
    ok(!r.provisioned && !existsSync(personalProviderConfigPath({ home, env: {} })),
      `selected provider key ${JSON.stringify(bad)} -> nothing seeded (${r.reason})`);
    rmSync(home, { recursive: true, force: true });
  }
  // NHa stores a custom provider's key verbatim (xz ApiKeyAccessConfig keeps
  // "" — offset 547578): a NON-selected provider's empty key still migrates;
  // the safety net is the selected-provider gate, not converter divergence.
  const both = JSON.parse(JSON.stringify(CLI_FIXTURE));
  both.provider.other = { kind: 'openai', options: { apiKey: '' }, models: { m1: {} } };
  const home = tempHome(both);
  const r = provisionPersonalProviderConfig({ home, env: {} });
  const doc = JSON.parse(readFileSync(personalProviderConfigPath({ home, env: {} }), 'utf8'));
  const other = doc.config.providerConfigRules.providerRules.find(p => p.providerId === 'other');
  ok(r.provisioned && other?.config?.access?.apiKey === '',
    "NHa parity: a non-selected provider's empty key is stored verbatim; the gate scopes to the selection");
  rmSync(home, { recursive: true, force: true });
}

// --- doctor and provisioning share ONE predicate ---
// modelResolutionCheck may never claim ok for a state the -p path refuses to
// seed (the OAuth/ZAI_API_KEY empty-key states): both consume
// planPersonalProviderConfig, so their answers move together.
{
  const withKey = apiKey => {
    const c = JSON.parse(JSON.stringify(CLI_FIXTURE));
    if (apiKey === undefined) delete c.provider.zai.options.apiKey;
    else c.provider.zai.options.apiKey = apiKey;
    return c;
  };
  for (const bad of ['', undefined]) {
    const home = tempHome(withKey(bad));
    const env = {};
    const res = modelResolutionCheck({ env, home, config: withKey(bad) });
    ok(res?.ok === false && /has no usable API key/.test(res.detail),
      `empty-key state: doctor says NOT resolvable, not ok (${res?.detail})`);
    const r = provisionPersonalProviderConfig({ home, env });
    const plan = planPersonalProviderConfig({ env, home, config: withKey(bad) });
    ok(!r.provisioned && plan.write === false && plan.resolves?.ok === false,
      'provisioner and plan agree the empty-key state is unseedable');
    rmSync(home, { recursive: true, force: true });
  }
  // The agreement invariant on a healthy state too: plan.write, the seeded
  // file, and the doctor verdict all line up.
  const home = tempHome();
  const env = {};
  const plan = planPersonalProviderConfig({ env, home, config: CLI_FIXTURE });
  const r = provisionPersonalProviderConfig({ home, env });
  ok(plan.write === true && plan.resolves?.ok === true && r.provisioned
    && modelResolutionCheck({ env, home, config: CLI_FIXTURE })?.ok === true,
    'healthy state: plan.write, provisioning, and the doctor verdict agree');
  rmSync(home, { recursive: true, force: true });
}
{
  // End-to-end: the OAuth-window config (apiKey:'') with a signed-in OAuth
  // store and even ZAI_API_KEY in the env — the credential lines look fine,
  // yet -p --model cannot seed the registry, so doctor must not exit 0.
  const cliEmptyKey = JSON.parse(JSON.stringify(CLI_FIXTURE));
  cliEmptyKey.provider.zai.options.apiKey = '';
  const home = tempHome(cliEmptyKey);
  mkdirSync(path.join(home, '.zcode', 'v2'), { recursive: true });
  writeFileSync(path.join(home, '.zcode', 'v2', 'credentials.json'),
    JSON.stringify({ 'oauth:zai:access_token': 'fixture-token' }), { mode: 0o600 });
  const runtime = path.join(home, 'runtime.cjs');
  writeFileSync(runtime, 'throw new Error("doctor must not start runtime");');
  const r = spawnSync(process.execPath, [new URL('./zagent.mjs', import.meta.url).pathname, 'doctor'], {
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home,
      ZCODE_RUNTIME: runtime, ZAI_API_KEY: 'fixture-env-key' },
    encoding: 'utf8', cwd: home, timeout: 30000,
  });
  ok(r.status === 1 && /^model: .+has no usable API key — NOT RESOLVABLE$/m.test(r.stdout),
    `doctor flags the unseedable OAuth-window config instead of exiting 0 (status ${r.status})`);
  ok(!existsSync(personalProviderConfigPath({ home, env: {} })), 'doctor seeded nothing (read-only)');
  rmSync(home, { recursive: true, force: true });
}

// --- the seeded document must resolve the selection (no permanent miss) ---
{
  // Usable key but no models map: the derived rule would carry no
  // personalModelIds, so the selection could never resolve — seeding that
  // would be a permanent miss (nothing rewrites an existing personal file).
  const noModels = JSON.parse(JSON.stringify(CLI_FIXTURE));
  delete noModels.provider.zai.models;
  const home = tempHome(noModels);
  const env = {};
  const r = provisionPersonalProviderConfig({ home, env });
  ok(!r.provisioned && !existsSync(personalProviderConfigPath({ home, env })),
    `models-less selection refuses to seed (${r.reason})`);
  const res = modelResolutionCheck({ env, home, config: noModels });
  ok(res?.ok === false && /not in the provider's model list/.test(res.detail),
    `doctor agrees the models-less selection will not resolve (${res?.detail})`);
  // Recovery: once the config grows the model list, the same host seeds fine —
  // the refusal kept the state repairable instead of bricking it.
  writeFileSync(path.join(home, '.zcode', 'cli', 'config.json'), JSON.stringify(CLI_FIXTURE));
  const r2 = provisionPersonalProviderConfig({ home, env });
  ok(r2.provisioned && existsSync(personalProviderConfigPath({ home, env })),
    'after the config grows its model list, seeding succeeds (state was not bricked)');
  rmSync(home, { recursive: true, force: true });
  // A selection naming a provider the config does not carry is the same class.
  const dangling = JSON.parse(JSON.stringify(CLI_FIXTURE));
  dangling.model.main = 'ghost/glm-5.3';
  const ghome = tempHome(dangling);
  const gr = provisionPersonalProviderConfig({ home: ghome, env: {} });
  ok(!gr.provisioned && !existsSync(personalProviderConfigPath({ home: ghome, env: {} })),
    `dangling selection refuses to seed (${gr.reason})`);
  rmSync(ghome, { recursive: true, force: true });
}

// --- source/target root rule is the kernel's measured asymmetry ---
// The kernel's legacy import reads ~/.zcode/cli/config.json from the REAL home
// (U7, offset 4090234) while the personal target follows ZCODE_DATA_BASE_DIR
// (dQi, offset 1068307). Measured live on 3.14.4: HOME's key lands in the
// data-root file; a data-root cli config is never consulted.
{
  const home = tempHome();
  const data = mkdtempSync(path.join(tmpdir(), 'zagent-pp-'));
  mkdirSync(path.join(data, '.zcode', 'cli'), { recursive: true });
  const dataCli = JSON.parse(JSON.stringify(CLI_FIXTURE));
  dataCli.provider.zai.options.apiKey = 'DATA-ROOT-KEY';
  writeFileSync(path.join(data, '.zcode', 'cli', 'config.json'), JSON.stringify(dataCli));
  const env = { ZCODE_DATA_BASE_DIR: data };
  ok(legacyCliConfigPath({ home }) === path.join(home, '.zcode', 'cli', 'config.json'),
    'legacy source path helper is HOME-rooted (U7 parity)');
  const r = provisionPersonalProviderConfig({ home, env });
  const target = path.join(data, '.zcode', 'v2', 'provider_config.json');
  ok(r.provisioned && r.path === target && existsSync(target),
    'target follows ZCODE_DATA_BASE_DIR (dQi parity)');
  ok(JSON.parse(readFileSync(target, 'utf8')).config.providerConfigRules.providerRules[0].config.access.apiKey === KEY,
    'source stays the HOME cli config — the data root cli config is never read');
  ok(!existsSync(path.join(home, '.zcode', 'v2', 'provider_config.json')),
    'nothing is written under HOME when the data root relocates the target');
  rmSync(home, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
}

// --- garbage entries degrade per provider, never abort the import ---
// Wrong-typed fields (name:{}, apiKey:5) make THAT field unusable; the other
// providers keep their migration. The kernel's zod layer (QAn -> RHa) is
// strict — one bad field rejects the whole config — but it has a desktop to
// repair the file; zagent's create-if-missing seed does not.
{
  const cli = JSON.parse(JSON.stringify(CLI_FIXTURE));
  cli.provider.zai.name = {};                       // wrong-typed name on the SELECTED provider
  const conv = importLegacyCliConfig(cli);
  ok(conv && !('providerName' in conv.providers[0]) && conv.providers[0].providerId === 'zai',
    'a non-string name degrades to no providerName (no throw)');
  const home = tempHome(cli);
  const r = provisionPersonalProviderConfig({ home, env: {} });
  ok(r.provisioned, 'a wrong-typed name does not abort provisioning of the selection');
  rmSync(home, { recursive: true, force: true });

  const fam = { provider: { 'builtin:zai': { options: { apiKey: 5 } }, zai: CLI_FIXTURE.provider.zai },
    model: { main: 'zai/glm-5.3' } };
  const fconv = importLegacyCliConfig(fam);
  ok(fconv && !fconv.providers.some(p => p.templateId === 'zai-api'),
    'a wrong-typed family key skips that family rule (no throw)');
  ok(fconv.providers.some(p => p.providerId === 'zai'), 'the healthy sibling provider still migrates');

  const mixed = JSON.parse(JSON.stringify(CLI_FIXTURE));
  mixed.provider.junk = { kind: 'anthropic', name: { bad: 1 }, options: { apiKey: { bad: 1 }, baseURL: 7 }, models: { m: {} } };
  const home2 = tempHome(mixed);
  const r2 = provisionPersonalProviderConfig({ home: home2, env: {} });
  const doc = r2.provisioned ? JSON.parse(readFileSync(personalProviderConfigPath({ home: home2, env: {} }), 'utf8')) : null;
  const junk = doc?.config.providerConfigRules.providerRules.find(p => p.providerId === 'junk');
  ok(r2.provisioned && junk && !('providerName' in junk) && !('apiKey' in junk.config.access) && !('baseUrl' in junk.config.api),
    'one garbage provider degrades field-by-field; the import and the selection survive');
  rmSync(home2, { recursive: true, force: true });
}

// --- null model entries are skipped, not fatal ---
{
  const cli = JSON.parse(JSON.stringify(CLI_FIXTURE));
  cli.provider.zai.models['glm-5.3-flash'] = null; // debris on a NON-selected model
  const conv = importLegacyCliConfig(cli);
  ok(JSON.stringify(conv?.providers[0]?.config?.personalModelIds) === JSON.stringify(['glm-5.3']),
    'null model entries are skipped like deleted ones (no throw)');
  const home = tempHome(cli);
  const r = provisionPersonalProviderConfig({ home, env: {} });
  ok(r.provisioned, 'a null model entry on an unselected model does not abort provisioning');
  rmSync(home, { recursive: true, force: true });

  // The selected model itself nullled: the derivation would drop it, so the
  // seed is refused (same permanent-miss class) and the verdict says so.
  const dropped = JSON.parse(JSON.stringify(CLI_FIXTURE));
  dropped.provider.zai.models['glm-5.3'] = null;
  const dhome = tempHome(dropped);
  const dr = provisionPersonalProviderConfig({ home: dhome, env: {} });
  const dres = modelResolutionCheck({ env: {}, home: dhome, config: dropped });
  ok(!dr.provisioned && !existsSync(personalProviderConfigPath({ home: dhome, env: {} })),
    `a nullned selected model refuses to seed (${dr.reason})`);
  ok(dres?.ok === false && /not in the provider's model list/.test(dres.detail),
    `resolution verdict stays honest for the dropped model (${dres?.detail}) — not "not expressible"`);
  rmSync(dhome, { recursive: true, force: true });
}

// --- a malformed existing file is a verdict, never a crash ---
{
  const home = tempHome();
  const env = {};
  const target = personalProviderConfigPath({ home, env });
  mkdirSync(path.dirname(target), { recursive: true });
  const write = doc => writeFileSync(target, JSON.stringify(doc), { mode: 0o600 });
  let res = null, threw = false;
  write({ schemaVersion: 1, config: { providerConfigRules: { providerRules: { zai: {} } } } });
  try { res = modelResolutionCheck({ env, home, config: CLI_FIXTURE }); } catch { threw = true; }
  ok(!threw && res?.ok === false && /malformed \(providerRules\)/.test(res.detail),
    `non-array providerRules -> malformed verdict, not a crash (${res?.detail})`);
  threw = false;
  write({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [
    { providerId: 'zai', config: { personalModelIds: { 'glm-5.3': 1 } } } ] } } });
  try { res = modelResolutionCheck({ env, home, config: CLI_FIXTURE }); } catch { threw = true; }
  ok(!threw && res?.ok === false && /malformed \(personalModelIds\)/.test(res.detail),
    `non-array personalModelIds -> malformed verdict, not a crash (${res?.detail})`);
  // end-to-end through doctor: a model: line and exit 1, never an uncaught throw
  write({ schemaVersion: 1, config: { providerConfigRules: { providerRules: { zai: {} } } } });
  const runtime = path.join(home, 'runtime.cjs');
  writeFileSync(runtime, 'throw new Error("doctor must not start runtime");');
  const doc2 = spawnSync(process.execPath, [new URL('./zagent.mjs', import.meta.url).pathname, 'doctor'], {
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home, ZCODE_RUNTIME: runtime },
    encoding: 'utf8', cwd: home, timeout: 30000,
  });
  ok(doc2.status === 1 && /^model: .+NOT RESOLVABLE$/m.test(doc2.stdout) && !/TypeError/.test(doc2.stdout + doc2.stderr),
    'doctor prints a model: verdict for a malformed personal config instead of crashing');
  rmSync(home, { recursive: true, force: true });
}

if (fails) { console.error(`${fails} FAILURE(S)`); process.exit(1); }
console.log('personal-provider: all checks passed');
process.exit(0);
