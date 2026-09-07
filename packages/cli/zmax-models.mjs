#!/usr/bin/env node
// zagent models [query] — B1: search the OFFICIAL provider catalog the desktop ships.
import { providerList, findModel } from '../driver/providers.mjs';
const q = process.argv[2];
if (!q) { for (const p of providerList()) console.log(`${p.id}\t${p.models.length} models\t${p.baseURL ?? ''}`); }
else {
  const exact = findModel(q);
  if (exact.length) for (const h of exact)
    console.log(`${h.provider}/${h.model}\tctx ${h.contextWindow ?? '?'}\tout ${h.maxOutputTokens ?? '?'}\tkinds ${h.kinds.join(',')}\tinput ${h.input.join(',')}`);
  else { // substring search
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    let hits = 0;
    for (const p of providerList()) for (const m of p.models) if (re.test(m)) { console.log(`${p.id}/${m}`); hits++; }
    // A query that matches nothing used to print nothing and exit 0, so "no such
    // model" and "the command is broken" looked identical — and a mistyped flag
    // (models --bogus) was silently a success.
    if (!hits) {
      console.error(`no model matching '${q}'. \`zagent models\` lists every provider.`);
      process.exit(1);
    }
  }
}
