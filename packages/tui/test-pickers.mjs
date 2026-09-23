// Picker tests. The fixtures are the SHAPES the host actually hands us, captured
// live from the runtime.
import { effortItems, modelItems, parseModes, pickerFor, grantItems, grantLabel } from './pickers.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

// --- effort --------------------------------------------------------------------
const EFFORT = [{ id: 'low', label: 'low' }, { id: 'high', label: 'high' }, { id: 'max', label: 'max' }];
const effort = effortItems(EFFORT, 'max');
ok(effort.map(i => i.value).join() === 'low,high,max', 'effort options keep the runtime order');
ok(effort[2].note === '(current)' && effort[0].note === '', 'the current effort is marked, others are not');
ok(effortItems(EFFORT).every(i => i.note === ''), 'no current effort marks nothing');
ok(effortItems(null).length === 0 && effortItems([null, {}, { id: 5 }]).length === 0,
   'malformed effort options are skipped');
ok(effortItems([{ id: 'x' }])[0].label === 'x', 'a missing label falls back to the id');

// --- model ---------------------------------------------------------------------
const MODELS = [
  { alias: 'main', id: 'zai/glm-5.3', name: 'GLM-5.3', contextWindow: 1000000,
    maxOutputTokens: 128000, supportsImages: false, supportsPdf: false, supportsVideo: false },
  { alias: 'lite', id: 'zai/glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1000000,
    maxOutputTokens: 128000, supportsImages: true, supportsPdf: false, supportsVideo: true },
];
const models = modelItems(MODELS, 'zai/glm-5.3');
ok(models.map(i => i.value).join() === 'zai/glm-5.3,zai/glm-5.3-flash', 'model ids are the pick values');
ok(models[0].label === 'GLM-5.3' && models[1].label === 'GLM-5.3-Flash', 'display names are used');
ok(models[0].note.includes('main') && models[1].note.includes('lite'), 'the alias is shown');
// vision is the actual reason to pick lite, so it must be visible
ok(models[1].note.includes('image') && models[1].note.includes('video'), 'the lite model advertises image+video');
ok(!models[0].note.includes('image'), 'the main model does not claim vision it lacks');
ok(models[0].note.includes('(current)') && !models[1].note.includes('(current)'), 'the current model is marked');
ok(modelItems(null).length === 0 && modelItems([{ name: 'no id' }]).length === 0, 'malformed models are skipped');
ok(modelItems([{ id: 'x/y' }])[0].label === 'x/y', 'a missing name falls back to the id');

// The kernel 3.12.x registry emits {ref:{providerId,modelId}, label, providerLabel,
// contextWindow, reasoning, properties} — no `id`/`name`/`alias`. Before this was
// handled, /model's picker was empty and the kernel's own reply rendered
// "• undefined" (its formatModelList expects the other shape too — kernel-side bug).
// properties.inputFormat is the OBJECT form used by zcode-builtin.json modelRules:
// {supportsText, supportsImage, supportsVideo, supportsAudio, supportsPdf}.
const REGISTRY = [
  { ref: { providerId: 'zai', modelId: 'glm-5.3' }, label: 'glm-5.3', providerLabel: 'Z.AI Coding Plan',
    contextWindow: 1000000, maxOutputTokens: 128000,
    reasoning: { levels: [{ value: 'low', label: 'low' }], defaultLevel: 'max' },
    properties: { inputFormat: { supportsText: true, supportsImage: false, supportsVideo: false },
      outputFormat: { supportsText: true } } },
  { ref: { providerId: 'zai', modelId: 'glm-5.3-flash' }, label: 'glm-5.3-flash', providerLabel: 'Z.AI Coding Plan',
    contextWindow: 1000000, maxOutputTokens: 128000,
    reasoning: { levels: [{ value: 'low', label: 'low' }], defaultLevel: 'max' },
    properties: { inputFormat: { supportsText: true, supportsImage: true, supportsVideo: true },
      outputFormat: { supportsText: true } } },
];
const reg = modelItems(REGISTRY, 'zai/glm-5.3');
ok(reg.length === 2, 'registry-shaped model options are not dropped');
ok(reg.map(i => i.value).join() === 'zai/glm-5.3,zai/glm-5.3-flash', 'registry refs become provider/model pick values');
ok(reg[0].label === 'glm-5.3' && reg[1].label === 'glm-5.3-flash', 'the registry label is displayed');
ok(reg[0].note.includes('(current)') && !reg[1].note.includes('(current)'), 'the current registry model is marked');
ok(reg[1].note.includes('image') && reg[1].note.includes('video'), 'registry inputFormat advertises vision');
ok(!reg[0].note.includes('image'), 'a text-only registry model does not claim vision');
ok(reg[0].note.includes('Z.AI Coding Plan'), 'the provider label fills the missing alias slot');
ok(modelItems([{ ref: { providerId: 'x' } }, { ref: {} }, { ref: { providerId: 'p', modelId: 'm' } }])
  .map(i => i.value).join() === 'p/m', 'incomplete refs are skipped');
ok(modelItems([{ id: 'a/b', ref: { providerId: 'x', modelId: 'y' } }])[0].value === 'a/b',
  'a present id wins over a ref (legacy shape is not reinterpreted)');
ok(modelItems([{ ref: { providerId: 'p', modelId: 'm' }, providerLabel: 'p', label: 'm' }])[0].note === '',
  'a providerLabel equal to the providerId adds no noise');
ok(modelItems([{ ref: { providerId: 'zai', modelId: 'm' }, providerLabel: 'ZAI', label: 'm' }])[0].note === '',
  'providerLabel/providerId dedup is case-insensitive');
ok(modelItems([{ ref: { providerId: 'p', modelId: 'm' }, label: 'm', alias: '' }])[0].note === '',
  'an empty-string alias does not shadow the providerLabel slot');
ok(modelItems([{ ref: { providerId: 'p', modelId: 'm' }, label: 'm', properties: { inputFormat: ['text', 'image'] } }])[0]
  .note.includes('image'), 'array inputFormat is read');
ok(modelItems([{ ref: { providerId: 'p', modelId: 'm' }, label: 'm', properties: { inputFormat: 'text+pdf' } }])[0]
  .note.includes('pdf'), 'a delimited-string inputFormat is read');
ok(modelItems([{ ref: { providerId: 'p', modelId: 'm' }, label: 'm', properties: { inputFormat: { supportsAudio: true } } }])[0]
  .note.includes('audio'), 'object inputFormat surfaces audio');
ok(modelItems([{ ref: { providerId: 'p', modelId: 'm' }, label: 'm', supportsImages: true, properties: { inputFormat: '' } }])[0]
  .note.includes('image'), 'a useless inputFormat falls back to the supports flags');
ok(modelItems([{ ref: { providerId: 'p', modelId: 'm' }, label: 'm', supportsImages: true, properties: { inputFormat: {} } }])[0]
  .note.includes('image'), 'an unkeyed inputFormat object falls back to the supports flags');
ok(!modelItems([{ ref: { providerId: 'p', modelId: 'm' }, label: 'm', supportsImages: true,
  properties: { inputFormat: { supportsText: true, supportsImage: false } } }])[0].note.includes('image'),
  'a keyed all-false inputFormat object is authoritative over the supports flags');
ok(modelItems([{ id: '  ' }]).length === 0, 'a whitespace-only id is skipped');
ok(modelItems([{ id: ' a/b ' }])[0].value === 'a/b', 'a padded id is trimmed for the pick value');
ok(modelItems([{ ref: { providerId: ' ', modelId: 'm' }, label: 'm' }]).length === 0,
  'a whitespace-only ref field is skipped');
ok(modelItems(REGISTRY, 'glm-5.3')[0].note.includes('(current)'),
  'a bare modelId current still marks the matching registry entry');
ok(modelItems(REGISTRY, 'ZAI/GLM-5.3')[0].note.includes('(current)'),
  'the current-model match is case-insensitive on the modelId tail');
{
  // the same modelId under two providers: exact id decides, the tail does not double-mark
  const dup = [
    { ref: { providerId: 'builtin:a', modelId: 'm1' }, label: 'm1' },
    { ref: { providerId: 'account:b', modelId: 'm1' }, label: 'm1' },
  ];
  const items = modelItems(dup, 'builtin:a/m1');
  ok(items[0].current === true && items[1].current === false,
    'duplicate modelIds mark only the exact provider/model');
  const tail = modelItems(dup, 'p/m1');
  ok(tail[0].current === true && tail[1].current === true,
    'with no exact hit the modelId tail marks the matches');
  ok(modelItems([{ id: 'a/b', ref: { providerId: 'p', modelId: 'y' }, label: 'x' }], 'q/y')[0]
    .current === false, 'an entry with a usable id is not tail-matched');
}

// --- modes: parsed from the runtime, never hardcoded ----------------------------
const REPLY = 'Current mode: build. Available modes: plan, build, edit, yolo.';
const modes = parseModes(REPLY);
ok(modes.items.map(i => i.value).join() === 'plan,build,edit,yolo', 'the mode list comes from the runtime reply');
ok(modes.current === 'build', 'the current mode is read from the reply');
ok(modes.items.find(i => i.value === 'build').note.includes('(current)'), 'the current mode is marked');
// Every mode carries the one-line meaning verified against the
// runtime's own permission chain — a mode name alone taught nothing.
ok(modes.items.find(i => i.value === 'plan').note.includes('planning only'),
   'plan says changes are denied');
ok(modes.items.find(i => i.value === 'build').note.includes('asks before risky tools'),
   'build says what it asks about');
ok(modes.items.find(i => i.value === 'edit').note.includes('file edits run free'),
   'edit says what it skips');
ok(modes.items.find(i => i.value === 'yolo').note.includes('every tool runs'),
   'yolo discloses that nothing asks');
// a runtime that adds a mode gains it here with no code change — 'auto' is
// real: the runtime reserves it and DENIES tools, so the note must say so
// rather than let a user pick a silent dead-end.
const withAuto = parseModes('Current mode: auto. Available modes: plan, build, edit, yolo, auto.');
ok(withAuto.items.map(i => i.value).includes('auto'), 'a new runtime mode needs no code change');
ok(withAuto.items.find(i => i.value === 'auto').note.includes('denies tools'),
   'auto is honest about being reserved');
ok(parseModes('Available modes: plan, zeta.').items.find(i => i.value === 'zeta').note === '',
   'a mode we know nothing about gets no invented note');
ok(parseModes('Available modes: plan, constructor.').items.find(i => i.value === 'constructor').note === '',
   'a mode named after an Object member gets no prototype note');
ok(parseModes('Current mode: BUILD. Available modes: plan, build.').items.find(i => i.value === 'build').note.includes('(current)'),
   'the current mark survives a case difference');
ok(parseModes('nothing useful') === null, 'an unparseable reply yields null, not a wrong list');
ok(parseModes('') === null && parseModes(null) === null, 'empty/null replies are safe');
ok(parseModes('Available modes: plan, build.').current === null, 'a reply with no current mode still parses the list');

// --- grants: the /permissions picker's rows -------------------------------------
{
  const items = grantItems([
    { key: 'k1', toolName: 'Bash', optionId: 'allow_always', pattern: 'npm test' },
    { key: 'k2', toolName: 'Write', optionId: 'deny_always' },          // pre-pattern record
    { toolName: 'NoKey' },                                             // keyless: dropped
    'garbage',
  ]);
  ok(items.length === 2, 'grant rows need a store key');
  ok(items[0].value === 'k1' && items[0].label === 'Bash(npm test)'
     && items[0].note === 'allow_always', 'a grant row shows what was approved and the decision');
  ok(items[1].label === 'Write', 'a grant without a pattern still lists');
  ok(grantItems(null).length === 0 && grantItems('x').length === 0, 'no grants yields no rows');
  const clipped = grantLabel({ toolName: 'Bash', pattern: 'x'.repeat(200) });
  ok(clipped.includes('…') && clipped.length === 'Bash()'.length + 80,
     'a long pattern is clipped to its bound');
}

// --- when a bare command is a request to choose ---------------------------------
ok(pickerFor('/effort') === 'effort' && pickerFor('/model') === 'model' && pickerFor('/mode') === 'mode',
   'a bare knob command opens its picker');
ok(pickerFor('/skill') === 'skill' && pickerFor('/mcp') === 'mcp' && pickerFor('/goal') === 'goal',
   'bare /skill /mcp /goal open pickers like the GUI command panel');
ok(pickerFor('  /mode  ') === 'mode', 'surrounding whitespace is tolerated');
ok(pickerFor('/mode plan') === null, 'a command WITH an argument goes straight to the runtime');
ok(pickerFor('/model zai/glm-5.3-flash') === null, 'an explicit model argument is not intercepted');
ok(pickerFor('/help') === null && pickerFor('hello') === null && pickerFor('') === null && pickerFor(null) === null,
   'nothing else is intercepted');
ok(pickerFor('/modes') === null, 'a longer command that merely starts the same is not intercepted');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
