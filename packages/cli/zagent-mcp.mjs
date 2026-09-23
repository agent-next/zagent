#!/usr/bin/env node
// `zagent mcp` — zagent as an MCP server, so any MCP-capable agent (Claude
// Code, opencode, …) can call it as a tool. Line-delimited JSON-RPC 2.0 on
// stdio, zero new dependencies — the same framing the driver's own kernel
// channel already uses.
//
// Security invariants:
//   * stdio transport only — this process never opens a listener.
//   * Credentials never cross the boundary: the tools read the local config
//     exactly like the CLI does; no tool returns a key, and a turn's prompt
//     goes to the runtime, not back to the caller.
//   * stdout is the protocol channel — nothing but JSON-RPC responses may be
//     written there. Diagnostics go to stderr.
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODES } from '../driver/session-control.mjs';
import { readDefaultMode } from '../driver/default-mode.mjs';
import { EFFORTS, modelRef } from './zagent-print.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERSION = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

// Protocol versions this server answers. On `initialize` the client's version
// is echoed when supported; otherwise the newest supported one is offered
// (the MCP spec's downgrade rule). 2024-11-05 is deliberately absent: this
// server does not implement JSON-RPC batching, which that revision still used.
const PROTOCOL_VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25'];
const PROTOCOL_VERSION = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];

// Prompt size cap: generous for real prompts (the kernel sees bigger), small
// enough that a hostile or buggy client cannot park a multi-megabyte blob in
// argv/stdin. Control characters other than \n, \t and \r are rejected — ANSI
// escapes in a prompt are an injection vector into the transcript renderer.
const MAX_PROMPT_CHARS = 128_000;
const MAX_ARG_CHARS = 4_096;
// The raw JSON-RPC line is bounded too — a cap applied after JSON.parse would
// leave the message layer itself unbounded.
const MAX_LINE_CHARS = 1_000_000;

export const TOOLS = [
  {
    name: 'zagent_turn',
    description: 'Run one headless prompt through zagent (the `zagent -p` equivalent) and return the answer plus session/usage envelope.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt text to run' },
        model: { type: 'string', description: 'provider/model or bare model id (bare = zai provider)' },
        effort: { type: 'string', description: "Reasoning effort — validated against the model's resolved levels; low|high|max on the coding plan" },
        // -p semantics auto-approve tool permissions; say so on the boundary.
        mode: { type: 'string', enum: MODES, description: 'Permission mode. Default = the persisted `zagent mode` default if set, else the -p contract (auto-approve); use plan to run read-only' },
        cwd: { type: 'string', description: 'Working directory for the turn (default: the server\'s cwd)' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
  },
  {
    name: 'zagent_quota',
    description: 'Coding Plan quota status — the same data `zagent quota status --json` prints.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object' },
  },
  {
    name: 'zagent_models',
    description: 'List providers and models from the runtime\'s catalog; optional `query` is a regular expression matched against provider/model ids.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Regex filter on provider/model ids' } },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
  },
  {
    name: 'zagent_doctor',
    description: 'Run `zagent doctor` and return its diagnosis (runtime, config, credential, exit code).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object' },
  },
];
const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const invalid = (id, msg) => rpcError(id, -32602, `Invalid params: ${msg}`);

// \n, \t and \r are allowed (pasted CRLF prompts are legitimate); ESC/C0/DEL
// are rejected — ANSI escapes in a prompt are an injection vector into the
// transcript renderer.
const hasControls = (s) => /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s);
const strArg = (v, name, { required = false, max = MAX_ARG_CHARS } = {}) => {
  if (v === undefined || v === null) {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new Error(`${name} must be a string`);
  if (!v.length) throw new Error(`${name} must not be empty`);
  if (v.length > max) throw new Error(`${name} is too long (max ${max} chars)`);
  if (hasControls(v)) throw new Error(`${name} contains control characters`);
  return v;
};

// The real implementations. Each is injected in tests; the wiring is the only
// thing this layer adds over the surfaces the CLI already ships.
export function defaultImpls() {
  return {
    async turn(sel) {
      const { runPrintOnce, printEnvelope } = await import('./zagent-print.mjs');
      return printEnvelope(await runPrintOnce(sel));
    },
    async quota() {
      const { codingPlanStatus } = await import('../driver/quota.mjs');
      return codingPlanStatus();
    },
    async models(query) {
      const { loadCatalog, providerList } = await import('../driver/providers.mjs');
      let providers = providerList(loadCatalog());
      if (query) {
        const re = new RegExp(query, 'i');
        providers = providers
          .map(p => ({ ...p, models: p.models.filter(m => re.test(`${p.id}/${m}`)) }))
          .filter(p => p.models.length || re.test(p.id));
      }
      return { providers };
    },
    async doctor() {
      // Spawn the real command: the tool reports exactly what a human sees —
      // no second copy of the diagnosis to drift. doctor exits 1 when the
      // setup is unhealthy; that is data, not a tool failure.
      const r = spawnSync(process.execPath, [path.join(root, 'bin', 'zagent'), 'doctor'],
        { encoding: 'utf8', timeout: 60_000 });
      if (r.error) return { ok: false, exitCode: null, output: `doctor failed to run: ${r.error.message}` };
      return { ok: r.status === 0, exitCode: r.status, output: `${r.stdout}${r.stderr}`.trim() };
    },
  };
}

// Validate a tools/call argument object and run the tool. Throws Error with
// user-facing wording for -32602 mapping; execution failures come back as
// isError results (MCP's honest-failure channel), never as a crash.
// The inputSchemas all declare additionalProperties:false — enforce it for
// every tool, not just the ones that read their keys.
const knownKeys = (args, known) => {
  const extra = Object.keys(args).filter(k => !known.has(k));
  if (extra.length) throw new Error(`unknown argument(s): ${extra.join(', ')}`);
};

export async function callTool(name, args, impls = defaultImpls()) {
  if (!TOOL_NAMES.has(name)) throw new Error(`unknown tool '${name}'`);
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
  switch (name) {
    case 'zagent_turn': {
      knownKeys(args, new Set(['prompt', 'model', 'effort', 'mode', 'cwd']));
      const prompt = strArg(args.prompt, 'prompt', { required: true, max: MAX_PROMPT_CHARS });
      const sel = { prompt };
      const model = strArg(args.model, 'model');
      if (model !== undefined) {
        const ref = modelRef(model);
        if (!ref.providerId || !ref.modelId)
          throw new Error('model must be provider/model or a bare model id');
        sel.model = model;
      }
      const effort = strArg(args.effort, 'effort');
      if (effort !== undefined) {
        sel.effort = effort.toLowerCase();
        // With a model, runPrintOnce validates against the model's resolved
        // vocabulary; without one the plan set is the bound here.
        if (!sel.model && !EFFORTS.includes(sel.effort))
          throw new Error(`effort must be one of ${EFFORTS.join('|')} without model (got '${effort}')`);
      }
      const mode = strArg(args.mode, 'mode');
      if (mode !== undefined) {
        if (!MODES.includes(mode.toLowerCase()))
          throw new Error(`mode must be one of ${MODES.join('|')} (got '${mode}')`);
        sel.mode = mode.toLowerCase();
      } else {
        // The tool advertises `-p` equivalence — honor the same persisted
        // default a flagless `-p` run would pick up (zagent.mjs injection).
        const persisted = readDefaultMode();
        if (persisted) sel.mode = persisted;
      }
      const cwd = strArg(args.cwd, 'cwd');
      if (cwd !== undefined) {
        const abs = path.resolve(cwd);
        if (!existsSync(abs) || !statSync(abs).isDirectory())
          throw new Error(`cwd is not a directory: ${cwd}`);
        sel.cwd = abs;
      }
      try { return { ok: true, data: await impls.turn(sel) }; }
      catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    }
    case 'zagent_quota':
      knownKeys(args, new Set());
      try { return { ok: true, data: await impls.quota() }; }
      catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    case 'zagent_models': {
      knownKeys(args, new Set(['query']));
      // The query is a user regex over catalog ids (all short strings), so
      // catastrophic backtracking has no long input to blow up on — same
      // exposure `zagent models <query>` already accepts.
      const query = strArg(args.query, 'query');
      try { new RegExp(query ?? '', 'i'); }
      catch { throw new Error(`query is not a valid regular expression: ${query}`); }
      try { return { ok: true, data: await impls.models(query) }; }
      catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    }
    case 'zagent_doctor':
      knownKeys(args, new Set());
      try { return { ok: true, data: await impls.doctor() }; }
      catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  }
}

const toolResult = (r) => r.ok
  ? { content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }], structuredContent: r.data, isError: false }
  : { content: [{ type: 'text', text: `zagent tool error: ${r.error}` }], isError: true };

// One JSON-RPC message -> the response object, or null for notifications.
// Exported so tests can drive the server in-process with injected impls.
export async function handleMessage(msg, impls = defaultImpls()) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg))
    return rpcError(null, -32600, 'Invalid Request');
  const { id, method } = msg;
  // A stray *response* ({id, result|error} with no method) is never answered —
  // JSON-RPC forbids replying to responses. `id: null` is spec-discouraged; we
  // treat it as a notification (silent), which is the safe direction.
  const isNotification = id === undefined || id === null;
  if (typeof method !== 'string' && ('result' in msg || 'error' in msg)) return null;
  if (msg.jsonrpc !== '2.0' || typeof method !== 'string') {
    return isNotification ? null : rpcError(id, -32600, 'Invalid Request');
  }
  if (method.startsWith('notifications/')) return null;
  if (isNotification) return null; // a method with no id is a notification — never answered
  switch (method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'zagent', version: VERSION },
      } };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const p = msg.params;
      if (!p || typeof p !== 'object' || typeof p.name !== 'string')
        return invalid(id, 'tools/call requires params.name');
      try {
        return { jsonrpc: '2.0', id, result: toolResult(await callTool(p.name, p.arguments, impls)) };
      } catch (e) {
        return invalid(id, e.message);
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function main() {
  // `zagent mcp` is meant to be spawned BY an MCP client, not typed by a
  // human: on a terminal it used to hang silently, and on a closed/empty
  // stdin it exited 0 with no output at all (FLOCK-F8). Both now explain.
  // Args are meaningless here (the dispatcher answers `mcp --help` itself);
  // an unknown one is a usage error like every sibling command.
  if (process.argv.slice(2).length || process.stdin.isTTY) {
    process.stderr.write('usage: zagent mcp — serves MCP tools over stdio; register it in a client\'s MCP config (see `zagent mcp --help`)\n');
    process.exitCode = 2;
    return;
  }
  const rl = createInterface({ input: process.stdin, terminal: false });
  let received = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    received++;
    if (trimmed.length > MAX_LINE_CHARS) {
      process.stdout.write(JSON.stringify(rpcError(null, -32600, `Invalid Request: message too large (max ${MAX_LINE_CHARS} chars)`)) + '\n');
      continue;
    }
    let msg;
    try { msg = JSON.parse(trimmed); }
    catch { process.stdout.write(JSON.stringify(rpcError(null, -32700, 'Parse error')) + '\n'); continue; }
    const res = await handleMessage(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  }
  if (!received) {
    process.stderr.write('zagent mcp: stdin closed with no request — this command speaks JSON-RPC for MCP clients (see `zagent mcp --help`)\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { process.stderr.write(`zagent mcp: ${e?.message ?? e}\n`); process.exit(1); });
}
