#!/usr/bin/env node
// zagent plugins [name] — J4 update-notification surface over the official marketplace
// cache: badges update-available/ok/not-installed/orphan/unknown-version + suppressed
// markers. Read-only (J3 install is a separate, heavier surface).
import { loadCatalog, providerList, findModel } from '../driver/providers.mjs';
import { marketplaceVersions, installedPlugins, suppressedBuiltins, updateReport, updateLine, installPlugin } from '../driver/plugins.mjs';
import { readFileSync } from 'node:fs';
import os from 'node:os';

const [arg, sub] = process.argv.slice(2);
const q = arg === 'install' ? null : arg;
if (arg === 'install') {
  if (!sub) { console.error('usage: zagent plugins install <name>'); process.exit(2); }
  let mkJson = null;
  try { mkJson = JSON.parse(readFileSync(`${os.homedir()}/.zcode/cli/plugins/marketplaces/zcode-plugins-official/marketplace.json`, 'utf8')); } catch {}
  if (!mkJson) { console.error('official marketplace cache not found'); process.exit(1); }
  try {
    const r = await installPlugin({ name: sub, marketplaceJson: mkJson });
    console.log(`installed ${r.name} ${r.version} → ${r.path}`);
    if (r.cleanupWarning) console.error(r.cleanupWarning);
  } catch (e) { console.error(e.message); process.exit(1); }
  process.exit(0);
}
const mkts = (() => { try { return readFileSync(`${os.homedir()}/.zcode/cli/plugins/known_marketplaces.json`, 'utf8'); } catch { return null; } })();
let marketplace = {};
for (const mktFile of ['zcode-plugins-official', 'claude-plugins-official']) {
  try { marketplace = { ...marketplace, ...marketplaceVersions(JSON.parse(readFileSync(`${os.homedir()}/.zcode/cli/plugins/marketplaces/${mktFile}/marketplace.json`, 'utf8'))) }; } catch {}
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
