#!/usr/bin/env node
// zagent wechat — D6 bot via the PUBLIC iLink Bot API, integrated through the
// @wechatbot/wechatbot SDK (OPTIONAL peer dependency — install separately; we vendor
// nothing and re-implement no protocol). Docs-verified surface (wechatbot.dev + qwenlm
// channel docs, 2026-09-06): QR login (no static token; sessions expire errcode -14),
// DM-only, plain text (markdown stripped), typing indicator, default-deny allowlist.
// Env: ZAGENT_WECHAT_ALLOWED_USERS (comma-separated; REQUIRED — no allowlist, no bot).
// Legacy ZMAX_WECHAT_* names are still read as fallbacks.
import os from 'node:os';

const wxEnv = key => process.env[`ZAGENT_WECHAT_${key}`] ?? process.env[`ZMAX_WECHAT_${key}`];
const allowed = (wxEnv('ALLOWED_USERS') ?? '').split(',').map(s => s.trim()).filter(Boolean);
if (!allowed.length) {
  console.error('zagent wechat: set ZAGENT_WECHAT_ALLOWED_USERS (authorized WeChat user ids; legacy ZMAX_WECHAT_* names still work). Default-deny: no allowlist, no bot.');
  console.error('Also install the SDK:  npm i -g @wechatbot/wechatbot   (optional peer — we ship none)');
  process.exit(1);
}
const workspace = wxEnv('WORKSPACE') ?? os.homedir();

// The SDK is an optional peer we do not ship: a bare import covers repo-local
// `npm i`, and loadWeChatSdk also resolves the global npm root so the printed
// `npm i -g` remedy is real (bare ESM specifiers never see global packages).
const { loadWeChatSdk } = await import('./wechat-sdk.mjs');
const sdk = await loadWeChatSdk();
const WeChatBot = sdk?.WeChatBot;
if (typeof WeChatBot !== 'function') {
  console.error('SDK not installed: npm i -g @wechatbot/wechatbot — or `npm i @wechatbot/wechatbot` in the zagent checkout (iLink Bot API SDK, QR login, DM-only)');
  process.exit(1);
}

const { ZCodeProtocolClient } = await import('../driver/zcode-protocol.mjs');
const { createChatTurnRunner } = await import('../driver/chat-turns.mjs');
const { bridgeAutoAllow } = await import('../driver/permissions.mjs');
const { preprocessForBot } = await import('../driver/mentions.mjs');

const turns = createChatTurnRunner({ workspace,
  createClient: () => new ZCodeProtocolClient({ cwd: workspace, requestHandlers: { 'interaction/requestPermission': bridgeAutoAllow } }),
});

const bot = new WeChatBot();
// QR polls time out after ~60s if nobody scans; the owner is a human who may come
// later — keep fetching fresh QRs (each logged) instead of dying. First scan wins and
// the SDK persists credentials, so subsequent starts skip QR entirely.
let live = false;
for (let attempt = 1; !live; attempt++) {
  try { await bot.login(); live = true; }
  catch (e) {
    if (/timeout/i.test(String(e?.message ?? e)) && attempt < 30) {
      console.error(`[login] QR window ${attempt} expired unscanned — fetching a fresh QR…`);
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }
    console.error(`login failed: ${String(e?.message ?? e).slice(0, 160)}`); process.exit(1);
  }
}
console.log(`zagent wechat bot: live (workspace ${workspace}; ${allowed.length} allowed user(s))`);

let messageQueue = Promise.resolve();
bot.onMessage(msg => {
  const work = messageQueue.then(async () => {
    const userId = String(msg.userId); // SDK may deliver numeric ids
    if (!allowed.includes(userId)) return;
    await bot.sendTyping(userId);
    const pre = preprocessForBot(msg.text ?? '', workspace);
    if (pre.note) { await bot.reply(msg, pre.note); return; }
    const ans = (await turns.run(userId, pre.prompt)) || '(no answer)';
    await bot.reply(msg, ans.slice(0, 2000));
  });
  messageQueue = work.catch(e => console.error(`[message_error] ${String(e?.message ?? e).slice(0, 200)}`));
  return messageQueue;
});
process.on('SIGINT', () => { // r20: registered BEFORE start(); graceful SDK stop then client close
  try { bot.stop?.(); } catch {}
  try { turns.close(); } catch {}
});
await bot.start();
