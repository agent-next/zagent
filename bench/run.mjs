#!/usr/bin/env node
// bench/run.mjs — dual-lane same-task benchmark: zcode runtime vs claude_code harness, same GLM model.
// Usage: node bench/run.mjs <lane> <taskDir> <runId>   lane: zcode | claude_code
//   claude_code runs `claude` (override with BENCH_CLAUDE_CODE_BIN) routed to the same model by the caller's environment.
// Writes bench/results/<lane>_<task>_<runId>.json ; correctness = objective test.py oracle.
import { ZCodeProtocolClient, runTurn } from '../packages/driver/zcode-protocol.mjs';
import { setModel } from '../packages/driver/session-control.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { prepareRun } from './run-safety.mjs';

// --- Pure, unit-testable extraction (no live runtime) ---
// ZCode `session/read` returns { messages:[ {info,parts}, ... ], session:{...}, ... }.
// The transcript array is TOP-LEVEL (`read.messages`); `read.session` holds only metadata
// (createdAt, model, status, workspace, ...) with NO messages and NO usage. Each message
// carries its content in `parts` ({type:'text', text}), NOT a `content` field. Verified by
// live probe 2026-09-04.
function messagesOf(read) {
  if (Array.isArray(read?.messages)) return read.messages;              // proven runtime path
  if (Array.isArray(read?.session?.messages)) return read.session.messages; // defensive fallback
  return [];
}

// Join a message's text across shapes: ZCode parts[] first, then string/array `content`.
function messageText(msg) {
  if (!msg) return '';
  if (Array.isArray(msg.parts)) {
    return msg.parts
      .filter(p => p?.type === 'text' && typeof p.text === 'string')
      .map(p => p.text).join('');
  }
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => typeof b?.text === 'string').map(b => b.text).join('');
  }
  return '';
}

// The model's answer = text of the last assistant message (fall back to the last message).
// Returns '' for an empty/missing transcript — the caller MUST treat '' as an error, never
// write it as a silent solution (the old code emitted JSON.stringify('') = the 2-char "").
export function extractAnswer(read) {
  const msgs = messagesOf(read);
  if (!msgs.length) return '';
  let msg = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const role = msgs[i]?.info?.role ?? msgs[i]?.role;
    if (role === 'assistant') { msg = msgs[i]; break; }
  }
  if (!msg) msg = msgs[msgs.length - 1];
  return messageText(msg);
}

// Token usage lives on assistant messages' info.tokens (NOT read.session.usage).
// Single-turn: last == total. Multi-turn agentic: per-message semantics unprobed, so we
// record last-turn, cross-message sum, and the runtime's projection for honest labeling.
export function extractUsage(read) {
  const msgs = messagesOf(read);
  let firstTurn = null, inputSum = 0, outputSum = 0, cacheSum = 0;
  for (const m of msgs) {
    const t = m?.info?.tokens;
    if (!t) continue;
    firstTurn ??= { inputTokens: t.input, outputTokens: t.output, totalTokens: t.total,
                    cacheReadTokens: t.cache?.read, cacheWriteTokens: t.cache?.write,
                    reasoningTokens: t.reasoning };
    inputSum += t.input ?? 0; outputSum += t.output ?? 0; cacheSum += t.cache?.read ?? 0;
  }
  if (!firstTurn) return null;
  // firstTurn = the first token-bearing assistant message (== the only turn for non-agentic
  // tasks); sums cover multi-turn agentic sessions. Both recorded — never silently dropped.
  return { firstTurn, inputSum, outputSum, cacheSum, projectionUsed: read?.projection?.contextUsed };
}

// claude_code lane usage: newest session jsonl under ~/.claude/projects/<sanitized-ws>/
// (Claude Code sanitizes every non-alphanumeric in the cwd path to '-').
function claudeCodeUsage(ws) {
  const proj = path.join(os.homedir(), '.claude', 'projects', '-' + ws.slice(1).replace(/[^a-zA-Z0-9]/g, '-'));
  let files = [];
  try { files = readdirSync(proj).filter(f => f.endsWith('.jsonl')).map(f => ({ f, m: statSync(path.join(proj, f)).mtimeMs })); } catch { return null; }
  if (!files.length) return null;
  files.sort((x, y) => y.m - x.m);
  let inputTokens = 0, cacheReadTokens = 0, outputTokens = 0;
  const seen = new Set(); // the jsonl logs the SAME logical call twice (same message.id) —
  for (const ln of readFileSync(path.join(proj, files[0].f), 'utf8').split('\n')) { // dedupe before summing
    let j; try { j = JSON.parse(ln); } catch { continue; }
    const u = j?.message?.usage;
    const mid = j?.message?.id;
    if (u && typeof u.input_tokens === 'number' && mid) {
      if (seen.has(mid)) continue;
      seen.add(mid);
      inputTokens += u.input_tokens; cacheReadTokens += u.cache_read_input_tokens ?? 0;
      outputTokens += u.output_tokens ?? 0;
    }
  }
  if (!outputTokens && !inputTokens) return null;
  return { inputTokens, cacheReadTokens, outputTokens };
}

async function main() {
  const [lane, taskDir, runId] = process.argv.slice(2);
  if (!['zcode', 'claude_code'].includes(lane)) throw new Error('lane must be zcode or claude_code');
  // Optional per-session model pin: --model <providerId/modelId> (e.g. zai/glm-4.7-flash).
  const mi = process.argv.indexOf('--model');
  const modelSpec = mi >= 0 ? process.argv[mi + 1] : (process.argv.find(x => x.startsWith('--model=')) ?? '').slice('--model='.length) || null;
  const prompt = readFileSync(path.join(taskDir, 'task.md'), 'utf8');
  const results = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'bench/results');
  const run = prepareRun({ lane, task: path.basename(taskDir), runId, results });
  const ws = run.workspace, grade = run.grade;
  try {
  for (const f of readdirSync(taskDir).filter(f => f.endsWith('.py') && f !== 'test.py'))
    try { writeFileSync(path.join(ws, f), readFileSync(path.join(taskDir, f))); } catch {}
  try { writeFileSync(path.join(grade, 'test.py'), readFileSync(path.join(taskDir, 'test.py'))); } catch {}
  const t0 = Date.now();
  let turnMs = null; // send->turn-completed only: excludes boot/settle/retry bias
  let answer = '', usage = null, spawnFail = null;
  async function zcodeAttempt() {
    const c = new ZCodeProtocolClient({ cwd: ws });
    c.requestHandlers['interaction/requestPermission'] = p => // bench runs yolo: auto-allow tools
      p?.options?.find(o => o.kind === 'allow_once')?.response ?? { decision: 'allow' };
    try {
      turnMs = null; // fresh per attempt: a failed first try must not leak its timing
      await c.ready; // probe-based readiness replaces the boot sleep
      const created = await c.createSession(ws);
      const sid = created.session?.sessionId ?? created.sessionId;
      if (modelSpec) { const [pid, ...rest] = modelSpec.split('/'); await setModel(c, sid, rest.join('/'), pid); }
      const agentic = existsSync(path.join(taskDir, 'agent_graded'));
      const tSend = Date.now();
      const { end } = await runTurn(c, sid, prompt, { timeoutMs: agentic ? 300000 : 90000 });
      turnMs = Date.now() - tSend;
      if (end.ended !== 'turn-completed') throw new Error(`turn ${end.ended}`);
      await new Promise(r => setTimeout(r, 2000)); // final assistant part lands just after turn-completed
      const read = await c.readSession(sid);
      usage = extractUsage(read);
      answer = extractAnswer(read);
      // Empty transcript after a completed turn is a real error — never fall through and write "".
      if (!answer) throw new Error('empty transcript: no assistant text in session/read.messages');
    } finally { c.close(); } // never leak the runtime child on early throws
  }
  if (lane === 'zcode') {
    try { await zcodeAttempt(); }
    catch (e) { // 429/1302, failed turn, or empty transcript: one backoff retry, else record failure
      await new Promise(r => setTimeout(r, 30000));
      try { await zcodeAttempt(); } catch (e2) {
        const rec = { lane, task: path.basename(taskDir), runId, error: e2.message, pass: false };
        run.write(rec);
        console.log(JSON.stringify(rec)); process.exitCode = 1; return;
      }
    }
  } else {
    const claudeCodeRun = spawnSync(process.env.BENCH_CLAUDE_CODE_BIN ?? 'claude', ['-p', prompt], { cwd: ws, encoding: 'utf8', timeout: 240000, maxBuffer: 64e6 });
    answer = claudeCodeRun.stdout ?? '';
    usage = claudeCodeUsage(ws);
    if (claudeCodeRun.error) spawnFail = String(claudeCodeRun.error.code ?? claudeCodeRun.error.message);
    else if (claudeCodeRun.status !== 0) spawnFail = `exit:${claudeCodeRun.status}`;
  }
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  const agentic = existsSync(path.join(taskDir, 'agent_graded'));
  if (!agentic) {
    const blocks = [...answer.matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/g)];
    writeFileSync(path.join(grade, 'solution.py'), blocks.at(-1)?.[1] ?? answer); // last fence: models echo the original first
    try { writeFileSync(path.join(grade, 'buggy.py'), readFileSync(path.join(taskDir, 'buggy.py'))); } catch {}
  } else { // agent edited ws files in place: bring them into the grade dir — never test.py
    for (const f of readdirSync(ws)) if (f.endsWith('.py') && f !== 'test.py') copyFileSync(path.join(ws, f), path.join(grade, f));
  }
  const t = spawnSync('python3', ['test.py'], { cwd: grade, encoding: 'utf8', timeout: 30000 });
  const pass = !spawnFail && t.status === 0;
  const rec = { lane, task: path.basename(taskDir), runId, wall_s: +wall, turn_s: turnMs != null ? +(turnMs / 1000).toFixed(1) : null,
    model: modelSpec ?? 'default',
    pass, outLen: answer.length, spawn_error: spawnFail,
    usage, testOut: `${t.stdout ?? ''}${t.stderr ?? ''}`.slice(-200) };
  run.write(rec);
  console.log(JSON.stringify(rec));
  if (!pass) process.exitCode = 1;
  } finally { run.cleanup(); }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) await main().catch(e => { console.error('FATAL:', e?.message ?? e); process.exit(1); }); // never die record-less and silently
