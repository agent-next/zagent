// Offline tests for the -p --model/--effort protocol path (zagent-print.mjs).
// Fake client follows the test-unit.mjs pattern: notifications are emitted from
// inside the fake's call() so runTurn's acknowledgement ordering is real.
import { EventEmitter } from 'node:events';
import { hasSelection, isPrintInvocation, splitSelection, modelRef, runPrintOnce, printEnvelope, kernelPositional0, SELECTION_VALUE_FLAGS } from './zagent-print.mjs';
import { modelReasoningLevels, findModel } from '../driver/providers.mjs';
import { withPersistedMode, hasModeFlag } from '../driver/default-mode.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const throws = (fn, re, m) => { try { fn(); ok(false, `${m} (no throw)`); } catch (e) { ok(re.test(e.message), `${m} (${e.message.slice(0, 60)})`); } };

// --- flag plumbing ---
ok(hasSelection(['-p', 'x', '--model', 'glm-5.3-flash']), 'hasSelection: --model v');
ok(hasSelection(['-p', 'x', '--effort=max']), 'hasSelection: --effort=v');
ok(!hasSelection(['-p', 'x', '--mode', 'plan']), 'hasSelection: no selection');
ok(isPrintInvocation(['--prompt=hi']), 'isPrintInvocation: --prompt=');
ok(isPrintInvocation(['-p', 'hi']), 'isPrintInvocation: -p');
ok(isPrintInvocation(['-p=hi']), 'isPrintInvocation: -p=');
ok(isPrintInvocation(['--prompt', 'hi']), 'isPrintInvocation: --prompt v');
ok(!isPrintInvocation(['--model', 'x']), 'isPrintInvocation: no -p');
ok(!isPrintInvocation(['-px']), 'isPrintInvocation: -px is not the prompt flag');
// Only PRE-`--` tokens are flags — the kernel's parseArgs treats everything
// after the separator as positionals, so a post-`--` --model/-p is data, never
// a selection or print flag (filed OPEN LOW in a previous review round).
ok(!hasSelection(['-p', 'x', '--', '--model', 'm']), 'hasSelection: post-`--` --model is data');
ok(!hasSelection(['--', '--model', 'm']), 'hasSelection: flag entirely post-`--`');
ok(hasSelection(['--model', 'm', '--', '-p', 'x']), 'hasSelection: pre-`--` flag still seen');
ok(!isPrintInvocation(['--', '-p', 'x']), 'isPrintInvocation: post-`--` -p is data');
ok(!isPrintInvocation(['--model', 'm', '--', '--prompt=hi']), 'isPrintInvocation: post-`--` --prompt= is data');
ok(isPrintInvocation(['-p', 'x', '--', '--json']), 'isPrintInvocation: pre-`--` -p still seen');

let s = splitSelection(['-p', 'hi', '--model', 'zai/glm-5.3-flash', '--effort', 'max', '--json']);
ok(s.prompt === 'hi' && s.model === 'zai/glm-5.3-flash' && s.effort === 'max', 'splitSelection: values parsed');
// The persisted `zagent mode` default is injected as `--mode <v>` ahead of
// splitSelection — zagent.mjs gates the injection on isPrintInvocation(preSep)
// && !hasModeFlag(preSep) && kernelPositional0(preSep, SELECTION_VALUE_FLAGS)
// === undefined, so mirror that predicate here; the selection path must pick
// the value up as sel.mode.
const persistedArgv = (argv, mode) => {
  const sep = argv.indexOf('--');
  const pre = sep === -1 ? argv : argv.slice(0, sep);
  return isPrintInvocation(pre) && !hasModeFlag(pre) && kernelPositional0(pre, SELECTION_VALUE_FLAGS) === undefined
    ? withPersistedMode(argv, mode) : argv;
};
// kernelPositional0 must not read a selection flag's value as the kernel
// positional — `-p hi --model m` used to suppress the persisted-mode
// injection because `m` posed as positionals[0] (a previous review-round
// finding).
ok(kernelPositional0(['-p', 'hi', '--model', 'm'], SELECTION_VALUE_FLAGS) === undefined,
  'kernelPositional0: --model value is not a positional');
ok(kernelPositional0(['-p', 'hi', '--effort', 'max'], SELECTION_VALUE_FLAGS) === undefined,
  'kernelPositional0: --effort value is not a positional');
ok(kernelPositional0(['-p', 'hi', '--model=m'], SELECTION_VALUE_FLAGS) === undefined,
  'kernelPositional0: glued --model= has no value token');
ok(kernelPositional0(['login', '-p', 'hi'], SELECTION_VALUE_FLAGS) === 'login',
  'kernelPositional0: a leading kernel verb still reads');
ok(kernelPositional0(['-p', 'hi', '--model', 'm', 'verb'], SELECTION_VALUE_FLAGS) === 'verb',
  'kernelPositional0: a real trailing positional still blocks injection');
ok(kernelPositional0(['-p', 'hi', '--', 'x'], SELECTION_VALUE_FLAGS) === 'x',
  'kernelPositional0: post-`--` token is the kernel positional');
s = splitSelection(persistedArgv(['-p', 'hi', '--model', 'zai/glm-5.3'], 'plan'));
ok(s.mode === 'plan' && s.model === 'zai/glm-5.3' && s.prompt === 'hi',
  'persisted default flows through splitSelection as sel.mode');
s = splitSelection(persistedArgv(['-p', 'hi', '--model', 'zai/glm-5.3', '--mode', 'build'], 'plan'));
ok(s.mode === 'build', 'an explicit --mode still beats the persisted default on the selection path');
s = splitSelection(['--prompt=hi', '--model=bare-id', '--cwd', '/tmp', '--mode', 'plan', '--no-color']);
ok(s.model === 'bare-id' && s.cwd === '/tmp' && s.mode === 'plan', 'splitSelection: =form + cwd + mode');
s = splitSelection(['-p=hi', '--model', 'zai/glm-5.3']);
ok(s.prompt === 'hi' && s.model === 'zai/glm-5.3', 'splitSelection: -p= parses as the prompt flag');
throws(() => splitSelection(['-p=', '--model', 'm']), /requires a prompt text/, 'empty -p= refused');
throws(() => splitSelection(['-p', 'x', '--model']), /--model requires a value/, 'missing --model value');
throws(() => splitSelection(['-p', 'x', '--model', 'm', '--resume', 'sess_1']), /cannot be combined/, 'refuses --resume');
throws(() => splitSelection(['-p', 'x', '--model', 'm', '--disallowed-tools', 'Bash']), /cannot be combined/, 'refuses tool denylist (silent drop would lie)');
throws(() => splitSelection(['-p', 'x', '--model', 'm', '--bogus']), /unrecognized arguments/, 'refuses unknown args');
throws(() => splitSelection(['-p', 'x', '--model', 'm', '--output-format', 'stream-json']), /not supported/, 'refuses stream-json');
throws(() => splitSelection(['--model', '-p']), /requires a value/, 'flag-shaped value is not a model id');
throws(() => splitSelection(['-p', '--json', '--model', 'm']), /requires a prompt text/, 'flag-shaped -p value refused');
throws(() => splitSelection(['--prompt=', '--model', 'm']), /requires a prompt text/, 'empty --prompt= refused');
throws(() => splitSelection(['-p']), /requires a prompt text/, 'bare -p refused');
throws(() => splitSelection(['-p', 'x', '--effort']), /requires a value/, 'missing --effort value');
throws(() => splitSelection(['-p', 'x', '--model', 'm', '--cwd']), /requires a value/, 'missing --cwd value');
throws(() => splitSelection(['-p', 'x', '--model', 'm', '--mode', 'bogus']), /--mode must be one of/, 'invalid --mode refused pre-flight');
throws(() => splitSelection(['-p', 'x', '--effort', 'bogus']), /--effort must be one of low\|high\|max/, 'invalid --effort refused pre-flight');
// With --model the parse gate defers to the resolved per-model vocabulary —
// a non-plan level like 'enabled' is not vetoed statically at split time.
s = splitSelection(['-p', 'x', '--model', 'zai/m', '--effort', 'enabled']);
ok(s.effort === 'enabled' && s.model === 'zai/m', 'splitSelection: non-plan effort passes through with --model');
s = splitSelection(['-p', 'x', '--effort', 'MAX']);
ok(s.effort === 'max', 'splitSelection: --effort normalized to lowercase');
// `--` ends flag parsing (POSIX, kernel parseArgs): a trailing separator is
// legal; post-`--` tokens are positionals — still refused on this path, but
// named as data, never parsed as flags.
s = splitSelection(['-p', 'hi', '--model', 'zai/glm-5.3', '--']);
ok(s.model === 'zai/glm-5.3' && s.prompt === 'hi', 'splitSelection: trailing `--` accepted');
throws(() => splitSelection(['-p', 'hi', '--model', 'm', '--', 'pos']),
  /unrecognized arguments with --model\/--effort: pos/,
  'post-`--` positional refused and named as data');
throws(() => splitSelection(['-p', 'hi', '--model', 'm', '--', '--effort', 'low']),
  /unrecognized arguments with --model\/--effort: --effort, low/,
  'post-`--` --effort is data, not a flag');

// --- model ref parsing ---
let r = modelRef('zai/glm-5.3-flash');
ok(r.providerId === 'zai' && r.modelId === 'glm-5.3-flash', 'modelRef provider/model');
r = modelRef('glm-5.3');
ok(r.providerId === 'zai' && r.modelId === 'glm-5.3', 'modelRef bare id defaults to zai');
throws(() => modelRef('  '), /non-empty/, 'modelRef rejects blank');

// --- protocol path against a fake client ---
const fakeClient = (messages) => {
  const calls = [];
  const client = {
    calls, dead: false, child: new EventEmitter(), onNotify() {},
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'session/create') return { session: { sessionId: 'sess_fake' } };
      if (method === 'session/read') return { messages: calls.some(c => c.method === 'session/send') ? messages.after : messages.before };
      if (method === 'session/send') {
        client.onNotify({ method: 'computer-use/operation-event',
          params: { sessionId: 'sess_fake', turnId: 't1', kind: 'turn-started' } });
        client.onNotify({ method: 'computer-use/operation-event',
          params: { sessionId: 'sess_fake', turnId: 't1', kind: 'turn-completed' } });
        return { turnId: 't1' };
      }
      return {};
    },
    close() {},
  };
  return client;
};
const assistant = (id, text) => ({ info: { id, role: 'assistant' }, parts: [{ type: 'text', text }] });

// Synthetic builtin catalog (mirrors the real zcode-builtin.json shape): a
// catch-all `.*` default first, then the lowercase glm-5.3 rule — the kernel's
// matchesRule (nct) is anchored `^(?:pattern)$` + /i, so 'GLM-5.3' resolves the
// glm-5.3 rule while 'glm-5.3xyz' falls back to the catch-all.
const fixtureCatalog = {
  schemaVersion: 1,
  config: {
    providerConfigRules: { providerRules: [], templateRules: [] },
    modelConfigRules: { modelRules: [
      { modelMatch: '.*', config: { optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] } } } },
      { modelMatch: '.*glm-5\\.3(?:-flash)?(?:[.\\-:/\\[].*)?', config: { optionSpecs: { reasoningLevel: { values: ['low', 'high', 'max'] } } } },
    ] },
  },
};
const J = JSON.stringify;
ok(J(modelReasoningLevels('GLM-5.3', fixtureCatalog)) === J(['low', 'high', 'max']),
  'kernel matcher parity: uppercase catalog id matches the lowercase rule (/i)');
ok(J(modelReasoningLevels('glm-5.3', fixtureCatalog)) === J(['low', 'high', 'max']),
  'kernel matcher parity: lowercase id matches');
ok(J(modelReasoningLevels('glm-5.3xyz', fixtureCatalog)) === J(['disabled', 'enabled']),
  'kernel matcher parity: $ anchor rejects a suffixed id (catch-all wins)');
ok(J(modelReasoningLevels('glm-5.3-flash', fixtureCatalog)) === J(['low', 'high', 'max']),
  'kernel matcher parity: -flash variant matches the same rule');

// The kernel merges ALL five modelConfigRules arrays into one RuleSet in this
// order (zcode.cjs `new _h([...])`): modelRules -> modelApiRules ->
// providerSiteRules -> templateModelRules -> builtinProviderModelRules — but
// api/site sets are scoped per provider (apiTypeMatch on config.api.type,
// baseUrlMatch on config.api.baseUrl) and the keyed sets need the matching
// templateId/providerId. A model matched only by a scoped set resolves its
// vocabulary ONLY for a provider the rule targets.
const fixtureAllSets = {
  schemaVersion: 1,
  config: {
    providerConfigRules: {
      providerRules: [],
      templateRules: [
        { templateId: 'zai-api', config: { api: { type: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic' },
          builtinModelIds: ['glm-x-preview-f', 'qwen-max', 'other-model'] } },
        { templateId: 'openai', config: { api: { type: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
          builtinModelIds: ['qwen-max', 'other-model'] } },
      ],
    },
    modelConfigRules: {
      modelRules: [{ modelMatch: '.*', config: { properties: { inputFormat: { supportsText: true } },
        optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] } } } }],
      modelApiRules: [{ modelMatch: '.*preview.*', apiTypeMatch: 'anthropic-messages',
        config: { optionSpecs: { reasoningLevel: { values: ['low', 'high', 'max'] } } } }],
      providerSiteRules: [
        { modelMatch: '.*', baseUrlMatch: 'https://api\\.z\\.ai/api/anthropic/?',
          config: { properties: { inputFormat: { supportsImage: true, supportsVideo: true } } } },
        { modelMatch: 'qwen-max', baseUrlMatch: 'https://api\\.z\\.ai/api/anthropic/?',
          config: { optionSpecs: { reasoningLevel: { values: ['minimal', 'xhigh'] } } } },
      ],
    },
  },
};
ok(J(modelReasoningLevels('glm-x-preview-f', fixtureAllSets, 'zai-api', null)) === J(['low', 'high', 'max']),
  'modelApiRules consulted for a provider whose api.type matches (later set wins over the catch-all)');
ok(J(modelReasoningLevels('glm-x-preview-f', fixtureAllSets, 'openai', null)) === J(['disabled', 'enabled']),
  'apiTypeMatch scopes the rule OUT for a non-matching provider');
ok(J(modelReasoningLevels('glm-x-preview-f', fixtureAllSets)) === J(['disabled', 'enabled']),
  'no provider context: scoped rules never apply (never over-claim)');
ok(J(modelReasoningLevels('qwen-max', fixtureAllSets, 'zai-api', null)) === J(['minimal', 'xhigh']),
  'providerSiteRules consulted when baseUrlMatch hits');
ok(J(modelReasoningLevels('qwen-max', fixtureAllSets, 'openai', null)) === J(['disabled', 'enabled']),
  'baseUrlMatch scopes the site rule OUT for a non-matching baseUrl');
ok(J(modelReasoningLevels('other-model', fixtureAllSets, 'zai-api', null)) === J(['disabled', 'enabled']),
  'unmatched model still resolves the modelRules catch-all');
{
  // The reviewer's MAJOR: an UNSCOPED merge would report the z.ai site
  // catch-all's vision flags on every builtin model (incl. openai template).
  const fm = findModel('other-model', fixtureAllSets);
  const zaiHit = fm.find(h => h.provider === 'zai-api');
  const openaiHit = fm.find(h => h.provider === 'openai');
  ok(zaiHit?.input.join() === 'text,image,video',
    `site catch-all adds vision on api.z.ai AND merges with supportsText (got ${zaiHit?.input})`);
  ok(openaiHit?.input.join() === 'text',
    `site catch-all does NOT leak to the openai template (got ${openaiHit?.input})`);
}

// Legacy catalog (zcode.model-providers.v1, verified on the 3.6.5
// models_catalog file): reasoning is {defaultLevel, levels:{<name>:{per-api
// patch}}} — an object keyed by level name, and the declared defaultLevel is
// the picker default, NOT the last key ('enabled/off' models default to the
// FIRST key 'enabled'). Ordering default-last keeps the at(-1) contract true.
const legacyCatalog = {
  schemaVersion: 'zcode.model-providers.v1',
  providers: [{ id: 'zai', models: [
    { id: 'm-default-first', reasoning: { defaultLevel: 'enabled', levels: { enabled: {}, off: {} } } },
    { id: 'm-plain', reasoning: { defaultLevel: 'max', levels: { low: {}, high: {}, max: {} } } },
    { id: 'm-array', reasoning: { defaultLevel: 'high', levels: [{ value: 'low' }, { value: 'high' }] } },
    { id: 'm-none' },
  ] }],
};
ok(J(modelReasoningLevels('m-default-first', legacyCatalog)) === J(['off', 'enabled']),
  'legacy reasoning.levels object keys resolve; defaultLevel sorts last');
ok(J(modelReasoningLevels('m-plain', legacyCatalog)) === J(['low', 'high', 'max']),
  'legacy levels keep declared order when the default already sits last');
ok(J(modelReasoningLevels('m-array', legacyCatalog)) === J(['low', 'high']),
  'legacy levels also accept the registry array-of-{value} shape');
ok(modelReasoningLevels('m-none', legacyCatalog) === null, 'model without reasoning -> null');
ok(modelReasoningLevels('absent', legacyCatalog) === null, 'absent model -> null');

// Duplicate ids across providers carry divergent vocabularies in the real
// catalog (a model published under both cn and intl providers): providerId
// scopes the lookup so another provider's levels can't be borrowed.
// Case-insensitive like the builtin matcher.
const dupCatalog = {
  schemaVersion: 'zcode.model-providers.v1',
  providers: [
    { id: 'qwen-cn', models: [{ id: 'm-dup', reasoning: { defaultLevel: 'enabled', levels: { enabled: {}, off: {} } } }] },
    { id: 'qwen-intl', models: [{ id: 'm-dup', reasoning: { defaultLevel: 'max', levels: { low: {}, max: {} } } }] },
  ],
};
ok(J(modelReasoningLevels('m-dup', dupCatalog, 'qwen-intl')) === J(['low', 'max']),
  'providerId picks the right provider\'s vocabulary for a duplicate id');
ok(J(modelReasoningLevels('m-dup', dupCatalog, 'QWEN-INTL')) === J(['low', 'max']),
  'providerId match is case-insensitive');
ok(modelReasoningLevels('m-dup', dupCatalog, 'absent-provider') === null,
  'unknown provider -> null (no borrowed vocabulary)');
ok(J(modelReasoningLevels('m-dup', dupCatalog)) === J(['off', 'enabled']),
  'no providerId -> first provider wins (legacy behavior preserved)');

{
  const client = fakeClient({ before: [], after: [assistant('a1', 'the answer')] });
  const out = await runPrintOnce({ prompt: 'hi', model: 'zai/glm-5.3-flash', effort: 'max', mode: 'plan', cwd: '/tmp' }, { client });
  const create = client.calls.find(c => c.method === 'session/create');
  ok(create && create.params.model.modelId === 'glm-5.3-flash' && create.params.model.providerId === 'zai',
    'session/create carries model selection');
  ok(create.params.model.options?.reasoningLevel === 'max' && create.params.thoughtLevel === 'max',
    'model+effort sends options.reasoningLevel AND thoughtLevel (kernel string-setModel wipes options)');
  ok(client.calls.some(c => c.method === 'session/setMode' && c.params.mode === 'plan'), '--mode applies via session/setMode');
  ok(out.ok && out.answer === 'the answer' && out.sessionId === 'sess_fake', 'answer extracted, ok');
  const env = printEnvelope(out);
  ok(env.is_error === false && env.isError === false && env.result === 'the answer' &&
    env.session_id === 'sess_fake' && env.sessionId === 'sess_fake' && env.subtype === 'success',
    'json envelope shape matches the kernel contract (both casings)');
  ok(!('error' in env) && !('usage' in env), 'success envelope has no error field; all-zero usage omitted');
}
{
  const client = fakeClient({ before: [], after: [assistant('a1', '')] });
  client.call = async (method, params) => { // turn-failed variant
    client.calls.push({ method, params });
    if (method === 'session/create') return { sessionId: 'sess_f2' };
    if (method === 'session/read') return { messages: [] };
    if (method === 'session/send') {
      client.onNotify({ method: 'computer-use/operation-event', params: { sessionId: 'sess_f2', turnId: 't9', kind: 'turn-started' } });
      client.onNotify({ method: 'computer-use/operation-event', params: { sessionId: 'sess_f2', turnId: 't9', kind: 'turn-failed' } });
      return { turnId: 't9' };
    }
    return {};
  };
  const out = await runPrintOnce({ prompt: 'hi', model: 'glm-5.3' }, { client, catalog: fixtureCatalog, providerConfig: null });
  const env = printEnvelope(out);
  ok(!out.ok && out.ended === 'turn-failed' && env.is_error === true && env.isError === true && typeof env.error === 'string',
    'turn-failed -> is_error/isError/error envelope (retry-oracle visible)');
  const m2 = client.calls.find(c => c.method === 'session/create').params.model;
  ok(m2.providerId === 'zai' && m2.options?.reasoningLevel === 'max',
    'bare model id maps to zai provider + fixture default (hermetic — no host catalog)');
}
{
  // Synthetic catalog injected: literal pins, no /opt/ZCode dependency — CI
  // fails if the reasoningLevel field drops or the kernel matcher diverges.
  const client = fakeClient({ before: [], after: [assistant('a1', 'x')] });
  await runPrintOnce({ prompt: 'hi', model: 'zai/GLM-5.3' }, { client, catalog: fixtureCatalog, providerConfig: null });
  const create = client.calls.find(c => c.method === 'session/create');
  ok(create.params.model.options?.reasoningLevel === 'max' && create.params.thoughtLevel === 'max',
    'no --effort: uppercase catalog id embeds the model default (literal max)');
}
{
  const client = fakeClient({ before: [], after: [assistant('a1', 'x')] });
  await runPrintOnce({ prompt: 'hi', model: 'zai/glm-5.3', effort: 'low' }, { client, catalog: fixtureCatalog, providerConfig: null });
  const create = client.calls.find(c => c.method === 'session/create');
  ok(create.params.model.options?.reasoningLevel === 'low' && create.params.thoughtLevel === 'low',
    '--effort low wins over the model default (literal low, not max)');
}
{
  const client = fakeClient({ before: [], after: [assistant('a1', 'x')] });
  await runPrintOnce({ prompt: 'hi', effort: 'low' }, { client });
  const create = client.calls.find(c => c.method === 'session/create');
  ok(create.params.thoughtLevel === 'low' && create.params.model === undefined,
    'effort-only still uses the thoughtLevel param');
}
{
  // --effort is validated against the model's resolved levels when a catalog
  // can answer: 'low' is not a level for an enabled/off model — refuse before
  // session/create instead of shipping an invalid reasoningLevel to the kernel.
  const client = fakeClient({ before: [], after: [assistant('a1', 'x')] });
  let threw = null;
  try { await runPrintOnce({ prompt: 'hi', model: 'zai/m-default-first', effort: 'low' }, { client, catalog: legacyCatalog, providerConfig: null }); }
  catch (e) { threw = e; }
  ok(/not a valid level for m-default-first.*off\|enabled/.test(threw?.message ?? ''),
    `--effort outside the resolved levels is refused (got: ${threw?.message})`);
  ok(!client.calls.some(c => c.method === 'session/create'),
    'refusal happens before session/create');
}
{
  // Same refusal on the builtin catch-all vocabulary (disabled|enabled).
  const client = fakeClient({ before: [], after: [assistant('a1', 'x')] });
  let threw = null;
  try { await runPrintOnce({ prompt: 'hi', model: 'zai/other-model', effort: 'low' }, { client, catalog: fixtureAllSets, providerConfig: null }); }
  catch (e) { threw = e; }
  ok(/not a valid level for other-model.*disabled\|enabled/.test(threw?.message ?? ''),
    `builtin catch-all levels bound --effort too (got: ${threw?.message})`);
}
{
  // An unresolvable model (no rule match, no levels) falls back to the plan
  // vocabulary: 'low' is forwarded, a level outside low|high|max is refused.
  const client = fakeClient({ before: [], after: [assistant('a1', 'x')] });
  await runPrintOnce({ prompt: 'hi', model: 'zai/m-none', effort: 'low' }, { client, catalog: legacyCatalog, providerConfig: null });
  const create = client.calls.find(c => c.method === 'session/create');
  ok(create.params.thoughtLevel === 'low', 'unresolvable levels: plan-set --effort forwarded');
  const client2 = fakeClient({ before: [], after: [assistant('a1', 'x')] });
  let threw = null;
  try { await runPrintOnce({ prompt: 'hi', model: 'zai/m-none', effort: 'medium' }, { client: client2, catalog: legacyCatalog, providerConfig: null }); }
  catch (e) { threw = e; }
  ok(/not a valid level for m-none.*low\|high\|max/.test(threw?.message ?? ''),
    `unresolvable levels: outside the plan set is refused (got: ${threw?.message})`);
  ok(!client2.calls.some(c => c.method === 'session/create'), 'fallback refusal precedes session/create');
}
{
  // A declared non-plan vocabulary accepts its own levels: 'enabled' is valid
  // for a legacy enabled/off model even though it is outside EFFORTS.
  const client = fakeClient({ before: [], after: [assistant('a1', 'x')] });
  await runPrintOnce({ prompt: 'hi', model: 'zai/m-default-first', effort: 'enabled' }, { client, catalog: legacyCatalog, providerConfig: null });
  const create = client.calls.find(c => c.method === 'session/create');
  ok(create?.params.model?.options?.reasoningLevel === 'enabled' && create.params.thoughtLevel === 'enabled',
    'declared non-plan level accepted and sent on both keys');
}

if (fails) { console.error(`${fails} FAIL`); process.exit(1); }
console.log('PASS print-selection');
