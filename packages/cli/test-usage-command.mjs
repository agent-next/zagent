#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseUsageArgs, recentSessionId, runUsage, USAGE } from './zagent-usage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const home = mkdtempSync(path.join(tmpdir(), 'zagent-usage-cli-'));
const io = () => {
  let out = '', err = '';
  return {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    get out() { return out; },
    get err() { return err; },
  };
};
const fake = (reply, fail) => {
  const calls = [];
  return {
    calls,
    call: async (m, p) => {
      calls.push({ m, p });
      if (fail) throw fail;
      return reply;
    },
    close() { this.closed = true; },
  };
};

try {
  assert.deepEqual(parseUsageArgs([]), { json: false, session: undefined });
  assert.equal(parseUsageArgs(['--json']).json, true);
  assert.equal(parseUsageArgs(['--session', 's1']).session, 's1');
  assert.equal(parseUsageArgs(['--session=s2', '--json']).session, 's2');
  for (const args of [['list'], ['--bogus'], ['--session'], ['--session='], ['s1'],
    ['stats', '--range', 'bogus'], ['stats', '--range'], ['stats', '--session', 'x'],
    ['stats', 'extra'], ['--range', '7d'], ['--range=30d'], ['stats', '--range=']]) {
    assert.equal(parseUsageArgs(args).error, USAGE, JSON.stringify(args));
  }
  assert.deepEqual(parseUsageArgs(['stats']), { action: 'stats', json: false, range: '7d' });
  assert.deepEqual(parseUsageArgs(['stats', '--range', '30d', '--json']),
    { action: 'stats', json: true, range: '30d' });
  assert.deepEqual(parseUsageArgs(['stats', '--range=all']),
    { action: 'stats', json: false, range: 'all' });

  mkdirSync(path.join(home, '.zcode/v2'), { recursive: true });
  const db = new DatabaseSync(path.join(home, '.zcode/v2/tasks-index.sqlite'));
  db.exec(`CREATE TABLE tasks (
    workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
    task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT, provider TEXT,
    mode TEXT NOT NULL DEFAULT 'build', model TEXT, migration_source TEXT, forked_from_task_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, unread_at INTEGER,
    last_unread_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
    title_overridden INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}',
    searchable_text TEXT NOT NULL DEFAULT '', cron_automation_id TEXT, off_peak_task_id TEXT,
    PRIMARY KEY (workspace_key, task_id))`);
  db.prepare(`INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status,
    created_at, updated_at) VALUES (?,?,?,?,?,?,?)`).run('/w', '/w', 'sess_recent', 'P', 'running', 1, 5);
  db.close();
  assert.equal(recentSessionId({ home }), 'sess_recent');

  const reply = {
    totalTokens: 18474,
    inputTokens: 17000,
    outputTokens: 1400,
    reasoningTokens: 74,
    cacheReadTokens: 8000,
    cacheCreationTokens: 500,
    modelRequestCount: 12,
    modelErrorCount: 1,
    inputBaselineBySource: { main_turn: 18474 },
  };
  const client = fake(reply);
  const cap = io();
  assert.equal(await runUsage([], { client, home, stdout: cap.stdout, stderr: cap.stderr }), 0);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].m, 'session/usage');
  assert.deepEqual(client.calls[0].p, { sessionId: 'sess_recent' });
  assert.match(cap.out, /session: sess_recent/);
  assert.match(cap.out, /totalTokens: 18474/);
  assert.match(cap.out, /inputTokens: 17000/);
  assert.match(cap.out, /outputTokens: 1400/);
  assert.match(cap.out, /cacheReadTokens: 8000/);
  assert.match(cap.out, /modelRequestCount: 12/);
  assert.match(cap.out, /modelErrorCount: 1/);
  assert.match(cap.out, /inputBaselineBySource: main_turn=18474/);
  assert.match(cap.err, /using latest CLI session sess_recent, started .* ago/);

  const jsonIo = io();
  const jsonClient = fake(reply);
  assert.equal(await runUsage(['--json', '--session', 's-explicit'], {
    client: jsonClient, home, stdout: jsonIo.stdout, stderr: jsonIo.stderr,
  }), 0);
  assert.deepEqual(jsonClient.calls[0].p, { sessionId: 's-explicit' });
  const parsed = JSON.parse(jsonIo.out);
  assert.equal(parsed.sessionId, 's-explicit');
  assert.equal(parsed.totalTokens, 18474);
  assert.equal(parsed.inputTokens, 17000);
  assert.equal(parsed.modelErrorCount, 1);
  assert.deepEqual(parsed.baselineBySource, { main_turn: 18474 });

  const empty = io();
  const emptyClient = fake({});
  assert.equal(await runUsage(['--session', 's1'], {
    client: emptyClient, stdout: empty.stdout, stderr: empty.stderr,
  }), 0);
  assert.match(empty.out, /totalTokens: 0/);
  assert.match(empty.out, /inputBaselineBySource: \(none\)/);

  const none = io();
  assert.equal(await runUsage([], {
    resolveSession: () => null, client: fake({}), stdout: none.stdout, stderr: none.stderr,
  }), 2);
  assert.match(none.err, /usage: no session/);
  assert.equal(none.out, '');

  const boom = io();
  assert.equal(await runUsage(['--session', 's1'], {
    client: fake(null, Object.assign(new Error('session not found'), { code: -32004 })),
    stdout: boom.stdout, stderr: boom.stderr,
  }), 0);
  assert.match(boom.out, /This session is not running\. Live sessions are process-local/);

  const usage = io();
  assert.equal(await runUsage(['nope'], {
    client: fake({}), stdout: usage.stdout, stderr: usage.stderr,
  }), 2);
  assert.equal(usage.err, `${USAGE}\n`);

  // Positional near-misses name the one real word — the dispatcher/quota
  // <3-edit bound plus a prefix allowance ('st' is 3 edits out). 'nope'
  // above stays silent (5 edits); flag tokens and one-letter prefixes never
  // hint. The stderr hint never enters the --json stdout envelope.
  for (const args of [['stat'], ['st'], ['sttats'], ['stats', 'sttats'], ['attas']]) {
    const tio = io();
    assert.equal(await runUsage(args, {
      client: fake({}), stdout: tio.stdout, stderr: tio.stderr,
    }), 2, JSON.stringify(args));
    assert.match(tio.err, /did you mean 'stats'\?/, JSON.stringify(args));
    assert.match(tio.err, /^usage: zagent usage/);
  }
  for (const args of [['s'], ['sessionx'], ['--bogus']]) {
    const tio = io();
    assert.equal(await runUsage(args, {
      client: fake({}), stdout: tio.stdout, stderr: tio.stderr,
    }), 2, JSON.stringify(args));
    assert.equal(tio.err, `${USAGE}\n`, JSON.stringify(args));
  }
  const statJson = io();
  assert.equal(await runUsage(['stat', '--json'], {
    client: fake({}), stdout: statJson.stdout, stderr: statJson.stderr,
  }), 2);
  assert.equal(JSON.parse(statJson.out).error, USAGE);
  assert.match(statJson.err, /did you mean 'stats'\?/);

  // --json failure paths emit the {"error"} envelope on stdout (the -p/quota
  // contract); the human line still goes to stderr.
  const noSessJson = io();
  assert.equal(await runUsage(['--json'], {
    resolveSession: () => null, client: fake({}), stdout: noSessJson.stdout, stderr: noSessJson.stderr,
  }), 2);
  assert.match(JSON.parse(noSessJson.out).error, /no session/);
  assert.match(noSessJson.err, /usage: no session/);

  const badArgsJson = io();
  assert.equal(await runUsage(['--bogus', '--json'], {
    client: fake({}), stdout: badArgsJson.stdout, stderr: badArgsJson.stderr,
  }), 2);
  assert.equal(JSON.parse(badArgsJson.out).error, USAGE);
  assert.equal(badArgsJson.err, `${USAGE}\n`);

  const spawnFail = io();
  assert.equal(await runUsage(['--json', '--session', 's1'], {
    createClient: async () => { throw new Error('spawn fixture failed'); },
    stdout: spawnFail.stdout, stderr: spawnFail.stderr,
  }), 1);
  assert.match(JSON.parse(spawnFail.out).error, /spawn fixture failed/);

  const turnFail = io();
  assert.equal(await runUsage(['--json', '--session', 's1'], {
    client: fake(null, new Error('turn fixture failed')),
    stdout: turnFail.stdout, stderr: turnFail.stderr,
  }), 1);
  assert.match(JSON.parse(turnFail.out).error, /turn fixture failed/);

  // --- stats: the app-usage dashboard surface (usage/stats, 3.12.1 schema) ---
  const statsReply = {
    range: '7d', generatedAt: 1758000000000, timeZone: 'UTC', source: 'agent-db',
    summary: {
      totalTokens: 337113365, inputTokens: 331809059, outputTokens: 5304306,
      reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 318259776,
      cacheHitRate: 0.9591654217011598, totalSessions: 315, totalTurns: 324,
      toolCallCount: 7254, toolErrorRate: 0.0106, modelErrorRate: 0.0101,
      avgTimeToFirstTokenMs: 7561.4, avgTurnDurationMs: 536808.9,
      activeDays: 6, currentStreakDays: 6, longestSessionMs: 3349201,
      longestStreakDays: 6, peakDayTokens: 1199584,
      favoriteModel: { modelId: 'glm-5.3', totalTokens: 300000000, share: 0.89 },
    },
    heatmap: { startDate: '2026-09-08', endDate: '2026-09-15', maxTokens: 1199584, weeks: [] },
    dailyModelUsage: [{ date: '2026-09-15', models: [{ modelId: 'glm-5.3', totalTokens: 1199584 }] }],
    models: [
      { modelId: 'glm-5.3', totalTokens: 300000000, inputTokens: 295000000, outputTokens: 5000000, requestCount: 300, share: 0.89 },
      { modelId: 'glm-5.3-flash', totalTokens: 37113365, inputTokens: 36809059, outputTokens: 304306, requestCount: 24, share: 0.11 },
    ],
    tools: [
      { toolName: 'edit_file', callCount: 3000, errorCount: 10, errorRate: 0.0033, avgDurationMs: 42 },
      { toolName: 'read_file', callCount: 2500, errorCount: 0, errorRate: 0, avgDurationMs: 12 },
    ],
  };
  const statsIo = io();
  const statsClient = fake(statsReply);
  assert.equal(await runUsage(['stats'], {
    client: statsClient, stdout: statsIo.stdout, stderr: statsIo.stderr,
  }), 0);
  assert.equal(statsClient.calls.length, 1);
  assert.equal(statsClient.calls[0].m, 'usage/stats');
  assert.equal(statsClient.calls[0].p.range, '7d');
  assert.deepEqual(Object.keys(statsClient.calls[0].p).sort(), ['range', 'timeZone']);
  assert.match(statsIo.out, /range: 7d/);
  assert.match(statsIo.out, /totalTokens: 337113365/);
  assert.match(statsIo.out, /cacheHitRate: 95\.9%/);
  assert.match(statsIo.out, /sessions: 315/);
  assert.match(statsIo.out, /favoriteModel: glm-5\.3/);
  assert.match(statsIo.out, /edit_file/);
  assert.match(statsIo.out, /read_file/);

  const statsJson = io();
  assert.equal(await runUsage(['stats', '--range', '30d', '--json'], {
    client: fake(statsReply), stdout: statsJson.stdout, stderr: statsJson.stderr,
  }), 0);
  const statsParsed = JSON.parse(statsJson.out);
  assert.equal(statsParsed.source, 'agent-db');
  assert.equal(statsParsed.summary.totalTokens, 337113365);
  assert.equal(statsParsed.models.length, 2);
  assert.equal(statsParsed.tools.length, 2);

  // -32601 on the v3 name falls back to the v4 registration once.
  const v4Io = io();
  const absent = Object.assign(new Error('method not found'), { code: -32601 });
  const v4Client = {
    calls: [],
    async call(m, p) { this.calls.push({ m, p }); if (m === 'usage/stats') throw absent; return statsReply; },
    close() {},
  };
  assert.equal(await runUsage(['stats', '--json'], {
    client: v4Client, stdout: v4Io.stdout, stderr: v4Io.stderr,
  }), 0);
  assert.deepEqual(v4Client.calls.map(c => c.m), ['usage/stats', 'v4/usage/stats']);
  assert.equal(JSON.parse(v4Io.out).summary.totalSessions, 315);

  // Both absent → honest refusal, exit 1.
  const noStats = io();
  assert.equal(await runUsage(['stats'], {
    client: fake(null, absent), stdout: noStats.stdout, stderr: noStats.stderr,
  }), 1);
  assert.match(noStats.err, /usage stats: this runtime does not serve usage\/stats/);

  // A non--32601 failure propagates verbatim (no fallback, no rewrite).
  const paramErr = io();
  const badParams = Object.assign(new Error('invalid params: range'), { code: -32602 });
  assert.equal(await runUsage(['stats'], {
    client: fake(null, badParams), stdout: paramErr.stdout, stderr: paramErr.stderr,
  }), 1);
  assert.match(paramErr.err, /usage stats: invalid params: range/);

  // --json stats failures carry the envelope too.
  const statsFailJson = io();
  assert.equal(await runUsage(['stats', '--json'], {
    client: fake(null, absent), stdout: statsFailJson.stdout, stderr: statsFailJson.stderr,
  }), 1);
  assert.match(JSON.parse(statsFailJson.out).error, /does not serve usage\/stats/);

  const statsSpawnFail = io();
  assert.equal(await runUsage(['stats', '--json'], {
    createClient: async () => { throw new Error('stats spawn fixture failed'); },
    stdout: statsSpawnFail.stdout, stderr: statsSpawnFail.stderr,
  }), 1);
  assert.match(JSON.parse(statsSpawnFail.out).error, /stats spawn fixture failed/);

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ZAGENT_TEST_SANDBOX: home,
    TMPDIR: path.join(home, 'tmp'),
    TEMP: path.join(home, 'tmp'),
    TMP: path.join(home, 'tmp'),
    ZCODE_RUNTIME: path.join(home, 'no-runtime'),
  };
  mkdirSync(path.join(home, 'tmp'), { recursive: true });

  const emptyHome = mkdtempSync(path.join(tmpdir(), 'zagent-usage-empty-'));
  try {
    const missing = spawnSync(process.execPath, [
      '--experimental-sqlite', '--no-warnings',
      path.join(root, 'packages/cli/zagent-usage.mjs'),
    ], {
      encoding: 'utf8', timeout: 15000,
      env: { ...env, HOME: emptyHome, USERPROFILE: emptyHome, ZAGENT_TEST_SANDBOX: emptyHome },
    });
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stderr, /usage: no session/);
    assert.equal(missing.stdout, '');

    const missingJson = spawnSync(process.execPath, [
      '--experimental-sqlite', '--no-warnings',
      path.join(root, 'packages/cli/zagent-usage.mjs'), '--json',
    ], {
      encoding: 'utf8', timeout: 15000,
      env: { ...env, HOME: emptyHome, USERPROFILE: emptyHome, ZAGENT_TEST_SANDBOX: emptyHome },
    });
    assert.equal(missingJson.status, 2, missingJson.stderr);
    assert.match(JSON.parse(missingJson.stdout).error, /no session/);
    assert.match(missingJson.stderr, /usage: no session/);
  } finally { rmSync(emptyHome, { recursive: true, force: true }); }

  const help = spawnSync(process.execPath, [path.join(root, 'bin/zagent'), 'usage', '--help'], {
    encoding: 'utf8', timeout: 15000, env,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /zagent usage/);

  const routed = spawnSync(process.execPath, [path.join(root, 'bin/zagent'), 'usage', 'list'], {
    encoding: 'utf8', timeout: 15000, env,
  });
  assert.equal(routed.status, 2, routed.stderr);
  assert.match(routed.stderr, /usage: zagent usage/);

  console.log('ok - usage CLI session/usage totals, baseline, --json, --session, no-session');
} finally {
  rmSync(home, { recursive: true, force: true });
}
