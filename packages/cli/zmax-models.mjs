#!/usr/bin/env node
// zagent models [query] — B1: search the OFFICIAL provider catalog the desktop ships.
// No query: the configured Coding Plan models first (the plan is what people
// actually run), then the other providers.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { loadCatalog, providerList, findModel } from '../driver/providers.mjs';

const q = process.argv[2];
const catalog = loadCatalog();
if (!catalog) {
  console.error('no provider catalog found for the installed runtime');
  process.exit(1);
}

const planHeader = () => {
  let model = {};
  try {
    model = JSON.parse(readFileSync(`${os.homedir()}/.zcode/cli/config.json`, 'utf8'))?.model ?? {};
  } catch {}
  const parts = [
    typeof model.main === 'string' && model.main ? `main ${model.main}` : null,
    typeof model.lite === 'string' && model.lite ? `lite ${model.lite}` : null,
  ].filter(Boolean);
  console.log(`Your Coding Plan: ${parts.length ? parts.join(' · ') : 'not configured'}`);
};

if (!q) {
  planHeader();
  const providers = providerList(catalog);
  const plan = providers.find((p) => p.id === 'zai');
  if (plan) {
    console.log();
    for (const m of plan.models) console.log(`  zai/${m}`);
  }
  const rest = providers.filter((p) => p !== plan);
  if (rest.length) {
    console.log('\nOther providers:');
    for (const p of rest) console.log(`${p.id}\t${p.models.length} models\t${p.baseURL ?? ''}`);
  }
} else {
  const exact = findModel(q, catalog);
  if (exact.length) for (const h of exact)
    console.log(`${h.provider}/${h.model}\tctx ${h.contextWindow ?? '?'}\tout ${h.maxOutputTokens ?? '?'}\tkinds ${h.kinds.join(',')}\tinput ${h.input.join(',')}`);
  else { // substring search over provider/model, so `models zai` or `models glm` find the plan's models
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    let hits = 0;
    for (const p of providerList(catalog)) for (const m of p.models) if (re.test(`${p.id}/${m}`)) { console.log(`${p.id}/${m}`); hits++; }
    // A query that matches nothing used to print nothing and exit 0, so "no such
    // model" and "the command is broken" looked identical — and a mistyped flag
    // (models --bogus) was silently a success.
    if (!hits) {
      console.error(`no model matching '${q}'. \`zagent models\` lists every provider.`);
      process.exit(1);
    }
  }
}
