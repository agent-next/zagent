#!/usr/bin/env node
// Explicit opt-in live probe: four small paid inference calls, never a CI test.
// Usage: node bench/quota-probe.mjs --live RECEIPT.json
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killChild } from './proc.mjs';
import { codingPlanStatus, codingPlanUsage } from '../packages/driver/quota.mjs';

if (process.argv.length !== 4 || process.argv[2] !== '--live') {
  console.error('usage: node bench/quota-probe.mjs --live RECEIPT.json (consumes quota)');
  process.exit(2);
}
const output = path.resolve(process.argv[3]);
// Refuse accidental overwriting of an earlier measurement.
writeFileSync(output, '', { flag: 'wx', mode: 0o600 });
const home = os.homedir();
const config = JSON.parse(readFileSync(path.join(home, '.zcode/cli/config.json'), 'utf8'));
const model = config.model.main;
const provider = config.provider[model.split('/')[0]].options;
const providerKey = process.env.ZAI_AUTH_TOKEN;
if (!providerKey) throw new Error('ZAI_AUTH_TOKEN must hold the provider key configured for both clients');
if (model !== 'zai/glm-5.3' || provider.baseURL !== 'https://api.z.ai/api/anthropic' || provider.apiKey !== providerKey) {
  throw new Error('Probe requires matching configured GLM-5.3 providers and keys; no configuration was changed');
}
const workspace = mkdtempSync(path.join(os.tmpdir(), 'zagent-quota-probe-'));
const prompt = 'Compute the sum of squares of the integers 1 through 10. Reply with exactly the integer, no explanation. Do not use tools or read files.';
const receipt = { startedAt: new Date().toISOString(), model, sameConfiguredKey: true,
  prompt, order: ['claude_code', 'zagent', 'zagent', 'claude_code'], measurements: [],
  caveats: ['Account monitor includes concurrent users and delayed reporting.',
    'Native client token fields are not normalized billing credits.',
    'Same task and model; client system prompts, tools, and reasoning settings differ.'],
};
const options = { env: { ZAI_API_KEY: provider.apiKey } };
const serialize = value => JSON.stringify(value, (_key, field) =>
  typeof field === 'string' ? field.replaceAll(providerKey, '[REDACTED]') : field, 2);
const save = () => writeFileSync(output, serialize(receipt) + '\n');
let activeChild, interrupted = false;
function interrupt() {
  interrupted = true;
  process.exitCode = 1;
  killChild(activeChild);
}
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
async function snapshot() {
  const result = { at: new Date().toISOString() };
  for (const [key, run] of [['quota', () => codingPlanStatus(options)],
    ['usage', () => codingPlanUsage({ ...options, days: 1 })]]) {
    try { result[key] = await run(); } catch (e) { result[key] = { unknown: true, error: e.message }; }
  }
  return result;
}
function run(client) {
  const args = client === 'claude_code' ? ['-p', prompt, '--model', 'glm-5.3', '--output-format', 'json',
    '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '']
    : ['-p', prompt, '--json'];
  return new Promise(resolve => {
    const start = Date.now();
    const child = spawn(client === 'claude_code' ? (process.env.BENCH_CLAUDE_CODE_BIN ?? 'claude') : client, args, { cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', timedOut = false, spawnError = null;
    child.stdout.on('data', d => { stdout = (stdout + d).slice(-1000000); });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-10000); });
    const timer = setTimeout(() => { timedOut = true; killChild(child); }, 180000);
    child.on('error', e => { spawnError = e.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      activeChild = undefined;
      let body; try { body = JSON.parse(stdout); } catch {}
      // Claude verbose JSON is an event array; the final result carries usage.
      if (Array.isArray(body)) body = body.findLast(event => event?.type === 'result');
      const answer = body?.result ?? body?.response ?? null;
      resolve({ client, code, signal, timedOut, spawnError, wallMs: Date.now() - start,
        pass: code === 0 && String(answer).trim() === '385', answer,
        envelopeKeys: body ? Object.keys(body) : null,
        usage: body?.usage ?? null, modelUsage: body?.modelUsage ?? null,
        sessionId: body?.session_id ?? body?.sessionId ?? null,
        diagnostic: stderr.replaceAll(providerKey, '[REDACTED]').slice(-1500) });
    });
  });
}
try {
  const names = execFileSync('ps', ['-eo', 'comm='], { encoding: 'utf8' }).split('\n');
  receipt.localProcessCounts = Object.fromEntries(['claude', 'node'].map(n => [n, names.filter(x => x.trim() === n).length]));
  receipt.baseline = await snapshot();
  for (const client of receipt.order) {
    if (interrupted) break;
    const before = await snapshot();
    if (interrupted) break;
    const result = await run(client);
    const after = await snapshot();
    receipt.measurements.push({ before, result, after });
    save();
    console.log(serialize({ client, pass: result.pass, wallMs: result.wallMs, usage: result.usage, envelopeKeys: result.envelopeKeys }));
    if (!result.pass) process.exitCode = 1;
    if (result.timedOut || result.code !== 0) break;
  }
  receipt.finishedAt = new Date().toISOString();
  if (receipt.measurements.length !== receipt.order.length) process.exitCode = 1;
} finally {
  try { save(); } finally {
    killChild(activeChild);
    rmSync(workspace, { recursive: true, force: true });
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
