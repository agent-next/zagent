// B1: the OFFICIAL provider catalog the desktop ships
// (/opt/ZCode/resources/model-providers/models_catalog_*.json — schemaVersion
// zcode.model-providers.v1; 2026-06-03 edition: 10 providers, 84 models, endpoint
// paths, modality, contextWindow, reasoning levels; counts COMPUTED at runtime, never hardcoded). Read-only; we never invent entries.
import { readdirSync, readFileSync } from 'node:fs';

export const CATALOG_DIRS = ['/opt/ZCode/resources/model-providers'];

export function loadCatalog({ dirs = CATALOG_DIRS } = {}) {
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

export function providerList(catalog = loadCatalog()) {
  return (catalog?.providers ?? []).map(p => ({
    id: p.id, name: p.name, baseURL: p.endpoints?.baseURL ?? null,
    kinds: [...new Set((p.models ?? []).flatMap(m => m.kinds ?? []))],
    models: (p.models ?? []).map(m => m.id),
  }));
}

export function findModel(modelId, catalog = loadCatalog()) {
  const hits = [];
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
