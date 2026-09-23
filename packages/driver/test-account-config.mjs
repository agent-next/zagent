// provider/updateAccountConfig param builder — pure-function tests.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildAccountConfigParams, kernelActiveBuiltinPath } from './account-config.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const eq = (a, b, m) => { try { assert.deepEqual(a, b); console.log('ok -', m); } catch (e) { console.error('FAIL:', m, '-', e.message); fails++; } };

const mkHome = () => mkdtempSync(path.join(tmpdir(), 'zagent-acfg-'));
const writeBuiltin = dir => {
  const p = path.join(dir, 'zcode-builtin.json');
  writeFileSync(p, JSON.stringify({
    schemaVersion: 1, revision: 12,
    config: { providerConfigRules: { providerRules: [
      { providerId: 'account:zai-individual-coding-plan', providerName: 'ZAI Plan',
        config: { access: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai' },
          builtinModelIds: ['account-model'] } },
      { providerId: 'account:zai-start-plan', providerName: 'ZAI Start',
        config: { access: { type: 'zhipu-account', mode: 'start-plan', accountType: 'zai' },
          builtinModelIds: ['start-model'] } },
      { providerId: 'fixture-provider', providerName: 'Fixture',
        config: { api: { type: 'anthropic-messages', baseUrl: 'https://fixture.invalid' },
          builtinModelIds: ['fixture-model'] } },
    ] } },
  }));
  return p;
};
const writeConfig = (home, provider) => {
  const d = path.join(home, '.zcode', 'v2');
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'config.json'), JSON.stringify({ provider }));
};

// --- null without builtin ---------------------------------------------------
{
  const home = mkHome();
  ok(buildAccountConfigParams({ env: {}, home }) === null, 'no builtin path -> null');
  ok(buildAccountConfigParams({ env: {}, home, builtinPath: path.join(home, 'missing.json') }) === null,
    'unreadable builtin path -> null');
  rmSync(home, { recursive: true, force: true });
}

// --- entitled coding-plan rule ----------------------------------------------
{
  const home = mkHome();
  const builtinPath = writeBuiltin(home);
  writeConfig(home, {
    'builtin:zai-coding-plan': { enabled: true, options: { apiKey: 'k-test' }, models: {} },
  });
  const p = buildAccountConfigParams({ env: {}, home, builtinPath });
  ok(p !== null, 'params built with builtin + configured key');
  eq(p.providers['account:zai-individual-coding-plan'],
    { builtinModelIds: ['account-model'], access: { type: 'zhipu-account', entitled: true } },
    'configured coding-plan rule pushed entitled');
  eq(p.states['account:zai-individual-coding-plan'],
    { availability: 'available', entitled: true, current: true },
    'entitled provider gets availability/entitled/current state');
  rmSync(home, { recursive: true, force: true });
}

// --- no config.json -> fail-closed ------------------------------------------
{
  const home = mkHome();
  const builtinPath = writeBuiltin(home);
  const p = buildAccountConfigParams({ env: {}, home, builtinPath });
  eq(p.providers['account:zai-individual-coding-plan'].access,
    { type: 'zhipu-account', entitled: false }, 'no config.json -> entitled:false');
  eq(p.states, {}, 'no config.json -> empty states');
  rmSync(home, { recursive: true, force: true });
}

// --- non-zhipu-account rules skipped ----------------------------------------
{
  const home = mkHome();
  const builtinPath = writeBuiltin(home);
  const p = buildAccountConfigParams({ env: {}, home, builtinPath });
  eq(Object.keys(p.providers).sort(),
    ['account:zai-individual-coding-plan', 'account:zai-start-plan'],
    'only zhipu-account rules are pushed');
  rmSync(home, { recursive: true, force: true });
}

// --- revision shape ---------------------------------------------------------
{
  const home = mkHome();
  const builtinPath = writeBuiltin(home);
  const p = buildAccountConfigParams({ env: {}, home, builtinPath });
  ok(p.revision.startsWith('account:'), 'revision starts with account:');
  const expected = `zcode-builtin:12:${createHash('sha256')
    .update(path.resolve(kernelActiveBuiltinPath({ env: {}, home }))).digest('hex')}`;
  eq(p.basedOnZCodeBuiltinRevision, expected, 'basedOn == zcode-builtin:<rev>:<sha256(active path)>');
  const plat = `${process.platform === 'win32' ? 'windows' : process.platform}-${
    process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}`;
  // the kernel layout names the dir endpoint-<sha256(origin).slice(0,32)>; with
  // no env the origin is the public https://zcode.z.ai
  const endpoint = `endpoint-${createHash('sha256').update('https://zcode.z.ai').digest('hex').slice(0, 32)}`;
  ok(kernelActiveBuiltinPath({ env: {}, home }).endsWith(
    path.join('runtime', 'provider', plat,
      '0.0.0-dev', endpoint, 'zcode-builtin.json')),
    `derived active path matches kernel layout (${plat}/0.0.0-dev/endpoint-<hash>)`);
  rmSync(home, { recursive: true, force: true });
}

// --- env fallback path ------------------------------------------------------
{
  const home = mkHome();
  const builtinPath = writeBuiltin(home);
  const p = buildAccountConfigParams({ env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath }, home });
  ok(p !== null && p.basedOnZCodeBuiltinRevision.startsWith('zcode-builtin:12:'),
    'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE resolves builtin');
  rmSync(home, { recursive: true, force: true });
}

// --- pre-set pair passes through (kernel keeps caller env verbatim) ---------
{
  const home = mkHome();
  const builtinPath = writeBuiltin(home);
  const env = {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(home, 'provider_config.json'),
  };
  const p = buildAccountConfigParams({ env, home });
  eq(p.basedOnZCodeBuiltinRevision,
    `zcode-builtin:12:${createHash('sha256').update(path.resolve(builtinPath)).digest('hex')}`,
    'both envs set -> hash the caller-supplied builtin path');
  rmSync(home, { recursive: true, force: true });
}

// --- PERSONAL-only env: kernelEnv injects the bundled builtin, so the -------
// spawned env carries BOTH vars and the kernel passes the pair through.
{
  const home = mkHome();
  const builtinPath = writeBuiltin(home);
  const env = { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(home, 'provider_config.json') };
  eq(kernelActiveBuiltinPath({ env, home, bundledPath: builtinPath }), builtinPath,
    'PERSONAL-only + injectable bundled -> effective builtin is the bundled file');
  const p = buildAccountConfigParams({ env, home, builtinPath });
  eq(p.basedOnZCodeBuiltinRevision,
    `zcode-builtin:12:${createHash('sha256').update(path.resolve(builtinPath)).digest('hex')}`,
    'PERSONAL-only env -> basedOn hashes the injected bundled path, not the managed path');
  rmSync(home, { recursive: true, force: true });
}

// --- managed active file wins over the bundled one ---------------------------
// When the kernel's managed file exists it is what the registry rebuilds from;
// rules+revision must come from it, not the bundled copy.
{
  const home = mkHome();
  const builtinPath = writeBuiltin(home);
  const effective = kernelActiveBuiltinPath({ env: {}, home });
  mkdirSync(path.dirname(effective), { recursive: true });
  writeFileSync(effective, JSON.stringify({
    schemaVersion: 1, revision: 99,
    config: { providerConfigRules: { providerRules: [
      { providerId: 'account:zai-start-plan', providerName: 'ZAI Start',
        config: { access: { type: 'zhipu-account', mode: 'start-plan', accountType: 'zai' },
          builtinModelIds: ['start-model'] } },
    ] } },
  }));
  const p = buildAccountConfigParams({ env: {}, home, builtinPath });
  eq(p.basedOnZCodeBuiltinRevision,
    `zcode-builtin:99:${createHash('sha256').update(path.resolve(effective)).digest('hex')}`,
    'managed active file supplies the revision when present');
  eq(Object.keys(p.providers), ['account:zai-start-plan'],
    'managed active file supplies the pushed rules when present');
  rmSync(home, { recursive: true, force: true });
}

// --- corrupt rules shape -> null, never a throw ------------------------------
{
  const home = mkHome();
  const builtinPath = path.join(home, 'zcode-builtin.json');
  writeFileSync(builtinPath, JSON.stringify({
    config: { providerConfigRules: { providerRules: { length: 3 } } } }));
  ok(buildAccountConfigParams({ env: {}, home, builtinPath }) === null,
    'non-array providerRules -> null, not a TypeError');
  rmSync(home, { recursive: true, force: true });
}

console.log(fails ? `FAIL (${fails})` : 'PASS account-config');
process.exit(fails ? 1 : 0);
