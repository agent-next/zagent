// Provider catalog tests — synthetic catalog in the real schema, independent of desktop installs.
import { providerList, findModel, catalogLine, loadCatalog, catalogDirs, builtinConfigDirs } from './providers.mjs';
import { findRuntime } from './runtime.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const CAT = { schemaVersion: 'zcode.model-providers.v1', providers: [
  { id: 'prov-a', name: 'A', endpoints: { baseURL: 'https://a.example', paths: {} },
    models: [ { id: 'm1', name: 'M1', kinds: ['anthropic'], contextWindow: 1000, maxOutputTokens: 100, modalities: { input: ['text', 'image'], output: ['text'] } },
              { id: 'm2', kinds: ['openai-compatible'] } ] },
  { id: 'prov-b', name: 'B', endpoints: { baseURL: 'https://b.example' }, models: [ { id: 'm1', kinds: ['anthropic'] } ] },
] };

let L = providerList(CAT);
ok(L.length === 2 && L[0].id === 'prov-a' && L[0].models.join(',') === 'm1,m2', 'provider list shape');
ok(L[0].kinds.join(',') === 'anthropic,openai-compatible', 'kinds unioned');
ok(L[0].baseURL === 'https://a.example', 'baseURL surfaced');
let hits = findModel('m1', CAT);
ok(hits.length === 2 && hits[0].provider === 'prov-a' && hits[0].contextWindow === 1000, 'cross-provider model lookup');
ok(hits[0].input.join(',') === 'text,image', 'modalities surfaced');
ok(findModel('nope', CAT).length === 0, 'missing model -> []');
ok(findModel('m1', null).length === 0, 'null catalog safe');
ok(catalogLine(CAT).includes('prov-a (2 models)'), 'line format');
ok(catalogLine(null) === 'no provider catalog found', 'missing catalog line');
for (const [platform, entry, want] of [
  ['linux', '/usr/lib/zcode/resources/glm/zcode.cjs', '/usr/lib/zcode/resources/model-providers'],
  ['darwin', '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs', '/Applications/ZCode.app/Contents/Resources/model-providers'],
  ['win32', 'C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs', 'C:\\Program Files\\ZCode\\resources\\model-providers'],
]) {
  ok(catalogDirs({ runtime: { entry, kind: 'explicit' }, platform }).join() === want,
    `${platform}: catalog follows the chosen runtime`);
}
ok(catalogDirs({ runtime: null }).length === 0, 'missing runtime has no implicit catalog');
for (const [platform, want] of [
  ['linux', '/usr/lib/zcode/resources/model-providers'],
  ['darwin', '/u/Applications/ZCode.app/Contents/Resources/model-providers'],
  ['win32', 'C:\\Users\\x\\AppData\\Local\\Programs\\ZCode\\resources\\model-providers'],
  ['win32', 'C:\\Program Files\\ZCode\\resources\\model-providers'],
]) {
  const env = { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' };
  const runtime = findRuntime({ platform, home: '/u', env, exists: () => true, read: () => '', asar: () => null });
  ok(runtime.kind === 'desktop-bundle' && catalogDirs({ runtime, platform, home: '/u', env }).includes(want),
    `${platform}: desktop priority retains per-root catalog fallback ${want}`);
}

const dir = mkdtempSync(path.join(tmpdir(), 'zagent-provider-test-'));
try {
  const home = path.join(dir, 'home');
  const fallback = path.join(home, 'Applications/ZCode.app/Contents/Resources/model-providers');
  mkdirSync(fallback, { recursive: true });
  writeFileSync(path.join(fallback, 'models_catalog_1.json'), JSON.stringify(CAT));
  // Explicit fixture dirs + builtinDirs:[] isolate the legacy-catalog cases
  // from the host: a real /Applications install would shadow the fixture, and
  // a 3.12.1 host's builtin config would otherwise answer schemaVersion 1.
  ok(loadCatalog({ dirs: [path.join(dir, 'no-system-catalog'), fallback], builtinDirs: [] })?.providers?.[0]?.id === 'prov-a',
    'app-cli without a catalog loads a desktop fallback catalog');
  ok(loadCatalog({ dirs: [path.join(dir, 'missing'), dir], builtinDirs: [] }) === null, 'missing and empty directories safe');
  writeFileSync(path.join(dir, 'models_catalog_1.json'), JSON.stringify(CAT));
  const newer = { ...CAT, providers: [CAT.providers[1]] };
  writeFileSync(path.join(dir, 'models_catalog_2.json'), JSON.stringify(newer));
  writeFileSync(path.join(dir, 'models_catalog_3.json'), '{broken');
  writeFileSync(path.join(dir, 'models_catalog_4.json'), JSON.stringify({ schemaVersion: 'wrong' }));
  writeFileSync(path.join(dir, 'unrelated.json'), JSON.stringify(CAT));
  const loaded = loadCatalog({ dirs: [path.join(dir, 'missing'), dir], builtinDirs: [] });
  ok(JSON.stringify(loaded) === JSON.stringify(newer), 'newest valid catalog wins over malformed and wrong-schema files');
  ok(findModel('m1', loaded)[0]?.provider === 'prov-b', 'loaded catalog supports model lookup');

  // 3.12.1 builtin shape — a subset of the real config/provider/zcode-builtin.json
  const BUILTIN = { schemaVersion: 1, revision: 25, config: {
    providerConfigRules: {
      providerRules: [{ providerId: 'account:zai-start-plan', providerName: 'Z.AI Start Plan',
        config: { access: { type: 'zhipu-account', mode: 'start-plan' },
          api: { type: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic' },
          builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'] } }],
      templateRules: [{ templateId: 'openai', templateNameMap: { 'en-US': 'OpenAI' },
        config: { access: { type: 'api-key' },
          api: { type: 'openai-chat-completions', baseUrl: 'https://api.openai.com/v1' },
          builtinModelIds: ['GPT-5.5'] } }] },
    modelConfigRules: { modelRules: [
      { modelMatch: '.*', config: { properties: { contextWindow: 200000,
          inputFormat: { supportsText: true } },
          optionSpecs: { maxOutputTokens: { max: 32000 } } } },
      { modelMatch: '.*Flash', config: { properties: { contextWindow: 128000 } } },
      { modelMatch: '(unclosed', config: {} }] } } };
  const bl = providerList(BUILTIN);
  ok(bl.length === 2 && bl[0].id === 'account:zai-start-plan' && bl[1].id === 'openai',
    'builtin: account plans first, then API templates');
  ok(bl[0].models.join(',') === 'GLM-5.3,GLM-5.3-Flash' && bl[0].baseURL === 'https://api.z.ai/api/anthropic',
    'builtin: builtinModelIds and baseUrl surfaced');
  let bh = findModel('GLM-5.3-Flash', BUILTIN);
  ok(bh.length === 1 && bh[0].provider === 'account:zai-start-plan', 'builtin: exact model found once');
  ok(bh[0].contextWindow === 128000 && bh[0].maxOutputTokens === 32000,
    'builtin: modelRules merge in order (Flash overrides the .* default)');
  ok(bh[0].input.join(',') === 'text', 'builtin: inputFormat flags become modalities');
  bh = findModel('GPT-5.5', BUILTIN);
  ok(bh.length === 1 && bh[0].provider === 'openai' && bh[0].contextWindow === 200000,
    'builtin: template model inherits the default rule');
  ok(findModel('nope', BUILTIN).length === 0, 'builtin: missing model -> []');
  ok(catalogLine(BUILTIN).includes('account:zai-start-plan (2 models)'), 'builtin: line format');

  // discovery: config/provider/zcode-builtin.json is found and wins over the legacy file
  const res = path.join(dir, 'res');
  mkdirSync(path.join(res, 'config', 'provider'), { recursive: true });
  mkdirSync(path.join(res, 'model-providers'), { recursive: true });
  writeFileSync(path.join(res, 'config', 'provider', 'zcode-builtin.json'), JSON.stringify(BUILTIN));
  writeFileSync(path.join(res, 'model-providers', 'models_catalog_1.json'), JSON.stringify(CAT));
  const both = loadCatalog({ dirs: [path.join(res, 'model-providers')], builtinDirs: [path.join(res, 'config', 'provider')] });
  ok(both?.schemaVersion === 1, 'builtin config wins over a legacy catalog in the same runtime');
  ok(loadCatalog({ dirs: [], builtinDirs: [path.join(res, 'config', 'provider')] })?.schemaVersion === 1,
    'builtin config loads without any legacy catalog (3.12.1 layout)');
  writeFileSync(path.join(res, 'config', 'provider', 'zcode-builtin.json'), '{broken');
  ok(loadCatalog({ dirs: [path.join(res, 'model-providers')], builtinDirs: [path.join(res, 'config', 'provider')] })
    ?.schemaVersion === 'zcode.model-providers.v1', 'malformed builtin config falls back to the legacy catalog');
  const rtEntry = path.join(res, 'glm', 'zcode.cjs');
  ok(builtinConfigDirs({ runtime: { entry: rtEntry, kind: 'explicit' } })[0] === path.join(res, 'config', 'provider'),
    'builtinConfigDirs follows the chosen runtime');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `FAIL (${fails})` : 'PASS providers');
process.exit(fails ? 1 : 0);
