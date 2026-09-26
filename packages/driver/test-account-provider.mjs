// account-provider standalone provisioning — kernel VUt contract:
// entitled(provider) <=> credentials[account-provider:<pid>:identity] = id AND
// credentials[account-provider:coding-plan:<pid>:account:<uri(id)>:api-key] = key
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { provisionStandaloneAccounts, accountIdentityKey, accountApiKeyKey, accountIdentity }
  from './account-provider.mjs';
import { decryptCredential, encryptCredential, atomicWriteFileSync, acquireFileLockSync } from './credentials.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const KEY = 'test-zai-key.abcdef';
const RULES = {
  schemaVersion: 1, revision: 25,
  config: { providerConfigRules: { providerRules: [
    { providerId: 'account:zai-individual-coding-plan',
      config: { builtinModelIds: ['GLM-5.3'],
        access: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai' } } },
    { providerId: 'account:zai-start-plan',
      config: { builtinModelIds: ['GLM-5.3-Flash'],
        access: { type: 'zhipu-account', mode: 'start-plan', accountType: 'zai' } } },
    { providerId: 'account:bigmodel-individual-coding-plan',
      config: { builtinModelIds: ['GLM-5.3'],
        access: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'bigmodel' } } },
    { providerId: 'builtin:plain-template',
      config: { builtinModelIds: ['X'], access: { type: 'api-key' } } },
  ] } },
};

function seed({ providers = {}, store = {} } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'zagent-acct-'));
  const v2 = path.join(home, '.zcode', 'v2');
  mkdirSync(v2, { recursive: true });
  const builtin = path.join(v2, 'zcode-builtin.json');
  writeFileSync(builtin, JSON.stringify(RULES));
  writeFileSync(path.join(v2, 'config.json'), JSON.stringify({ provider: providers }));
  writeFileSync(path.join(v2, 'credentials.json'), JSON.stringify(store));
  const env = { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin };
  const save = s => { const f = path.join(v2, 'credentials.json');
    writeFileSync(f, JSON.stringify(s), { mode: 0o600 }); chmodSync(f, 0o600); };
  const load = () => JSON.parse(readFileSync(path.join(v2, 'credentials.json'), 'utf8'));
  return { home, env, save, load, v2 };
}

// The kernel's standalone resolver (VUt/w2n), replicated: an account provider
// is entitled when its identity record and the derived api-key record exist.
function kernelEntitled(store, providerId) {
  const id = decryptCredential(store[accountIdentityKey(providerId)] ?? '', {});
  if (!id.trim()) return false;
  const key = store[accountApiKeyKey(providerId, id)];
  return !!(key && decryptCredential(key, {}).trim());
}

const ENABLED = { 'builtin:zai-coding-plan': { enabled: true, options: { apiKey: `  ${KEY}  ` } } };

// --- happy path: coding-plan key provisions individual + team, nothing else ---
{
  const t = seed({ providers: ENABLED });
  const r = provisionStandaloneAccounts({ env: t.env, home: t.home, save: t.save });
  ok(r.provisioned.includes('account:zai-individual-coding-plan'), 'provisions the individual coding plan');
  ok(!r.provisioned.includes('account:zai-start-plan'), 'start-plan not provisioned without its key');
  ok(!r.provisioned.includes('account:bigmodel-individual-coding-plan'), 'bigmodel skipped (no key)');
  const store = t.load();
  const pid = 'account:zai-individual-coding-plan';
  const id = decryptCredential(store[accountIdentityKey(pid)], {});
  ok(id === accountIdentity(KEY), 'identity is the kernel key-sha256 form');
  ok(store[accountApiKeyKey(pid, id)] !== undefined, 'api-key record under uri(identity) key');
  ok(decryptCredential(store[accountApiKeyKey(pid, id)], {}) === KEY, 'api-key record decrypts to the trimmed key');
  ok(kernelEntitled(store, pid), 'kernel resolver would mark the provider entitled');
  ok(!kernelEntitled(store, 'account:zai-start-plan'), 'unprovisioned rule stays unentitled');
  // win32 reports synthetic modes; 0600 is a POSIX-only contract
  ok(process.platform === 'win32' || (statSync(path.join(t.v2, 'credentials.json')).mode & 0o777) === 0o600, 'store stays owner-only');
  rmSync(t.home, { recursive: true, force: true });
}

// --- idempotent: a provisioned identity is never clobbered ---
{
  const pid = 'account:zai-individual-coding-plan';
  const t = seed({ providers: ENABLED, store: { [accountIdentityKey(pid)]: 'enc-placeholder' } });
  const r = provisionStandaloneAccounts({ env: t.env, home: t.home, save: t.save });
  ok(r.provisioned.length === 0, 'existing identity is left alone');
  ok(t.load()[accountIdentityKey(pid)] === 'enc-placeholder', 'existing record not overwritten');
  rmSync(t.home, { recursive: true, force: true });
}

// --- start-plan key provisions only the start-plan rule ---
{
  const t = seed({ providers: { 'builtin:zai-start-plan': { enabled: true, options: { apiKey: KEY } } } });
  const r = provisionStandaloneAccounts({ env: t.env, home: t.home, save: t.save });
  ok(r.provisioned.join() === 'account:zai-start-plan', 'start-plan key provisions only start-plan');
  // the kernel standalone resolver (Ppe) uses the coding-plan segment for every
  // mode — assert the record actually entitles, not just that it was written
  ok(kernelEntitled(t.load(), 'account:zai-start-plan'), 'start-plan record entitles under the kernel key shape');
  rmSync(t.home, { recursive: true, force: true });
}

// --- torn store: identity without its api-key record is repaired, not skipped ---
{
  const pid = 'account:zai-individual-coding-plan';
  const t = seed({ providers: ENABLED,
    store: { [accountIdentityKey(pid)]: encryptCredential(accountIdentity(KEY), { env: {} }) } });
  const r = provisionStandaloneAccounts({ env: t.env, home: t.home, save: t.save });
  ok(r.provisioned.join().includes('api-key record repaired'), 'a torn identity record is repaired');
  ok(kernelEntitled(t.load(), pid), 'repaired records entitle the provider');
  // a foreign identity (different key) is never re-associated
  const t2 = seed({ providers: ENABLED,
    store: { [accountIdentityKey(pid)]: encryptCredential('key-aaaaaaaaaaaaaaaaaaaaaaaa', { env: {} }) } });
  const r2 = provisionStandaloneAccounts({ env: t2.env, home: t2.home, save: t2.save });
  ok(!r2.provisioned.length && r2.skipped.join().includes('already provisioned'),
    'a foreign identity is left alone');
  ok(t2.load()[accountApiKeyKey(pid, 'key-aaaaaaaaaaaaaaaaaaaaaaaa')] === undefined,
    'no api-key record written under a foreign identity');
  rmSync(t.home, { recursive: true, force: true });
  rmSync(t2.home, { recursive: true, force: true });
}

// --- disabled / key-less providers provision nothing ---
{
  const t = seed({ providers: {
    'builtin:zai-coding-plan': { enabled: true, systemDisabledReason: 'off', options: { apiKey: KEY } },
    'builtin:zai-start-plan': { enabled: true, options: {} },
  } });
  const r = provisionStandaloneAccounts({ env: t.env, home: t.home, save: t.save });
  ok(r.provisioned.length === 0, 'disabled and key-less entries provision nothing');
  rmSync(t.home, { recursive: true, force: true });
}

// --- no builtin config path / no keys: clean no-op with a reason ---
{
  const t = seed();
  ok(provisionStandaloneAccounts({ env: {}, home: t.home, save: t.save }).reason !== null,
    'missing builtin path is a reasoned no-op');
  ok(provisionStandaloneAccounts({ env: t.env, home: t.home, save: t.save }).reason === 'no configured provider keys',
    'empty provider config is a reasoned no-op');
  rmSync(t.home, { recursive: true, force: true });
}

// --- crash mid-write leaves the old store intact (Jb atomicity) ---
{
  const t = seed({ providers: ENABLED });
  const f = path.join(t.v2, 'credentials.json');
  const before = readFileSync(f, 'utf8');
  try {
    atomicWriteFileSync(f, '{"replaced":true}', {
      io: {
        mkdir: mkdirSync,
        writeFile: (p, d, o) => { writeFileSync(p, d, o); throw Object.assign(new Error('simulated crash'), { code: 'EIO' }); },
        rename: renameSync,
        rm: rmSync,
      },
    });
    ok(false, 'atomic write propagates the injected failure');
  } catch (e) { ok(e?.code === 'EIO', 'atomic write propagates the write-stage failure'); }
  ok(readFileSync(f, 'utf8') === before, 'a write-stage crash never touches the committed store');
  ok(!readdirSync(t.v2).some(n => n.endsWith('.tmp')), 'the sibling tmp is cleaned up on failure');
  try {
    atomicWriteFileSync(f, '{"replaced":true}', {
      io: {
        mkdir: mkdirSync, writeFile: writeFileSync, rm: rmSync,
        rename: () => { throw Object.assign(new Error('simulated kill before rename'), { code: 'EIO' }); },
      },
    });
    ok(false, 'atomic write propagates the rename failure');
  } catch (e) { ok(e?.code === 'EIO', 'atomic write propagates the rename-stage failure'); }
  ok(readFileSync(f, 'utf8') === before, 'a rename-stage crash never touches the committed store');
  ok(!readdirSync(t.v2).some(n => n.endsWith('.tmp')), 'tmp cleaned up after rename failure too');
  // a persistent retryable rename error must exhaust the bounded ladder, not spin
  let renames = 0;
  try {
    atomicWriteFileSync(f, '{"replaced":true}', {
      retryDelaysMs: [1, 1, 1],
      io: {
        mkdir: mkdirSync, writeFile: writeFileSync, rm: rmSync,
        rename: () => { renames++; throw Object.assign(new Error('AV lock'), { code: 'EPERM' }); },
      },
    });
    ok(false, 'a persistent retryable rename error still throws');
  } catch (e) { ok(e?.code === 'EPERM' && renames === 4, `the rename ladder is bounded (renames=${renames})`); }
  ok(readFileSync(f, 'utf8') === before, 'exhausted rename retries still leave the committed store');
  atomicWriteFileSync(f, '{"replaced":true}');
  ok(readFileSync(f, 'utf8') === '{"replaced":true}', 'atomic write commits via rename');
  ok(process.platform === 'win32' || (statSync(f).mode & 0o777) === 0o600, 'committed store is owner-only');
  rmSync(t.home, { recursive: true, force: true });
}

// --- corrupt store: abort with a .corrupt backup, never wipe (zKe parity) ---
{
  const t = seed({ providers: ENABLED });
  const f = path.join(t.v2, 'credentials.json');
  writeFileSync(f, '{corrupt not json');
  const r = provisionStandaloneAccounts({ env: t.env, home: t.home, save: t.save });
  ok(r.provisioned.length === 0, 'a corrupt store provisions nothing');
  ok(/unreadable/.test(r.reason ?? ''), `corrupt store aborts with a clear reason (${r.reason})`);
  ok(readFileSync(f, 'utf8') === '{corrupt not json', 'a corrupt store is never overwritten');
  const baks = readdirSync(t.v2).filter(n => n.startsWith('credentials.json.corrupt-') && n.endsWith('.bak'));
  ok(baks.length === 1, 'the corrupt store is backed up aside');
  ok(baks.length === 1 && readFileSync(path.join(t.v2, baks[0]), 'utf8') === '{corrupt not json',
    'the backup holds the original bytes');
  rmSync(t.home, { recursive: true, force: true });
}

// --- held lock: provisioning aborts rather than write around the lock ---
{
  const t = seed({ providers: ENABLED });
  const f = path.join(t.v2, 'credentials.json');
  const before = readFileSync(f, 'utf8');
  const release = acquireFileLockSync(f);
  try {
    const r = provisionStandaloneAccounts({
      env: t.env, home: t.home, save: t.save,
      lockOptions: { maxWaitMs: 200, retryDelaysMs: [10] },
    });
    ok(r.provisioned.length === 0 && /lock unavailable/.test(r.reason ?? ''),
      'a held lock aborts provisioning with a reason');
    ok(readFileSync(f, 'utf8') === before, 'an aborted provision never touches the store');
  } finally { release(); }
  const r2 = provisionStandaloneAccounts({ env: t.env, home: t.home, save: t.save });
  ok(r2.provisioned.includes('account:zai-individual-coding-plan'), 'provisioning proceeds once the lock frees');
  rmSync(t.home, { recursive: true, force: true });
}

// --- concurrent writer: serialized read-modify-write drops no records ---
// A foreign process takes the same <file>.lock, signals a ready marker, writes
// a record, releases; our provision must actually WAIT on the held lock, then
// read inside it and merge on top of that commit — a no-op lock fails the
// elapsed floor.
{
  const t = seed({ providers: ENABLED });
  const f = path.join(t.v2, 'credentials.json');
  const ready = path.join(t.v2, 'child-lock-ready');
  const modUrl = pathToFileURL(path.join(import.meta.dirname, 'credentials.mjs')).href;
  const childSrc =
    `import { withFileLockSync, atomicWriteFileSync } from ${JSON.stringify(modUrl)};\n` +
    `import { readFileSync, writeFileSync } from 'node:fs';\n` +
    `const [f, ready] = [process.argv[1], process.argv[2]];\n` +
    `withFileLockSync(f, () => {\n` +
    `  writeFileSync(ready, '1');\n` +
    `  const s = JSON.parse(readFileSync(f, 'utf8'));\n` +
    `  s['foreign:record'] = 'kept';\n` +
    `  atomicWriteFileSync(f, JSON.stringify(s));\n` +
    `  const end = Date.now() + 900; while (Date.now() < end) {}\n` +
    `});\n`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSrc, f, ready], { stdio: ['ignore', 'ignore', 'pipe'] });
  let childErr = '';
  child.stderr.on('data', d => { childErr += d; });
  const exited = new Promise(res => child.once('exit', (code, signal) => res({ code, signal })));
  const waitDeadline = Date.now() + 5000;
  while (!existsSync(ready) && Date.now() < waitDeadline)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  ok(existsSync(ready), 'the foreign writer actually took the lock');
  const t0 = Date.now();
  const r = provisionStandaloneAccounts({ env: t.env, home: t.home, save: t.save });
  const waitedMs = Date.now() - t0;
  const { code, signal } = await Promise.race([
    exited,
    new Promise(res => setTimeout(() => res({ code: null, signal: 'TIMEOUT' }), 5000)),
  ]);
  if (code === null) child.kill('SIGKILL');
  ok(code === 0, `the foreign writer exits clean (code=${code} signal=${signal}) ${childErr.trim()}`);
  ok(waitedMs >= 300, `provisioning blocked on the held lock (${waitedMs}ms), not written around it`);
  const store = t.load();
  ok(store['foreign:record'] === 'kept', 'a foreign committed write is not dropped');
  ok(r.provisioned.includes('account:zai-individual-coding-plan'), 'provisioning still lands after contention');
  ok(store[accountIdentityKey('account:zai-individual-coding-plan')] !== undefined,
    'provisioned records coexist with the foreign record');
  rmSync(t.home, { recursive: true, force: true });
}


// --- fallback: no v2/config.json, key only in the cli config (3.14 host) ----
// Verified live 2026-09-23: kernels >=3.12 may never write v2/config.json; the
// plan key exists only as the personal provider in ~/.zcode/cli/config.json.
// The provisioner must map it to builtin:<family>-coding-plan and provision.
{
  const home = mkdtempSync(path.join(tmpdir(), 'zagent-acct-'));
  const v2 = path.join(home, '.zcode', 'v2');
  const cli = path.join(home, '.zcode', 'cli');
  mkdirSync(v2, { recursive: true }); mkdirSync(cli, { recursive: true });
  const builtin = path.join(v2, 'zcode-builtin.json');
  const RULES_TEAM = { ...RULES, config: { ...RULES.config, providerConfigRules: { providerRules: [
    ...RULES.config.providerConfigRules.providerRules,
    { providerId: 'account:zai-team-coding-plan',
      config: { builtinModelIds: ['GLM-5.3'],
        access: { type: 'zhipu-account', mode: 'team-coding-plan', accountType: 'zai' } } },
  ] } } };
  writeFileSync(builtin, JSON.stringify(RULES_TEAM));
  // NO v2/config.json — the 3.14-host shape
  writeFileSync(path.join(cli, 'config.json'), JSON.stringify({ provider: { zai: { options: { apiKey: KEY } } } }));
  writeFileSync(path.join(v2, 'credentials.json'), JSON.stringify({}));
  const r = provisionStandaloneAccounts({
    env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin },
    home,
    save: s => writeFileSync(path.join(v2, 'credentials.json'), JSON.stringify(s)),
    lock: (_f, fn) => fn(),
  });
  const store = JSON.parse(readFileSync(path.join(v2, 'credentials.json'), 'utf8'));
  ok(r.provisioned.includes('account:zai-individual-coding-plan'), 'cli-key fallback provisions zai individual');
  ok(r.provisioned.includes('account:zai-team-coding-plan'), 'cli-key fallback provisions zai team (shared plan key)');
  ok(kernelEntitled(store, 'account:zai-individual-coding-plan'), 'kernel resolver entitles individual after fallback');
  ok(!kernelEntitled(store, 'account:zai-start-plan'), 'start-plan NOT entitled by the coding-plan fallback');
  ok(!kernelEntitled(store, 'account:bigmodel-individual-coding-plan'), 'bigmodel untouched by a zai-only cli key');
  rmSync(home, { recursive: true, force: true });
}

process.exit(fails ? 1 : 0);
