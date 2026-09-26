#!/usr/bin/env node
// zagentd — persistent daemon for zagent. Keeps a warm ZCode runtime + cached sessions.
// The CLI connects via unix socket, sends a prompt, gets the answer back in ~2-5s
// instead of ~11s cold start. This is the "top 1" performance play.
//
// Usage: node packages/cli/zagentd.mjs start  (background daemon)
//        node packages/cli/zagentd.mjs ask "prompt"  (connect to daemon)
//        node packages/cli/zagentd.mjs stop
import { createServer, connect } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptRequest, isolatedTurn, serializeWorkspaces, DAEMON_RESPONSE_TIMEOUT_MS } from './daemon-request.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // = repo root
const SOCK = `${os.tmpdir()}/zagentd-${process.getuid()}.sock`;
const PID_FILE = `${os.tmpdir()}/zagentd-${process.getuid()}.pid`;

const [cmd, ...rest] = process.argv.slice(2);

if (!['start', 'stop', 'ask', '--serve', 'serve'].includes(cmd)) {
  console.error('usage: zagentd start | stop | ask "prompt"');
  process.exit(2);
}

if (cmd === 'stop') {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 'SIGTERM');
    rmSync(PID_FILE, { force: true });
    console.log('daemon stopped');
  } catch { console.log('daemon not running'); }
  process.exit(0);
}

if (cmd === 'ask') {
  const prompt = rest.join(' ');
  if (!prompt) { console.error('usage: zagentd ask "prompt"'); process.exit(1); }
  const start = Date.now();
  const client = connect(SOCK);
  client.on('error', () => { console.error('daemon not running (start with: zagentd start)'); process.exit(1); });
  client.on('connect', () => client.write(JSON.stringify({ prompt, cwd: process.cwd() }) + '\n'));
  let buf = '', received = false;
  client.setEncoding('utf8');
  client.on('end', () => { if (!received) { console.error('daemon closed before a response'); process.exit(1); } });
  client.on('data', d => {
    if (received) return;
    buf += d;
    const idx = buf.indexOf('\n');
    if (idx >= 0) {
      received = true;
      try {
        const resp = JSON.parse(buf.slice(0, idx));
        if (!resp || typeof resp !== 'object' || Array.isArray(resp)) throw new Error('invalid response');
        client.destroy();
        const failed = resp.error != null || resp.ended === 'turn-failed';
        process.stdout.write(JSON.stringify(resp) + '\n', () => process.exit(failed ? 1 : 0));
      } catch { console.error('unparseable daemon response'); client.destroy(); process.exit(1); }
    }
  });
  setTimeout(() => { console.error('timeout'); process.exit(1); }, DAEMON_RESPONSE_TIMEOUT_MS);
  // keep alive
  setInterval(() => {}, 1000);
  process.on('exit', () => console.error(`wall: ${((Date.now() - start) / 1000).toFixed(1)}s`));
}

if (cmd === 'start') {
  if (existsSync(PID_FILE)) {
    try { process.kill(parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10), 0); console.log('daemon already running'); process.exit(0); }
    catch { rmSync(PID_FILE, { force: true }); } // stale PID
  }
  // Daemon mode: fork ourselves detached
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'],
    { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  console.log(`daemon started (pid ${child.pid})`);
  process.exit(0);
}

if (cmd === '--serve' || cmd === 'serve') {
  // === THE DAEMON ===
  const { ZCodeProtocolClient, runTurn, extractUsage, usageLine, toolCallSummary, groupTools, turnSummary } = await import(new URL('../driver/zcode-protocol.mjs', import.meta.url).href);
  const { sessionUsage, compactSession } = await import(new URL('../driver/session-control.mjs', import.meta.url).href);
  const { autoAllow } = await import(new URL('../driver/permissions.mjs', import.meta.url).href);
  const sessions = new Map(); // cwd -> { client, sessionId, lastUsed, usage }
  const mergeTotals = (a = { deltas: 0 }, b = { deltas: 0 }) => { // sum two usage totals (missing keys default 0)
    const out = { deltas: (a.deltas ?? 0) + (b.deltas ?? 0) };
    for (const k of ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'])
      out[k] = (a[k] ?? 0) + (b[k] ?? 0);
    return out;
  };
  const mergeByModel = (a = {}, b = {}) => { // per-model sums; models present in only one side carry over
    const out = {};
    for (const [m, v] of [...Object.entries(a), ...Object.entries(b)]) out[m] = mergeTotals(out[m], v);
    return out;
  };
  writeFileSync(PID_FILE, `${process.pid}\n`);
  if (existsSync(SOCK)) rmSync(SOCK, { force: true });

  const handleRequest = serializeWorkspaces(async req => {
      if (req.op === 'compact') { // compact the daemon's WARM session for this cwd (live sessions live here)
        try { // r8: exactly ONE response on every path; compact is async — report ACCEPTED, not a raced after-value
          const cached = sessions.get(req.cwd);
          if (!cached) return { error: 'no warm session for this workspace (ask first)' };
          const r = await compactSession(cached.client, cached.sessionId);
          return { compacted: cached.sessionId, accepted: true,
            state: r?.compact?.state ?? 'accepted' };
        } catch (e) { throw new Error(`compact failed: ${e.message}`); }
      }
      const { prompt, cwd } = req;
      const tAsk = Date.now();
      try {
        let cached = sessions.get(cwd);
        if (cached && Date.now() - cached.lastUsed > 5 * 60_000) {
          try { cached.client.close(); } catch {}
          sessions.delete(cwd); cached = undefined;
        }
        if (!cached) {
          // daemon = scripted use: auto-allow (the TUI remains the interactive surface).
          // Deliberately plain autoAllow, not bridgeAutoAllow — no remote chat drives this.
          const client = new ZCodeProtocolClient({ cwd, requestHandlers: { 'interaction/requestPermission': autoAllow } });
          try {
            await client.ready;
            const created = await client.createSession(cwd);
            const sid = created.session?.sessionId ?? created.sessionId;
            cached = { client, sessionId: sid, lastUsed: Date.now() };
            sessions.set(cwd, cached);
          } catch (e) { client.close(); throw e; }
        }
        cached.lastUsed = Date.now();
        const { end, events, answer } = await isolatedTurn(cached, prompt, runTurn);
        const turnUsage = extractUsage(events); // E7: per-turn usage from usage.delta telemetry
        cached.usage = { totals: mergeTotals(cached.usage?.totals, turnUsage.totals),
          byModel: mergeByModel(cached.usage?.byModel, turnUsage.byModel) }; // cumulative per workspace session
        return { answer, ended: end.ended, sessions: sessions.size,
          usage: { turn: turnUsage, session: usageLine(cached.usage),
            api: await sessionUsage(cached.client, cached.sessionId).catch(() => null) },
          tools: { ...toolCallSummary(events, cached.sessionId), groups: groupTools(toolCallSummary(events, cached.sessionId).tools) },
          summary: turnSummary({ end, events, turnMs: Date.now() - tAsk, usage: turnUsage }, toolCallSummary(events, cached.sessionId)) };
      } catch (e) {
        try { sessions.get(cwd)?.client.close(); } catch {}
        sessions.delete(cwd);
        throw e;
      }
  });
  const server = createServer(sock => acceptRequest(sock, handleRequest));

  server.listen(SOCK, () => {
    console.log(`zagentd listening on ${SOCK} (pid ${process.pid})`);
  });

  process.on('SIGTERM', () => {
    for (const { client } of sessions.values()) try { client.close(); } catch {}
    if (existsSync(SOCK)) rmSync(SOCK, { force: true });
    if (existsSync(PID_FILE)) rmSync(PID_FILE, { force: true });
    process.exit(0);
  });
}
