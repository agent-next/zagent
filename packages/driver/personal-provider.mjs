// 3.14.x personal provider config provisioning (kernel symbols NHa/Jkt/Cpe/
// dQi/Ykt in zcode.cjs; byte offsets from the 3.14.4 bundle).
//
// The app-server boots its Provider Registry WITHOUT the standalone options
// (runZCodeProtocolAgent calls Ykt(env) with no `standalone` key — unlike the
// CLI -p runner R2n, which passes `standalone` and with it `importLegacy`).
// The registry therefore reads personal providers ONLY from
// ZCODE_PERSONAL_PROVIDER_CONFIG_FILE (default ~/.zcode/v2/provider_config.json)
// and never imports the legacy CLI config — on a host that has only
// ~/.zcode/cli/config.json, every model-bearing session/create fails with
// "Provider Registry 中不存在 Model: zai/glm-5.3" until that file exists. The
// kernel's own -p path migrates the CLI config into it on first run (Cpe.#f
// persists the importLegacy result via the atomic qL write, mode 0600); the
// app-server path never does.
//
// This mirrors that migration so a fresh host works on the FIRST app-server
// backed run (-p --model, commit-msg, models): convert the CLI config exactly
// like the kernel's NHa/MHa/FHa/LHa, write it only when the target file does
// not exist (a desktop-written or kernel-migrated file always wins), under the
// shared interprocess lock, atomically, mode 0600. Best-effort like
// provisionStandaloneAccounts: never throws, never blocks the launch.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWriteFileSync, withFileLockSync } from './credentials.mjs';

// dQi parity (offset 1068307): preset ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
// passes through; otherwise the personal config lives under the kernel's data
// base dir (ZCODE_DATA_BASE_DIR replaces HOME).
export function personalProviderConfigPath({ env = process.env, home = os.homedir() } = {}) {
  const preset = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim();
  if (preset) return preset;
  const dataBaseDir = env.ZCODE_DATA_BASE_DIR?.trim() || home;
  return path.join(dataBaseDir, '.zcode', 'v2', 'provider_config.json');
}

// U7 parity (offset 4090234; tHr="~/.zcode/cli" at 4092479, zg at 4086419
// expands "~/" via os.homedir()): the kernel's legacy import ALWAYS reads the
// cli config from the real home, even when ZCODE_DATA_BASE_DIR relocates the
// data root. Measured live on 3.14.4 (HOME=A with key K1, ZCODE_DATA_BASE_DIR=B
// with cli config key K2, kernel-native -p): the migration wrote
// B/.zcode/v2/provider_config.json carrying K1 — B's cli config was never
// read, and A kept the cli state. Source and target are therefore rooted
// differently ON PURPOSE; do not "fix" one to match the other.
export function legacyCliConfigPath({ home = os.homedir() } = {}) {
  return path.join(home, '.zcode', 'cli', 'config.json');
}

// MHa parity: legacy `kind` -> personal provider api type.
const API_TYPE = {
  anthropic: 'anthropic-messages',
  openai: 'openai-responses',
  'openai-compatible': 'openai-chat-completions',
};
const apiType = kind => API_TYPE[kind] ?? 'openai-chat-completions';

// aee parity: the two legacy builtin ids that map onto builtin api families.
const LEGACY_BUILTIN_FAMILY = { 'builtin:zai': 'zai-api', 'builtin:bigmodel': 'bigmodel-api' };

// A provider the kernel's importer refuses: no-auth entries have no personal
// representation, and the kernel aborts the WHOLE import on one (Gkt -> Jkt
// returns null -> nothing is written). Mirrored: throw, provisioner abstains.
export class UnsupportedLegacyCliProviderConfigError extends Error {
  constructor(providerId) {
    super(`legacy CLI provider ${providerId} carries a field the formal config cannot express`);
    this.name = 'UnsupportedLegacyCliProviderConfigError';
    this.providerId = providerId;
  }
}

const positiveInt = v => typeof v === 'number' && Number.isInteger(v) && v > 0;

// A credential the provider could actually authenticate with. The kernel's
// family entries require one (NHa trims and skips when empty, ~14109800); a
// custom provider's key is stored VERBATIM by NHa (xz ApiKeyAccessConfig,
// offset 547578: `this.apiKey = t.apiKey`, no trim/validation; toJSON's dAe
// strips only undefined, so "" serializes). zagent keeps the converter at that
// parity but the provisioner refuses to PERSIST a selection whose key is not
// usable: ensureConfig writes apiKey:'' during the OAuth window
// (zagent.mjs — backfilled only once the kernel's provider_config carries the
// key), and a create-if-missing seed of an empty-key file can never be
// repaired — neither the kernel's import (file exists) nor the backfill
// (it reads this very file) rewrites it.
const usableKey = provider => typeof provider?.options?.apiKey === 'string' && provider.options.apiKey.trim() !== '';

// FHa parity: the provider's model members in declared order, skipping
// deleted entries and null/primitive garbage (FHa guards with zod upstream;
// we guard at read), with a positive-integer context window when carried
// (contextWindow wins over limit.context).
function modelMembers(provider) {
  const seen = new Set();
  const out = [];
  for (const [key, m] of Object.entries(provider?.models ?? {})) {
    if (m?.deleted === true || !m || typeof m !== 'object') continue;
    const id = (typeof m.id === 'string' ? m.id : key).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const cw = positiveInt(m.contextWindow) ? m.contextWindow
      : positiveInt(m.limit?.context) ? m.limit.context : undefined;
    out.push(cw === undefined ? { modelId: id } : { modelId: id, contextWindow: cw });
  }
  return out;
}

/**
 * Convert a parsed ~/.zcode/cli/config.json into the personal provider rules
 * the kernel's registry reads (NHa parity). Returns null when there is nothing
 * importable (kernel Jkt parity: missing/unparseable input imports nothing);
 * throws UnsupportedLegacyCliProviderConfigError on a no-auth provider.
 * @returns {{providers:Array, models:Array, defaultModelSelection:{providerId,modelId}|null}|null}
 */
export function importLegacyCliConfig(cli) {
  if (!cli || typeof cli !== 'object' || Array.isArray(cli)) return null;
  const providers = [], models = [];
  for (const [rawId, p] of Object.entries(cli.provider ?? {})) {
    const id = rawId.trim();
    if (!id) continue;
    const family = LEGACY_BUILTIN_FAMILY[id];
    if (family) {
      // NHa: builtin:zai/builtin:bigmodel become api-key rules on the builtin
      // family — and only when they carry a key.
      const key = p?.options?.apiKey?.trim();
      if (key) providers.push({ providerId: family, templateId: family,
        config: { group: 'standard-personal', access: { apiKey: key } } });
      continue;
    }
    if (id.startsWith('builtin:') || id.startsWith('account:') || p?.source !== undefined && p?.source !== 'custom') continue;
    if (p?.options?.apiKeyRequired === false) throw new UnsupportedLegacyCliProviderConfigError(id);
    const members = modelMembers(p);
    const ids = members.map(m => m.modelId);
    const name = p?.name?.trim();
    const headers = { ...p?.headers, ...p?.options?.headers };
    // NHa stores a custom provider's apiKey verbatim ("" and whitespace
    // included — see usableKey); the safety net is the provisioner's
    // selected-provider gate, not a divergence here.
    providers.push({
      providerId: id,
      ...(name && name !== id ? { providerName: name } : {}),
      config: {
        group: 'standard-personal',
        access: { type: 'api-key', ...(p?.options?.apiKey !== undefined ? { apiKey: p.options.apiKey } : {}) },
        api: {
          type: apiType(p?.kind),
          ...(p?.options?.baseURL !== undefined ? { baseUrl: p.options.baseURL } : {}),
          ...(Object.keys(headers).length ? { headers } : {}),
        },
        ...(ids.length ? { personalModelIds: ids, modelOrder: ids } : {}),
      },
    });
    for (const m of members)
      if (m.contextWindow !== undefined)
        models.push({ modelId: m.modelId, config: { properties: { contextWindow: m.contextWindow } }, providerId: id });
  }
  if (!providers.length) return null;
  // LHa parity: model.main is the configured default; the kernel's own
  // builtin-default provider id (OHa) is not imported.
  const main = typeof cli.model?.main === 'string' && /^[^/]+\/.+$/.test(cli.model.main)
    ? cli.model.main : null;
  const defaultModelSelection = main && main.split('/')[0] !== 'builtin:zapi'
    ? { providerId: main.split('/')[0], modelId: main.slice(main.indexOf('/') + 1) } : null;
  return { providers, models, defaultModelSelection };
}

/** The on-disk document shape (schemaVersion 1, strict M3i schema). */
export function personalProviderConfigDocument({ providers, models, defaultModelSelection }) {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: providers },
      modelConfigRules: { providerModelRules: models, manualProviderModelRules: [] },
      ...(defaultModelSelection ? { defaultModelSelection } : {}),
    },
  };
}

/**
 * Best-effort provisioning of the personal provider config from the legacy
 * CLI config. Never throws. An existing target file is authoritative (the
 * desktop or a prior kernel run owns it — provisioning must never overwrite).
 * @returns {{provisioned:boolean, path:string, reason:string|null}}
 */
export function provisionPersonalProviderConfig({
  env = process.env, home = os.homedir(),
  read = p => readFileSync(p, 'utf8'), exists = existsSync,
  write = atomicWriteFileSync, lock = withFileLockSync, lockOptions = {},
} = {}) {
  const result = { provisioned: false, path: personalProviderConfigPath({ env, home }), reason: null };
  if (exists(result.path)) { result.reason = 'personal provider config already present'; return result; }
  // U7 parity: the legacy source is always the real home's cli config — even
  // when ZCODE_DATA_BASE_DIR relocates the target (see legacyCliConfigPath).
  let cli;
  try { cli = JSON.parse(read(legacyCliConfigPath({ home }))); }
  catch { result.reason = 'no readable cli config to migrate'; return result; }
  let imported;
  try { imported = importLegacyCliConfig(cli); }
  catch (e) {
    result.reason = e?.name === 'UnsupportedLegacyCliProviderConfigError'
      ? `cli provider '${e.providerId}' cannot be expressed in the personal config` : `legacy import failed: ${e?.message ?? e}`;
    return result;
  }
  if (!imported) { result.reason = 'cli config has no importable providers'; return result; }
  // Never seed a permanent unusable selection: the file is create-if-missing,
  // so an empty-key write could never be repaired afterwards (neither the
  // kernel's import — the file exists — nor the OAuth backfill — it reads this
  // very file). An OAuth-window config (apiKey:'') must abstain, not brick.
  const selected = imported.defaultModelSelection?.providerId;
  if (selected !== undefined && cli.provider?.[selected] !== undefined && !usableKey(cli.provider[selected])) {
    result.reason = `selected provider '${selected}' has no usable API key — refusing to seed an empty-key personal config`;
    return result;
  }
  try {
    return lock(result.path, () => {
      // Re-check under the lock: a concurrent kernel/GUI writer wins silently.
      if (exists(result.path)) { result.reason = 'personal provider config already present'; return result; }
      write(result.path, JSON.stringify(personalProviderConfigDocument(imported), null, 2));
      result.provisioned = true;
      return result;
    }, lockOptions);
  } catch (e) {
    result.reason = e?.code === 'ELOCKTIMEOUT'
      ? `personal provider config lock unavailable: ${e.message}`
      : `personal provider config provisioning failed: ${e?.message ?? e}`;
    return result;
  }
}

/**
 * Read-only resolution check for doctor: can the app-server registry resolve
 * the cli config's model.main? The effective personal source is an existing
 * provider_config.json (file wins) or what provisioning would derive from the
 * cli config. Provider ids whose resolution depends on builtin entitlements
 * or the runtime's bundled catalog cannot be judged statically -> null.
 * @returns {{ok:boolean, source:string, detail:string}|null}
 */
export function modelResolutionCheck({ env = process.env, home = os.homedir(),
  config = null, read = p => readFileSync(p, 'utf8'), exists = existsSync } = {}) {
  const main = typeof config?.model?.main === 'string' && /^[^/]+\/.+$/.test(config.model.main)
    ? config.model.main : null;
  if (!main) return null;
  const providerId = main.split('/')[0], modelId = main.slice(main.indexOf('/') + 1);
  if (providerId.startsWith('builtin:') || providerId.startsWith('account:')) return null;
  const file = personalProviderConfigPath({ env, home });
  let rules = null, source;
  if (exists(file)) {
    source = 'personal provider config';
    let parsed;
    try { parsed = JSON.parse(read(file)); }
    catch { return { ok: false, source, detail: 'the personal provider config is unreadable' }; }
    // The kernel's strict parser (yAe) rejects a structurally wrong file and
    // the registry falls back to no personal providers — so a wrong shape is
    // a NOT-RESOLVABLE verdict, never a crash in doctor.
    const providerRules = parsed?.config?.providerConfigRules?.providerRules;
    if (!Array.isArray(providerRules))
      return { ok: false, source, detail: 'the personal provider config is malformed (providerRules)' };
    for (const r of providerRules)
      if (r?.config !== undefined && (typeof r.config !== 'object' || Array.isArray(r.config)))
        return { ok: false, source, detail: 'the personal provider config is malformed (provider rule)' };
      else if (r?.config?.personalModelIds !== undefined && !Array.isArray(r.config.personalModelIds))
        return { ok: false, source, detail: 'the personal provider config is malformed (personalModelIds)' };
    rules = { providers: providerRules };
  } else {
    source = 'cli config (provisioned on first -p run)';
    let imported = null;
    try { imported = importLegacyCliConfig(config); }
    catch (e) {
      return { ok: false, source, detail: e?.name === 'UnsupportedLegacyCliProviderConfigError'
        ? `provider '${e.providerId}' is not expressible in the personal config`
        : `the cli config is malformed (${e?.message ?? e})` };
    }
    if (imported) rules = imported;
  }
  if (!rules) return { ok: false, source, detail: `provider '${providerId}' is not configured` };
  const rule = rules.providers.find(p => p?.providerId === providerId);
  if (!rule) return { ok: false, source, detail: `provider '${providerId}' is not configured` };
  const ids = Array.isArray(rule.config?.personalModelIds) ? rule.config.personalModelIds : [];
  if (!ids.includes(modelId))
    return { ok: false, source, detail: `model ${providerId}/${modelId} is not in the provider's model list` };
  return { ok: true, source, detail: `${providerId}/${modelId}` };
}
