// `zagent -p "…" --model <ref> --effort <level>` — model/effort selection for
// headless one-shots. The kernel's own -p parser (parseGlobalArgs, verified
// identical on 3.11.2 and 3.12.1) has NO --model/--effort flag; selection is a
// protocol surface instead: session/create accepts {model:{modelId,providerId,
// options:{reasoningLevel}}, thoughtLevel} (its "hasInitialModel/
// hasInitialThoughtLevel" telemetry proves both keys), and the turn runs over
// the app-server channel. Registry models REQUIRE options.reasoningLevel —
// a bare model ref fails bootstrap validation before thoughtLevel is read.
//
// Only invocations carrying --model/--effort take this path; every other -p
// keeps the kernel's own runner (and its retry wrapper) verbatim. Flags this
// path cannot honor — session continuity (-c/--resume), file attach, goal
// targets, tool denylists — are refused with exit 2 rather than silently
// dropped.
import path from 'node:path';
import { ZCodeProtocolClient, runTurn, sessionSid, currentAnswer, extractUsage } from '../driver/zcode-protocol.mjs';
import { setMode, MODES } from '../driver/session-control.mjs';
import { autoAllow } from '../driver/permissions.mjs';
import { modelReasoningLevels } from '../driver/providers.mjs';

const VALUE_FLAGS = new Set(['--model', '--effort', '--mode', '--cwd', '--output-format', '--locale']);
// The coding-plan vocabulary (GLM reasoningLevel/thoughtLevel low|high|max,
// same contract as commit-msg's --effort). With --model the model's resolved
// per-model vocabulary is the authority — EFFORTS is only the fallback when
// the catalog cannot answer, and the bound for effort-without-model.
export const EFFORTS = ['low', 'high', 'max'];
// Presentation-only flags a headless run can accept and ignore without lying.
const IGNORED_FLAGS = new Set(['--no-color', '--no-browser', '--verbose']);
// Flags whose semantics this path would silently break — refuse loudly.
const REFUSED_FLAGS = new Set(['-c', '--continue', '--resume', '--attach', '--target',
  '--target-replace', '--force', '-f', '--force-mcs', '--browser-use', '--browser-executable',
  '--surface', '--disallowedTools', '--disallowed-tools', '--stdio']);

export function hasSelection(args) {
  return args.some(a => a === '--model' || a === '--effort' || a.startsWith('--model=') || a.startsWith('--effort='));
}

export function isPrintInvocation(args) {
  return args.includes('-p') || args.some(a => a === '--prompt' || a.startsWith('--prompt=') || a.startsWith('-p='));
}

// Pull the selection/presentation flags out of argv; `rest` keeps the prompt
// flag and anything else. Throws (exit-2 wording) on a missing value or a flag
// this path cannot honor.
export function splitSelection(args) {
  const sel = { model: null, effort: null, mode: null, cwd: null, format: null, prompt: null };
  const refused = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const [name, eq] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (name === '-p' || name === '--prompt') {
      sel.prompt = eq !== undefined ? eq : args[++i];
      if (typeof sel.prompt !== 'string' || !sel.prompt || sel.prompt.startsWith('-'))
        throw new Error('-p/--prompt requires a prompt text');
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      const v = eq !== undefined ? eq : args[++i];
      // A flag-shaped value means the real flag was consumed as text
      // (`--model -p`): refuse rather than run an unselected session.
      if (typeof v !== 'string' || !v || v.startsWith('-')) throw new Error(`${name} requires a value`);
      if (name === '--model') sel.model = v;
      else if (name === '--effort') sel.effort = v;
      else if (name === '--mode') sel.mode = v;
      else if (name === '--cwd') sel.cwd = v;
      else if (name === '--output-format') sel.format = v;
      // --locale is presentation-only for a headless run; parsed, not forwarded.
      continue;
    }
    if (a === '--json' || IGNORED_FLAGS.has(a)) continue;
    if (REFUSED_FLAGS.has(name)) { refused.push(a); continue; }
    rest.push(a);
  }
  if (refused.length)
    throw new Error(`${refused.join(', ')} cannot be combined with --model/--effort — drop the selection flags to use the runtime's own -p path`);
  if (rest.length)
    throw new Error(`unrecognized arguments with --model/--effort: ${rest.join(', ')}`);
  if (sel.format && sel.format !== 'json' && sel.format !== 'text')
    throw new Error(`--output-format ${sel.format} is not supported with --model/--effort (text|json only)`);
  if (sel.prompt == null)
    throw new Error('-p/--prompt requires a prompt text');
  if (sel.mode && !MODES.includes(sel.mode))
    throw new Error(`--mode must be one of ${MODES.join('|')} (got '${sel.mode}')`);
  if (sel.effort) {
    sel.effort = sel.effort.toLowerCase();
    // --model's resolved vocabulary is the --effort authority (runPrintOnce
    // enforces it). Without --model there is no vocabulary to resolve — bound
    // to the plan set so typos still refuse at usage-error instead of flying
    // to the provider unvalidated.
    if (!sel.model && !EFFORTS.includes(sel.effort))
      throw new Error(`--effort must be one of ${EFFORTS.join('|')} without --model (got '${sel.effort}')`);
  }
  return sel;
}

// 'provider/model' or a bare 'model' (provider defaults to the plan's 'zai',
// matching the cli config's model.main convention and setModel's default).
export function modelRef(ref) {
  const v = String(ref ?? '').trim();
  if (!v) throw new Error('--model requires a non-empty model id');
  const i = v.indexOf('/');
  return i === -1 ? { providerId: 'zai', modelId: v }
    : { providerId: v.slice(0, i), modelId: v.slice(i + 1) };
}

async function openPrintClient(cwd) {
  const client = new ZCodeProtocolClient({ cwd, requestHandlers: { 'interaction/requestPermission': autoAllow } });
  try { await client.ready; }
  catch (e) { try { client.close(); } catch {} throw e; } // a spawned runtime is always terminated
  return client;
}

// One headless turn on a fresh session with the requested selection. `client`
// is injectable for tests; the CLI path opens (and always closes) its own.
// Permissions get autoAllow — the kernel's -p contract is "default yolo for
// --prompt" and zagentd does the same. A user-chosen --mode still applies via
// session/setMode (kernel-side enforcement); plan approval prompts hit the
// client's default decline handler, so headless plan mode produces the plan.
export async function runPrintOnce(sel, { client, createClient = openPrintClient, timeoutMs = 600_000, catalog, providerConfig } = {}) {
  const t0 = Date.now();
  const cwd = path.resolve(sel.cwd ?? process.cwd());
  const key = path.normalize(cwd);
  const params = { workspace: { workspaceKey: key, workspacePath: key } };
  if (sel.model) {
    // Kernel contract (verified on 3.12.1): bootstrap validates the model
    // selection strictly — registry models whose optionSpecs.reasoningLevel
    // exists reject a bare {providerId,modelId} with "Reasoning level is
    // required". Then the create handler re-applies the model via the string
    // setModel path, which DROPS options — so thoughtLevel must also be sent
    // to restore the level afterwards. --effort wins; without it we send the
    // model's own default (kernel picker convention: values.at(-1)).
    const ref = modelRef(sel.model);
    const levels = modelReasoningLevels(ref.modelId, catalog, ref.providerId, providerConfig);
    // A resolved vocabulary bounds --effort: sending a level the model does
    // not declare would fly to the kernel unvalidated and fail (or mis-map)
    // there. When the catalog cannot answer (levels null) the plan's EFFORTS
    // set is the fallback bound — refuse rather than forward an unverifiable
    // level. Refusal lands before the runtime is even spawned.
    const vocab = levels ?? EFFORTS;
    if (sel.effort && !vocab.includes(sel.effort))
      throw new Error(`--effort '${sel.effort}' is not a valid level for ${ref.modelId} (one of: ${vocab.join('|')})`);
    const level = sel.effort ?? levels?.at(-1);
    params.model = level ? { ...ref, options: { reasoningLevel: level } } : ref;
    if (level) params.thoughtLevel = level;
  } else if (sel.effort) {
    // No model to resolve a vocabulary for — the plan's set is the bound
    // (direct callers like commit-msg/MCP bypass splitSelection's check).
    if (!EFFORTS.includes(sel.effort))
      throw new Error(`--effort must be one of ${EFFORTS.join('|')} without --model (got '${sel.effort}')`);
    params.thoughtLevel = sel.effort;
  }
  const own = !client;
  if (own) client = await createClient(cwd);
  let sid = null;
  try {
    const created = await client.call('session/create', params);
    sid = sessionSid(created);
    if (!sid) throw new Error('unexpected session/create reply (no session id)');
    if (sel.mode) await setMode(client, sid, sel.mode);
    const before = await client.call('session/read', { sessionId: sid }, 30000);
    const turn = await runTurn(client, sid, sel.prompt, { timeoutMs });
    const after = await client.call('session/read', { sessionId: sid }, 30000);
    const answer = currentAnswer(before?.messages ?? [], after?.messages ?? []);
    const failed = turn.end?.ended !== 'turn-completed';
    const totals = extractUsage(turn.events)?.totals;
    const usage = totals && Object.values(totals).some(v => typeof v === 'number' && v > 0) ? totals : null;
    return { ok: !failed, answer, sessionId: sid, ended: turn.end?.ended ?? 'unknown',
      durationMs: Date.now() - t0, usage };
  } finally {
    if (own) try { client.close(); } catch {}
  }
}

// The kernel -p envelope is claude-code-shaped; in-repo consumers key on
// result + session_id/sessionId + BOTH is_error and isError (paired-core reads
// the former, headless-retry's oracle the latter) + error — emit all of them.
export function printEnvelope(r) {
  return { type: 'result', subtype: r.ok ? 'success' : 'error', is_error: !r.ok, isError: !r.ok,
    ...(r.ok ? {} : { error: r.error ?? r.answer ?? `turn ${r.ended}` }),
    result: r.ok ? r.answer : (r.answer || `turn ${r.ended}`),
    session_id: r.sessionId, sessionId: r.sessionId, duration_ms: r.durationMs, num_turns: 1,
    ...(r.usage ? { usage: r.usage } : {}) };
}
