#!/usr/bin/env node
// zagent plugins [name] — J4 update-notification surface over the official marketplace
// cache: badges update-available/ok/not-installed/orphan/unknown-version + suppressed
// markers. Read-only (J3 install is a separate, heavier surface).
import { loadCatalog, providerList, findModel } from '../driver/providers.mjs';
import { marketplaceVersions, installedPlugins, suppressedBuiltins, updateReport, updateLine, installPlugin, fetchMarketplace } from '../driver/plugins.mjs';
import { readFileSync } from 'node:fs';
import os from 'node:os';

const [arg, sub] = process.argv.slice(2);
const q = arg === 'install' ? null : arg;
if (arg === 'install') {
  if (!sub) { console.error('usage: zagent plugins install <name>'); process.exit(2); }
  // Refresh first. The local cache is written by the desktop app and goes stale:
  // on this machine it listed 2 plugins while the CDN listed 18, so installing a
  // published plugin failed with "no verifiable source". Offline still works —
  // the cache is the fallback, and which source was used is stated, not implied.
  let mkJson = null;
  let source = null;
  if (!process.argv.includes('--offline')) {
    try { mkJson = await fetchMarketplace(); source = 'cdn'; }
    catch (e) { console.error(`marketplace refresh failed (${e.message}) — falling back to the local cache`); }
  }
  if (!mkJson) {
    for (const file of ['zagent-marketplace.json', 'marketplace.json']) {
      try {
        mkJson = JSON.parse(readFileSync(`${os.homedir()}/.zcode/cli/plugins/marketplaces/zcode-plugins-official/${file}`, 'utf8'));
        source = `cache (${file})`;
        break;
      } catch {}
    }
  }
  if (!mkJson) { console.error('no marketplace available: refresh failed and no local cache'); process.exit(1); }
  console.error(`marketplace: ${source}, ${mkJson.plugins?.length ?? 0} plugins`);
  try {
    const r = await installPlugin({ name: sub, marketplaceJson: mkJson });
    console.log(`installed ${r.name} ${r.version} → ${r.path}`);
    if (r.cleanupWarning) console.error(r.cleanupWarning);
  } catch (e) { console.error(e.message); process.exit(1); }
  process.exit(0);
}
const mkts = (() => { try { return readFileSync(`${os.homedir()}/.zcode/cli/plugins/known_marketplaces.json`, 'utf8'); } catch { return null; } })();
let marketplace = {};
// The LISTING needs the same refresh as the install path, or a plugin we just
// installed from the CDN is reported as an "orphan" — present on disk, absent
// from the stale cache we compared it against.
if (!process.argv.includes('--offline')) {
  try { marketplace = { ...marketplace, ...marketplaceVersions(await fetchMarketplace()) }; } catch {}
}
for (const mktFile of ['zcode-plugins-official', 'claude-plugins-official']) {
  for (const file of ['zagent-marketplace.json', 'marketplace.json']) {
    try { marketplace = { ...marketplaceVersions(JSON.parse(readFileSync(`${os.homedir()}/.zcode/cli/plugins/marketplaces/${mktFile}/${file}`, 'utf8'))), ...marketplace }; } catch {}
  }
}
const installed = installedPlugins();
const suppressed = suppressedBuiltins();
const rows = updateReport({ marketplace, installed, suppressed });

if (q) {
  const hits = rows.filter(r => r.name.includes(q));
  if (!hits.length) { console.error(`no plugin matching '${q}'`); process.exit(1); }
  console.log(updateLine(hits));
} else {
  console.log(updateLine(rows));
  const updates = rows.filter(r => r.badge === 'update-available').length;
  if (updates) { console.error(`\n${updates} update(s) available`); process.exit(3); } // J4 notification: nonzero distinct code
}
