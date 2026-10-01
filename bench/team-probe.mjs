#!/usr/bin/env node
// Ordinary plan-channel acceptance; NOT a free-idle run.
// node bench/team-probe.mjs --live claude_code|zagent RECEIPT.json
// node bench/team-probe.mjs --self-test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { ZCodeProtocolClient } from '../packages/driver/zcode-protocol.mjs';
import { killChild } from './proc.mjs';

const roles = ['zteam-build', 'zteam-test', 'zteam-review', 'zteam-verify'];
const canonical = model => ({ opus: 'glm-5.3', sonnet: 'glm-5.3-flash', haiku: 'glm-5.3-flash' })[model] ?? model;
const modelsOf = read => [...new Set((read.messages ?? []).filter(m => m.info?.role === 'assistant' && m.info?.time?.completed)
  .map(m => m.info?.model?.modelId).filter(m => typeof m === 'string' && m.length))];

export function parseOutput(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch {
    // NDJSON is supported, but arbitrary prose/partially captured JSON is not success.
    const lines = stdout.trim().split('\n');
    try { parsed = lines.map(line => JSON.parse(line)); } catch { return { parseError: 'CLI output is not complete JSON or NDJSON' }; }
  }
  const events = Array.isArray(parsed) ? parsed : [];
  const body = events.length ? events.findLast(e => e?.type === 'result') : parsed;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { parseError: 'Missing result envelope' };
  const content = events.filter(e => !e?.parent_tool_use_id).flatMap(e => Array.isArray(e?.message?.content) ? e.message.content : []);
  const results = new Map(content.filter(p => p.type === 'tool_result' && typeof p.tool_use_id === 'string').map(p => [p.tool_use_id, p]));
  const mainModels = [...new Set(events.filter(e => e?.type === 'assistant' && !e.parent_tool_use_id)
    .map(e => e.message?.model).filter(Boolean))];
  const agentCalls = content.filter(p => p.type === 'tool_use' && ['Agent', 'Task'].includes(p.name)).map(p => {
    const result = results.get(p.id);
    const actualModels = typeof p.id === 'string' ? [...new Set(events.filter(e => e?.type === 'assistant' && e.parent_tool_use_id === p.id)
      .map(e => e.message?.model).filter(model => typeof model === 'string' && model.length))] : [];
    return { tool: p.name, toolUseId: p.id, role: p.input?.subagent_type, requestedModel: p.input?.model ?? 'inherit',
      actualModels, actualModelEvidence: 'Child assistant events bound by parent_tool_use_id',
      foreground: p.input?.run_in_background !== true,
      completed: !!result && result.is_error !== true && (typeof result.content === 'string' ? result.content.trim().length > 0 : Array.isArray(result.content) && result.content.length > 0),
      resultError: result?.is_error === true };
  });
  return { response: body.result ?? body.response, usage: body.usage, modelUsage: body.modelUsage,
    sessionId: body.sessionId ?? body.session_id, resultError: body.is_error === true || body.error != null,
    mainModels, agentCalls };
}

export function teamEvidence(client, execution, subagents, childModels) {
  if (client === 'claude_code') {
    const mainVerified = execution.mainModels?.length > 0 && execution.mainModels.every(m => canonical(m) === 'glm-5.3');
    const calls = (execution.agentCalls ?? []).map(call => {
      const model = call.requestedModel === 'inherit' ? 'glm-5.3' : canonical(call.requestedModel);
      const requestedRoutingSupported = ['glm-5.3', 'glm-5.3-flash'].includes(model);
      const actualRoutingVerified = requestedRoutingSupported && Array.isArray(call.actualModels) && call.actualModels.length > 0 &&
        call.actualModels.every(actual => canonical(actual) === model);
      return { ...call, resolvedRequestedModel: model, requestedRoutingSupported, actualRoutingVerified };
    });
    const completed = call => call.completed && call.foreground;
    const workflowVerified = roles.every(role => calls.some(c => c.role === role && completed(c)));
    const actualRoutingVerified = mainVerified && roles.every(role => calls.some(c => c.role === role && completed(c) && c.actualRoutingVerified));
    return { verified: workflowVerified && actualRoutingVerified, workflowVerified, actualRoutingVerified,
      mainVerified, calls, modelEvidenceBasis: 'Per-child assistant model events bound to the Agent tool call; aggregate modelUsage is not routing proof' };
  }
  const ended = subagents?.ended?.items;
  const evidence = roles.map(role => {
    const match = Array.isArray(ended) ? ended.find(e => e.subagentType === role && e.status === 'success' && typeof e.childSessionId === 'string') : undefined;
    const child = childModels?.find(c => c.sessionId === match?.childSessionId);
    return { role, sessionId: match?.childSessionId, completed: !!match,
      modelEvidence: !!child && child.parentSessionId === execution.sessionId && child.models?.length > 0 && child.models.every(m => ['glm-5.3', 'glm-5.3-flash'].includes(m)) };
  });
  const workflowVerified = Array.isArray(subagents?.running) && subagents.running.length === 0 && evidence.every(e => e.completed);
  const actualRoutingVerified = evidence.every(e => e.modelEvidence);
  return { verified: workflowVerified && actualRoutingVerified, workflowVerified, actualRoutingVerified, roles: evidence,
    modelEvidenceBasis: 'Completed assistant messages in each persisted child session' };
}

export async function collectZagentEvidence(runtime, execution, workspace) {
  await runtime.ready;
  if (!execution.sessionId) {
    // Exact task-owned mkdtemp path disambiguates concurrent sessions; never guess by latest time/title.
    const listed = await runtime.listSessions();
    const matches = (listed.sessions ?? []).filter(s => s.workspace?.workspacePath === workspace && s.sessionKind === 'interactive');
    if (matches.length !== 1) throw Error(`Expected one session for owned workspace; found ${matches.length}`);
    execution.sessionId = matches[0].sessionId;
    execution.sessionIdSource = 'exact unique owned workspace match';
  }
  const sid = execution.sessionId;
  // resume loads the persisted snapshot; it does not send a prompt or run inference.
  const parent = await runtime.call('session/resume', { sessionId: sid });
  if (parent.session?.workspace?.workspacePath !== workspace) throw Error('Session workspace mismatch');
  const subagents = await runtime.call('session/subagents', { sessionId: sid });
  const childModels = [];
  for (const id of subagents.childSessionIds ?? []) {
    const read = await runtime.call('session/resume', { sessionId: id });
    childModels.push({ sessionId: id, parentSessionId: read.session?.parentSessionId, models: modelsOf(read) });
  }
  return { subagents: { ...subagents, ended: { ...subagents.ended, items: (subagents.ended?.items ?? []).map(({ summary, ...e }) => e) } },
    childModels, mainModels: modelsOf(parent), usage: await runtime.call('session/usage', { sessionId: sid }) };
}

export function runGeneratedTests(workspace) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'sum.test.mjs'], { cwd: workspace, encoding: 'utf8', timeout: 10000 });
  const count = Number(result.stdout?.match(/^# tests (\d+)$/m)?.[1]);
  const passed = Number(result.stdout?.match(/^# pass (\d+)$/m)?.[1]);
  // Node counts an empty file as one passing file test. Require a registered subtest.
  const namedTests = [...(result.stdout ?? '').matchAll(/^# Subtest: (.+)$/gm)].filter(m => path.basename(m[1]) !== 'sum.test.mjs').length;
  return { exitCode: result.status, signal: result.signal, tests: Number.isFinite(count) ? count : null,
    passed: Number.isFinite(passed) ? passed : null, stdout: result.stdout, stderr: result.stderr,
    success: result.status === 0 && count > 0 && namedTests > 0 && passed === count };
}

export function assertNotCancelled(cancelled) {
  if (cancelled) throw Error('Cancelled before verification; generated code was not executed');
}

async function main() {
  if (process.argv.length !== 5 || process.argv[2] !== '--live' || !['claude_code', 'zagent'].includes(process.argv[3])) throw Error('Usage: --live claude_code|zagent RECEIPT.json');
  const client = process.argv[3], output = path.resolve(process.argv[4]);
  fs.writeFileSync(output, '', { flag: 'wx', mode: 0o600 });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `zteam-${client}-`));
  const receipt = { client, channel: 'ordinary plan usage, not free idle channel', startedAt: new Date().toISOString(), success: false };
  let child, runtime, cancelled = false;
  const kill = () => killChild(child);
  function cancel() { cancelled = true; kill(); runtime?.close(); }
  process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
  try {
    fs.writeFileSync(path.join(ws, 'sum.mjs'), 'export function sumFinite(values) { return values.reduce((a,b)=>a+b,0); }\n');
    fs.writeFileSync(path.join(ws, 'SPEC.md'), 'sumFinite(array): sum only finite numeric values; ignore NaN, infinities, strings, null and other nonnumbers. Empty array returns 0. Do not mutate input. Export named sumFinite from sum.mjs. No dependencies.\n');
    const prompt = 'Use the Agent tool to run our four configured roles as a coordinated team. ' +
      'The task is entirely in this temporary workspace; read SPEC.md. zteam-build owns only sum.mjs; zteam-test owns only sum.test.mjs. ' +
      'Dispatch these two roles in parallel with separate file ownership. After both complete, dispatch zteam-review read-only and zteam-verify to run node --test sum.test.mjs. ' +
      'Use these actual named roles, not roleplay; run foreground subagents. Do not solve the task yourself instead of delegating. ' +
      (client === 'claude_code' ? 'Keep the main model GLM-5.3. All four roles inherit by default; you decide independently whether each subagent needs full GLM-5.3 (opus or inherit) or Flash (sonnet). Flash is permitted only in subagents, never switch the main model to Flash. ' : '') +
      'Do not read unrelated home files or change configuration. No dependencies or git operations. Report the four role results, test command, and any remaining issue.';
    const args = client === 'claude_code' ? ['-p', prompt, '--no-session-persistence', '--output-format', 'json',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Read,Grep,Glob,Bash,Edit,Write,Agent'] : ['-p', prompt, '--json'];
    const start = Date.now();
    receipt.execution = await new Promise(resolve => {
      child = spawn(client === 'claude_code' ? (process.env.BENCH_CLAUDE_CODE_BIN ?? 'claude') : client, args, { cwd: ws, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      let stdout = '', stderr = '', truncated = false, timedOut = false, spawnError;
      child.stdout.on('data', d => { if (stdout.length + d.length > 2000000) truncated = true; stdout = (stdout + d).slice(-2000000); });
      child.stderr.on('data', d => { stderr = (stderr + d).slice(-3000); });
      const timer = setTimeout(() => { timedOut = true; kill(); }, 8 * 60 * 1000);
      child.on('error', e => { spawnError = e.code ?? 'spawn failed'; });
      child.on('close', (code, signal) => { clearTimeout(timer); kill(); child = undefined;
        resolve({ code, signal, wallMs: Date.now() - start, ...parseOutput(stdout), truncated, timedOut, spawnError, stderr }); });
    });
    assertNotCancelled(cancelled);
    const oracle = 'import assert from "node:assert/strict";import {sumFinite} from "./sum.mjs";' +
      'assert.equal(sumFinite([1,2,-3,4]),4);assert.equal(sumFinite([NaN,Infinity,-Infinity,"3",null,undefined,{},2]),2);' +
      'assert.equal(sumFinite([]),0);const a=Object.freeze([1,2]);assert.equal(sumFinite(a),3);console.log("PASS independent oracle");';
    const verified = spawnSync(process.execPath, ['--input-type=module', '-e', oracle], { cwd: ws, encoding: 'utf8', timeout: 10000 });
    receipt.oracle = { exitCode: verified.status, stdout: verified.stdout, stderr: verified.stderr };
    receipt.generatedTests = runGeneratedTests(ws);
    receipt.files = Object.fromEntries(['sum.mjs', 'sum.test.mjs'].map(f => [f, fs.existsSync(path.join(ws, f)) ? fs.readFileSync(path.join(ws, f), 'utf8') : null]));
    if (client === 'zagent' && !cancelled) {
      runtime = new ZCodeProtocolClient({ cwd: ws });
      try { Object.assign(receipt, await collectZagentEvidence(runtime, receipt.execution, ws)); }
      catch (e) { receipt.subagentEvidenceError = e.message; }
      finally { runtime.close(); runtime = undefined; }
    }
    receipt.team = teamEvidence(client, receipt.execution, receipt.subagents, receipt.childModels);
    const execution = receipt.execution;
    receipt.success = !cancelled && execution.code === 0 && !execution.signal && !execution.timedOut && !execution.truncated &&
      !execution.parseError && !execution.resultError && verified.status === 0 && receipt.generatedTests.success && receipt.team.verified;
  } catch (e) { receipt.error = e.message; }
  finally {
    kill(); runtime?.close(); receipt.cancelled = cancelled; receipt.finishedAt = new Date().toISOString();
    try { fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n'); }
    finally { fs.rmSync(ws, { recursive: true, force: true }); }
    process.off('SIGTERM', cancel); process.off('SIGINT', cancel);
  }
  if (!receipt.success) process.exitCode = 1;
  console.log(JSON.stringify({ client, success: receipt.success, wallMs: receipt.execution?.wallMs,
    team: receipt.team, parseError: receipt.execution?.parseError, subagentEvidenceError: receipt.subagentEvidenceError }));
}

async function selfTest() {
  const assert = (await import('node:assert/strict')).default;
  const content = roles.flatMap((role, i) => [{ type: 'tool_use', name: 'Agent', id: String(i), input: { subagent_type: role, model: i === 0 ? 'sonnet' : 'inherit' } },
    { type: 'tool_result', tool_use_id: String(i), content: 'complete' }]);
  const fixture = [{ type: 'assistant', message: { model: 'glm-5.3', content } },
    ...roles.map((_, i) => ({ type: 'assistant', parent_tool_use_id: String(i), message: { model: i === 0 ? 'glm-5.3-flash' : 'glm-5.3' } })),
    { type: 'result', result: 'done', modelUsage: {
    'glm-5.3': { inputTokens: 10, outputTokens: 1 }, 'glm-5.3-flash': { inputTokens: 10, outputTokens: 1 } } }];
  const parsed = parseOutput(JSON.stringify(fixture));
  assert.equal(teamEvidence('claude_code', parsed).verified, true);
  for (const change of [p => { p.agentCalls.pop(); }, p => { p.agentCalls[0].completed = false; }, p => { p.agentCalls[0].foreground = false; },
    p => { p.mainModels = ['glm-5.3-flash']; }, p => { p.agentCalls[0].actualModels = []; },
    p => { p.agentCalls[0].actualModels = ['glm-5.3']; }]) {
    const p = structuredClone(parsed); change(p); assert.equal(teamEvidence('claude_code', p).verified, false);
  }
  const noChildEvents = parseOutput(JSON.stringify(fixture.filter(e => !e.parent_tool_use_id)));
  assert.equal(teamEvidence('claude_code', noChildEvents).workflowVerified, true);
  assert.equal(teamEvidence('claude_code', noChildEvents).actualRoutingVerified, false);
  assert.equal(teamEvidence('claude_code', noChildEvents).verified, false); // aggregate usage alone cannot pass
  const wrongBinding = structuredClone(fixture); wrongBinding[1].parent_tool_use_id = 'unrelated';
  assert.equal(teamEvidence('claude_code', parseOutput(JSON.stringify(wrongBinding))).verified, false);
  let generatedCodeRan = false;
  assert.throws(() => { assertNotCancelled(true); generatedCodeRan = true; }, /Cancelled/);
  assert.equal(generatedCodeRan, false);
  assert.doesNotThrow(() => assertNotCancelled(false));
  assert.ok(parseOutput('garbage').parseError);
  assert.ok(parseOutput('{}').agentCalls.length === 0);
  const failed = structuredClone(fixture); failed[0].message.content[1].is_error = true;
  assert.equal(teamEvidence('claude_code', parseOutput(JSON.stringify(failed))).verified, false);
  const sub = { running: [], ended: { items: roles.map((role, i) => ({ subagentType: role, status: 'success', childSessionId: String(i) })) } };
  const children = roles.map((_, i) => ({ sessionId: String(i), parentSessionId: 'parent', models: ['glm-5.3-flash'] }));
  assert.equal(teamEvidence('zagent', { sessionId: 'parent' }, sub, children).verified, true);
  assert.equal(teamEvidence('zagent', { sessionId: 'other' }, sub, children).verified, false);
  children[0].models = [];
  assert.equal(teamEvidence('zagent', { sessionId: 'parent' }, sub, children).verified, false);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'zteam-selftest-'));
  try {
    for (const [source, accepted] of [['', false], ['import {test} from "node:test";test("bad",()=>{throw Error("fail")});', false],
      ['import {test} from "node:test";test("ok",()=>{});', true]]) {
      fs.writeFileSync(path.join(ws, 'sum.test.mjs'), source);
      assert.equal(runGeneratedTests(ws).success, accepted);
    }
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  console.log('PASS team-probe acceptance self-test');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') await selfTest(); else await main();
}
