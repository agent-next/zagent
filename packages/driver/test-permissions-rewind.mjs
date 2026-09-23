// Permissions and rewind tests — fixtures from live probes 2026-09-05 (runtime 2.1.0).
import { autoAllow, deny, answerOption, bridgeAutoAllow } from './permissions.mjs';
import { forkLatest, noCheckpointYet } from './rewind.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const REQ = { input: { file_path: '/x/calc.py' }, reason: 'Tool has side effects',
  options: [
    { kind: 'allow_once', optionId: 'allow_once', response: { decision: 'allow', reason: 'Allow once' } },
    { kind: 'deny', optionId: 'deny', response: { decision: 'deny' } },
  ] };

// autoAllow returns the OPTION's response (the only shape the runtime accepts)
ok(autoAllow(REQ).decision === 'allow', 'autoAllow picks allow_once response');
ok(JSON.stringify(autoAllow(REQ)) === JSON.stringify(REQ.options[0].response), 'exact option object, not a re-invention');
ok(autoAllow({ options: [] }).decision === 'allow', 'no options -> {decision:allow} fallback');
ok(autoAllow(undefined).decision === 'allow', 'no request at all -> allow fallback');
ok(deny(REQ).decision === 'deny', 'deny picks deny option');

// bridgeAutoAllow: remote bridges (feishu/wechat/telegram) answer for a chat
// message, not a human at the terminal — high-risk tools must be denied there.
const HIGH = { ...REQ, riskLevel: 'high', reason: 'High risk tools require explicit approval' };
const noFlag = {}; // ZAGENT_BRIDGE_ALLOW_HIGH_RISK unset
ok(bridgeAutoAllow(HIGH, noFlag).decision === 'deny', 'bridge denies high-risk by default');
ok(JSON.stringify(bridgeAutoAllow(HIGH, noFlag)) === JSON.stringify(REQ.options[1].response),
   'bridge deny returns the request\'s own deny option response');
ok(bridgeAutoAllow(HIGH, { ZAGENT_BRIDGE_ALLOW_HIGH_RISK: '1' }).decision === 'allow',
   'ZAGENT_BRIDGE_ALLOW_HIGH_RISK=1 opts back into allow on bridges');
ok(bridgeAutoAllow(HIGH, { ZMAX_BRIDGE_ALLOW_HIGH_RISK: '1' }).decision === 'allow',
   'legacy ZMAX_BRIDGE_ALLOW_HIGH_RISK=1 still opts in (compat)');
ok(bridgeAutoAllow({ ...REQ, riskLevel: 'medium' }, noFlag).decision === 'allow',
   'medium risk still auto-allows on bridges');
ok(bridgeAutoAllow(REQ, noFlag).decision === 'allow', 'absent riskLevel still auto-allows on bridges');
ok(bridgeAutoAllow({ riskLevel: 'high', options: [] }, noFlag).decision === 'deny',
   'high-risk with no options still denies (fallback shape)');
let threw = false; try { answerOption(REQ, 'allow_session'); } catch { threw = true; }
ok(threw, 'answerOption throws on missing kind (no silent wrong answer)');

// fork: method+params oracle, normalization
const fake = r => { const calls = []; return { calls, call: async (m, p) => { calls.push({ m, p }); return r; } }; };
const liveFork = { forkedSessionId: 'f1', parentSessionId: 'p1', targetCheckpointId: 'cp1',
  targetMessageId: 'm1', response: 'Forked session f1 from checkpoint cp1: copied 1 messages and restored 1 file.' };
const f = fake(liveFork);
const n = await forkLatest(f, 's1');
ok(f.calls.length === 1 && f.calls[0].m === 'session/fork' && JSON.stringify(f.calls[0].p) === '{"sessionId":"s1"}', 'fork calls session/fork with ONLY sessionId');
ok(n.forkedSessionId === 'f1' && n.targetCheckpointId === 'cp1' && n.summary.includes('restored 1 file'), 'normalized fork result');
ok((await forkLatest(fake({}), 's1')).forkedSessionId === null, 'empty result safe');

// no-checkpoint detection
ok(noCheckpointYet({ code: -32603, message: 'No workspace checkpoint is available yet.' }), 'detects -32603 no-checkpoint');
ok(!noCheckpointYet({ code: -32603, message: 'other internal error' }), 'other -32603 not mislabeled');
ok(!noCheckpointYet({ code: -32602, message: 'No workspace checkpoint is available yet.' }), 'wrong code not mislabeled');

console.log('part 1:', fails ? `FAIL (${fails})` : 'ok');

// Specific blocked reasons from live-captured request shapes
import { permissionReason, blockedLine } from './permissions.mjs';
const LIVE_EDIT = { input: { file_path: '/x/calc.py' }, reason: 'Tool has side effects and requires approval',
  riskLevel: 'medium', options: [] };
const LIVE_HIGH = { input: { command: 'rm -rf /' }, reason: 'High risk tools require explicit approval',
  riskLevel: 'high', options: [] };
let pr = permissionReason(LIVE_EDIT);
ok(pr.reason.includes('side effects') && pr.riskLevel === 'medium', 'edit reason extracted');
pr = permissionReason(LIVE_HIGH);
ok(pr.riskLevel === 'high' && pr.tool === null, 'high risk extracted');
ok(blockedLine(LIVE_EDIT) === 'blocked (medium): Tool has side effects and requires approval', 'blocked line exact');
ok(blockedLine({}) === 'blocked: no reason provided', 'no reason fallback');
ok(permissionReason(null) === null, 'null safe');
console.log('part 2:', fails ? `FAIL (${fails})` : 'ok');

// input EXCLUDED by default; opt-in preview bounded+redacted
ok(permissionReason({ reason: 'x', riskLevel: 'high', input: { secret: 'sk-testkey1' } }).input === undefined, 'raw input excluded from default result');
import { permissionInputPreview } from './permissions.mjs';
const pv = permissionInputPreview({ input: { key: 'sk-testkey0000000' } });
ok(pv.includes('sk-testke…') && !pv.includes('sk-testkey'), 'preview redacts key-shaped strings (6-char prefix kept)');
ok(permissionInputPreview({ input: 'x'.repeat(300) }).length <= 81 + 1, 'preview bounded');
console.log('part 3:', fails ? `FAIL (${fails})` : 'ok');

// Persistent allow_always / deny-always grants (hermetic temp HOME).
import {
  lookupGrant, rememberGrant, isAlwaysOptionId, optionIdOf, grantsPath, grantFingerprint,
  listGrants, forgetGrants, revokeGrant,
} from './permissions.mjs';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

ok(isAlwaysOptionId('allow_always') && isAlwaysOptionId('deny-always') && isAlwaysOptionId('deny_always'),
  'allow_always / deny-always style optionIds are rememberable');
ok(!isAlwaysOptionId('allow_once') && !isAlwaysOptionId('deny') && !isAlwaysOptionId('allow_session'),
  'once / deny / session optionIds are not rememberable');
ok(optionIdOf({ optionId: 'allow_always', kind: 'x' }) === 'allow_always', 'optionId wins over kind');
ok(optionIdOf({ value: 'deny-always' }) === 'deny-always', 'TUI chooser value is accepted');

ok(grantFingerprint({ toolName: 'Bash', input: { command: 'rm -rf build' } }) === 'rm -rf build',
  'bash fingerprint is the exact command string');
ok(grantFingerprint({ toolName: 'Bash', input: { command: 'rm -rf build' } }) !== 'rm *',
  'bash fingerprint is not a glob');
ok(grantFingerprint({ toolName: 'Bash', input: { command: 'git push origin main' } })
  !== grantFingerprint({ toolName: 'Bash', input: { command: 'git push origin other' } }),
  'git push fingerprints are exact, not git push *');

const realHome = process.env.HOME ?? os.homedir();
const realUserProfile = process.env.USERPROFILE;
const restoreEnv = () => {
  process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
};
const tmp = mkdtempSync(path.join(os.tmpdir(), 'zgrants-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
try {
  const always = { kind: 'allow_always', optionId: 'allow_always',
    response: { decision: 'allow', scope: 'session' } };
  const denyAlways = { kind: 'deny-always', optionId: 'deny-always',
    response: { decision: 'deny', reason: 'remembered' } };
  const once = { kind: 'allow_once', optionId: 'allow_once', response: { decision: 'allow' } };

  const editA = { toolName: 'Edit', input: { file_path: '/x/a.py' }, options: [always, once] };
  ok(lookupGrant(editA) === null, 'missing grants.json -> lookupGrant null');
  ok(JSON.stringify(rememberGrant(editA, always)) === JSON.stringify(always.response),
    'rememberGrant returns the saved option response');
  ok(JSON.stringify(lookupGrant(editA)) === JSON.stringify(always.response),
    'lookupGrant returns the saved allow_always response');
  ok(lookupGrant({ toolName: 'Edit', input: { file_path: '/x/b.py' }, options: [always] }) === null,
    'different input does not match');
  ok(lookupGrant({ toolName: 'Read', input: { file_path: '/x/a.py' }, options: [always] }) === null,
    'different toolName does not match');

  const gp = grantsPath();
  ok(gp === path.join(tmp, '.zcode', 'cli', 'grants.json'), 'store is ~/.zcode/cli/grants.json');
  ok(existsSync(gp), 'grants.json created');
  if (process.platform !== 'win32') {
    ok((statSync(gp).mode & 0o777) === 0o600, 'grants.json mode 0600');
  }

  const bashRm = { toolName: 'Bash', input: { command: 'rm -rf build' }, options: [always] };
  rememberGrant(bashRm, always);
  ok(JSON.stringify(lookupGrant(bashRm)) === JSON.stringify(always.response),
    'exact bash command is remembered');
  ok(lookupGrant({ toolName: 'Bash', input: { command: 'rm -rf /' }, options: [always] }) === null,
    'dangerous bash is exact-only: rm -rf build does not grant rm -rf /');
  ok(lookupGrant({ toolName: 'Bash', input: { command: 'rm *' }, options: [always] }) === null,
    'a glob is not implied by an exact grant');

  const secret = 'sk-testkey0000000';
  const bearer = 'Bearer testtoken0000';
  const secretReq = { toolName: 'WebFetch', input: { url: 'https://x', key: secret, auth: bearer },
    options: [always] };
  rememberGrant(secretReq, always);
  const dumped = readFileSync(gp, 'utf8');
  ok(!dumped.includes(secret) && !dumped.includes('sk-testkey'),
    'grants.json does not store raw sk- secrets');
  ok(!dumped.includes('testtoken0000'), 'grants.json does not store raw Bearer tokens');
  ok(JSON.stringify(lookupGrant(secretReq)) === JSON.stringify(always.response),
    'lookup still matches after redaction (same request, same fingerprint)');

  const denyReq = { toolName: 'Bash', input: { command: 'git push origin main' }, options: [denyAlways] };
  rememberGrant(denyReq, denyAlways);
  ok(lookupGrant(denyReq).decision === 'deny', 'deny-always is persisted');

  const onceReq = { toolName: 'Edit', input: { file_path: '/once.py' }, options: [once, always] };
  ok(rememberGrant(onceReq, once) === null, 'allow_once is not persisted');
  ok(lookupGrant(onceReq) === null, 'allow_once does not create a grant');

  const session = { kind: 'allow_session', optionId: 'allow_session',
    response: { decision: 'allow', scope: 'session' } };
  const sessReq = { toolName: 'Edit', input: { file_path: '/sess.py' }, options: [session] };
  ok(rememberGrant(sessReq, session) === null, 'allow_session is not persisted');

  mkdirSync(path.join(tmp, 'other'), { recursive: true });
  writeFileSync(gp, '{not json');
  ok(lookupGrant(editA) === null, 'corrupt grants.json fails closed (null, no throw)');

  const other = mkdtempSync(path.join(os.tmpdir(), 'zgrants-b-'));
  process.env.HOME = other; process.env.USERPROFILE = other;
  ok(lookupGrant(editA) === null, 'grants do not leak across HOME sandboxes');
  rmSync(other, { recursive: true, force: true });

  // The {home} option scopes the store without an env dance — a test/journey
  // host must never read or write the developer's real grants.json.
  const scoped = mkdtempSync(path.join(os.tmpdir(), 'zgrants-c-'));
  try {
    ok(grantsPath({ home: scoped }).startsWith(scoped), 'grantsPath honors the home option');
    ok(lookupGrant(editA, { home: scoped }) === null, 'lookupGrant({home}) starts empty');
    rememberGrant(editA, always, { home: scoped });
    ok(existsSync(grantsPath({ home: scoped })), 'rememberGrant({home}) writes under that home');
    ok(lookupGrant(editA, { home: scoped }) !== null, 'and reads it back');
    ok(!existsSync(grantsPath()), 'a scoped grant never touches the default store');
  } finally { rmSync(scoped, { recursive: true, force: true }); }
} finally {
  rmSync(tmp, { recursive: true, force: true });
  restoreEnv();
}

// A grant stores a displayable pattern next to its opaque hash so
// /permissions and `zagent permissions` can show and revoke WHAT was allowed —
// "Bash(npm install:*) — allow_always", not a bare "Bash — allow_always".
{
  const home = mkdtempSync(path.join(os.tmpdir(), 'zgrants-d-'));
  try {
    const always = { kind: 'allow_always', optionId: 'allow_always',
      response: { decision: 'allow' } };
    const bash = { toolName: 'Bash', input: { command: 'npm install: *' }, options: [always] };
    const edit = { toolName: 'Edit', input: { file_path: '/x/a.py' }, options: [always] };
    rememberGrant(bash, always, { home });
    rememberGrant(edit, always, { home });

    const grants = listGrants({ home });
    ok(grants.length === 2, 'listGrants returns both grants');
    const b = grants.find(g => g.toolName === 'Bash');
    ok(b && b.pattern === 'npm install: *', 'bash grant pattern is the command string');
    ok(typeof b.key === 'string' && /^[0-9a-f]{64}$/.test(b.key), 'grant keeps its hash key');
    const e = grants.find(g => g.toolName === 'Edit');
    ok(e && e.pattern.includes('/x/a.py'), 'non-bash grant pattern holds the redacted input');

    // The pattern is display-bounded even for a huge input (Edit inputs can
    // carry whole files — the store must not grow a copy of them).
    const big = { toolName: 'Write', input: { file_path: '/x/big', content: 'y'.repeat(5000) },
      options: [always] };
    rememberGrant(big, always, { home });
    const w = listGrants({ home }).find(g => g.toolName === 'Write');
    ok(w && w.pattern.length <= 161, 'stored pattern is display-bounded');

    // Secrets never reach the stored pattern either.
    const sec = { toolName: 'Bash', input: { command: 'curl -H "Bearer testtoken0000" x' },
      options: [always] };
    rememberGrant(sec, always, { home });
    ok(!readFileSync(grantsPath({ home }), 'utf8').includes('testtoken0000'),
      'stored pattern carries the redacted form only');

    // Control bytes are stripped before storage — the pattern is echoed raw
    // by `zagent permissions` and /permissions, so a command carrying \n or an
    // ANSI escape must not reach a terminal through it.
    const evil = { toolName: 'Bash', input: { command: 'ok\x1b[2J\nforged' }, options: [always] };
    rememberGrant(evil, always, { home });
    const ep = listGrants({ home }).find(g => g.toolName === 'Bash' && g.pattern.includes('forged'));
    // '\x1b[2J' -> ' [2J' — the ESC byte is gone so the residue is inert text.
    ok(ep && !/[\x00-\x1f\x7f-\x9f]/.test(ep.pattern) && ep.pattern === 'ok [2J forged',
      'stored pattern is sanitized for terminal output');
    ok(lookupGrant(evil, { home }) !== null, 'sanitized display does not change grant identity');

    ok(forgetGrants('', { home }).removed.length === 0, "forgetGrants('') removes nothing");
    ok(forgetGrants('  ', { home }).removed.length === 0, 'whitespace-only query removes nothing');
    ok(listGrants({ home }).length === 5, 'guarded queries leave the store intact');

    // Revocation: substring on the remembered pattern, tool name, or 'all'.
    ok(forgetGrants('nothing-matches', { home }).removed.length === 0,
      'forgetGrants no-match removes nothing');
    ok(lookupGrant(bash, { home }) !== null, 'no-match leaves grants intact');
    ok(forgetGrants('npm install', { home }).removed.length === 1,
      'forgetGrants substring-removes the matching grant');
    ok(lookupGrant(bash, { home }) === null, 'the revoked grant no longer answers');
    ok(forgetGrants('edit', { home }).removed.length === 1, 'tool name matches case-insensitively');
    ok(forgetGrants('all', { home }).removed.length === 3, "forgetGrants('all') clears the rest");
    ok(listGrants({ home }).length === 0, 'store is empty after revoke all');
    ok(existsSync(grantsPath({ home })), 'revoke keeps the (empty) store file');
    ok(forgetGrants('all', { home }).removed.length === 0, 'revoke on an empty store is honest');
    rmSync(grantsPath({ home }), { force: true });
    ok(forgetGrants('all', { home }).removed.length === 0 && !existsSync(grantsPath({ home })),
      'revoke on an absent store creates nothing');

    // The /permissions picker revokes by store key — a pattern-substring
    // query could take a sibling grant whose pattern merely contains it.
    const bash2 = { toolName: 'Bash', input: { command: 'npm test' }, options: [always] };
    const bash3 = { toolName: 'Bash', input: { command: 'npm test --watch' }, options: [always] };
    rememberGrant(bash2, always, { home });
    rememberGrant(bash3, always, { home });
    const k2 = listGrants({ home }).find(g => g.pattern === 'npm test');
    ok(revokeGrant(k2.key, { home }) === true, 'revokeGrant removes the keyed grant');
    ok(lookupGrant(bash2, { home }) === null, 'the keyed grant no longer answers');
    ok(lookupGrant(bash3, { home }) !== null, 'the sibling prefix-pattern grant survives');
    ok(revokeGrant(k2.key, { home }) === false, 'a second revoke is honest false');
    ok(revokeGrant('not-a-key', { home }) === false && revokeGrant('', { home }) === false
      && revokeGrant(null, { home }) === false, 'absent/junk keys revoke nothing');
  } finally { rmSync(home, { recursive: true, force: true }); }
}

console.log(fails ? `FAIL (${fails})` : 'PASS permissions-rewind');
process.exit(fails ? 1 : 0);
