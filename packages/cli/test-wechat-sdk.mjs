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
