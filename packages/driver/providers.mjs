// B1: the OFFICIAL provider catalog the desktop ships. 3.11.2 and older:
// resources/model-providers/models_catalog_*.json (schemaVersion
// zcode.model-providers.v1; 2026-06-03 edition: 10 providers, 84 models, endpoint
// paths, modality, contextWindow, reasoning levels). 3.12.1 replaced it with
// resources/config/provider/zcode-builtin.json (schemaVersion 1): account
// providerRules + API templateRules carry builtinModelIds; modelConfigRules
// modelRules are regexes merged in order for contextWindow/maxOutputTokens/
// modalities. Counts COMPUTED at runtime, never hardcoded. Read-only; we never
// invent entries.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findRuntime, desktopRuntimeEntries } from './runtime.mjs';

export const CATALOG_DIRS = ['/opt/ZCode/resources/model-providers'];

function resourceDirs(sub, { runtime = findRuntime(), platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (!runtime) return [];
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const entries = [runtime.entry, ...(runtime.kind === 'explicit' ? [] : desktopRuntimeEntries({ platform, env, home }))];
  return [...new Set(entries.map(entry => paths.resolve(paths.dirname(entry), '..', ...sub)))];
}

export function catalogDirs(opts = {}) {
  return resourceDirs(['model-providers'], opts);
}

export function builtinConfigDirs(opts = {}) {
  return resourceDirs(['config', 'provider'], opts);
}

const isBuiltin = j => j?.schemaVersion === 1 && !!j?.config?.providerConfigRules;

export function loadCatalog({ dirs = catalogDirs(), builtinDirs = builtinConfigDirs() } = {}) {
  // 3.12.1+: the built-in provider config is the catalog; it wins wherever it
  // exists (the old file is gone there, and a stale copy must not shadow it).
  for (const d of builtinDirs) {
    try { const j = JSON.parse(readFileSync(path.join(d, 'zcode-builtin.json'), 'utf8'));
      if (isBuiltin(j)) return j; } catch {}
  }
  // r13: candidates restricted to models_catalog_*.json, newest-first, until one parses
  // with the expected schema — an unrelated/malformed later-sorting JSON cannot shadow it.
  for (const d of dirs) {
    let names; try { names = readdirSync(d); } catch { continue; }
    const cands = names.filter(n => /^models_catalog_.*\.json$/.test(n)).sort().reverse();
    for (const f of cands) {
      try { const j = JSON.parse(readFileSync(`${d}/${f}`, 'utf8'));
        if (j?.schemaVersion === 'zcode.model-providers.v1') return j; } catch {}
    }
  }
  return null;
}

// 3.12.1 builtin shape: account providerRules first (what a signed-in user
// actually has), then the API templateRules; both carry builtinModelIds.
function builtinProviderList(catalog) {
  const rules = catalog.config?.providerConfigRules ?? {};
  const plan = p => ({
    id: p.providerId ?? p.templateId,
    name: p.providerName ?? p.templateNameMap?.['en-US'] ?? p.providerId ?? p.templateId,
    baseURL: p.config?.api?.baseUrl ?? null,
    kinds: p.config?.api?.type ? [p.config.api.type] : [],
    models: [...(p.config?.builtinModelIds ?? [])],
  });
  return [...(rules.providerRules ?? []).map(plan), ...(rules.templateRules ?? []).map(plan)];
}

// Kernel parity: the kernel matches modelConfigRules through its matchesRule
// (nct in zcode.cjs, called by RuleSet.resolve as nct(o.modelMatch, t.modelId,
// !0)) — anchored `^(?:pattern)$` AND case-insensitive. Both are load-bearing:
// catalog ids are uppercase ('GLM-5.3') while rule patterns are lowercase, and
// without the $ anchor 'glm-5.3xyz' would take the glm-5.3 rule.
const matchModelRule = (pattern, modelId) => new RegExp(`^(?:${pattern})$`, 'i').test(modelId);

// The kernel merges ALL five modelConfigRules arrays into ONE RuleSet in this
// order (zcode.cjs `new _h([...])`, each rule tagged with its set type): later
// matches win across set boundaries. The sets are SCOPED, though — a
// modelApiRules rule applies only to providers whose config.api.type matches
// its apiTypeMatch, a providerSiteRules rule needs its baseUrlMatch on
// config.api.baseUrl too, and templateModelRules/builtinProviderModelRules
// key on literal modelId + templateId/providerId. A declared matcher whose
// context is unknown can never be verified — the rule is skipped rather than
// claimed for every provider (an unscoped merge would report e.g. the z.ai
// site catch-all's vision flags on openai-template models).
const scopedMatch = (pattern, value) => {
  if (pattern === undefined) return true;
  if (typeof value !== 'string') return false;
  try { return matchModelRule(pattern, value); } catch { return false; }
};
const eqFold = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

function* builtinRules(catalog, ctx) {
  const mcr = catalog.config?.modelConfigRules ?? {};
  for (const r of mcr.modelRules ?? [])
    if (scopedMatch(r.modelMatch, ctx.modelId)) yield r;
  for (const r of mcr.modelApiRules ?? [])
    if (scopedMatch(r.modelMatch, ctx.modelId) && scopedMatch(r.apiTypeMatch, ctx.apiType)) yield r;
  for (const r of mcr.providerSiteRules ?? [])
    if (scopedMatch(r.modelMatch, ctx.modelId) && scopedMatch(r.apiTypeMatch, ctx.apiType) &&
        scopedMatch(r.baseUrlMatch, ctx.baseUrl)) yield r;
  for (const r of mcr.templateModelRules ?? [])
    if (ctx.templateId && eqFold(r.modelId, ctx.modelId) && eqFold(r.templateId, ctx.templateId)) yield r;
  for (const r of mcr.builtinProviderModelRules ?? [])
    if (ctx.providerId && eqFold(r.modelId, ctx.modelId) && eqFold(r.providerId, ctx.providerId)) yield r;
}

// Provider context for the scoped sets. A builtin provider/template id resolves
// straight from the catalog; a configured-provider key like 'zai' (what
// `-p --model zai/x` actually sends — the kernel maps it through the
// registry's configured providers) resolves via ~/.zcode/v2/config.json —
// kind 'anthropic' is the anthropic-messages api type, other kinds stay
// undefined rather than guessed. Unresolvable providers get {}: only
// unscoped rules then apply (never a scoped claim on an unknown provider).
function builtinProviderCtx(catalog, providerId, providerConfig) {
  if (!providerId) return {};
  const rules = catalog.config?.providerConfigRules ?? {};
  for (const r of rules.providerRules ?? [])
    if (eqFold(r.providerId, providerId))
      return { providerId, apiType: r.config?.api?.type, baseUrl: r.config?.api?.baseUrl };
  for (const r of rules.templateRules ?? [])
    if (eqFold(r.templateId, providerId))
      return { templateId: providerId, apiType: r.config?.api?.type, baseUrl: r.config?.api?.baseUrl };
  // undefined = read the real config lazily (only reached when the catalog
  // itself cannot resolve the id); an injected null disables the lookup.
  const cfg = providerConfig === undefined ? readProviderConfig() : providerConfig;
  const p = cfg?.provider?.[providerId] ?? cfg?.provider?.[`builtin:${providerId}`];
  if (p) return { configuredId: providerId, apiType: p.kind === 'anthropic' ? 'anthropic-messages' : undefined,
    baseUrl: p.options?.baseURL };
  return {};
}

function readProviderConfig() {
  try { return JSON.parse(readFileSync(`${os.homedir()}/.zcode/v2/config.json`, 'utf8')); }
  catch { return null; }
}

// properties merge one level deep — a later rule's inputFormat adds/overrides
// individual flags; a wholesale replace would silently drop every capability
// the narrower rule did not mention (e.g. supportsText from the catch-all).
const mergeProps = (dst, src) => {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return;
  for (const [k, v] of Object.entries(src)) {
    const d = dst[k];
    dst[k] = (v && d && typeof v === 'object' && typeof d === 'object' && !Array.isArray(v) && !Array.isArray(d))
      ? { ...d, ...v } : v;
  }
};

// Rules are regexes applied in kernel merge order; later matches override
// earlier ones (the first modelRules rule is the `.*` default).
function builtinModelProps(catalog, modelId, ctx = {}) {
  const props = {}; let maxOutputTokens = null;
  for (const r of builtinRules(catalog, { ...ctx, modelId })) {
    mergeProps(props, r.config?.properties);
    const m = r.config?.optionSpecs?.maxOutputTokens?.max;
    if (typeof m === 'number') maxOutputTokens = m;
  }
  return { props, maxOutputTokens };
}

const MODALITY_FLAGS = [['supportsText', 'text'], ['supportsImage', 'image'], ['supportsVideo', 'video'],
  ['supportsAudio', 'audio'], ['supportsPdf', 'pdf']];
const inputOf = fmt => MODALITY_FLAGS.filter(([f]) => fmt?.[f]).map(([, n]) => n);

export function providerList(catalog = loadCatalog()) {
  if (isBuiltin(catalog)) return builtinProviderList(catalog);
  return (catalog?.providers ?? []).map(p => ({
    id: p.id, name: p.name, baseURL: p.endpoints?.baseURL ?? null,
    kinds: [...new Set((p.models ?? []).flatMap(m => m.kinds ?? []))],
    models: (p.models ?? []).map(m => m.id),
  }));
}

export function findModel(modelId, catalog = loadCatalog()) {
  const hits = [];
  if (isBuiltin(catalog)) {
    for (const p of builtinProviderList(catalog)) if (p.models.includes(modelId)) {
      const { props, maxOutputTokens } = builtinModelProps(catalog, modelId, builtinProviderCtx(catalog, p.id));
      hits.push({ provider: p.id, model: modelId, name: modelId,
        contextWindow: props.contextWindow ?? null, maxOutputTokens,
        kinds: p.kinds, input: inputOf(props.inputFormat) });
    }
    return hits;
  }
  for (const p of catalog?.providers ?? []) for (const m of p.models ?? [])
    if (m.id === modelId) hits.push({ provider: p.id, model: m.id, name: m.name ?? m.id,
      contextWindow: m.contextWindow ?? null, maxOutputTokens: m.maxOutputTokens ?? null,
      kinds: m.kinds ?? [], input: m.modalities?.input ?? [] });
  return hits;
}

// Reasoning-level vocabulary for a model id, resolved the same way the kernel
// does (modelRules regexes applied in order, later matches win). The kernel
// requires options.reasoningLevel on registry-backed selections and picks
// values.at(-1) as the picker default (yDn/jio); mirror that here so headless
// `--model` can complete a required level when --effort was not given.
export function modelReasoningLevels(modelId, catalog = loadCatalog(), providerId, providerConfig) {
  if (isBuiltin(catalog)) {
    const ctx = { ...builtinProviderCtx(catalog, providerId, providerConfig), modelId };
    let values;
    for (const r of builtinRules(catalog, ctx)) {
      const v = r.config?.optionSpecs?.reasoningLevel?.values;
      if (Array.isArray(v) && v.length) values = v;
    }
    return values ?? null;
  }
  // Legacy catalog shape (verified on the real 3.6.5 models_catalog file):
  // reasoning is {defaultLevel, levels:{<name>:{per-api patch}}} — an
  // object keyed by level name, and the declared defaultLevel is the picker
  // default, NOT the last key ('enabled'/'off' models default to the FIRST
  // key). Order the keys so the declared default sits last — the consumer's
  // values.at(-1) picker convention then yields it. The registry's
  // array-of-{value} levels form is accepted too. With providerId, only that
  // provider's model entry counts — duplicate ids across providers can carry
  // divergent vocabularies (qwen3.5-plus cn vs intl), so borrowing another
  // provider's levels could embed a wrong default or refuse a valid --effort.
  for (const p of catalog?.providers ?? []) {
    if (providerId && !eqFold(p.id, providerId)) continue;
    for (const m of p.models ?? [])
      if (eqFold(m.id, modelId)) {
        const lv = m.reasoning?.levels;
        const keys = (Array.isArray(lv) ? lv.map(l => l?.value) : Object.keys(lv ?? {})).filter(Boolean);
        if (!keys.length) return null;
        const d = m.reasoning?.defaultLevel;
        return keys.includes(d) ? [...keys.filter(k => k !== d), d] : keys;
      }
  }
  return null;
}

export function catalogLine(catalog = loadCatalog()) {
  const list = providerList(catalog);
  if (!list.length) return 'no provider catalog found';
  return list.map(p => `${p.id} (${p.models.length} models) · ${p.baseURL ?? 'no base url'}`).join('\n');
}
