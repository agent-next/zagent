#!/usr/bin/env node
// zagent telegram — run the D5 bot: Telegram messages -> zcode turns -> replies.
// Env-gated AND sender-authorized (default-deny): requires ZAGENT_TELEGRAM_TOKEN and
// ZAGENT_TELEGRAM_CHAT_IDS (comma-separated numeric chat ids authorized to drive the agent).
// Tokens/ids are never logged. Legacy ZMAX_TELEGRAM_* names are still read as fallbacks.
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { runBot } from '../driver/telegram.mjs';
import { ZCodeProtocolClient } from '../driver/zcode-protocol.mjs';
import { createChatTurnRunner } from '../driver/chat-turns.mjs';
import { bridgeAutoAllow } from '../driver/permissions.mjs';
import { preprocessForBot } from '../driver/mentions.mjs';
import { telegramAttachments, attachmentsNote } from '../driver/attachments.mjs';

const tgEnv = key => process.env[`ZAGENT_TELEGRAM_${key}`] ?? process.env[`ZMAX_TELEGRAM_${key}`];
const token = tgEnv('TOKEN');
const chatIds = (tgEnv('CHAT_IDS') ?? '').split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
if (!token || chatIds.length === 0) {
  console.error('zagent telegram: set ZAGENT_TELEGRAM_TOKEN (BotFather) and ZAGENT_TELEGRAM_CHAT_IDS (authorized chat ids, comma-separated; legacy ZMAX_TELEGRAM_* names still work). Default-deny: no chat ids, no bot.');
  process.exit(1);
}
const workspace = tgEnv('WORKSPACE') ?? os.homedir();
try { mkdirSync(workspace, { recursive: true }); } catch {} // runtime spawn needs an existing cwd
console.log(`zagent telegram bot: polling… (workspace ${workspace}; ${chatIds.length} authorized chat(s); Ctrl+C to stop)`);

const turns = createChatTurnRunner({ workspace,
  createClient: () => new ZCodeProtocolClient({ cwd: workspace, requestHandlers: { 'interaction/requestPermission': bridgeAutoAllow } }),
});

const bot = await runBot({
  token, allowedChatIds: chatIds,
  // Restart-safe redelivery: an answered-but-undelivered update survives a
  // process restart here and is resent, never re-run.
  stateFile: `${os.homedir()}/.zcode/cli/telegram-state.json`,
  handler: async (chatId, text, rawMessage) => {
    if (text === '/ping') return 'pong';
    const att = attachmentsNote(telegramAttachments(rawMessage));
    if (att && !text.trim()) return att; // attachment-ONLY: disclose, no turn
    const attSuffix = att || ''; // mixed: text still runs; disclosure appended to the answer
    const pre = preprocessForBot(text, workspace);
    if (pre.note) return pre.note; // mention validation: no turn spent on missing files
    const ans = (await turns.run(chatId, pre.prompt)) || '(no answer)';
    return attSuffix ? `${ans}\n(${attSuffix})` : ans;
  },
  onEvent: (t, d) => { if (t !== 'message') console.error(`[${t}]`, String(d).slice(0, 120)); },
});
process.on('SIGINT', () => { console.error('stopping…'); bot.stop(); setTimeout(() => { try { turns.close(); } catch {} process.exit(0); }, 500); });
await bot.done;
