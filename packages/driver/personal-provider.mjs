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

// Wrong-typed fields degrade to absent instead of throwing: hand-edited
// configs carry garbage ("name": {}, "apiKey": 5) and one bad provider must
// not cost the others their migration. The kernel is strict here — its zod
// layer (QAn -> RHa: name m.string(), options.apiKey m.string()) rejects the
// whole config — but it also has a desktop to repair the file; zagent's
// create-if-missing seed has no such repair path, so leniency is the safer
// failure mode for the converter.
const strField = v => (typeof v === 'string' ? v : undefined);
const strRecord = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

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
      // family — and only when they carry a (string) key. A wrong-typed key
      // degrades to "no key" for this entry alone; the kernel's zod layer
      // (QAn -> RHa, options.apiKey m.string().optional()) instead rejects
      // the WHOLE config on a type violation — zagent's converter has no
      // schema layer, so one garbage provider must not cost the others.
      const key = strField(p?.options?.apiKey)?.trim();
      if (key) providers.push({ providerId: family, templateId: family,
        config: { group: 'standard-personal', access: { apiKey: key } } });
      continue;
    }
    if (id.startsWith('builtin:') || id.startsWith('account:') || p?.source !== undefined && p?.source !== 'custom') continue;
    if (p?.options?.apiKeyRequired === false) throw new UnsupportedLegacyCliProviderConfigError(id);
    const members = modelMembers(p);
    const ids = members.map(m => m.modelId);
    const name = strField(p?.name)?.trim();
    const headers = { ...strRecord(p?.headers), ...strRecord(p?.options?.headers) };
    const apiKey = strField(p?.options?.apiKey);
    const baseURL = strField(p?.options?.baseURL);
    // NHa stores a custom provider's apiKey verbatim ("" and whitespace
    // included — see usableKey); the safety net is the provisioner's
    // selected-provider gate, not a divergence here. Wrong-typed values
    // degrade to absent (per-entry, kernel-zod-strict but converter-lenient).
    providers.push({
      providerId: id,
      ...(name && name !== id ? { providerName: name } : {}),
      config: {
        group: 'standard-personal',
        access: { type: 'api-key', ...(apiKey !== undefined ? { apiKey } : {}) },
        api: {
          type: apiType(p?.kind),
          ...(baseURL !== undefined ? { baseUrl: baseURL } : {}),
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

// The selection a cli config asks for (model.main), or null when it names
// none. Selections under builtin:/account: ids resolve through builtin
// entitlements the personal config knows nothing about -> not judgeable.
function selectedModel(cli) {
  const main = typeof cli?.model?.main === 'string' && /^[^/]+\/.+$/.test(cli.model.main)
    ? cli.model.main : null;
  if (!main) return null;
  const providerId = main.split('/')[0];
  if (providerId.startsWith('builtin:') || providerId.startsWith('account:')) return null;
  return { providerId, modelId: main.slice(main.indexOf('/') + 1) };
}

// Judge a selection against personal provider rules: the provider must be
// configured and carry the model in personalModelIds. A family rule
// (templateId set) resolves through the builtin template's model list, which
// the document does not carry — it counts as resolvable.
function selectionVerdict(rules, { providerId, modelId }) {
  const rule = rules.find(p => p?.providerId === providerId);
  if (!rule) return { ok: false, detail: `provider '${providerId}' is not configured` };
  if (rule.templateId) return { ok: true, detail: `${providerId}/${modelId}` };
  const ids = Array.isArray(rule.config?.personalModelIds) ? rule.config.personalModelIds : [];
  if (!ids.includes(modelId))
    return { ok: false, detail: `model ${providerId}/${modelId} is not in the provider's model list` };
  return { ok: true, detail: `${providerId}/${modelId}` };
}

const DERIVED_SOURCE = 'cli config (provisioned on first -p run)';
const FILE_SOURCE = 'personal provider config';

/**
 * THE predicate both provisioning and doctor use — one answer to "would the
 * -p path make this host's selection resolvable, and what would it write".
 * Doctor can therefore never report ok for a state the provisioning refuses
 * to seed. Refusals (write:false) always pair `reason` (the provisioning
 * wording) with the matching `resolves` verdict (the doctor wording) when a
 * selection is judgeable at all.
 * @returns {{write:boolean, doc:Object|null, reason:string|null,
 *            source:string, resolves:{ok:boolean, detail:string}|null}}
 */
export function planPersonalProviderConfig({
  env = process.env, home = os.homedir(),
  read = p => readFileSync(p, 'utf8'), exists = existsSync, config = null,
} = {}) {
  const path = personalProviderConfigPath({ env, home });
  // U7 parity: the legacy source is always the real home's cli config — even
  // when ZCODE_DATA_BASE_DIR relocates the target (see legacyCliConfigPath).
  // Doctor hands in the config it already parsed; everyone else reads it.
  let cli = config;
  let cliUnreadable = false;
  if (cli == null) {
    try { cli = JSON.parse(read(legacyCliConfigPath({ home }))); }
    catch { cli = null; cliUnreadable = true; }
  }
  const sel = selectedModel(cli);

  if (exists(path)) {
    // An existing file is authoritative: never overwritten, judged as-is.
    let parsed;
    try { parsed = JSON.parse(read(path)); }
    catch { return { write: false, doc: null, reason: 'personal provider config already present',
      source: FILE_SOURCE, resolves: sel ? { ok: false, detail: 'the personal provider config is unreadable' } : null }; }
    // The kernel's strict parser (yAe) rejects a structurally wrong file and
    // the registry falls back to no personal providers — so a wrong shape is
    // a NOT-RESOLVABLE verdict, never a crash in doctor.
    const providerRules = parsed?.config?.providerConfigRules?.providerRules;
    const malformed = detail => ({ write: false, doc: null,
      reason: 'personal provider config already present', source: FILE_SOURCE,
      resolves: sel ? { ok: false, detail } : null });
    if (!Array.isArray(providerRules)) return malformed('the personal provider config is malformed (providerRules)');
    for (const r of providerRules)
      if (r?.config !== undefined && (typeof r.config !== 'object' || Array.isArray(r.config)))
        return malformed('the personal provider config is malformed (provider rule)');
      else if (r?.config?.personalModelIds !== undefined && !Array.isArray(r.config.personalModelIds))
        return malformed('the personal provider config is malformed (personalModelIds)');
    return { write: false, doc: null, reason: 'personal provider config already present',
      source: FILE_SOURCE, resolves: sel ? selectionVerdict(providerRules, sel) : null };
  }

  const refuse = (reason, resolves) => ({ write: false, doc: null, reason, source: DERIVED_SOURCE, resolves: sel ? resolves : null });
  if (cli == null)
    return refuse('no readable cli config to migrate', { ok: false, detail: 'the cli config is unreadable' });
  let imported = null;
  try { imported = importLegacyCliConfig(cli); }
  catch (e) {
    const detail = e?.name === 'UnsupportedLegacyCliProviderConfigError'
      ? `provider '${e.providerId}' is not expressible in the personal config`
      : `the cli config is malformed (${e?.message ?? e})`;
    return refuse(e?.name === 'UnsupportedLegacyCliProviderConfigError'
      ? `cli provider '${e.providerId}' cannot be expressed in the personal config`
      : `legacy import failed: ${e?.message ?? e}`, { ok: false, detail });
  }
  if (!imported)
    return refuse('cli config has no importable providers',
      sel ? { ok: false, detail: `provider '${sel.providerId}' is not configured` } : null);
  if (!sel)
    return { write: true, doc: personalProviderConfigDocument(imported), reason: null, source: DERIVED_SOURCE, resolves: null };
  // Gate 1 — never seed a permanent unusable selection: the file is
  // create-if-missing, so an empty-key write could never be repaired
  // afterwards (neither the kernel's import — the file exists — nor the OAuth
  // backfill — it reads this very file). An OAuth-window config (apiKey:'')
  // must abstain, not brick.
  if (cli.provider?.[sel.providerId] !== undefined && !usableKey(cli.provider[sel.providerId]))
    return refuse(`selected provider '${sel.providerId}' has no usable API key — refusing to seed an empty-key personal config`,
      { ok: false, detail: `provider '${sel.providerId}' has no usable API key` });
  // Gate 2 — the document we are about to leave behind forever must resolve
  // the selection: a create-if-missing seed whose rules lack the selected
  // model turns a wait-for-the-config-to-grow state into a permanent miss
  // (nothing rewrites an existing personal file).
  const verdict = selectionVerdict(imported.providers, sel);
  if (!verdict.ok)
    return refuse(`selected model ${sel.providerId}/${sel.modelId} would not resolve in the seeded config — refusing to create a permanent miss (${verdict.detail})`,
      verdict);
  return { write: true, doc: personalProviderConfigDocument(imported), reason: null, source: DERIVED_SOURCE, resolves: verdict };
}

/**
 * Best-effort provisioning of the personal provider config from the legacy
 * CLI config. Never throws. An existing target file is authoritative (the
 * desktop or a prior kernel run owns it — provisioning must never overwrite);
 * every other refusal comes from planPersonalProviderConfig, so what doctor
 * reports and what the -p path seeds cannot diverge.
 * @returns {{provisioned:boolean, path:string, reason:string|null}}
 */
export function provisionPersonalProviderConfig({
  env = process.env, home = os.homedir(),
  read = p => readFileSync(p, 'utf8'), exists = existsSync,
  write = atomicWriteFileSync, lock = withFileLockSync, lockOptions = {},
} = {}) {
  const result = { provisioned: false, path: personalProviderConfigPath({ env, home }), reason: null };
  const plan = planPersonalProviderConfig({ env, home, read, exists });
  if (!plan.write) { result.reason = plan.reason; return result; }
  try {
    return lock(result.path, () => {
      // Re-check under the lock: a concurrent kernel/GUI writer wins silently.
      if (exists(result.path)) { result.reason = 'personal provider config already present'; return result; }
      write(result.path, JSON.stringify(plan.doc, null, 2));
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
 * Read-only resolution check for doctor: can the -p path make the app-server
 * registry resolve the cli config's model.main? Thin wrapper over
 * planPersonalProviderConfig — the same predicate provisioning obeys — so the
 * verdict can never claim ok for a state provisioning refuses to seed.
 * @returns {{ok:boolean, source:string, detail:string}|null}
 */
export function modelResolutionCheck(opts = {}) {
  if (opts.config == null) return null; // doctor judges a parsed config; none -> nothing to check
  const plan = planPersonalProviderConfig(opts);
  return plan.resolves ? { ok: plan.resolves.ok, source: plan.source, detail: plan.resolves.detail } : null;
}
