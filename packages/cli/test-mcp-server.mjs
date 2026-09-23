#!/usr/bin/env node
// Oracles for `zagent mcp` — the MCP stdio server. Two layers are pinned:
//   * the wire layer, by spawning the real server and speaking line-delimited
//     JSON-RPC to it (handshake, tools/list, error paths — all offline);
//   * the tool envelopes, by driving handleMessage/callTool in-process with
//     injected impls, so success shapes are literal oracles, not presence.
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMessage, callTool, TOOLS } from './zagent-mcp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, 'zagent-mcp.mjs');

const tests = [];
const test = (n, f) => tests.push([n, f]);

// --- wire layer -------------------------------------------------------------

// Spawn the server, send requests, collect every response line. Requests
// carry ids; parse errors answer with id null, so responses are a list and
// `byId` picks the one for a request id.
async function rpcSession(lines, { settle = 1500 } = {}) {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const all = [];
  let buf = '', stderr = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) all.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', (d) => { stderr += d; });
  const expected = lines.filter(l =>
    typeof l === 'string' ? l.trim()
      : l.id != null && !String(l.method ?? '').startsWith('notifications/')).length;
  for (const l of lines) child.stdin.write(typeof l === 'string' ? l : JSON.stringify(l) + '\n');
  const deadline = Date.now() + settle;
  while (all.length < expected && Date.now() < deadline)
    await new Promise(r => setTimeout(r, 25));
  child.stdin.end();
  await new Promise(r => child.once('exit', r));
  const responses = new Map();
  for (const m of all) if (m.id != null) responses.set(m.id, m);
  return { responses, all, stderr };
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'oracle', version: '0' } } };

test('initialize answers with the literal handshake envelope', async () => {
  const { responses } = await rpcSession([INIT, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
  const r = responses.get(1);
  assert.equal(r.jsonrpc, '2.0');
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.equal(r.result.serverInfo.name, 'zagent');
  assert.match(r.result.serverInfo.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
});

test('an unsupported client protocolVersion gets the newest supported one', async () => {
  const { responses } = await rpcSession([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }]);
  assert.equal(responses.get(1).result.protocolVersion, '2025-11-25');
});

test('tools/list returns exactly the four tools with their schemas', async () => {
  const { responses } = await rpcSession([{ jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  const tools = responses.get(2).result.tools;
  assert.deepEqual(tools.map(t => t.name), ['zagent_turn', 'zagent_quota', 'zagent_models', 'zagent_doctor']);
  const turn = tools.find(t => t.name === 'zagent_turn');
  assert.deepEqual(turn.inputSchema.required, ['prompt']);
  // No static enum — the resolved per-model vocabulary is the authority.
  assert.match(turn.inputSchema.properties.effort.description, /resolved levels/);
  assert.equal(turn.inputSchema.additionalProperties, false);
});

test('ping answers {} and unknown methods get -32601', async () => {
  const { responses } = await rpcSession([
    { jsonrpc: '2.0', id: 3, method: 'ping' },
    { jsonrpc: '2.0', id: 4, method: 'resources/list' },
  ]);
  assert.deepEqual(responses.get(3).result, {});
  assert.equal(responses.get(4).error.code, -32601);
});

test('a malformed line gets -32700 and the server keeps answering', async () => {
  const { responses, all } = await rpcSession(['{not json\n', INIT]);
  const parse = all.find(m => m.error?.code === -32700);
  assert.ok(parse, 'expected a -32700 response');
  assert.ok(responses.get(1)?.result?.serverInfo, 'server died after the parse error');
});

test('tools/call validates arguments before any runtime work', async () => {
  const { responses } = await rpcSession([
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'zagent_turn', arguments: {} } },
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'zagent_turn', arguments: { prompt: 'x'.repeat(128_001) } } },
    { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'zagent_turn', arguments: { prompt: 'hi\x1b[31m' } } },
    { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'zagent_turn', arguments: { prompt: 'hi', effort: 'turbo' } } },
    { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'zagent_turn', arguments: { prompt: 'hi', cwd: '/no/such/dir-mcp-oracle' } } },
    { jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'nope' } },
    { jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'zagent_models', arguments: { query: '([' } } },
    { jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'zagent_turn', arguments: { prompt: 'hi', smuggle: 1 } } },
    { jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 'zagent_doctor', arguments: { evil: true } } },
    { jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'zagent_quota', arguments: { evil: true } } },
    { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'zagent_models', arguments: { evil: true } } },
    { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'zagent_turn', arguments: { prompt: 'hi', model: '/' } } },
  ]);
  for (const id of [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]) {
    assert.equal(responses.get(id)?.error?.code, -32602, `id ${id}: ${JSON.stringify(responses.get(id))}`);
  }
  assert.match(responses.get(10).error.message, /prompt is required/);
  assert.match(responses.get(11).error.message, /too long/);
  assert.match(responses.get(12).error.message, /control characters/);
  assert.match(responses.get(13).error.message, /effort must be one of/);
  assert.match(responses.get(14).error.message, /not a directory/);
  assert.match(responses.get(15).error.message, /unknown tool/);
  assert.match(responses.get(16).error.message, /regular expression/);
  assert.match(responses.get(17).error.message, /unknown argument/);
  assert.match(responses.get(21).error.message, /model must be/);
});

test('an over-sized raw line gets -32600 before it can reach JSON.parse', async () => {
  const { responses, all } = await rpcSession(['x'.repeat(1_000_001) + '\n', INIT]);
  const big = all.find(m => m.error?.code === -32600 && /too large/.test(m.error.message));
  assert.ok(big, 'expected a -32600 too-large response');
  assert.ok(responses.get(1)?.result?.serverInfo, 'server died on the big line');
});

test('a stray JSON-RPC response is never answered', async () => {
  const { all } = await rpcSession([
    { jsonrpc: '2.0', id: 5, result: {} },
    { jsonrpc: '2.0', id: 6, method: 'ping' }]);
  assert.equal(all.length, 1, 'only the ping should get a response');
  assert.equal(all[0].id, 6);
});

test('the wire layer can carry a real successful tools/call (zagent_models)', async () => {
  // Offline-safe: with no catalog installed this still returns a success
  // envelope with an empty providers array.
  const { responses } = await rpcSession([
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'zagent_models', arguments: {} } }]);
  const r = responses.get(7).result;
  assert.equal(r.isError, false);
  assert.equal(r.content[0].type, 'text');
  assert.ok(Array.isArray(r.structuredContent.providers));
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
});

test('bare `mcp` on a dead/empty stdin exits nonzero with guidance, never silent 0', async () => {
  // A human who runs `zagent mcp` without an MCP client attached must not get
  // a silent exit 0 — guidance to stderr and a usage-class exit code.
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.end();
  const [code] = await new Promise(r => child.once('exit', (c) => r([c])));
  assert.equal(code, 2, `empty-stdin exit code (stderr: ${stderr})`);
  assert.equal(stdout, '', 'no protocol bytes for a client that never spoke');
  assert.match(stderr, /zagent mcp/);
  assert.match(stderr, /--help/);
});

test('blank lines alone still count as no client', async () => {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.write('\n\n');
  child.stdin.end();
  const [code] = await new Promise(r => child.once('exit', (c) => r([c])));
  assert.equal(code, 2);
  assert.match(stderr, /zagent mcp/);
});

// --- tool envelopes (in-process, injected impls) -----------------------------

const fakeImpls = {
  async turn(sel) {
    return { type: 'result', subtype: 'success', is_error: false, isError: false,
      result: `echo:${sel.prompt}`, session_id: 'sess_fake', sessionId: 'sess_fake',
      duration_ms: 1, num_turns: 1, usage: { input_tokens: 1 } };
  },
  async quota() { return { ok: true, plan: { providerId: 'zai' }, used: { percent: 12 } }; },
  async models(query) {
    const providers = [{ id: 'zai', name: 'Z AI', baseURL: 'https://x', kinds: ['llm'], models: ['glm-5.3', 'glm-5.3-flash'] }];
    if (!query) return { providers };
    const re = new RegExp(query, 'i');
    return { providers: providers.map(p => ({ ...p, models: p.models.filter(m => re.test(`${p.id}/${m}`)) })).filter(p => p.models.length) };
  },
  async doctor() { return { ok: true, exitCode: 0, output: 'runtime: ok' }; },
};

test('zagent_turn returns the -p envelope as structuredContent + text', async () => {
  const res = (await handleMessage({ jsonrpc: '2.0', id: 20, method: 'tools/call',
    params: { name: 'zagent_turn', arguments: { prompt: 'say hi', effort: 'HIGH' } } }, fakeImpls)).result;
  assert.equal(res.isError, false);
  assert.equal(res.structuredContent.type, 'result');
  assert.equal(res.structuredContent.result, 'echo:say hi');
  assert.equal(res.structuredContent.session_id, 'sess_fake');
  assert.equal(JSON.parse(res.content[0].text).result, 'echo:say hi');
});

test('CRLF prompts pass validation; mode is normalized like effort', async () => {
  let seen;
  const impls = { ...fakeImpls, turn: async (sel) => { seen = sel; return fakeImpls.turn(sel); } };
  const res = (await handleMessage({ jsonrpc: '2.0', id: 26, method: 'tools/call',
    params: { name: 'zagent_turn', arguments: { prompt: 'line one\r\nline two', mode: 'PLAN' } } }, impls)).result;
  assert.equal(res.isError, false);
  assert.equal(seen.prompt, 'line one\r\nline two');
  assert.equal(seen.mode, 'plan');
});

test('zagent_turn honors the persisted default mode; an explicit mode wins', async () => {
  // -p equivalence: a flagless -p run picks up `zagent mode set`'s store — the
  // MCP tool that claims the -p contract must too.
  const home = mkdtempSync(path.join(os.tmpdir(), 'zagent-mcp-mode-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
    writeFileSync(path.join(home, '.zcode', 'cli', 'config.json'),
      JSON.stringify({ permissions: { defaultMode: 'plan' } }));
    process.env.HOME = home; process.env.USERPROFILE = home;
    let seen;
    const impls = { ...fakeImpls, turn: async (sel) => { seen = sel; return fakeImpls.turn(sel); } };
    const res = (await handleMessage({ jsonrpc: '2.0', id: 30, method: 'tools/call',
      params: { name: 'zagent_turn', arguments: { prompt: 'hi' } } }, impls)).result;
    assert.equal(res.isError, false);
    assert.equal(seen.mode, 'plan', 'persisted default applies when the mode argument is omitted');
    await callTool('zagent_turn', { prompt: 'hi', mode: 'yolo' }, impls);
    assert.equal(seen.mode, 'yolo', 'an explicit mode argument beats the persisted default');
    // 'auto' stays accepted here on purpose: an explicit turn mode rides
    // session/setMode (MODES includes it); only the persisted default must be
    // --mode-launchable because it is injected as the kernel flag.
    await callTool('zagent_turn', { prompt: 'hi', mode: 'auto' }, impls);
    assert.equal(seen.mode, 'auto', "explicit 'auto' is legal via session/setMode — not the launch-flag domain");
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a failed turn is isError content, not a protocol error', async () => {
  const res = (await handleMessage({ jsonrpc: '2.0', id: 21, method: 'tools/call',
    params: { name: 'zagent_turn', arguments: { prompt: 'x' } } },
    { ...fakeImpls, turn: async () => { throw new Error('quota exhausted'); } })).result;
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /quota exhausted/);
});

test('zagent_quota and zagent_doctor pass their data through literally', async () => {
  const q = (await handleMessage({ jsonrpc: '2.0', id: 22, method: 'tools/call',
    params: { name: 'zagent_quota', arguments: {} } }, fakeImpls)).result;
  assert.deepEqual(q.structuredContent, { ok: true, plan: { providerId: 'zai' }, used: { percent: 12 } });
  const d = (await handleMessage({ jsonrpc: '2.0', id: 23, method: 'tools/call',
    params: { name: 'zagent_doctor' } }, fakeImpls)).result;
  assert.deepEqual(d.structuredContent, { ok: true, exitCode: 0, output: 'runtime: ok' });
});

test('zagent_models filters with the query regex', async () => {
  const all = (await handleMessage({ jsonrpc: '2.0', id: 24, method: 'tools/call',
    params: { name: 'zagent_models', arguments: {} } }, fakeImpls)).result;
  assert.equal(all.structuredContent.providers[0].models.length, 2);
  const some = (await handleMessage({ jsonrpc: '2.0', id: 25, method: 'tools/call',
    params: { name: 'zagent_models', arguments: { query: 'flash' } } }, fakeImpls)).result;
  assert.deepEqual(some.structuredContent.providers[0].models, ['glm-5.3-flash']);
});

test('notifications and id-less calls get no response', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'tools/list' }), null);
});

test('callTool defaults to an empty arguments object', async () => {
  const r = await callTool('zagent_doctor', undefined, fakeImpls);
  assert.equal(r.ok, true);
});

let pass = 0, fail = 0;
for (const [n, f] of tests) {
  try { await f(); pass++; }
  catch (e) { fail++; console.error(`FAIL ${n}\n  ${e.message}`); }
}
console.log(`${pass}/${tests.length} mcp-server tests passed`);
process.exit(fail ? 1 : 0);
