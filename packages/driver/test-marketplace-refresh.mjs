// Marketplace refresh. installPlugin() always verified and installed correctly,
// but the CLI only read the LOCAL cache — which the desktop app writes, and which
// on a real machine was five weeks stale: 2 plugins cached while the CDN listed
// 18. `zagent plugins install video2code` therefore failed with "no verifiable
// source" for a plugin that exists and is published.
//
// fetch is injected throughout; these assertions never touch the network.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchMarketplace, OFFICIAL_MARKETPLACE_URL, marketplaceVersions } from './plugins.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const CATALOG = { name: 'zcode-plugins-official', plugins: [
  { name: 'video2code', version: '0.6.0',
    source: { url: 'https://cdn-zcode.z.ai/zcode/official-plugin/plugins/video2code/0.6.0/plugin.zip', sha256: 'a'.repeat(64) } },
  { name: 'video-agent-kit', version: '0.4.3', requiresPaidPlan: true,
    source: { url: 'https://cdn-zcode.z.ai/zcode/official-plugin/plugins/video-agent-kit/0.4.3/plugin.zip', sha256: 'b'.repeat(64) } },
] };

const sandbox = () => {
  const home = mkdtempSync(path.join(tmpdir(), 'zagent-mkt-'));
  mkdirSync(path.join(home, '.zcode', 'cli', 'plugins'), { recursive: true });
  return home;
};
const withKnown = (home, url) => {
  writeFileSync(path.join(home, '.zcode', 'cli', 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ version: 1, marketplaces: [{ id: 'zcode-plugins-official', source: { source: 'url', url } }] }));
};
const okFetch = (body = CATALOG) => async () => ({ ok: true, status: 200, json: async () => body });

const home = sandbox();
try {
  // --- the happy path ----------------------------------------------------------
  let seen = null;
  const catalog = await fetchMarketplace({ home, fetchImpl: async (u) => { seen = u; return (await okFetch()())?.valueOf?.() ?? { ok: true, status: 200, json: async () => CATALOG }; } });
  ok(seen === OFFICIAL_MARKETPLACE_URL, 'with no local record it uses the official CDN url');
  ok(catalog.plugins.length === 2, 'the catalog comes back parsed');
  ok(Object.keys(marketplaceVersions(catalog)).includes('video2code'), 'and feeds the version map the CLI uses');

  // --- the cache is ours, not the runtime's ------------------------------------
  const dir = path.join(home, '.zcode', 'cli', 'plugins', 'marketplaces', 'zcode-plugins-official');
  ok(existsSync(path.join(dir, 'zagent-marketplace.json')), 'the refresh caches under OUR filename');
  ok(!existsSync(path.join(dir, 'marketplace.json')),
     'and never overwrites marketplace.json, which the desktop app maintains');
  ok(JSON.parse(readFileSync(path.join(dir, 'zagent-marketplace.json'), 'utf8')).plugins.length === 2,
     'the cached copy is the catalog');

  // --- the local record is honoured, but not blindly ---------------------------
  withKnown(home, 'https://cdn-zcode.z.ai/zcode/official-plugin/other.json');
  seen = null;
  await fetchMarketplace({ home, fetchImpl: async (u) => { seen = u; return { ok: true, status: 200, json: async () => CATALOG }; } });
  ok(seen.endsWith('/other.json'), 'a url recorded by the runtime is used');

  // A local file is not a sufficient reason to fetch from anywhere.
  for (const [url, why] of [
    ['http://cdn-zcode.z.ai/x.json', 'plain http is refused'],
    ['https://evil.example.com/marketplace.json', 'a non-official host is refused'],
    ['https://cdn-zcode.z.ai.evil.com/x.json', 'a lookalike host is refused'],
    ['not a url at all', 'an unparseable url is refused'],
  ]) {
    withKnown(home, url);
    let threw = null;
    try { await fetchMarketplace({ home, fetchImpl: async () => { throw new Error('should not have been called'); } }); }
    catch (e) { threw = e; }
    ok(threw !== null && /non-official source/.test(threw.message), why);
  }

  // --- bad responses fail loudly, they do not poison the cache -----------------
  withKnown(home, OFFICIAL_MARKETPLACE_URL);
  const bad = async (fetchImpl) => {
    try { await fetchMarketplace({ home, fetchImpl }); return null; } catch (e) { return e.message; }
  };
  ok(/http 503/.test(await bad(async () => ({ ok: false, status: 503 })) ?? ''), 'a failed request reports its status');
  ok(/no plugins array/.test(await bad(async () => ({ ok: true, status: 200, json: async () => ({}) })) ?? ''),
     'a response with no plugins array is rejected');
  ok(/no plugins array/.test(await bad(async () => ({ ok: true, status: 200, json: async () => ({ plugins: 'nope' }) })) ?? ''),
     'a non-array plugins field is rejected');
  ok(JSON.parse(readFileSync(path.join(dir, 'zagent-marketplace.json'), 'utf8')).plugins.length === 2,
     'a rejected response leaves the previous cache intact');

  // --- a read-only home must not break an install ------------------------------
  const roCatalog = await fetchMarketplace({ home, write: false, fetchImpl: async () => ({ ok: true, status: 200, json: async () => CATALOG }) });
  ok(roCatalog.plugins.length === 2, 'write:false still returns the catalog');
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
