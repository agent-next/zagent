#!/usr/bin/env node
// zagent feishu — D4 bot: webhook server, Feishu messages -> zcode turns -> replies.
// Env-gated AND default-deny: requires ZAGENT_FEISHU_APP_ID, ZAGENT_FEISHU_APP_SECRET and
// ZAGENT_FEISHU_ALLOWED_CHATS (comma-separated chat ids). Secrets never logged.
// Legacy ZMAX_FEISHU_* names are still read as fallbacks.
import http from 'node:http';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { tokenCache, sendText, makeInbox, FEISHU_API, feishuWebhookConfig } from '../driver/feishu.mjs';
import { ZCodeProtocolClient } from '../driver/zcode-protocol.mjs';
import { createChatTurnRunner } from '../driver/chat-turns.mjs';
import { bridgeAutoAllow } from '../driver/permissions.mjs';
import { preprocessForBot } from '../driver/mentions.mjs';
import { feishuAttachments, attachmentsNote } from '../driver/attachments.mjs';

const feishuEnv = key => process.env[`ZAGENT_FEISHU_${key}`] ?? process.env[`ZMAX_FEISHU_${key}`];
const appId = feishuEnv('APP_ID');
const appSecret = feishuEnv('APP_SECRET');
const allowed = (feishuEnv('ALLOWED_CHATS') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const { host, port, verifyToken, generatedToken } = feishuWebhookConfig();
if (!appId || !appSecret || allowed.length === 0) {
  console.error('zagent feishu: set ZAGENT_FEISHU_APP_ID, ZAGENT_FEISHU_APP_SECRET and ZAGENT_FEISHU_ALLOWED_CHATS (comma-separated chat ids; legacy ZMAX_FEISHU_* names still work). Default-deny: no allowlist, no bot. ZAGENT_FEISHU_VERIFY_TOKEN is optional — a fresh one is generated per run when unset; ZAGENT_FEISHU_HOST opts in to a non-loopback bind.');
  process.exit(1);
}
const workspace = feishuEnv('WORKSPACE') ?? os.homedir();
try { mkdirSync(workspace, { recursive: true }); } catch {} // runtime spawn needs an existing cwd
const getToken = tokenCache({ fetchImpl: fetch, appId, appSecret });
const sendReply = (chatId, text) => getToken().then(t => sendText(fetch, t, 'chat_id', chatId, text, { api: feishuEnv('API') ?? FEISHU_API }));

const turns = createChatTurnRunner({ workspace,
  createClient: () => new ZCodeProtocolClient({ cwd: workspace, requestHandlers: { 'interaction/requestPermission': bridgeAutoAllow } }),
});
const inbox = makeInbox({
  handler: async (chatId, text, rawEvent) => {
    if (text === '/ping') return 'pong';
    const att = attachmentsNote(feishuAttachments(rawEvent));
    if (att && !text.trim()) return att; // attachment-ONLY: disclose, no turn
    const attSuffix = att || ''; // mixed: text still runs; disclosure appended
    const pre = preprocessForBot(text, workspace);
    if (pre.note) return pre.note; // mention validation: no turn spent on missing files
    const ans = (await turns.run(chatId, pre.prompt)) || '(no answer)';
    return attSuffix ? `${ans}\n(${attSuffix})` : ans;
  },
  sendReply, allowedChatIds: allowed, verifyToken,
  onEvent: (t, d) => { if (t !== 'message') console.error(`[${t}]`, String(d).slice(0, 120)); },
});
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let buf = '';
  req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); }); // 1MB guard
  req.on('end', async () => {
    try {
      let body; try { body = JSON.parse(buf); } catch { res.writeHead(400).end(); return; }
      if (body === null || typeof body !== 'object') { res.writeHead(400).end(); return; } // r3 #2: scalars/arrays
      const r = await inbox(body);
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
    } catch { try { res.writeHead(500).end(); } catch {} } // r3 #2: no unhandled rejection kills the server
  });
});
server.listen(port, host, () => {
  console.log(`zagent feishu bot: webhook on ${host}:${port} (workspace ${workspace}; ${allowed.length} authorized chat(s); Ctrl+C to stop)`);
  if (generatedToken) console.log(`zagent feishu bot: generated one-run verify token (paste into the app's Verification Token, or set ZAGENT_FEISHU_VERIFY_TOKEN to pin it): ${verifyToken}`);
});
process.on('SIGINT', () => { console.error('stopping…'); server.close(); try { turns.close(); } catch {}; setTimeout(() => process.exit(0), 500); });
