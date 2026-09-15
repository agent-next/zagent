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

// modelRules are regexes applied in array order; later matches override earlier
// ones (the first rule is the `.*` default). Unparseable patterns are skipped.
function builtinModelProps(catalog, modelId) {
  const props = {}; let maxOutputTokens = null;
  for (const r of catalog.config?.modelConfigRules?.modelRules ?? []) {
    try { if (!new RegExp(r.modelMatch).test(modelId)) continue; } catch { continue; }
    Object.assign(props, r.config?.properties ?? {});
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
      const { props, maxOutputTokens } = builtinModelProps(catalog, modelId);
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

export function catalogLine(catalog = loadCatalog()) {
  const list = providerList(catalog);
  if (!list.length) return 'no provider catalog found';
  return list.map(p => `${p.id} (${p.models.length} models) · ${p.baseURL ?? 'no base url'}`).join('\n');
}
