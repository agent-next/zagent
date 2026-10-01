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
import { existsSync, rmSync, readFileSync, openSync, closeSync, fstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptRequest, isolatedTurn, serializeWorkspaces, DAEMON_RESPONSE_TIMEOUT_MS } from './daemon-request.mjs';
import { daemonPaths, pidIsZagentd, logShowsListening } from './zagentd-paths.mjs';
import { acquireFileLockSync, writePrivateFileSync } from '../driver/credentials.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // = repo root
const [cmd, ...rest] = process.argv.slice(2);

if (!['start', 'stop', 'ask', '--serve', 'serve'].includes(cmd)) {
  console.error('usage: zagentd start | stop | ask "prompt"');
  process.exit(2);
}
// Socket/pid paths resolve on FIRST USE, never at import: a machine where no
// usable dir exists must fail the command that needs the socket, carrying the
// resolver's error naming every dir it tried — not crash every importer of
// this module at load time. Memoized so a process sees one consistent dir.
let pathsCache = null;
const paths = () => pathsCache ??= daemonPaths();

// The pid file names a live zagentd --serve process, or there is no daemon.
// Anything else recorded there is stale/foreign and must not be trusted.
const liveDaemonPid = () => {
  let pid = null;
  try { pid = Number(readFileSync(paths().pid, 'utf8').trim()); } catch {}
  return pidIsZagentd(pid) ? pid : null;
};

if (cmd === 'stop') {
  const { pid: PID_FILE } = paths();
  let pid = null;
  try { pid = Number(readFileSync(PID_FILE, 'utf8').trim()); } catch {}
  if (Number.isInteger(pid) && pid > 0) {
    if (pidIsZagentd(pid)) {
      process.kill(pid, 'SIGTERM');
      rmSync(PID_FILE, { force: true });
      console.log('daemon stopped');
      process.exit(0);
    }
    // Never signal a pid we cannot prove is the daemon: it may be a recycled
    // same-uid process, and the pid file itself may have been planted.
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    rmSync(PID_FILE, { force: true });
    if (alive) { console.error(`pid file names non-zagentd process ${pid}; removed it`); process.exit(1); }
  }
  console.log('daemon not running');
  process.exit(0);
}

if (cmd === 'ask') {
  const prompt = rest.join(' ');
  if (!prompt) { console.error('usage: zagentd ask "prompt"'); process.exit(1); }
  const { sock: SOCK } = paths();
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
  const { dir: RUN_DIR, sock: SOCK, pid: PID_FILE } = paths();
  // Single-instance lock (mkdir-based): serializes `start` and the daemon's own
  // socket setup inside the private runtime dir. A lock whose owner pid is dead
  // is reclaimed by acquireFileLockSync; a live holder is never stolen from.
  const START_LOCK = path.join(RUN_DIR, 'zagentd-start');
  const alreadyRunning = () => { console.log('daemon already running'); process.exit(0); };
  if (liveDaemonPid()) alreadyRunning();
  // The lock is taken BEFORE spawning: without it two concurrent starts both
  // find no pid file and each fork a daemon that then overwrites the pid file
  // and unlinks the other's socket path.
  let release;
  try {
    release = acquireFileLockSync(START_LOCK, { maxWaitMs: 10000 });
  } catch (e) {
    // Contention that outlives the holder usually means the other start just
    // won: its pid file names a live --serve child now.
    if (e?.code === 'ELOCKTIMEOUT' && liveDaemonPid()) alreadyRunning();
    throw e;
  }
  // The serve child's output lands in the private runtime dir, not /dev/null:
  // a daemon that dies at boot must be diagnosable from `start` itself.
  const LOG = path.join(RUN_DIR, 'zagentd.log');
  let logFd, logStart = 0;
  let child;
  try {
    if (liveDaemonPid()) { release(); alreadyRunning(); }
    rmSync(PID_FILE, { force: true }); // stale or foreign record — never trust it
    logFd = openSync(LOG, 'a');
    logStart = fstatSync(logFd).size; // only lines this spawn writes count as its proof of life
    // Daemon mode: fork ourselves detached
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'],
      { detached: true, stdio: ['ignore', logFd, logFd], env: process.env });
    child.unref();
    // Record the child pid before releasing the lock: the --serve argv is live
    // from spawn, so a racing `start` sees a live daemon even while this child
    // is still loading its modules.
    writePrivateFileSync(PID_FILE, `${child.pid}\n`);
  } finally { try { release?.(); } catch {} }
  // "daemon started" is a promise the socket keeps, so poll for the bind
  // instead of trusting spawn(). The lock is released above — the serve child
  // takes it for its own socket setup — and a child that dies at boot turns
  // into a nonzero exit carrying the log tail, not a silent missing socket.
  // Giving up also reaps the child: a daemon that never bound is not left
  // running behind a failed start.
  const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
  const deadline = Date.now() + 10000;
  const giveUp = async (why) => {
    try { closeSync(logFd); } catch {}
    try { child.kill('SIGKILL'); } catch {} // boot-failed daemon: no state worth a graceful ask
    rmSync(PID_FILE, { force: true });
    if (child.exitCode === null && child.signalCode === null)
      await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 2000))]);
    // The socket is ours to remove only if nothing serves it: a child that
    // refused to start because a live daemon already owns the path must not
    // take that daemon's socket away.
    if (!(await accepting())) rmSync(SOCK, { force: true });
    console.error(`daemon failed to ${why} (pid ${child.pid}, socket ${Buffer.byteLength(SOCK) + 1} bytes); ${LOG} tail:`);
    try { console.error(readFileSync(LOG, 'utf8').trimEnd().split('\n').slice(-20).join('\n') || '(empty)'); }
    catch { console.error('(no log)'); }
    process.exit(1);
  };
  // A socket FILE is not proof of a daemon: a stale one from a crashed run
  // exists before the child has removed it, and a connect can reach a DIFFERENT
  // live daemon that owns the path. Success needs both the serve child's own
  // "listening (pid <child>)" line in the log and a connect, with the child alive.
  const childListening = () => { try { return logShowsListening(readFileSync(LOG), logStart, SOCK, child.pid); } catch { return false; } };
  const accepting = () => new Promise(res => {
    const probe = connect(SOCK);
    probe.setTimeout(1000, () => { probe.destroy(); res(false); }); // a wedged listener must not outlast the deadline
    probe.once('connect', () => { probe.destroy(); res(true); });
    probe.once('error', () => res(false));
  });
  const childDied = () => child.exitCode !== null || child.signalCode !== null || !pidAlive(child.pid);
  for (;;) {
    if (childDied()) await giveUp('start');
    if (childListening() && await accepting() && !childDied()) break;
    if (Date.now() >= deadline) await giveUp('bind its socket within 10s');
    await new Promise(r => setTimeout(r, 100));
  }
  try { closeSync(logFd); } catch {}
  console.log(`daemon started (pid ${child.pid})`);
  process.exit(0);
}

if (cmd === '--serve' || cmd === 'serve') {
  // === THE DAEMON ===
  const { dir: RUN_DIR, sock: SOCK, pid: PID_FILE } = paths();
  const START_LOCK = path.join(RUN_DIR, 'zagentd-start');
  // Hold the start lock through socket setup: a second serve serializes behind
  // this one, then sees a live socket owner and refuses instead of unlinking
  // the path out from under the running daemon.
  const release = acquireFileLockSync(START_LOCK, { maxWaitMs: 15000 });
  let released = false;
  const releaseLock = () => { if (!released) { released = true; try { release(); } catch {} } };
  try {
    if (existsSync(SOCK)) {
      const owned = await new Promise(res => {
        const probe = connect(SOCK);
        probe.once('connect', () => { probe.destroy(); res(true); });
        probe.once('error', () => res(false));
      });
      if (owned) { console.error(`zagentd already running: ${SOCK} is owned by a live instance`); process.exit(1); }
      rmSync(SOCK, { force: true }); // stale socket file — safe to replace
    }
    writePrivateFileSync(PID_FILE, `${process.pid}\n`);
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
    // The kernel truncates over-long sun_path binds instead of failing them
    // (a 130-char Linux bind lands at 108 chars and reports success), so
    // "listening" is not proof the socket is where any client computes it.
    // daemonRuntimeDir keeps the path inside the room by construction; this
    // guard is the invariant made loud if that ever regresses.
    if (!existsSync(SOCK)) {
      console.error(`zagentd socket missing at ${SOCK} after listen — sun_path truncation?`);
      process.exit(1);
    }
    console.log(`zagentd listening on ${SOCK} (pid ${process.pid})`);
  });
  // Release the single-instance lock only once the socket is bound — a second
  // daemon serialized behind us then sees a live owner and refuses to start,
  // rather than probing a not-yet-listening path and unlinking it.
  server.once('listening', releaseLock);
  server.once('error', e => { releaseLock(); console.error(`zagentd listen failed: ${e.message}`); process.exit(1); });

  process.on('SIGTERM', () => {
    for (const { client } of sessions.values()) try { client.close(); } catch {}
    if (existsSync(SOCK)) rmSync(SOCK, { force: true });
    if (existsSync(PID_FILE)) rmSync(PID_FILE, { force: true });
    process.exit(0);
  });
  } catch (e) { releaseLock(); throw e; }
}
