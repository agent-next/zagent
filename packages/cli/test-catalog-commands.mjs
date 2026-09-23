import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const home = mkdtempSync(path.join(tmpdir(), 'zagent-catalog-commands-'));
const root = fileURLToPath(new URL('../../', import.meta.url));
try {
  const resources = path.join(home, 'ZCode/Resources');
  mkdirSync(path.join(resources, 'glm'), { recursive: true });
  const runtime = path.join(resources, 'glm/zcode.cjs');
  writeFileSync(runtime, 'throw Error("fixture runtime must not execute");');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home, ZCODE_RUNTIME: runtime };
  const run = args => spawnSync(process.execPath, [path.join(root, 'bin/zagent'), ...args], {
    encoding: 'utf8', timeout: 10000, env,
  });
  let r = run(['models']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /no provider catalog found/);
  mkdirSync(path.join(resources, 'model-providers'));
  writeFileSync(path.join(resources, 'model-providers/models_catalog_1.json'), JSON.stringify({
    schemaVersion: 'zcode.model-providers.v1', providers: [{ id: 'fixture', models: [{ id: 'fixture-model' }] }],
  }));
  r = run(['models']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fixture\s+1 models/);
  r = run(['models', 'fixture-model']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fixture\/fixture-model/);

  // 3.12.1 layout: config/provider/zcode-builtin.json wins over the legacy catalog
  mkdirSync(path.join(resources, 'config/provider'), { recursive: true });
  writeFileSync(path.join(resources, 'config/provider/zcode-builtin.json'), JSON.stringify({
    schemaVersion: 1, config: { providerConfigRules: {
      providerRules: [{ providerId: 'account:zai-start-plan', providerName: 'Z.AI Start Plan',
        config: { api: { type: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic' },
          builtinModelIds: ['GLM-5.3'] } }],
      templateRules: [{ templateId: 'openai',
        config: { api: { type: 'openai-chat-completions', baseUrl: 'https://api.openai.com/v1' },
          builtinModelIds: [] } }] },
      modelConfigRules: { modelRules: [
        { modelMatch: '.*', config: { properties: { contextWindow: 200000,
            inputFormat: { supportsText: true } }, optionSpecs: { maxOutputTokens: { max: 32000 } } } }] } },
  }));
  r = run(['models']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /account:zai-start-plan\s+1 models\thttps:\/\/api\.z\.ai\/api\/anthropic/);
  r = run(['models', 'GLM-5.3']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /account:zai-start-plan\/GLM-5\.3\tctx 200000\tout 32000/);

  // install --json with no marketplace at all (offline + no cache) must still
  // emit the {name, installed:false, error} envelope on stdout.
  r = run(['plugins', 'install', 'demo', '--offline', '--json']);
  assert.equal(r.status, 1);
  const noMkt = JSON.parse(r.stdout);
  assert.equal(noMkt.name, 'demo');
  assert.equal(noMkt.installed, false);
  assert.match(noMkt.error, /no marketplace available/);

  const marketplace = path.join(home, '.zcode/cli/plugins/marketplaces/zcode-plugins-official');
  mkdirSync(marketplace, { recursive: true });
  writeFileSync(path.join(marketplace, 'marketplace.json'), JSON.stringify({ plugins: [
    { name: 'demo', source: { url: 'https://fixture.invalid/plugins/demo/1.0.0/plugin.zip' } },
  ] }));
  for (const args of [['plugins', '--offline'], ['plugins', '--offline', 'demo'], ['plugins', 'demo', '--offline']]) {
    r = run(args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /demo: not-installed/);
  }

  // A flag must never be swallowed as the positional query — 'plugins --json'
  // used to answer "no plugin matching '--json'", and 'models --json' searched
  // the catalog for a model literally named '--json'.
  r = run(['plugins', '--offline', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.count, 1);
  assert.equal(report.plugins[0].name, 'demo');
  assert.equal(report.plugins[0].badge, 'not-installed');
  r = run(['plugins', '--offline', 'demo', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).plugins.map(p => p.name), ['demo']);
  // a --json query miss reports the empty envelope, not stderr-only text
  r = run(['plugins', '--offline', 'nomatch', '--json']);
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stdout), { count: 0, plugins: [] });
  // 'list' is a verb, not a plugin name — `plugins list` must show
  // the listing, not "no plugin matching 'list'".
  r = run(['plugins', 'list', '--offline']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /demo: not-installed/);
  r = run(['plugins', 'list', '--offline', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).plugins[0].name, 'demo');
  r = run(['plugins', 'list', 'extra', '--offline']);
  assert.equal(r.status, 2, 'list takes no positional query');
  assert.match(r.stderr, /usage:/);
  r = run(['plugins', '--offline', '--bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
  r = run(['plugins', '--offline', 'demo', 'extra']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
  // install --json: the fixture URL can't be fetched — pins the JSON error shape
  r = run(['plugins', 'install', 'demo', '--offline', '--json']);
  assert.equal(r.status, 1);
  const installErr = JSON.parse(r.stdout);
  assert.equal(installErr.name, 'demo');
  assert.equal(installErr.installed, false);
  r = run(['plugins', 'install', '--offline', '--json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
  r = run(['models', '--json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
  r = run(['models', 'a', 'b']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
  r = run(['diff', '--json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
  console.log('PASS installed-runtime catalog discovery and offline plugin listing');
} finally { rmSync(home, { recursive: true, force: true }); }
