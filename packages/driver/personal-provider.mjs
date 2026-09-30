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
import { builtinConfigPath, kernelActiveBuiltinPath } from './account-config.mjs';
import { findRuntime } from './runtime.mjs';

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
      // family — and only when they carry a (string) key. The access block
      // carries `type: 'api-key'` like every xz serialization (toJSON always
      // emits it); without it the kernel's strict parser rejects the file.
      // A wrong-typed key degrades to "no key" for this entry alone; the
      // kernel's zod layer (QAn -> RHa, options.apiKey m.string().optional())
      // instead rejects the WHOLE config on a type violation — zagent's
      // converter has no schema layer, so one garbage provider must not cost
      // the others.
      const key = strField(p?.options?.apiKey)?.trim();
      if (key) providers.push({ providerId: family, templateId: family,
        config: { group: 'standard-personal', access: { type: 'api-key', apiKey: key } } });
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

// The cli provider entry for an id, matched the way the importer normalises:
// raw map keys are trimmed on import ('zai ' -> rule id 'zai'), so gates must
// look the entry up by its TRIMMED id too — an untrimmed lookup would miss
// the entry and skip the key gate entirely.
function cliProviderEntry(cli, id) {
  const providers = cli?.provider;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return undefined;
  if (Object.hasOwn(providers, id)) return providers[id];
  for (const [raw, value] of Object.entries(providers)) if (raw.trim() === id) return value;
  return undefined;
}

// Builtin template index for family-rule verdicts: templateId -> model id
// list (null when the template exists but carries no list). Returns null when
// the builtin provider config is absent/unreadable — the verdict then reports
// UNVERIFIED (the seed still happens, kernel-migration parity).
function builtinTemplateIndex(builtin) {
  const rules = builtin?.config?.providerConfigRules?.templateRules;
  if (!Array.isArray(rules)) return null;
  const map = new Map();
  for (const r of rules) {
    if (typeof r?.templateId !== 'string') continue;
    const ids = r.config?.builtinModelIds;
    map.set(r.templateId, Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : null);
  }
  return map;
}

// Resolve the builtin provider config the way the runtime spawn sees it —
// reuse zagent's own resolvers, do not invent a path:
//   1. an injected document (tests)
//   2. the kernel's effective builtin file (kernelActiveBuiltinPath): a normal
//      spawn rewrites the builtin path to the managed active cache under
//      <dataBaseDir>/.zcode/v2/runtime/provider/<platform>/…, and the
//      registry rebuilds from THAT file — same order as
//      buildAccountConfigParams ([effective, preset||bundled])
//   3. ZCODE_BUILTIN_PROVIDER_CONFIG_FILE preset in the env (what kernelEnv
//      passes through), else the bundled copy beside the discovered runtime
//      (builtinConfigPath — what kernelEnv() injects, runtime.mjs)
// Returns the parsed document, or undefined when none is readable.
function resolveBuiltinConfig({ env, home, read, builtin, runtimeEntry }) {
  if (builtin !== undefined) return builtin;
  const entry = runtimeEntry ?? findRuntime({ env })?.entry;
  const bundled = entry ? builtinConfigPath(entry) : null;
  const candidates = [kernelActiveBuiltinPath({ env, home, bundledPath: bundled }),
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim(), bundled];
  for (const p of candidates) {
    if (!p) continue;
    try { return JSON.parse(read(p)); } catch { /* try the next candidate */ }
  }
  return undefined;
}

// Judge a selection against personal provider rules. Model id comparison is
// the kernel's own lookup semantics: the registry indexes models in plain
// Maps and the explicit-selection path reads them verbatim
// (getModel: `this.#n.get(providerId)?.get(modelId)`, zcode.cjs ~576830;
// `models.find(g => g.modelId === t.modelId)`, ~579813) — EXACT and
// case-sensitive, which is why commit-msg canonicalises casing before
// sending. Measured live on 3.14.4: `--model zai-api/glm-5.3` against the
// template list ['GLM-5.3','GLM-5.3-Flash'] answers model-not-found while
// `zai-api/GLM-5.3` answers ok (the kernel's default-selection path
// canonicalises; the explicit one does not).
// A family rule (templateId set) has no model list of its own — its models
// are the builtin template's builtinModelIds. Without a resolvable template
// list the verdict is UNVERIFIED ({unverified: reason}); family rules are
// never a seed refusal either way (the kernel migration writes them
// regardless — their model list lives in the template, so a seed cannot
// brick a later selection).
function selectionVerdict(rules, { providerId, modelId }, templates) {
  const rule = rules.find(p => p?.providerId === providerId);
  if (!rule) return { ok: false, detail: `provider '${providerId}' is not configured` };
  if (rule.templateId) {
    if (!templates) return { unverified: `the builtin template model list is unavailable — ${providerId}/${modelId} could not be checked` };
    const ids = templates.get(rule.templateId);
    if (ids === undefined) return { unverified: `builtin template '${rule.templateId}' is not in the builtin provider config — ${providerId}/${modelId} could not be checked` };
    if (!Array.isArray(ids) || !ids.includes(modelId)) return { ok: false, family: true,
      detail: `model ${providerId}/${modelId} is not in the builtin template's model list` };
    return { ok: true, detail: `${providerId}/${modelId}` };
  }
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
 * selection is judgeable at all. Never throws — even a throwing `exists`/
 * `read` degrades to a conservative refusal.
 * @returns {{write:boolean, doc:Object|null, reason:string|null,
 *            source:string, resolves:{ok:boolean, detail:string}|null,
 *            unverified:string|null, repair?:Object}}
 */
export function planPersonalProviderConfig(opts = {}) {
  try { return buildPersonalProviderPlan(opts); }
  catch (e) {
    return { write: false, doc: null, reason: `personal provider plan failed: ${e?.message ?? e}`,
      source: DERIVED_SOURCE, resolves: null, unverified: null };
  }
}

function buildPersonalProviderPlan({
  env = process.env, home = os.homedir(),
  read = p => readFileSync(p, 'utf8'), exists = existsSync, config = null,
  builtin = undefined, runtimeEntry = undefined,
} = {}) {
  const target = personalProviderConfigPath({ env, home });
  // U7 parity: the legacy source is always the real home's cli config — even
  // when ZCODE_DATA_BASE_DIR relocates the target (see legacyCliConfigPath).
  // Doctor hands in the config it already parsed; everyone else reads it.
  let cli = config;
  if (cli == null) {
    try { cli = JSON.parse(read(legacyCliConfigPath({ home }))); }
    catch { cli = null; }
  }
  const sel = selectedModel(cli);
  // Family-rule verdicts need the builtin template's model list, resolved the
  // way the runtime spawn sees it (resolveBuiltinConfig). Unreadable/absent
  // -> null, and the verdict reports UNVERIFIED while the seed still happens
  // (the kernel migration writes family rules regardless of any model list).
  let templates;
  const loadTemplates = () => templates ??= builtinTemplateIndex(
    resolveBuiltinConfig({ env, home, read, builtin, runtimeEntry }));

  if (exists(target)) {
    // An existing file is authoritative: never overwritten, judged as-is.
    let parsed;
    try { parsed = JSON.parse(read(target)); }
    catch { return { write: false, doc: null, reason: 'personal provider config already present',
      source: FILE_SOURCE, resolves: sel ? { ok: false, detail: 'the personal provider config is unreadable' } : null, unverified: null }; }
    // The kernel's strict parser (yAe) rejects a structurally wrong file and
    // the registry falls back to no personal providers — so a wrong shape is
    // a NOT-RESOLVABLE verdict, never a crash in doctor.
    const providerRules = parsed?.config?.providerConfigRules?.providerRules;
    const malformed = detail => ({ write: false, doc: null,
      reason: 'personal provider config already present', source: FILE_SOURCE,
      resolves: sel ? { ok: false, detail } : null, unverified: null });
    if (!Array.isArray(providerRules)) return malformed('the personal provider config is malformed (providerRules)');
    // A typeless access block is what the first seeder wrote; the kernel's
    // strict parser rejects it. When it carries a string key the only missing
    // piece is the tag every xz serialization emits, so the plan carries a
    // repaired document and the seeding paths (the only readers of this file:
    // the app-server registry behind --model/--effort, commit-msg, models test)
    // rewrite it once.
    let repaired = false;
    const rules = providerRules.map(r => {
      const a = r?.config?.access;
      if (!a || typeof a !== 'object' || Array.isArray(a) || a.type !== undefined || typeof a.apiKey !== 'string') return r;
      repaired = true;
      return { ...r, config: { ...r.config, access: { type: 'api-key', ...a } } };
    });
    for (const r of rules) {
      const c = r?.config;
      if (!c || typeof c !== 'object' || Array.isArray(c))
        return malformed('the personal provider config is malformed (provider rule)');
      if (!c.access || typeof c.access !== 'object' || typeof c.access.type !== 'string' || !c.access.type)
        return malformed('the personal provider config is malformed (access.type)');
      if (c.personalModelIds !== undefined && !Array.isArray(c.personalModelIds))
        return malformed('the personal provider config is malformed (personalModelIds)');
    }
    const base = { write: false, doc: null, reason: 'personal provider config already present', source: FILE_SOURCE };
    // The file on disk is what the kernel reads until a seeding run rewrites
    // it, so the verdict is NOT-RESOLVABLE now, with the way out in the detail.
    if (repaired) return { ...base, repair: { ...parsed, config: { ...parsed.config,
      providerConfigRules: { ...parsed.config.providerConfigRules, providerRules: rules } } },
      resolves: sel ? { ok: false, detail: 'the personal provider config lacks access.type — the next --model, commit-msg or models test run rewrites it' } : null,
      unverified: null };
    return planVerdict(sel, rules, loadTemplates, base);
  }

  const refuse = (reason, resolves) => ({ write: false, doc: null, reason, source: DERIVED_SOURCE, resolves: sel ? resolves : null, unverified: null });
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
    return { write: true, doc: personalProviderConfigDocument(imported), reason: null, source: DERIVED_SOURCE, resolves: null, unverified: null };
  // Gate 1 — never seed a permanent unusable selection: the file is
  // create-if-missing, so an empty-key write could never be repaired
  // afterwards (neither the kernel's import — the file exists — nor the OAuth
  // backfill — it reads this very file). An OAuth-window config (apiKey:'')
  // must abstain, not brick. The lookup normalises the id the same way the
  // importer does, so an entry keyed 'zai ' is still the selected provider.
  const entry = cliProviderEntry(cli, sel.providerId);
  if (entry !== undefined && !usableKey(entry))
    return refuse(`selected provider '${sel.providerId}' has no usable API key — refusing to seed an empty-key personal config`,
      { ok: false, detail: `provider '${sel.providerId}' has no usable API key` });
  // Gate 2 — the document we are about to leave behind forever must resolve
  // the selection: a create-if-missing seed whose CUSTOM rules lack the
  // selected model turns a wait-for-the-config-to-grow state into a permanent
  // miss (nothing rewrites an existing personal file). FAMILY rules are never
  // refused: the kernel migration writes them regardless, and their model
  // list lives in the builtin template, not in the seeded file — a family
  // seed cannot brick a later selection. Their verdict (and the unverified
  // fallback when no template list is resolvable) still reaches doctor.
  const verdict = selectionVerdict(imported.providers, sel,
    imported.providers.some(r => r?.templateId === sel.providerId) ? loadTemplates() : undefined);
  if (!verdict.ok && !verdict.unverified && !verdict.family)
    return refuse(`selected model ${sel.providerId}/${sel.modelId} would not resolve in the seeded config — refusing to create a permanent miss (${verdict.detail})`,
      verdict);
  return planVerdict(sel, imported.providers, () => templates, {
    write: true, doc: personalProviderConfigDocument(imported), reason: null, source: DERIVED_SOURCE,
  }, verdict);
}

// Attach the selection verdict to a plan result. `verdict` may be omitted to
// recompute it (file-branch); family UNVERIFIED verdicts map to
// resolves:null plus the `unverified` reason instead of an ok/fail answer.
function planVerdict(sel, rules, loadTemplates, base, verdict = undefined) {
  if (!sel) return { ...base, resolves: null, unverified: null };
  const v = verdict ?? selectionVerdict(rules, sel,
    rules.some(r => r?.templateId) ? loadTemplates() : undefined);
  if (v.unverified) return { ...base, resolves: null, unverified: v.unverified };
  return { ...base, resolves: v, unverified: null };
}

/**
 * Best-effort provisioning of the personal provider config from the legacy
 * CLI config. Never throws. An existing target file is authoritative (the
 * desktop or a prior kernel run owns it — provisioning must never overwrite);
 * every other refusal comes from planPersonalProviderConfig, so what doctor
 * reports and what the -p path seeds cannot diverge.
 * @returns {{provisioned:boolean, path:string, reason:string|null, repaired?:boolean}}
 */
export function provisionPersonalProviderConfig({
  env = process.env, home = os.homedir(),
  read = p => readFileSync(p, 'utf8'), exists = existsSync,
  write = atomicWriteFileSync, lock = withFileLockSync, lockOptions = {}, builtin = undefined, runtimeEntry = undefined,
} = {}) {
  const result = { provisioned: false, path: personalProviderConfigPath({ env, home }), reason: null };
  const plan = planPersonalProviderConfig({ env, home, read, exists, builtin, runtimeEntry });
  if (!plan.write && !plan.repair) { result.reason = plan.reason; return result; }
  try {
    return lock(result.path, () => {
      // Re-check under the lock: a concurrent kernel/GUI writer wins silently.
      if (exists(result.path)) {
        result.reason = 'personal provider config already present';
        // Under the lock the plan is re-read, so a concurrent writer's file is judged, never clobbered.
        const fresh = planPersonalProviderConfig({ env, home, read, exists, builtin, runtimeEntry });
        if (fresh.repair) {
          write(result.path, JSON.stringify(fresh.repair, null, 2));
          result.repaired = true;
        }
        return result;
      }
      if (!plan.write) { result.reason = 'personal provider config vanished before repair'; return result; }
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
 * verdict can never claim ok for a state provisioning refuses to seed. An
 * UNVERIFIED verdict (family rule, no resolvable builtin template list)
 * reports ok with the caveat in `detail` and an `unverified` flag: the seed
 * happens (kernel-migration parity), only the check could not be performed.
 * @returns {{ok:boolean, unverified?:boolean, source:string, detail:string}|null}
 */
export function modelResolutionCheck(opts = {}) {
  if (opts.config == null) return null; // doctor judges a parsed config; none -> nothing to check
  const plan = planPersonalProviderConfig(opts);
  if (plan.unverified) {
    const sel = selectedModel(opts.config);
    return { ok: true, unverified: true, source: plan.source,
      detail: sel ? `${sel.providerId}/${sel.modelId} — unverified (${plan.unverified})` : `unverified (${plan.unverified})` };
  }
  return plan.resolves ? { ok: plan.resolves.ok, source: plan.source, detail: plan.resolves.detail } : null;
}
