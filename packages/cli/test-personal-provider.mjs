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
  // The file carries provider 'other' (models ['x']) but not its model 'm':
  // the verdict must name the missing MODEL, not a missing provider.
  const wrongModel = modelResolutionCheck({ env, home, config: { model: { main: 'other/m' } } });
  ok(wrongModel?.ok === false && /model other\/m is not in the provider's model list/.test(wrongModel.detail),
    `existing file: a configured provider without the model is flagged precisely (${wrongModel?.detail})`);
  const noProvider = modelResolutionCheck({ env, home, config: { model: { main: 'ghost/m' } } });
  ok(noProvider?.ok === false && /provider 'ghost' is not configured/.test(noProvider.detail),
    `existing file: an absent provider is flagged precisely (${noProvider?.detail})`);
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

// --- provider ids are normalised everywhere (import AND the key gate) ---
// The importer trims map keys ('zai ' -> rule id 'zai'); the gates must look
// the cli entry up the same way, or an entry keyed 'zai ' slips past the
// unusable-key gate and seeds an empty-key file the doctor calls resolvable.
{
  const withRawId = (rawId, apiKey) => {
    const c = JSON.parse(JSON.stringify(CLI_FIXTURE));
    const entry = c.provider.zai;
    delete c.provider.zai;
    entry.options.apiKey = apiKey;
    c.provider[rawId] = entry;
    return c;
  };
  const bad = withRawId('zai ', '');
  const home = tempHome(bad);
  const env = {};
  const r = provisionPersonalProviderConfig({ home, env });
  ok(!r.provisioned && !existsSync(personalProviderConfigPath({ home, env })),
    `untrimmed map key with an empty key refuses to seed (${r.reason})`);
  const res = modelResolutionCheck({ env, home, config: bad });
  ok(res?.ok === false && /has no usable API key/.test(res.detail),
    `doctor agrees the untrimmed-key entry is unseedable (${res?.detail})`);
  rmSync(home, { recursive: true, force: true });
  const good = withRawId('zai ', KEY);
  const ghome = tempHome(good);
  const gr = provisionPersonalProviderConfig({ home: ghome, env: {} });
  ok(gr.provisioned && modelResolutionCheck({ env: {}, home: ghome, config: good })?.ok === true,
    'an untrimmed map key with a usable key still seeds (one normalised id everywhere)');
  rmSync(ghome, { recursive: true, force: true });
}

// --- the public plan never throws, even when the injected IO does ---
{
  const boom = () => { throw new Error('probe: exists exploded'); };
  let threw = false, plan = null;
  const phome = tempHome();
  try { plan = planPersonalProviderConfig({ home: phome, env: {}, exists: boom }); }
  catch { threw = true; }
  ok(!threw && plan?.write === false && /plan failed: probe/.test(plan?.reason ?? ''),
    `a throwing exists degrades to a conservative refusal (${plan?.reason})`);
  rmSync(phome, { recursive: true, force: true });
  threw = false;
  const home = tempHome();
  let r = null;
  try { r = provisionPersonalProviderConfig({ home, env: {}, exists: boom }); } catch { threw = true; }
  ok(!threw && r?.provisioned === false && /plan failed/.test(r?.reason ?? ''),
    `provisioning never propagates the throw (${r?.reason})`);
  threw = false;
  let res = null;
  try { res = modelResolutionCheck({ env: {}, home, config: CLI_FIXTURE, exists: boom }); } catch { threw = true; }
  ok(!threw && res === null, 'doctor wrapper never throws on failing IO (null verdict)');
  rmSync(home, { recursive: true, force: true });
}

// --- family-rule selections: kernel-exact verdicts, never a seed refusal ---
// The registry's explicit-selection lookup is exact and case-sensitive
// (getModel: `this.#n.get(providerId)?.get(modelId)`, zcode.cjs ~576830;
// models.find(g => g.modelId === t.modelId), ~579813) — measured live on
// 3.14.4: `--model zai-api/glm-5.3` vs the template list answers
// model-not-found, `zai-api/GLM-5.3` answers ok. Builtin catalog ids are
// UPPER case (real zcode-builtin.json: ['GLM-5.3','GLM-5.3-Flash']) while
// cli configs use lowercase — commit-msg canonicalises before sending for
// exactly this reason. Family rules therefore seed ALWAYS (the kernel
// migration writes them regardless; their model list lives in the template,
// so a seed cannot brick a later selection) and the verdict compares ids
// exactly like the kernel.
const BUILTIN_FIXTURE = { // real shape: upper-case template ids
  schemaVersion: 1,
  config: { providerConfigRules: { providerRules: [], templateRules: [
    { templateId: 'zai-api', config: { builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'] } },
  ] } },
};
{
  const famCli = main => ({ provider: { 'builtin:zai': { options: { apiKey: KEY } } }, model: { main } });
  const env = {};
  // Byte parity with the kernel's own migration of the same config (measured
  // live on 3.14.4): the family rule's access block carries type:'api-key'
  // (xz toJSON always emits it) — without it the kernel's strict parser
  // rejects the whole file and even the kernel's own -p fails.
  const KERNEL_FAMILY_BYTES = JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [
        { providerId: 'zai-api', templateId: 'zai-api',
          config: { group: 'standard-personal', access: { type: 'api-key', apiKey: KEY } } }] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      defaultModelSelection: { providerId: 'zai-api', modelId: 'glm-5.3' },
    },
  }, null, 2);
  const phome = tempHome(famCli('zai-api/glm-5.3'));
  const pr = provisionPersonalProviderConfig({ home: phome, env, runtimeEntry: '/nonexistent-runtime-entry' });
  ok(pr.provisioned && readFileSync(personalProviderConfigPath({ home: phome, env }), 'utf8') === KERNEL_FAMILY_BYTES,
    'family seed is byte-identical to the kernel migration output (access.type included)');
  rmSync(phome, { recursive: true, force: true });

  // Unknown id: verdict says not-in-list, the seed still happens.
  const home = tempHome(famCli('zai-api/not-a-real-model'));
  const r = provisionPersonalProviderConfig({ home, env, builtin: BUILTIN_FIXTURE });
  ok(r.provisioned && existsSync(personalProviderConfigPath({ home, env })),
    `family selection with an unknown model id still seeds (kernel-migration parity)`);
  const res = modelResolutionCheck({ env, home, config: famCli('zai-api/not-a-real-model'), builtin: BUILTIN_FIXTURE });
  ok(res?.ok === false && /not in the builtin template's model list/.test(res.detail),
    `doctor names the missing template model (${res?.detail})`);
  rmSync(home, { recursive: true, force: true });

  // Lowercase id against the real upper-case list: exact comparison misses —
  // the kernel's explicit-selection path rejects it too (measured).
  const lhome = tempHome(famCli('zai-api/glm-5.3'));
  const lr = provisionPersonalProviderConfig({ home: lhome, env, builtin: BUILTIN_FIXTURE });
  const lres = modelResolutionCheck({ env, home: lhome, config: famCli('zai-api/glm-5.3'), builtin: BUILTIN_FIXTURE });
  ok(lr.provisioned && lres?.ok === false && /model zai-api\/glm-5\.3 is not in the builtin template's model list/.test(lres.detail),
    `case-mismatched family id seeds but is flagged exactly like the kernel rejects it (${lres?.detail})`);
  rmSync(lhome, { recursive: true, force: true });

  // Canonical id: seeds and resolves.
  const ohome = tempHome(famCli('zai-api/GLM-5.3'));
  const or = provisionPersonalProviderConfig({ home: ohome, env, builtin: BUILTIN_FIXTURE });
  ok(or.provisioned && modelResolutionCheck({ env, home: ohome, config: famCli('zai-api/GLM-5.3'), builtin: BUILTIN_FIXTURE })?.ok === true,
    'a canonical family model the template carries seeds and resolves');
  rmSync(ohome, { recursive: true, force: true });

  // Template list unresolvable (no env preset, no runtime, no managed cache):
  // seed exactly what the kernel migration would write and report UNVERIFIED.
  const uhome = tempHome(famCli('zai-api/glm-5.3'));
  const NO_RUNTIME = { env: {}, runtimeEntry: '/nonexistent-runtime-entry' };
  const uplan = planPersonalProviderConfig({ home: uhome, ...NO_RUNTIME });
  const ur = provisionPersonalProviderConfig({ home: uhome, ...NO_RUNTIME });
  const ures = modelResolutionCheck({ ...NO_RUNTIME, home: uhome, config: famCli('zai-api/glm-5.3') });
  ok(ur.provisioned && existsSync(personalProviderConfigPath({ home: uhome, env: {} })),
    'family selection without any resolvable template list still seeds (#7 behaviour)');
  ok(uplan.resolves === null && /builtin template model list is unavailable/.test(uplan.unverified ?? ''),
    `plan reports the unverified reason (${uplan.unverified})`);
  ok(ures?.ok === true && ures.unverified === true && /zai-api\/glm-5\.3 — unverified/.test(ures.detail),
    `doctor says the check is unverified, not failed (${ures?.detail})`);
  rmSync(uhome, { recursive: true, force: true });

  // The env-named builtin config is read when no document is injected.
  const bfile = path.join(tmpdir(), `zagent-pp-builtin-${process.pid}.json`);
  writeFileSync(bfile, JSON.stringify(BUILTIN_FIXTURE));
  const ehome = tempHome(famCli('zai-api/GLM-5.3'));
  const er = provisionPersonalProviderConfig({ home: ehome, env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: bfile } });
  ok(er.provisioned, 'family selection seeds from the env-named builtin config');
  rmSync(ehome, { recursive: true, force: true });
  rmSync(bfile, { force: true });
}

// --- the template list resolves the way the runtime spawn sees it ---
// No env preset and no injected document: the bundled copy beside the
// discovered runtime (what kernelEnv injects for our spawns) is read, then
// the kernel's managed active cache under the data root — reusing zagent's
// own resolvers (builtinConfigPath / kernelActiveBuiltinPath), not invented
// paths.
{
  const famCli = main => ({ provider: { 'builtin:zai': { options: { apiKey: KEY } } }, model: { main } });
  const { builtinConfigPath, kernelActiveBuiltinPath } = await import('../driver/account-config.mjs');
  const { findRuntime } = await import('../driver/runtime.mjs');

  // Runtime-anchored bundled copy: <resources>/glm/zcode.cjs beside
  // <resources>/config/provider/zcode-builtin.json — discoverable via
  // ZCODE_RUNTIME with no other env.
  const rt = mkdtempSync(path.join(tmpdir(), 'zagent-pp-rt-'));
  mkdirSync(path.join(rt, 'resources', 'glm'), { recursive: true });
  mkdirSync(path.join(rt, 'resources', 'config', 'provider'), { recursive: true });
  writeFileSync(path.join(rt, 'resources', 'glm', 'zcode.cjs'), '// stub entry\n');
  writeFileSync(path.join(rt, 'resources', 'config', 'provider', 'zcode-builtin.json'), JSON.stringify(BUILTIN_FIXTURE));
  const entry = path.join(rt, 'resources', 'glm', 'zcode.cjs');
  const env = { ZCODE_RUNTIME: entry };
  ok(findRuntime({ env })?.entry === entry && builtinConfigPath(entry) === path.join(rt, 'resources', 'config', 'provider', 'zcode-builtin.json'),
    'fixture runtime anchors the bundled builtin path (kernelEnv parity)');
  const bhome = tempHome(famCli('zai-api/GLM-5.3'));
  const bres = modelResolutionCheck({ env, home: bhome, config: famCli('zai-api/GLM-5.3') });
  ok(bres?.ok === true && !bres.unverified,
    `template list found beside the runtime -> verified verdict (${bres?.detail})`);
  const lres = modelResolutionCheck({ env, home: bhome, config: famCli('zai-api/glm-5.3') });
  ok(lres?.ok === false && /not in the builtin template's model list/.test(lres.detail),
    `the runtime-anchored list is actually consulted (${lres?.detail})`);
  rmSync(bhome, { recursive: true, force: true });
  rmSync(rt, { recursive: true, force: true });

  // Managed active cache (what a bare kernel spawn provisions under the data
  // root) is the next candidate when nothing else resolves.
  const mhome = tempHome(famCli('zai-api/GLM-5.3'));
  const active = kernelActiveBuiltinPath({ env: {}, home: mhome });
  mkdirSync(path.dirname(active), { recursive: true });
  writeFileSync(active, JSON.stringify(BUILTIN_FIXTURE));
  const mres = modelResolutionCheck({ env: {}, home: mhome, config: famCli('zai-api/GLM-5.3'), runtimeEntry: '/nonexistent-runtime-entry' });
  ok(mres?.ok === true && !mres.unverified,
    `managed active cache under the data root resolves the list (${mres?.detail})`);
  rmSync(mhome, { recursive: true, force: true });
}

// --- custom lists are kernel-exact too: casing must match the config's own ---
// Same registry semantics as family lists: a selection whose id differs in
// case from the configured models map is rejected by the kernel's explicit
// lookup (measured: zai/GLM-5.3 vs ['glm-5.3',…] answers model-not-found),
// so the verdict flags it and the permanent-miss guard refuses the seed.
{
  const cli = JSON.parse(JSON.stringify(CLI_FIXTURE));
  cli.model.main = 'zai/GLM-5.3';
  const home = tempHome(cli);
  const env = {};
  const r = provisionPersonalProviderConfig({ home, env });
  const res = modelResolutionCheck({ env, home, config: cli });
  ok(!r.provisioned && res?.ok === false && /model zai\/GLM-5\.3 is not in the provider's model list/.test(res.detail),
    `case-mismatched custom selection is flagged exactly (${res?.detail})`);
  rmSync(home, { recursive: true, force: true });
}

// --- commit-msg and models test seed before opening their app-server client ---
// The runtime stub dies on contact, so both commands must FAIL — but only
// after the seeding line ran: the personal config exists afterwards. These
// assertions fail if either seed call is removed from the command files.
{
  const bin = new URL('../../bin/zagent', import.meta.url).pathname;
  const stubHome = () => {
    const h = tempHome();
    writeFileSync(path.join(h, 'runtime.cjs'), 'process.exit(3); // stub: never speaks JSON-RPC\n');
    return h;
  };
  const stubEnv = h => ({ PATH: process.env.PATH, HOME: h, USERPROFILE: h,
    ZAGENT_TEST_SANDBOX: h, ZCODE_RUNTIME: path.join(h, 'runtime.cjs') });

  const ch = stubHome();
  const repo = mkdtempSync(path.join(tmpdir(), 'zagent-pp-repo-'));
  const git = (args, extra = {}) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...extra } });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  writeFileSync(path.join(repo, 'hello.txt'), 'change');
  git(['add', 'hello.txt']);
  const cm = spawnSync(process.execPath, [bin, 'commit-msg'], {
    encoding: 'utf8', timeout: 60000, env: stubEnv(ch), cwd: repo });
  ok(cm.status !== 0, `commit-msg fails against the dead stub (status ${cm.status})`);
  ok(existsSync(personalProviderConfigPath({ home: ch, env: {} })),
    'commit-msg seeded the personal provider config before opening its client');
  rmSync(ch, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });

  const mh = stubHome();
  // models test consults the v2 config mirror (~/.zcode/v2/config.json) for
  // configured carriers and exits before the client without one; give the
  // fixture both stores so the command reaches its seeding line.
  mkdirSync(path.join(mh, '.zcode', 'v2'), { recursive: true });
  writeFileSync(path.join(mh, '.zcode', 'v2', 'config.json'),
    JSON.stringify({ provider: { zai: { options: { apiKey: KEY },
      models: { 'glm-5.3': {}, 'glm-5.3-flash': {} } } } }), { mode: 0o600 });
  const mt = spawnSync(process.execPath, [bin, 'models', 'test', 'zai/glm-5.3'], {
    encoding: 'utf8', timeout: 60000, env: stubEnv(mh), cwd: mh });
  ok(mt.status !== 0, `models test fails against the dead stub (status ${mt.status})`);
  ok(existsSync(personalProviderConfigPath({ home: mh, env: {} })),
    'models test seeded the personal provider config before opening its client');
  rmSync(mh, { recursive: true, force: true });
}

if (fails) { console.error(`${fails} FAILURE(S)`); process.exit(1); }
console.log('personal-provider: all checks passed');
process.exit(0);
