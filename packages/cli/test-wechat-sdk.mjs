// wechat SDK loader — the documented `npm i -g` remedy must actually resolve:
// bare ESM specifiers never search the global root, so the loader walks it
// explicitly.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sdkEntryUrl, loadWeChatSdk } from './wechat-sdk.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

// A fabricated global root holding an ESM-only SDK (exports['.'] -> file).
const root = mkdtempSync(path.join(os.tmpdir(), 'zwxsdk-'));
const dir = path.join(root, '@wechatbot', 'wechatbot');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'package.json'),
  JSON.stringify({ name: '@wechatbot/wechatbot', version: '0.0.0', type: 'module', exports: { '.': './sdk.mjs' } }));
writeFileSync(path.join(dir, 'sdk.mjs'), 'export class WeChatBot { marker() { return 42; } }\n');

ok(sdkEntryUrl(root)?.endsWith('sdk.mjs'), 'entry resolved from the exports map');
ok(sdkEntryUrl(path.join(root, 'absent')) === null, 'missing package -> null entry');
const mod = await loadWeChatSdk({ globalRoot: root });
ok(typeof mod?.WeChatBot === 'function' && new mod.WeChatBot().marker() === 42,
  'global-installed SDK loads via npm root fallback');

// Manifest shapes a real package can carry. sdkEntryUrl takes the npm ROOT,
// so each probed manifest lives under <shapes>/@wechatbot/wechatbot.
const shapes = mkdtempSync(path.join(os.tmpdir(), 'zwxshapes-'));
const WECHAT = '@wechatbot/wechatbot';
const pkgDir = path.join(shapes, '@wechatbot', 'wechatbot');
const probe = (manifest, files) => {
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: WECHAT, ...manifest }));
  for (const f of files) { mkdirSync(path.dirname(path.join(pkgDir, f)), { recursive: true }); writeFileSync(path.join(pkgDir, f), 'export {};\n'); }
  return sdkEntryUrl(shapes);
};
ok(probe({ exports: './sdk.mjs' }, ['sdk.mjs'])?.endsWith('/sdk.mjs'), 'string exports sugar resolves');
ok(probe({ exports: { '.': './dot.mjs', './extra': './x.mjs' } }, ['dot.mjs'])?.endsWith('/dot.mjs'), 'subpath map "." entry resolves');
ok(probe({ exports: { '.': { import: './esm.mjs', default: './fb.cjs' } } }, ['esm.mjs', 'fb.cjs'])?.endsWith('/esm.mjs'), 'conditional under "." prefers import');
ok(probe({ exports: { import: './top.mjs', default: './fb.cjs' } }, ['top.mjs', 'fb.cjs'])?.endsWith('/top.mjs'), 'top-level conditions object resolves');
ok(probe({ exports: { default: './d.mjs' } }, ['d.mjs'])?.endsWith('/d.mjs'), 'default-only conditions object resolves');
ok(probe({ exports: { '.': { import: { node: './n.mjs', default: './d.mjs' } } } }, ['n.mjs', 'd.mjs'])?.endsWith('/n.mjs'), 'nested conditions walk to a file');
ok(probe({ main: './legacy.cjs' }, ['legacy.cjs'])?.endsWith('/legacy.cjs'), 'main fallback resolves');
ok(probe({}, ['index.js'])?.endsWith('/index.js'), 'bare manifest falls back to index.js');
ok(probe({ exports: './missing.mjs' }, []) === null, 'exports naming a missing file -> null');
rmSync(shapes, { recursive: true, force: true });

// Absent-SDK outcomes are only checkable when the bare import genuinely fails
// (this repo ships no @wechatbot/wechatbot dependency).
let bare = null;
try { bare = await import('@wechatbot/wechatbot'); } catch {}
if (!bare) {
  ok(await loadWeChatSdk({ globalRoot: path.join(root, 'absent') }) === null, 'absent SDK resolves to null, not a crash');
  ok(await loadWeChatSdk({ globalRoot: null }) === null, 'no global root -> null');
}
rmSync(root, { recursive: true, force: true });
console.log(fails ? `FAIL (${fails})` : 'PASS wechat-sdk');
process.exit(fails ? 1 : 0);
