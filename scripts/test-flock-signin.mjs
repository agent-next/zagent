#!/usr/bin/env node
// Offline oracles for the flock's signed-in card class (FLOCK-V2-SIGNIN
// slice 2): under --signin, every --signin-every-th round seeds a broker-
// backed placeholder credential ('flock-dummy.<32hex>' + loopback baseURL —
// the dotted shape is load-bearing for the kernel's client-signing) and
// wires a second inner listener (127.0.0.1:3129 -> bound-in broker.sock) so
// real signed-in turns ride the host-injected key. The key never enters the
// sandbox; nothing here touches a real credential (key-source env: seam).
//
// The e2e legs run a stub "opencode" INSIDE the real bwrap wall: it inspects
// the seeded HOME and probes the broker listener, then reports via the
// stream-json contract — an OK verdict means the wiring was really there.
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Lane-runtime suite: full flock rounds shell out to the real `opencode`
// worker runtime (usertest/swarm/opencode-flock.mjs -> `which opencode`).
// Skip loudly where it is not installed (CI containers), like the --live
// suites - the pure code-shape assertions return when the runner image
// gains the runtime (CI runner images lack the runtime today).
if (spawnSync('which', ['opencode'], { encoding: 'utf8' }).status !== 0) {
  console.log('skip (lane runtime `opencode` not installed - flock rounds cannot run)');
  process.exit(0);
}


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLOCK = path.join(root, 'usertest', 'swarm', 'opencode-flock.mjs');
const work = mkdtempSync(path.join(tmpdir(), 'flock-signin-'));

const tests = [];
const test = (n, a, b) => tests.push(typeof a === 'function' ? [n, {}, a] : [n, a, b]);

// bwrap is the wall — without it the e2e legs can't run. Skip loudly, never
// silently green (the code-shape oracles below still run either way).
const haveBwrap = spawnSync('bwrap', ['--version'], { encoding: 'utf8' }).status === 0;

// A dependency-free npm package as the SUT — `npm install -g` of a local
// tarball is fully offline (same pattern as test-flock-claude-lane).
const pkgDir = path.join(work, 'stub-pkg');
mkdirSync(pkgDir);
writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
  name: 'stub-sut', version: '0.0.0', bin: { zagent: 'zagent.js' },
}));
writeFileSync(path.join(pkgDir, 'zagent.js'), '#!/usr/bin/env node\nconsole.log("stub zagent");\n');
const tarball = path.join(work,
  execFileSync('npm', ['pack', '--quiet', '--pack-destination', work], { cwd: pkgDir, encoding: 'utf8' }).trim().split('\n').pop());

// The stub opencode: runs INSIDE the wall, probes the sandbox state, then
// speaks opencode stream-json. Expectation is read off the card text —
// signin cards say "IS signed in", unsigned cards say "NO zagent account".
const stubDir = path.join(work, 'stub', 'bin');
mkdirSync(stubDir, { recursive: true });
const STUB = path.join(stubDir, 'opencode');
writeFileSync(STUB, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import os from 'node:os';
const card = process.argv[process.argv.length - 1] ?? '';
const seed = (card.match(/SEED:(\\d+)/) || [])[1] ?? '0';
const signedIn = /IS signed in/.test(card);
const lines = [];
const emit = (o) => lines.push(JSON.stringify(o));
const bash = (command) => emit({ part: { type: 'tool', tool: 'bash', state: { input: { command } } } });
const text = (t) => emit({ part: { type: 'text', text: t } });
bash(\`echo SEED:\${seed}\`);
bash('zagent --version');
bash('cat ~/.zcode/cli/config.json');
const home = process.env.HOME;
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const cfg = read(path.join(home, '.zcode', 'cli', 'config.json'));
const pc = read(path.join(home, '.zcode', 'v2', 'provider_config.json'));
const v2cfg = read(path.join(home, '.zcode', 'v2', 'config.json'));
const creds = read(path.join(home, '.zcode', 'v2', 'credentials.json'));
// The headless -p path never runs the TUI-launch provisioner, so the seed
// must carry the account-provider:* records itself — proven live 2026-09-19:
// without them the kernel resolves no entitled account and every signed-in
// zagent -p fails 'Model creation failed'. Decrypt IN-WALL: the enc:v1
// fallback secret derives from the decrypting context's $HOME, so a record
// encrypted under the wrong home decrypts wrong here and must be a finding.
const DUMMY = 'flock-dummy.0123456789abcdef0123456789abcdef';
const EXPECT_ID = 'key-' + crypto.createHash('sha256').update(DUMMY).digest('hex').slice(0, 24);
const credSecret = process.env.ZCODE_CREDENTIAL_SECRET
  || \`zcode-credential-fallback:\${process.platform}:\${home}:\${os.userInfo().username}\`;
const credKey = crypto.createHash('sha256').update(credSecret).digest();
// A record that fails to decrypt (wrong-home secret, torn store) is the
// exact regression this oracle exists to catch — it must degrade to the
// finding lines below, never crash: a nonzero stub exit is classified INFRA
// by the flock and would mask the failure AND every other wiring assert.
const credDec = (blob) => {
  try {
    if (typeof blob !== 'string' || !blob.startsWith('enc:v1:')) return null;
    const [iv, tag, ct] = blob.slice(7).split('.').map((s) => Buffer.from(s, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', credKey, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return null; }
};
const credEntries = Object.entries(creds ?? {}).filter(([k]) => k.startsWith('account-provider:'));
const hasIdentity = credEntries.some(([k, v]) => /:identity$/.test(k) && credDec(v) === EXPECT_ID);
const hasApiKey = credEntries.some(([k, v]) => /:api-key$/.test(k) && credDec(v) === DUMMY);
let broker = 0;
try { const r = await fetch('http://127.0.0.1:3129/outside-prefix'); broker = r.status; } catch {}
// The TLS twin only exists when the spawn env carried the builtin-override
// pin (that env var IS the wiring's own flag — the probe is self-consistent).
// https.request with rejectUnauthorized:false proves listener reachability
// without depending on undici honoring NODE_TLS_REJECT_UNAUTHORIZED.
let tlsBroker = -1; // -1 = not probed (no TLS leg wired this round)
if (process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
  tlsBroker = 0;
  tlsBroker = await new Promise((res) => {
    const rq = https.request({ host: '127.0.0.1', port: 3130, path: '/outside-prefix', rejectUnauthorized: false, timeout: 5000 }, (r) => res(r.statusCode));
    rq.on('error', () => res(0)); rq.on('timeout', () => { rq.destroy(); res(0); }); rq.end();
  });
}
const findings = [];
if (signedIn) {
  if (!/^flock-dummy\.[0-9a-f]{32}$/.test(cfg?.provider?.zai?.options?.apiKey ?? '')) findings.push('cli config lacks the placeholder credential');
  if (cfg?.provider?.zai?.options?.baseURL !== 'http://127.0.0.1:3129/api/anthropic') findings.push('cli config baseURL not pointed at the broker listener');
  if (!/^flock-dummy\.[0-9a-f]{32}$/.test(pc?.config?.providerConfigRules?.providerRules?.[0]?.config?.access?.apiKey ?? '')) findings.push('v2 provider_config lacks the placeholder key');
  if (!/^flock-dummy\.[0-9a-f]{32}$/.test(v2cfg?.provider?.['builtin:zai-coding-plan']?.options?.apiKey ?? '')) findings.push('v2 config builtin provider lacks the placeholder key');
  if (v2cfg?.provider?.['builtin:zai-coding-plan']?.options?.baseURL !== 'https://127.0.0.1:3130/api/anthropic') findings.push('v2 config builtin baseURL not pointed at the TLS broker');
  if (broker !== 403) findings.push(\`broker listener not reached on 3129 (status \${broker})\`);
  if (tlsBroker !== -1 && tlsBroker !== 403) findings.push(\`TLS broker listener not reached on 3130 (status \${tlsBroker})\`);
  if (!hasIdentity) findings.push('no account-provider identity record decrypting to the placeholder identity — headless -p cannot authenticate');
  if (!hasApiKey) findings.push('no provisioned account api-key record decrypting to the placeholder key — headless -p cannot authenticate');
} else {
  if (cfg !== null) findings.push('unsigned sandbox carries a cli provider config');
  if (pc !== null) findings.push('unsigned sandbox carries a provisioned provider_config');
  if (v2cfg !== null) findings.push('unsigned sandbox carries a v2 provider config');
  if (credEntries.length) findings.push('unsigned sandbox carries account-provider records');
  if (broker !== 0) findings.push(\`broker listener unexpectedly reachable unsigned (status \${broker})\`);
}
text('probed the sandbox state');
for (const f of findings) text(\`FLOCK-FINDING: signin wiring — \${f} | CMD: cat ~/.zcode/cli/config.json | EXPECTED: wiring per card | GOT: probe mismatch\`);
if (!findings.length) text('FLOCK-VERDICT: OK');
console.log(lines.join('\\n'));
`);
chmodSync(STUB, 0o755);

// A minimal builtin provider config pinned via env — under the gate's
// minimal env there is no runtime for signinBuiltinSrc() to discover, so
// without it every signin e2e leg degrades to unsigned (the TUI-leg seed
// AND the account-provider provisioning both read this file). Shape
// mirrors the real zcode-builtin.json zhipu-account rule.
const BUILTIN_SRC = path.join(work, 'zcode-builtin.json');
writeFileSync(BUILTIN_SRC, JSON.stringify({
  config: { providerConfigRules: { providerRules: [
    { providerId: 'account:zai-individual-coding-plan', providerName: 'Z.AI Individual Coding Plan',
      config: { group: 'zai-family', builtinModelIds: ['GLM-5.3'],
        access: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai' },
        api: { type: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic' } } } ] } },
}));

function runFlock(args, extraEnv = {}) {
  const flockDir = mkdtempSync(path.join(work, 'flockdir-'));
  const home = mkdtempSync(path.join(work, 'home-')); // hermetic: no host auth/cache
  const env = {
    ...process.env, NODE_OPTIONS: '', FLOCK_DIR: flockDir, HOME: home, USERPROFILE: home,
    FLOCK_OPENCODE: STUB,
    FLOCK_BROKER_KEY_SOURCE: 'env:FLOCK_BROKER_KEY', FLOCK_BROKER_KEY: 'test-key-789',
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: BUILTIN_SRC,
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, [FLOCK, '--tarball', tarball, '--seed', '7', '--max-hours', '0.01', ...args], {
    encoding: 'utf8', timeout: 180_000, env,
  });
  const runs = existsSync(path.join(flockDir, 'runs.ndjson'))
    ? readFileSync(path.join(flockDir, 'runs.ndjson'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { r, runs };
}

test('a --signin round seeds the placeholder credential and reaches the broker through the wall', { skip: !haveBwrap }, () => {
  const { r, runs } = runFlock(['--signin', '--signin-every', '1', '-n', '1', '-r', '1']);
  assert.equal(r.status, 0, `flock failed: ${r.stderr}\n${r.stdout}`);
  assert.equal(runs.length, 1, `expected 1 record: ${r.stdout}`);
  const rec = runs[0];
  assert.equal(rec.signin, true, 'signin round must be marked for triage');
  assert.match(rec.scenario, /^signin-/, `expected a signin scenario, got ${rec.scenario}`);
  // OK = the in-wall stub verified the seeded config AND the 3129 broker
  // refusal; FINDING here means the wiring is broken — surface the detail.
  assert.equal(rec.class, 'OK', `signin wiring probe failed: ${JSON.stringify(rec.findings ?? rec.note)}`);
});

test('without --signin no credential is seeded and no broker listener exists', { skip: !haveBwrap }, async () => {
  const { SIGNIN_SCENARIOS, SIGNIN_PTY_SCENARIOS } = await import(path.join(root, 'usertest', 'swarm', 'scenarios.mjs'));
  const signinIds = new Set([...SIGNIN_SCENARIOS, ...SIGNIN_PTY_SCENARIOS].map((s) => s.id));
  const { r, runs } = runFlock(['-n', '1', '-r', '1']);
  assert.equal(r.status, 0, `flock failed: ${r.stderr}\n${r.stdout}`);
  assert.equal(runs.length, 1, `expected 1 record: ${r.stdout}`);
  const rec = runs[0];
  assert.ok(!rec.signin, 'unsigned round must not carry the signin marker');
  // Membership, not naming: 'signin-lifecycle-honesty' is a legit UNSIGNED
  // pool card — an id-prefix assert would false-fail on it.
  assert.ok(!signinIds.has(rec.scenario), `unsigned pool must never serve signin cards, got ${rec.scenario}`);
  assert.equal(rec.class, 'OK', `unsigned probe failed: ${JSON.stringify(rec.findings ?? rec.note)}`);
});

test('--signin-every 2 signs only the cadence round, not every round', { skip: !haveBwrap }, () => {
  const { r, runs } = runFlock(['--signin', '--signin-every', '2', '-n', '1', '-r', '2']);
  assert.equal(r.status, 0, `flock failed: ${r.stderr}\n${r.stdout}`);
  assert.equal(runs.length, 2, `expected 2 records: ${r.stdout}`);
  // Rounds are 1-based post-increment: 1%2!=0 unsigned, 2%2==0 signed.
  assert.ok(!runs[0].signin, `round 1 must be unsigned on every-2 cadence: ${JSON.stringify(runs[0])}`);
  assert.equal(runs[1].signin, true, 'round 2 must be the signin round');
  // Both legs OK = the stub verified absent wiring on r1 and full wiring on r2.
  for (const rec of runs) assert.equal(rec.class, 'OK', `round ${rec.round} probe failed: ${JSON.stringify(rec.findings ?? rec.note)}`);
});

test('signin cards are gated out of the unsigned pool and carry the marker', async () => {
  const { SCENARIOS } = await import(path.join(root, 'usertest', 'swarm', 'scenarios.mjs'));
  const { EXTRA_SCENARIOS } = await import(path.join(root, 'usertest', 'swarm', 'scenarios-extra.mjs'));
  const { SIGNIN_SCENARIOS, SIGNIN_PTY_SCENARIOS } = await import(path.join(root, 'usertest', 'swarm', 'scenarios.mjs'));
  assert.ok(SIGNIN_SCENARIOS.length >= 2, 'expected a signed-in card pool');
  assert.ok(SIGNIN_PTY_SCENARIOS.length >= 1, 'expected a signed-in pty card pool');
  for (const s of [...SIGNIN_SCENARIOS, ...SIGNIN_PTY_SCENARIOS]) assert.equal(s.signin, true, `${s.id} missing signin: true`);
  for (const s of SIGNIN_PTY_SCENARIOS) assert.equal(s.pty, true, `${s.id} missing pty: true`);
  for (const s of [...SCENARIOS, ...EXTRA_SCENARIOS]) assert.ok(!s.signin, `${s.id} must not be a signin card`);
  for (const s of [...SIGNIN_SCENARIOS, ...SIGNIN_PTY_SCENARIOS]) assert.match(s.card(), /IS signed in/, `${s.id} card lacks the signed-in contract`);
  // Signed-in pty cards must also carry the pty oracle contract: the driver
  // named, the SCREEN-cite verdict form, and the tiny-quota discipline.
  for (const s of SIGNIN_PTY_SCENARIOS) {
    const card = s.card();
    assert.ok(card.includes('pty-drive.py'), `${s.id}: card does not name the driver`);
    assert.ok(card.includes('SCREEN:'), `${s.id}: card does not demand a SCREEN cite`);
    assert.ok(card.includes('-- zagent'), `${s.id}: card must drive plain zagent (env is pre-wired)`);
    assert.ok(/at most 2 turns|at most \d+ real turns/i.test(card), `${s.id}: card lacks the tiny-turn quota cap`);
  }
});

test('signin-pty-streaming card carries the streamed-partial-output contract', async () => {
  const { SIGNIN_PTY_SCENARIOS } = await import(path.join(root, 'usertest', 'swarm', 'scenarios.mjs'));
  const s = SIGNIN_PTY_SCENARIOS.find((c) => c.id === 'signin-pty-streaming');
  assert.ok(s, 'signin-pty-streaming must exist in SIGNIN_PTY_SCENARIOS');
  const card = s.card();
  assert.match(card, /waiting/, 'card must teach the waiting phase');
  assert.match(card, /responding/, 'card must teach the responding phase');
  assert.match(card, /\^\\s\*DONE\[\.!\?\]\?\\s\*\$/, 'card must teach the anchored whitespace/punctuation-tolerant end-marker expect');
  // Bind the card's own expect pattern to a realistic screen — an
  // anchor regression (^DONE$) must break this oracle, not just the
  // presence assert above. The renderer indents answer continuation lines
  // two cells (render.mjs), so the settled tail is `  DONE`, while the
  // echoed prompt sits in a '> …' line that must NEVER match.
  const em = card.match(/expect (\^\\s\*DONE\S*) 90000/);
  assert.ok(em, 'card must pin the end-marker expect line');
  const endMarker = new RegExp(em[1], 'm');
  const settledTail = ['> count from 1 to 60, one number per line, then a last line that says DONE',
    '⏺ 1', '  2', '  59', '  60', '  DONE'].join('\n');
  assert.ok(endMarker.test(settledTail), `end-marker ${em[1]} must match the indented answer tail`);
  assert.ok(endMarker.test('  DONE.'), 'end-marker must tolerate trailing punctuation');
  assert.ok(!endMarker.test('> count from 1 to 60, one number per line, then a last line that says DONE'),
    'end-marker must never match the echoed prompt line');
  assert.match(card, /mid-turn|partial/i, 'card must judge mid-turn/partial output');
});

test('code shapes: broker spawn, seed, and cadence are wired', () => {
  const src = readFileSync(FLOCK, 'utf8');
  // The broker is spawned with an explicit key source (never ambient) and
  // confined to /api/ on api.z.ai.
  const brokerFn = src.match(/function ensureBroker[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(brokerFn.includes("'broker'") && brokerFn.includes("'--key-source'"), 'ensureBroker must spawn net-relay broker with --key-source');
  // Confinement is the anthropic surface AND the client-signing handshake —
  // a wider /api/ prefix would let the walled agent ride the injected key to
  // account/key-management paths.
  assert.ok(brokerFn.includes('https://api.z.ai') && brokerFn.includes("'/api/anthropic'"), 'broker must upstream to api.z.ai confined to /api/anthropic');
  assert.ok(brokerFn.includes("'/api/paas/"), 'broker must also confine the client-signing handshake prefix');
  assert.ok(!brokerFn.includes("'/api/'"), 'broker prefix must be narrower than /api/');
  // The signing handshake refuses plain http — the TLS twin must be spawned.
  assert.ok(brokerFn.includes("'--tls-sock'") && brokerFn.includes("'--tls-cert'") && brokerFn.includes("'--tls-key'"),
    'ensureBroker must wire the TLS twin listener for signed-in TUI turns');
  // The seeded credential is the literal placeholder — no host key path,
  // env var, or resolver output is ever written into the sandbox. The dotted
  // shape is load-bearing: the kernel's client-signing splits the plan key on
  // its single '.' and a separatorless placeholder fails closed.
  const seedFn = src.match(/function seedSigninHome[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(/SIGNIN_DUMMY_KEY = 'flock-dummy\.[0-9a-f]{32}'/.test(src), 'SIGNIN_DUMMY_KEY must keep the dotted placeholder shape');
  assert.ok(seedFn.includes('SIGNIN_DUMMY_KEY') && seedFn.includes('127.0.0.1:3129'), 'seed must write the placeholder key + loopback baseURL');
  assert.ok(!seedFn.includes('resolveCodingPlanKey') && !seedFn.includes('process.env.ZAI'), 'seed must never touch a real key source');
  // Second inner listener only exists on signin rounds; the TLS twin's inner
  // listener and the builtin-override env pin only exist when the TUI leg
  // seeded (sbx.signinTui) — otherwise a pty card would boot unsigned and farm
  // a false "No model access" finding.
  const spawnFn = src.match(/function spawnNetns[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(spawnFn.includes('inner 3129') && spawnFn.includes('sbx.signin'), 'spawnNetns must wire inner 3129 only for signin sandboxes');
  assert.ok(spawnFn.includes('SIGNIN_TLS_PORT') && spawnFn.includes('sbx.signinTui'), 'spawnNetns must gate the TLS inner on the seeded TUI leg');
  assert.ok(spawnFn.includes('ZCODE_BUILTIN_PROVIDER_CONFIG_FILE') && spawnFn.includes('NODE_TLS_REJECT_UNAUTHORIZED'),
    'signed-in TUI rounds must pin the builtin override and accept the throwaway cert');
  // The builtin-override seed repoints api.z.ai endpoints at the TLS twin.
  assert.ok(/function seedSigninTui/.test(src) && /replace\('https:\/\/api\.z\.ai'/.test(src),
    'seedSigninTui must rewrite builtin api.z.ai baseUrls at the TLS listener');
  // The pick must gate pty cards on BOTH the seeded override AND a live TLS sock.
  assert.ok(/sbx\.signinTui && ensureBroker\(\)\.tlsSock/.test(src), 'signin pty pick must gate on signinTui + live tlsSock');
  // Headless -p needs the provisioned account-provider:* records — the seed
  // must provision them (TUI-only call site in zagent.mjs) keyed to the
  // in-wall credential secret, and a sandbox that cannot complete the seed
  // must degrade to a genuinely unsigned round rather than farm false
  // 'Model creation failed' findings.
  assert.ok(/provisionSigninAccounts\(home\)/.test(src),
    'signin seed must call provisionSigninAccounts(home) — the bare import alone must not satisfy this');
  assert.ok(/ZCODE_CREDENTIAL_SECRET/.test(src),
    'provisioning must pin the credential secret the in-wall kernel will derive');
  // The seed itself must gate on the TLS twin BEFORE writing anything — a
  // sandbox seeded while the twin is down is a signed machine running an
  // unsigned card (broker bound + records present = guaranteed-false
  // findings on the unsigned asserts above).
  assert.ok(/signin = !!ensureBroker\(\)\.tlsSock/.test(src),
    'signin seed must degrade before seeding when the TLS twin is down');
  // The cadence gate: signin cards only when signinOk AND on cadence AND the
  // round rides the walled opencode engine (a claude-lane worker has no 3129).
  assert.ok(/signinOk && eng === 'opencode' && worker\.round % SIGNIN_EVERY === 0/.test(src),
    'oneRound must gate signin cards on signinOk + engine + cadence');
  // A malformed key source must degrade, not false-enable into a broker that
  // refuses it on every round.
  assert.ok(/\^\(zai\|env:\.\+\|file:\.\+\)\$\//.test(src) || src.includes('/^(zai|env:.+|file:.+)$/'),
    'signinKeyOk must validate the key-source shape');
});

// A record encrypted under the WRONG home must produce the
// identity/api-key findings — pre-fix the stub crashed in credDec (GCM auth
// throw), which the flock classifies INFRA, masking the very seeded-
// credential regression this oracle exists to catch. Run the stub directly
// under a fake HOME holding a wrong-home-encrypted store; assert exit 0 and
// both finding lines (discriminates vs the pre-fix crash).
test('a wrong-home credential record reports findings, never crashes the stub', () => {
  const fakeHome = mkdtempSync(path.join(work, 'stubhome-'));
  mkdirSync(path.join(fakeHome, '.zcode', 'v2'), { recursive: true });
  const wrongKey = crypto.createHash('sha256')
    .update(`zcode-credential-fallback:${process.platform}:/nonexistent/other/home:${userInfo().username}`)
    .digest();
  const enc = (s) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', wrongKey, iv);
    const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
    return 'enc:v1:' + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
  };
  writeFileSync(path.join(fakeHome, '.zcode', 'v2', 'credentials.json'), JSON.stringify({
    'account-provider:zai:identity': enc('key-wronghome'),
    'account-provider:coding-plan:zai:account:key-wronghome:api-key': enc('wronghome-key'),
  }));
  const r = spawnSync(process.execPath, [STUB, 'probe card IS signed in'], {
    encoding: 'utf8', timeout: 30_000,
    env: { HOME: fakeHome, PATH: process.env.PATH },
  });
  assert.equal(r.status, 0, `stub must not crash on a wrong-home record: ${r.stderr}`);
  assert.match(r.stdout, /no account-provider identity record decrypting to the placeholder identity/);
  assert.match(r.stdout, /no provisioned account api-key record decrypting to the placeholder key/);
});

let failed = 0;
try {
  for (const [name, opt, f] of tests) {
    if (opt.skip) { console.log(`skip ${name} (bwrap unavailable)`); continue; }
    try { await f(); console.log(`ok ${name}`); }
    catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(failed ? `${failed} failure(s)` : 'all signin oracles passed');
process.exit(failed ? 1 : 0);
