// Load the optional @wechatbot/wechatbot SDK.
//
// A bare ESM import only searches node_modules above this file — i.e. a
// repo-local `npm i @wechatbot/wechatbot`. It never consults the global root,
// so the documented `npm i -g` remedy used to still produce "SDK not
// installed". Resolve `npm root -g` explicitly so both install shapes work.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const WECHAT_SDK = '@wechatbot/wechatbot';

export function npmGlobalRoot() {
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
    return root || null;
  } catch { return null; }
}

// Walk an exports value down the conditions an ESM import honours.
const pickEntry = exp => {
  if (typeof exp === 'string') return exp;
  if (exp && typeof exp === 'object') return pickEntry(exp.import ?? exp.node ?? exp.default);
  return null;
};

// <root>/@wechatbot/wechatbot → importable file URL. Reads package.json
// directly: require.resolve honours the "require" condition and can miss an
// ESM-only exports map. Manifest shapes handled: string sugar
// ("exports": "./sdk.mjs"), a conditions object ({"import":…,"default":…})
// either at top level or under ".", a subpath map (keys start with '.'),
// then module/main, then index.js.
export function sdkEntryUrl(root) {
  const dir = join(root, ...WECHAT_SDK.split('/'));
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
  catch { return null; }
  const exp = pkg.exports;
  const subpathMap = exp != null && typeof exp === 'object' && Object.keys(exp).some(k => k.startsWith('.'));
  const rel = (typeof exp === 'string' ? exp : null)
    ?? (subpathMap ? pickEntry(exp['.']) : pickEntry(exp))
    ?? (typeof pkg.module === 'string' ? pkg.module : null)
    ?? (typeof pkg.main === 'string' ? pkg.main : null)
    ?? 'index.js';
  const file = join(dir, rel);
  return existsSync(file) ? pathToFileURL(file).href : null;
}

export async function loadWeChatSdk({ globalRoot = npmGlobalRoot() } = {}) {
  try { return await import(WECHAT_SDK); } catch {}
  const href = globalRoot && sdkEntryUrl(globalRoot);
  if (!href) return null;
  try { return await import(href); } catch { return null; }
}
