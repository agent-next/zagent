#!/usr/bin/env node
// onboard must prove the smoke turn actually succeeded. A fixture that prints
// {"response":"NOT OK: failed"} used to pass because includes('OK') matches
// inside "NOT OK", and a non-zero child status was ignored.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smokeSucceeded, smokeFailureDetail, preflightCredential, runOnboard, oauthSignedIn } from './zagent-onboard.mjs';

const cases = [
  [{ status: 0, stdout: '{"response":"OK"}' }, true, 'exact OK + exit 0'],
  [{ status: 0, stdout: '{"response":"  OK\\n"}' }, true, 'trimmed OK + exit 0'],
  [{ status: 1, stdout: '{"response":"NOT OK: failed"}' }, false, 'NOT OK substring + exit 1'],
  [{ status: 0, stdout: '{"response":"NOT OK: failed"}' }, false, 'NOT OK substring + exit 0'],
  [{ status: 1, stdout: '{"response":"OK"}' }, false, 'OK text but failed child'],
  [{ status: 0, error: { code: 'ENOENT' }, stdout: '{"response":"OK"}' }, false, 'spawn error'],
  [{ status: 0, stdout: 'not-json' }, false, 'non-JSON stdout'],
  [{ status: 0, stdout: '{"response":"ok"}' }, false, 'wrong case'],
  [{ status: 0, stdout: '{"response":"OK extra"}' }, false, 'not the single word'],
];

let fails = 0;
for (const [spawn, want, name] of cases) {
  const got = smokeSucceeded(spawn);
  if (got !== want) {
    console.error(`FAIL: ${name}: got ${got}, want ${want}`);
    fails++;
  } else console.log('ok -', name);
}
// preflightCredential: a rejected key must be fatal (fail fast before the
// smoke turn) ONLY when no OAuth credential could carry the turn anyway; an
// exhausted window is fatal only on the provider's business codes (a bare
// HTTP 429 on the monitor can be request rate-limiting); transport and
// unclassified failures stay inconclusive so a monitor flap cannot block a
// working inference path.
const signedOut = () => false, signedIn = () => true;
const preflightCases = [
  [async () => ({ keySource: 'ZAI_API_KEY', plan: { name: 'Z.AI Coding Plan' } }), signedOut,
    { ok: true, keySource: 'ZAI_API_KEY', plan: 'Z.AI Coding Plan' }, 'accepted key reports source+plan'],
  [async () => ({ keySource: 'cli-config', plan: null }), signedOut,
    { ok: true, keySource: 'cli-config', plan: null }, 'accepted key without plan'],
  [async () => null, signedOut,
    { ok: false, fatal: false, message: 'credential probe returned no status' }, 'null probe resolution is inconclusive'],
  [async () => ({}), signedOut,
    { ok: true, keySource: null, plan: null }, 'bare object probe resolution is ok without source'],
  [async () => { throw Object.assign(new Error('credential rejected'), { quotaClass: 'auth' }); }, signedOut,
    { ok: false, fatal: true, message: 'credential rejected' }, 'auth class signed-out is fatal'],
  [async () => { throw Object.assign(new Error('credential rejected'), { quotaClass: 'auth' }); }, signedIn,
    { ok: false, fatal: false, message: 'credential rejected' }, 'auth class with OAuth store is inconclusive'],
  [async () => { throw Object.assign(new Error('usage limit'), { quotaClass: 'limit', quotaCode: 1308 }); }, signedOut,
    { ok: false, fatal: true, message: 'usage limit' }, 'limit with business code 1308 is fatal'],
  [async () => { throw Object.assign(new Error('usage limit'), { quotaClass: 'limit', quotaCode: 1113 }); }, signedOut,
    { ok: false, fatal: true, message: 'usage limit' }, 'limit with business code 1113 is fatal'],
  [async () => { throw Object.assign(new Error('usage limit'), { quotaClass: 'limit', quotaStatus: 429, quotaCode: null }); }, signedOut,
    { ok: false, fatal: false, message: 'usage limit' }, 'bare HTTP 429 limit is inconclusive'],
  [async () => { throw Object.assign(new Error('transport failed'), { quotaClass: 'network' }); }, signedOut,
    { ok: false, fatal: false, message: 'transport failed' }, 'network class is inconclusive'],
  [async () => { throw new Error('Invalid quota pool'); }, signedOut,
    { ok: false, fatal: false, message: 'Invalid quota pool' }, 'unclassified is inconclusive'],
  [async () => { throw 'string-throw'; }, signedOut,
    { ok: false, fatal: false, message: 'string-throw' }, 'non-Error throw is inconclusive'],
];
for (const [probe, oauth, want, name] of preflightCases) {
  const got = await preflightCredential({ probe, oauth });
  const match = got.ok === want.ok && got.fatal === want.fatal &&
    got.message === want.message && got.keySource === want.keySource && got.plan === want.plan;
  if (!match) {
    console.error(`FAIL: ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    fails++;
  } else console.log('ok -', name);
}

// smokeFailureDetail: a failed smoke turn used to print a
// raw 160-char stderr tail — on a real kernel failure that lands mid-object
// ('e: false,\n  reason: undefined,…'). The detail must classify a provider
// signature, surface the stdout envelope's error, or name the last Error line.
const PROVIDER_1308 = 'ProviderBusinessError: [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-09-20 03:06:09][reqid123]\n    at detectProviderBusinessError (/x/zcode.cjs:1:1)';
const detailCases = [
  [{ status: 1, stdout: '', stderr: PROVIDER_1308 },
    d => d.includes('provider code 1308') && d.includes('Usage limit') && d.includes('reqid123'),
    'provider signature classifies into the readable block'],
  [{ status: 1, stdout: '{"type":"result","is_error":true,"error":"No ZCode credentials — a sign-in problem, not a quota limit; run `zagent login` to sign in first"}', stderr: 'noise' },
    d => d === 'No ZCode credentials — a sign-in problem, not a quota limit; run `zagent login` to sign in first',
    'stdout envelope error is surfaced'],
  [{ status: 1, stdout: 'boot noise\n{"error":"bad key"}\n', stderr: '' },
    d => d === 'bad key', 'envelope error is found past leading noise lines'],
  [{ status: 1, stdout: 'noise\r\n{"error":"crlf err"}\r\n', stderr: '' },
    d => d === 'crlf err', 'CRLF lines still parse'],
  [{ status: 1, stdout: '{"error":{"code":"AUTH","retry":true}}', stderr: '' },
    d => d === '{"code":"AUTH","retry":true}', 'structured error serializes, never [object Object]'],
  [{ status: 1, stdout: '{"error":{"message":"broken pipe"}}', stderr: '' },
    d => d === 'broken pipe', 'structured error prefers its message'],
  [{ status: 1, stdout: 'x'.repeat(200000) + '\n{"error":"tail err"}', stderr: '' },
    d => d === 'tail err', 'oversized stdout is bounded and the last-line envelope still found'],
  [{ status: 1, stdout: '', stderr: 'Error [ERR_MODULE_NOT_FOUND]: Cannot find package' },
    d => d === 'Error [ERR_MODULE_NOT_FOUND]: Cannot find package', 'Error [CODE]: form is named'],
  [{ status: 1, stdout: '', stderr: 'ZCode Built-in skipped (not-due)\nClientRequestSigningV4Error: Client signing credential must contain one separator.\n    at signingError (/x/zcode.cjs:49:1718)\n  kind: \'invalid-config\',\n  reason: undefined\n}\nError: Turn execution failed (traceId: abc123)' },
    d => d === 'ClientRequestSigningV4Error: Client signing credential must contain one separator.',
    'the opaque Turn-execution-failed wrapper yields to the real cause'],
  [{ status: 1, stdout: '', stderr: 'some noise\nError: Turn execution failed (traceId: abc123)' },
    d => d === 'Error: Turn execution failed (traceId: abc123)',
    'the wrapper prints when it is the only Error line (keeps the traceId)'],
  [{ status: 1, stdout: '{"error":"envelope cause"}', stderr: PROVIDER_1308 },
    d => d.includes('provider code 1308'),
    'provider signature outranks the envelope'],
  [{ status: 1, stdout: 'noise\nProviderBusinessError: [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-09-20 03:06:09][req9]', stderr: '' },
    d => d.includes('provider code 1308'), 'a signature on stdout also classifies'],
  [{ status: 1, stdout: '{"error":"real cause"}', stderr: 'dump [404][Not Found] body' },
    d => d === 'real cause', 'an unknown [code][text] pair does not preempt the envelope'],
  [{ status: 1, stdout: '{"error":""}', stderr: 'RealError: boom' },
    d => d === 'RealError: boom', 'empty envelope error falls through to stderr'],
  [{ status: 1, stdout: '', stderr: 'warn: low disk space\n{\n  reason: undefined\n}' },
    d => d === 'warn: low disk space', 'fragment-only tail yields the last substantive line'],
  [{ status: 1, stdout: '', stderr: '{\n  reason: undefined\n}' },
    d => d === '', 'all-fragment stderr has no detail'],
  [{ status: 1, stdout: '', stderr: 'line one\nfinal words here' },
    d => d === 'final words here', 'no Error line falls back to the last line'],
  [{ status: 1, stdout: '', stderr: '' },
    d => d === '', 'silent failure has no detail'],
  [{ status: null, signal: 'SIGTERM', stdout: '', stderr: 'progress: still working' },
    d => d.includes('SIGTERM') && !d.includes('still working'),
    'signal kill is classified as a stall, not dressed in a partial progress line'],
  [{ status: null, signal: null, error: new Error('spawn zagent ENOENT'), stdout: '', stderr: '' },
    d => d.includes('could not start') && d.includes('ENOENT'),
    'a spawn error is named, never printed as signal ?'],
  [{ status: 0, stdout: '{"response":"OK."}', stderr: '' },
    d => d.includes('did not answer exactly') && d.includes('OK.'),
    'exit 0 with a wrong answer is a malformed-output failure'],
  [{ status: 0, stdout: '', stderr: '' },
    d => d.includes('did not answer exactly') && d.includes('empty output'),
    'exit 0 with no envelope is still explained'],
  // r4 verify-leg traps: each of these returned the wrong class on the
  // pre-fix head — the discriminating power is the point.
  [{ status: 1, stdout: `noise\n${'ProviderBusinessError: [1308][Usage limit reached for 5 hour.][req5]'}`, stderr: 'hdr dump [404][Not Found] body' },
    d => d.includes('provider code 1308'),
    'an unknown stderr signature does not blind the stdout scan'],
  [{ status: 1, stdout: '', stderr: '{\n  e: false,\n}' },
    d => d === '', 'scalar dump fragments are junk, never the detail'],
  [{ status: 1, stdout: '', stderr: "warn: low disk space\n{\n  kind: 'invalid-config',\n  e: false,\n}" },
    d => d === 'warn: low disk space', 'scalar fragments yield to the last substantive line'],
  [{ status: 1, stdout: '{"error":false}', stderr: 'RealError: boom' },
    d => d === 'RealError: boom', 'a flag-valued envelope error falls through to stderr'],
  [{ status: 1, stdout: '{"error":{}}', stderr: 'RealError: boom' },
    d => d === 'RealError: boom', 'an empty-object envelope error falls through to stderr'],
  [{ status: 0, stdout: '{"response":{"a":1}}', stderr: '' },
    d => d.includes('did not answer exactly') && !d.includes('[object Object]'),
    'an object wrong-answer serializes, never [object Object]'],
  [null, d => d === '', 'a null spawn result has no detail and never throws'],
  [undefined, d => d === '', 'an undefined spawn result has no detail and never throws'],
];
for (const [spawn, pred, name] of detailCases) {
  const got = smokeFailureDetail(spawn);
  if (!pred(got)) {
    console.error(`FAIL: ${name}: got ${JSON.stringify(got)}`);
    fails++;
  } else console.log('ok -', name);
}

// runOnboard wiring: the probe must run BETWEEN the doctor spawn and the
// smoke-turn spawn, and a fatal probe must prevent the smoke turn entirely.
// (Deleting `await preflightCredential()` must fail these oracles.)
{
  const events = [];
  const spawnImpl = (cmd, args) => {
    events.push(`spawn:${args[1]}`);
    return args[1] === 'doctor'
      ? { status: 0, stdout: 'all good', stderr: '' }
      : { status: 0, stdout: '{"response":"OK"}', stderr: '' };
  };
  const probeImpl = async () => { events.push('probe'); return { keySource: 'ZAI_API_KEY', plan: null }; };
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  let code;
  try { code = await runOnboard({ spawnImpl, probeImpl, oauthImpl: signedOut }); }
  finally { console.log = origLog; }
  const want = ['spawn:doctor', 'probe', 'spawn:-p'];
  if (code !== 0 || JSON.stringify(events) !== JSON.stringify(want)) {
    console.error(`FAIL: happy-path order+rc: got rc ${code} events ${JSON.stringify(events)}, want ${JSON.stringify(want)}`);
    fails++;
  } else console.log('ok -', 'happy path: doctor -> probe -> smoke, rc 0');
  // F14c: setup was flag-only knowledge — the success block must teach the
  // permission-mode choice with what each mode actually does.
  const text = logs.join('\n');
  const modeChecks = [
    [/Permission modes/, 'the success block teaches the mode choice'],
    [/\/mode/, 'the TUI picker is named'],
    [/--mode/, 'the launch flag is named'],
    [/plan\s+planning only/, 'plan says changes are denied'],
    [/yolo\s+every tool runs — nothing asks \(the -p default\)/, 'yolo discloses it asks nothing and is the -p default'],
  ];
  for (const [re, name] of modeChecks) {
    if (!re.test(text)) { console.error(`FAIL: ${name}`); fails++; }
    else console.log('ok -', name);
  }
  if (/^  auto /m.test(text)) { console.error('FAIL: the launch-flag-only auto mode is advertised'); fails++; }
  else console.log('ok -', 'the reserved auto mode is not offered as a launch choice');
}
{
  const events = [];
  const spawnImpl = (cmd, args) => { events.push(`spawn:${args[1]}`); return { status: 0, stdout: 'ok', stderr: '' }; };
  const probeImpl = async () => {
    events.push('probe');
    throw Object.assign(new Error('credential rejected'), { quotaClass: 'auth' });
  };
  const code = await runOnboard({ spawnImpl, probeImpl, oauthImpl: signedOut });
  const want = ['spawn:doctor', 'probe'];
  if (code !== 1 || JSON.stringify(events) !== JSON.stringify(want)) {
    console.error(`FAIL: fatal probe short-circuit: got rc ${code} events ${JSON.stringify(events)}, want ${JSON.stringify(want)}`);
    fails++;
  } else console.log('ok -', 'fatal probe: smoke turn never spawns, rc 1');
}
{
  // Doctor failure never reaches the probe or the smoke turn.
  const events = [];
  const spawnImpl = (cmd, args) => { events.push(`spawn:${args[1]}`); return { status: 1, stdout: 'bad', stderr: '' }; };
  const probeImpl = async () => { events.push('probe'); return { keySource: 'x' }; };
  const code = await runOnboard({ spawnImpl, probeImpl, oauthImpl: signedOut });
  if (code !== 1 || JSON.stringify(events) !== JSON.stringify(['spawn:doctor'])) {
    console.error(`FAIL: doctor gate: got rc ${code} events ${JSON.stringify(events)}`);
    fails++;
  } else console.log('ok -', 'doctor failure short-circuits before the probe, rc 1');
}
{
  // Inconclusive probe still runs the smoke turn.
  const events = [];
  const spawnImpl = (cmd, args) => {
    events.push(`spawn:${args[1]}`);
    return args[1] === 'doctor' ? { status: 0, stdout: 'ok', stderr: '' }
      : { status: 1, stdout: '', stderr: 'kernel boom' };
  };
  const probeImpl = async () => { events.push('probe'); throw Object.assign(new Error('flap'), { quotaClass: 'network' }); };
  const code = await runOnboard({ spawnImpl, probeImpl, oauthImpl: signedOut });
  const want = ['spawn:doctor', 'probe', 'spawn:-p'];
  if (code !== 1 || JSON.stringify(events) !== JSON.stringify(want)) {
    console.error(`FAIL: inconclusive probe continues to smoke: got rc ${code} events ${JSON.stringify(events)}`);
    fails++;
  } else console.log('ok -', 'inconclusive probe: smoke turn still runs, rc 1 on its failure');
}
{
  // End-to-end: the failed smoke turn prints the classified provider block,
  // not a raw stderr tail. The fixture's tail is a mid-object slice — pre-fix
  // output showed exactly that; post-fix it must show 'provider code 1308'.
  const spawnImpl = (cmd, args) => args[1] === 'doctor'
    ? { status: 0, stdout: 'ok', stderr: '' }
    : { status: 1, stdout: '', stderr: PROVIDER_1308 };
  const probeImpl = async () => ({ keySource: 'ZAI_API_KEY', plan: null });
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => { errs.push(a.join(' ')); };
  let code;
  try { code = await runOnboard({ spawnImpl, probeImpl, oauthImpl: signedOut }); }
  finally { console.error = origErr; }
  const errText = errs.join('\n');
  if (code !== 1 || !/provider code 1308/.test(errText) || /at detectProviderBusinessError/.test(errText)) {
    console.error(`FAIL: smoke failure prints classified detail: rc ${code} stderr ${JSON.stringify(errText)}`);
    fails++;
  } else console.log('ok -', 'smoke failure prints the classified provider block, no stack tail');
}
{
  // A signal/timeout kill has no exit code — the line must name the signal,
  // not 'rc null'.
  const spawnImpl = (cmd, args) => args[1] === 'doctor'
    ? { status: 0, stdout: 'ok', stderr: '' }
    : { status: null, signal: 'SIGTERM', stdout: '', stderr: '' };
  const probeImpl = async () => ({ keySource: 'ZAI_API_KEY', plan: null });
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => { errs.push(a.join(' ')); };
  let code;
  try { code = await runOnboard({ spawnImpl, probeImpl, oauthImpl: signedOut }); }
  finally { console.error = origErr; }
  if (code !== 1 || !/signal SIGTERM/.test(errs.join('\n')) || /rc null/.test(errs.join('\n'))
      || !/stopped by SIGTERM/.test(errs.join('\n'))) {
    console.error(`FAIL: signal kill named: rc ${code} stderr ${JSON.stringify(errs.join('\n'))}`);
    fails++;
  } else console.log('ok -', 'signal kill prints signal SIGTERM + the stall explanation, not rc null');
}
{
  // A spawn error has no exit code AND no signal — the header must name the
  // spawn failure, never 'signal ?' (a null-internal of the rc-null class).
  const spawnImpl = (cmd, args) => args[1] === 'doctor'
    ? { status: 0, stdout: 'ok', stderr: '' }
    : { status: null, signal: null, error: new Error('spawn zagent ENOENT'), stdout: '', stderr: '' };
  const probeImpl = async () => ({ keySource: 'ZAI_API_KEY', plan: null });
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => { errs.push(a.join(' ')); };
  let code;
  try { code = await runOnboard({ spawnImpl, probeImpl, oauthImpl: signedOut }); }
  finally { console.error = origErr; }
  const errText = errs.join('\n');
  if (code !== 1 || /signal \?|rc null/.test(errText) || !/could not start.*ENOENT/.test(errText)) {
    console.error(`FAIL: spawn error named: rc ${code} stderr ${JSON.stringify(errText)}`);
    fails++;
  } else console.log('ok -', 'spawn error prints could-not-start + ENOENT, never signal ?');
}
{
  // rc-0 wrong answer: the smoke succeeded as a process but the model did not
  // reply 'OK' — the failure must name that class, not print a bare FAILED.
  const spawnImpl = (cmd, args) => args[1] === 'doctor'
    ? { status: 0, stdout: 'ok', stderr: '' }
    : { status: 0, stdout: '{"response":"OK."}', stderr: '' };
  const probeImpl = async () => ({ keySource: 'ZAI_API_KEY', plan: null });
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => { errs.push(a.join(' ')); };
  let code;
  try { code = await runOnboard({ spawnImpl, probeImpl, oauthImpl: signedOut }); }
  finally { console.error = origErr; }
  if (code !== 1 || !/did not answer exactly 'OK'/.test(errs.join('\n'))) {
    console.error(`FAIL: wrong answer classified: rc ${code} stderr ${JSON.stringify(errs.join('\n'))}`);
    fails++;
  } else console.log('ok -', 'exit-0 wrong answer prints the malformed-output class');
}

// oauthSignedIn predicate: the v2 store decides, not file presence.
{
  const home = mkdtempSync(join(tmpdir(), 'onb-'));
  mkdirSync(join(home, '.zcode', 'v2'), { recursive: true });
  if (oauthSignedIn(home)) { console.error('FAIL: absent store signed in'); fails++; }
  else console.log('ok -', 'absent v2 store is signed out');
  writeFileSync(join(home, '.zcode', 'v2', 'credentials.json'), JSON.stringify({ 'oauth:zai:access_token': 'tok' }));
  if (!oauthSignedIn(home)) { console.error('FAIL: token store signed out'); fails++; }
  else console.log('ok -', 'v2 store with access token is signed in');
  writeFileSync(join(home, '.zcode', 'v2', 'credentials.json'), JSON.stringify({ 'oauth:zai:access_token': '' }));
  if (oauthSignedIn(home)) { console.error('FAIL: empty token signed in'); fails++; }
  else console.log('ok -', 'empty access token is signed out');
  writeFileSync(join(home, '.zcode', 'v2', 'credentials.json'), 'not-json');
  if (oauthSignedIn(home)) { console.error('FAIL: corrupt store signed in'); fails++; }
  else console.log('ok -', 'corrupt store is signed out');
}

// An injected probe must be the only path — the real default probe hits the
// network, which a unit test must never do.
if (fails) process.exit(1);
console.log('PASS onboard');
