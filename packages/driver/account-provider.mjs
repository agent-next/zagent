// 3.12.1 standalone account provisioning (kernel symbols HUt/VUt/Ppe/l6/qUt).
//
// The kernel TUI resolves its provider registry in STANDALONE mode: it derives
// entitled accounts purely from `account-provider:*` records in
// ~/.zcode/v2/credentials.json (the app-server is host-pushed via
// provider/updateAccountConfig instead — a separate gap). A 3.11.2-era store
// has no such records, so the TUI booted to "No model access configured" even
// with a working plan key configured. This mirrors the kernel's own
// provisioner: for every builtin account rule whose configured sibling carries
// an API key, write the two records the standalone resolver reads:
//   account-provider:<providerId>:identity                                  -> identity
//   account-provider:coding-plan:<providerId>:account:<uri(identity)>:api-key -> apiKey
// where identity = `key-${sha256(apiKey.trim()).hex.slice(0,24)}` (the
// kernel's API-key identity form, qUt). Existing identity records are never
// overwritten — a GUI/OAuth-provisioned identity wins over a derived one.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encryptCredential, decryptCredential, saveCredentialStore, withFileLockSync, backupCorruptFileSync } from './credentials.mjs';

export const accountIdentityKey = providerId => `account-provider:${providerId}:identity`;
export const accountApiKeyKey = (providerId, identity) =>
  `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`;
export const accountIdentity = apiKey =>
  `key-${createHash('sha256').update(apiKey.trim()).digest('hex').slice(0, 24)}`;

// Which configured `builtin:<family>-*` provider key can stand in for an
// account rule of that mode. team-coding-plan shares the coding-plan key: the
// GUI carries one plan key for both account types and the server decides which
// the account actually is; the apiKey is what authenticates either way.
const CODING_MODES = new Set(['individual-coding-plan', 'team-coding-plan']);
export function configuredKeyFor(configured, family, mode) {
  if (CODING_MODES.has(mode)) return configured[`builtin:${family}-coding-plan`];
  if (mode === 'start-plan') return configured[`builtin:${family}-start-plan`];
  return null; // off-peak and unknown modes have no configured-key counterpart
}

// config.json provider map -> {id: apiKey} for providers that can authenticate:
// enabled, not system-disabled, with a non-empty options.apiKey. Shared by the
// credential provisioner and the app-server account-config push.
export function configuredAccountKeys(providerMap) {
  const configured = {};
  for (const [id, p] of Object.entries(providerMap ?? {})) {
    const key = p?.options?.apiKey;
    if (p?.enabled !== false && !p?.systemDisabledReason && typeof key === 'string' && key.trim())
      configured[id] = key.trim();
  }
  return configured;
}

/**
 * Best-effort provisioning. Never throws — callers invoke it on the TUI launch
 * path where a failure must not break the spawn.
 * @returns {{provisioned: string[], skipped: string[], reason: string|null}}
 */
export function provisionStandaloneAccounts({
  env = process.env, home = os.homedir(),
  read = p => readFileSync(p, 'utf8'),
  save = s => saveCredentialStore(s, path.join(home, '.zcode', 'v2', 'credentials.json')),
  lock = withFileLockSync,
  lockOptions = {},
} = {}) {
  const result = { provisioned: [], skipped: [], reason: null };
  let rules;
  try {
    const builtinPath = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    if (!builtinPath) { result.reason = 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE unset'; return result; }
    rules = JSON.parse(read(builtinPath))?.config?.providerConfigRules?.providerRules ?? [];
  } catch { result.reason = 'builtin provider config unreadable'; return result; }

  let configured = {};
  try {
    const providers = JSON.parse(read(path.join(home, '.zcode', 'v2', 'config.json')))?.provider;
    configured = configuredAccountKeys(providers);
  } catch { /* a missing config.json just means nothing is configured */ }
  if (!Object.keys(configured).length) { result.reason = 'no configured provider keys'; return result; }

  // Kernel parity (fu/FE): the whole read-modify-write runs under the shared
  // interprocess lock so a concurrent GUI/kernel writer cannot be clobbered,
  // and a non-ENOENT read failure (corruption, EACCES, partial write) aborts —
  // the kernel treats a corrupt store as fatal (zKe backup), never as empty.
  const credFile = path.join(home, '.zcode', 'v2', 'credentials.json');
  try {
    return lock(credFile, () => {
      let store;
      try {
        const parsed = JSON.parse(read(credFile));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new SyntaxError('credentials store is not a JSON object');
        store = parsed;
      } catch (e) {
        if (e?.code === 'ENOENT') store = {};
        else {
          let bak = null;
          try { bak = backupCorruptFileSync(credFile); } catch {}
          result.reason = `credentials store unreadable (${e?.code ?? e?.name}); aborted${bak ? `, backed up to ${bak}` : ''}`;
          return result;
        }
      }
      let dirty = false;
      for (const rule of rules) {
        const pid = rule?.providerId, access = rule?.config?.access ?? {};
        if (typeof pid !== 'string' || access.type !== 'zhipu-account') continue;
        const apiKey = configuredKeyFor(configured, access.accountType, access.mode);
        if (!apiKey) { result.skipped.push(pid); continue; }
        const idKey = accountIdentityKey(pid);
        if (typeof store[idKey] === 'string' && store[idKey].trim()) {
          // The resolver needs the api-key record paired with the identity.
          // A torn/foreign store can hold only the identity — repair it when
          // it decrypts to exactly the identity this key derives; never
          // re-associate an identity that belongs to a different credential.
          let repaired = false;
          try {
            const existing = decryptCredential(store[idKey], { env });
            const apiKeyKey = accountApiKeyKey(pid, existing);
            if (existing === accountIdentity(apiKey) && !store[apiKeyKey]) {
              store[apiKeyKey] = encryptCredential(apiKey, { env });
              dirty = true;
              repaired = true;
              result.provisioned.push(`${pid} (api-key record repaired)`);
            }
          } catch { /* undecryptable identity record: leave the store alone */ }
          if (!repaired) result.skipped.push(`${pid} (already provisioned)`);
          continue;
        }
        const identity = accountIdentity(apiKey);
        store[idKey] = encryptCredential(identity, { env });
        store[accountApiKeyKey(pid, identity)] = encryptCredential(apiKey, { env });
        dirty = true;
        result.provisioned.push(pid);
      }
      if (dirty) save(store);
      if (!result.provisioned.length && !result.skipped.length) result.reason = 'no account rules';
      return result;
    }, lockOptions);
  } catch (e) {
    result.reason = e?.code === 'ELOCKTIMEOUT'
      ? `credentials store lock unavailable: ${e.message}`
      : `credentials provisioning failed: ${e?.message ?? e}`;
    return result;
  }
}
