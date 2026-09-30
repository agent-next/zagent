// Personal provider config provisioning — 3.14.x kernel parity.
//
// Oracle: the file the 3.14.4 kernel itself writes when its own -p path
// migrates ~/.zcode/cli/config.json into ~/.zcode/v2/provider_config.json
// (measured live on a fresh HOME; kernel Cpe.#f -> qL, JSON.stringify(...,2)).
// The app-server registry reads personal providers ONLY from that file and
// never runs the legacy import (runZCodeProtocolAgent -> Ykt(env), no
// standalone options), which is why `-p --model` failed on fresh hosts.
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  importLegacyCliConfig, personalProviderConfigDocument, personalProviderConfigPath,
  provisionPersonalProviderConfig, modelResolutionCheck, UnsupportedLegacyCliProviderConfigError,
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

if (fails) { console.error(`${fails} FAILURE(S)`); process.exit(1); }
console.log('personal-provider: all checks passed');
process.exit(0);
