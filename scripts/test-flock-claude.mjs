#!/usr/bin/env node
// Offline oracle for the flock's claude-lane (--engine claude-lane / --claude-lane-workers K):
// a stub FLOCK_LANE_BIN emits claude-CLI stream-json and the harness must spawn it
// INSIDE the bwrap wall (the brokered re-arm: the stub is copied into the
// sandbox), parse assistant.message.content[] tool_use commands, audit them
// for escapes, and classify the record like any other round. The brokered
// legs drive a real net-relay broker against a local stub upstream and prove
// the key never enters the worker env — only the loopback + dummy do.
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Lane-runtime suite: full flock rounds shell out to the real `opencode`
// worker runtime (usertest/swarm/opencode-flock.mjs -> `which opencode`).
// Skip loudly where it is not installed (CI containers), like the --live
// suites - the pure code-shape assertions return when the runner image
// gains the runtime (CI runner images lack the runtime today).
const lacks = (bin) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).status !== 0;
if (lacks('opencode') || lacks('bwrap')) {
  console.log(`skip (${lacks('opencode') ? 'lane runtime `opencode`' : 'bubblewrap `bwrap`'} not installed - flock rounds cannot run)`);
  process.exit(0);
}

const FLOCK = path.join(root, 'usertest', 'swarm', 'opencode-flock.mjs');
const work = mkdtempSync(path.join(tmpdir(), 'flock-claude-lane-'));

const tests = [];
const test = (n, f) => tests.push([n, f]);

// A dependency-free npm package as the SUT — `npm install -g` of a local
// tarball is fully offline.
const pkgDir = path.join(work, 'stub-pkg');
mkdirSync(pkgDir);
writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
  name: 'stub-sut', version: '0.0.0', bin: { zagent: 'zagent.js' },
}));
writeFileSync(path.join(pkgDir, 'zagent.js'), '#!/usr/bin/env node\nconsole.log("stub zagent");\n');
const tarball = path.join(work,
  execFileSync('npm', ['pack', '--quiet', '--pack-destination', work], { cwd: pkgDir, encoding: 'utf8' }).trim().split('\n').pop());

// A stub claude-lane that just prints the given stream-json lines and exits 0.
// Ignores -p/--output-format args entirely.
function stubClaudeLane(lines) {
  const f = path.join(work, `claude-lane-stub-${tests.length}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(f, `#!/usr/bin/env node\n${lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join('\n')}\n`);
  chmodSync(f, 0o755);
  return f;
}

const assistant = (content) => ({ type: 'assistant', message: { content } });
const bashUse = (command) => ({ type: 'tool_use', name: 'Bash', input: { command } });
const textPart = (text) => ({ type: 'text', text });

function runFlock(args, claudeLaneBin, extraEnv) {
  const flockDir = mkdtempSync(path.join(work, 'flockdir-'));
  const home = mkdtempSync(path.join(work, 'home-')); // hermetic: no host opencode auth/cache
  const env = { ...process.env, NODE_OPTIONS: '', FLOCK_DIR: flockDir, HOME: home, USERPROFILE: home, ...extraEnv };
  if (claudeLaneBin) env.FLOCK_LANE_BIN = claudeLaneBin; // absent = production path (fail-closed)
  else delete env.FLOCK_LANE_BIN; // an inherited FLOCK_LANE_BIN must not leak into the null legs
  // Hermetic key surface: ambient pool/claude vars must not arm the lane in
  // legs that did not ask for it (an inherited FLOCK_LANE_API_KEY would silently
  // wire a real broker into a "no seam" leg).
  for (const k of ['FLOCK_LANE_API_KEY', 'FLOCK_LANE_API_KEYS', 'FLOCK_LANE_KEY_CACHE', 'FLOCK_LANE_UPSTREAM', 'FLOCK_CLAUDE']) {
    if (!(extraEnv && k in extraEnv)) delete env[k];
  }
  const r = spawnSync(process.execPath, [FLOCK, '--tarball', tarball, '--seed', '7', '--max-hours', '0.01', ...args], {
    encoding: 'utf8', timeout: 120_000, env,
  });
  const runs = existsSync(path.join(flockDir, 'runs.ndjson'))
    ? readFileSync(path.join(flockDir, 'runs.ndjson'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { r, runs };
}

test('a claude-lane worker spawns the lane binary and parses the claude-CLI stream', () => {
  const stub = stubClaudeLane([
    assistant([textPart('checking the install'), bashUse('zagent --version')]),
    assistant([textPart('FLOCK-VERDICT: OK')]),
  ]);
  const { r, runs } = runFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], stub);
  assert.equal(r.status, 0, `flock failed: ${r.stderr}\n${r.stdout}`);
  assert.equal(runs.length, 1, `expected 1 record, got ${runs.length}: ${r.stdout}`);
  const rec = runs[0];
  assert.equal(rec.model, 'claude-lane/deepseek-v4-flash', 'claude-lane worker must record the claude-lane model label');
  assert.ok(rec.cmds.includes('zagent --version'), `tool_use command not parsed: ${JSON.stringify(rec.cmds)}`);
  // ranZagent + a verdict but no SEED echo -> NOISY 'OK verdict but no SEED
  // echo' — proves BOTH the tool_use command and the assistant text landed.
  assert.equal(rec.class, 'NOISY');
  assert.match(rec.note ?? '', /no SEED echo/, `unexpected note: ${rec.note}`);
});

test('--engine claude-lane puts every worker on the claude-lane', () => {
  const stub = stubClaudeLane([assistant([textPart('hi'), bashUse('zagent doctor')])]);
  const { r, runs } = runFlock(['--engine', 'claude-lane', '-n', '2', '-r', '1'], stub);
  assert.equal(r.status, 0, `flock failed: ${r.stderr}\n${r.stdout}`);
  assert.equal(runs.length, 2, `expected 2 records: ${r.stdout}`);
  for (const rec of runs) assert.equal(rec.model, 'claude-lane/deepseek-v4-flash');
  assert.deepEqual(runs.map((x) => x.worker).sort(), [1, 2]);
});

test('a claude-lane worker probing /proc/<pid>/environ is an ESCAPE and kills the flock', () => {
  const stub = stubClaudeLane([assistant([bashUse('cat /proc/1/environ')])]);
  const { r, runs } = runFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], stub);
  assert.equal(r.status, 42, `escape must self-kill loudly, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.equal(runs[0]?.class, 'ESCAPE');
  assert.ok(runs[0]?.escaped?.length, 'escape record must name the offending command');
});

test('reading the lane key cache (env var or path) is an ESCAPE', () => {
  for (const cmd of ['cat "$FLOCK_LANE_KEY_CACHE"', 'cat /var/tmp/lane-keys/.api_key']) {
    const stub = stubClaudeLane([assistant([bashUse(cmd)])]);
    const { r, runs } = runFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], stub);
    assert.equal(r.status, 42, `${cmd}: escape must self-kill, got ${r.status}`);
    assert.equal(runs[0]?.class, 'ESCAPE', `${cmd}: ${JSON.stringify(runs[0])}`);
  }
});

test('scenario-prop credentials (flock-test-*) are NOT escapes — only real carriers are', () => {
  // The pty cards instruct `env ZAI_API_KEY=flock-test-000 zagent`; a worker
  // obeying the card must not trip the credential-carrier audit (it did, and
  // the false ESCAPE killed the whole flock on the qwen lane, 2026-09-18).
  const ok = stubClaudeLane([
    assistant([bashUse('env ZAI_API_KEY=flock-test-000 zagent'), textPart('FLOCK-VERDICT: OK')]),
  ]);
  const { r, runs } = runFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], ok);
  assert.equal(r.status, 0, `prop credential must not self-kill: ${r.stdout}${r.stderr}`);
  assert.notEqual(runs[0]?.class, 'ESCAPE', `prop credential audited as escape: ${JSON.stringify(runs[0])}`);
  // And the carrier pattern still bites on a value that is NOT a declared prop.
  const bad = stubClaudeLane([assistant([bashUse('env | grep ANTHROPIC_AUTH_TOKEN')])]);
  const res = runFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], bad);
  assert.equal(res.r.status, 42, `real credential probe must still self-kill: ${res.r.stdout}`);
  assert.equal(res.runs[0]?.class, 'ESCAPE');
});

test('the onboard-bad-key card literal is a declared prop — the 0.0.238 release-flock FP', () => {
  // 2026-09-19 ~01:54Z: worker 2 ran the card verbatim (`export
  // ZAI_API_KEY=dummy-not-a-real-key; time zagent onboard`) and the
  // credential-carrier audit ESCAPEd it, halting a release run. A
  // card-mandated prop is not a wall probe.
  const ok = stubClaudeLane([
    assistant([bashUse('export ZAI_API_KEY=dummy-not-a-real-key; time zagent onboard 2>&1; echo "EXIT:$?"'), textPart('FLOCK-VERDICT: OK')]),
  ]);
  const { r, runs } = runFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], ok);
  assert.equal(r.status, 0, `card-mandated prop must not self-kill: ${r.stdout}${r.stderr}`);
  assert.notEqual(runs[0]?.class, 'ESCAPE', `card literal audited as escape: ${JSON.stringify(runs[0])}`);
  // Discriminating control: a real-looking key value still trips the audit.
  const bad = stubClaudeLane([assistant([bashUse('export ZAI_API_KEY=zai-live-9f8e7d6c5b; zagent quota')])]);
  const res = runFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], bad);
  assert.equal(res.r.status, 42, `non-prop credential carrier must still self-kill: ${res.r.stdout}`);
  assert.equal(res.runs[0]?.class, 'ESCAPE');
});

test('the lane is fail-closed without a key pool or the test seam', () => {
  // --engine claude-lane refuses before the pack when no broker/test seam exists.
  const { r } = runFlock(['--engine', 'claude-lane', '-n', '1', '-r', '1'], null);
  assert.equal(r.status, 3, `expected refusal exit 3, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, /REFUSED: --engine claude-lane/, 'refusal must name the lane');
  // --claude-lane-workers degrades loudly to opencode instead of spawning the lane.
  // FLOCK_OPENCODE → a fast stub keeps the round hermetic (no real gateway).
  const ocDir = path.join(work, 'oc-stub', 'bin');
  mkdirSync(ocDir, { recursive: true });
  const ocStub = path.join(ocDir, 'opencode');
  writeFileSync(ocStub, '#!/usr/bin/env node\nconsole.log(JSON.stringify({part:{type:"text",text:"FLOCK-VERDICT: OK"}}));\n');
  chmodSync(ocStub, 0o755);
  const d = runFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], null, { FLOCK_OPENCODE: ocStub });
  assert.match(d.r.stdout + d.r.stderr, /claude-lane DISABLED/, 'degradation must be loud');
  assert.ok(!d.runs.some((x) => x.model === 'claude-lane/deepseek-v4-flash'), 'no claude-lane round may run unbrokered');
  // The degraded worker must actually RUN the opencode stub (exit 0, verdict
  // text, no zagent cmds → NOISY) — an empty/INFRA run proves nothing.
  assert.equal(d.runs.length, 1, `expected 1 opencode round, got ${JSON.stringify(d.runs)}`);
  assert.equal(d.runs[0].class, 'NOISY', `degraded round must execute the stub: ${JSON.stringify(d.runs[0])}`);
  // The lane binary's env must not name a key path — and spawnClaudeLane's env must
  // stay a whitelist (a `...process.env` spread would re-expose every host
  // secret regardless of the key-cache line).
  const src = readFileSync(FLOCK, 'utf8');
  assert.ok(!/FLOCK_LANE_KEY_CACHE:\s*'/.test(src), 'spawn env must not carry FLOCK_LANE_KEY_CACHE');
  const claudeLaneFn = src.match(/function spawnClaudeLane[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(claudeLaneFn, 'spawnClaudeLane not found');
  assert.ok(!claudeLaneFn.includes('...process.env'), 'spawnClaudeLane env must be a whitelist — no process.env spread');
});

test('a claude inside a broad HOME subdir refuses to widen the wall', () => {
  // <home>/.local/bin/claude -> pkgDir <home>/.local: ro-binding it over the
  // home tmpfs would re-expose <home>/.local/share/opencode/auth.json — the
  // ancestor-or-root guard was the wrong direction for this install layout.
  const home = path.join(work, 'home-broad');
  mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  mkdirSync(path.join(home, '.local', 'share', 'opencode'), { recursive: true });
  writeFileSync(path.join(home, '.local', 'share', 'opencode', 'auth.json'), '{}');
  const fakeClaude = path.join(home, '.local', 'bin', 'claude');
  writeFileSync(fakeClaude, '#!/bin/sh\n'); chmodSync(fakeClaude, 0o755);
  const env = { HOME: home, USERPROFILE: home, FLOCK_LANE_API_KEY: 'fi-test-key', FLOCK_CLAUDE: fakeClaude };
  const { r } = runFlock(['--engine', 'claude-lane', '-n', '1', '-r', '1'], null, env);
  assert.equal(r.status, 3, `broad pkgDir must refuse, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, /REFUSED: --engine claude-lane — claude binary unresolvable \(FLOCK_CLAUDE resolves to/, 'refusal must name the resolution failure (why is truncated at 120ch)');
  // A dedicated leaf dir (…/opt/claude/bin/claude -> pkgDir opt/claude)
  // stays allowed — the guard must not over-refuse.
  const home2 = path.join(work, 'home-leaf');
  mkdirSync(path.join(home2, 'opt', 'claude', 'bin'), { recursive: true });
  const leafClaude = path.join(home2, 'opt', 'claude', 'bin', 'claude');
  writeFileSync(leafClaude, '#!/bin/sh\n'); chmodSync(leafClaude, 0o755);
  const ok = runFlock(['--engine', 'claude-lane', '-n', '1', '-r', '1'], null,
    { HOME: home2, USERPROFILE: home2, FLOCK_LANE_API_KEY: 'fi-test-key', FLOCK_CLAUDE: leafClaude, FLOCK_LANE_UPSTREAM: 'http://127.0.0.1:1' });
  assert.ok(!/would expose/.test(ok.r.stdout + ok.r.stderr), `dedicated leaf pkgDir must pass the wall guard: ${ok.r.stdout}${ok.r.stderr}`);
});

test('a dead claude-lane upstream refuses/degrades instead of burning INFRA rounds', () => {
  // 127.0.0.1:1 refuses connects instantly — the upstream preflight must
  // trip before any round is burned.
  const home = path.join(work, 'home-deadup');
  mkdirSync(path.join(home, 'opt', 'claude', 'bin'), { recursive: true });
  const fakeClaude = path.join(home, 'opt', 'claude', 'bin', 'claude');
  writeFileSync(fakeClaude, '#!/bin/sh\n'); chmodSync(fakeClaude, 0o755);
  const env = { HOME: home, USERPROFILE: home, FLOCK_LANE_API_KEY: 'fi-test-key', FLOCK_CLAUDE: fakeClaude, FLOCK_LANE_UPSTREAM: 'http://127.0.0.1:1' };
  const { r } = runFlock(['--engine', 'claude-lane', '-n', '1', '-r', '1'], null, env);
  assert.equal(r.status, 3, `dead upstream must refuse, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, /REFUSED: --engine claude-lane — claude-lane upstream .*unreachable/, 'refusal must name the upstream');
  const ocDir = path.join(work, 'oc-stub3', 'bin');
  mkdirSync(ocDir, { recursive: true });
  const ocStub = path.join(ocDir, 'opencode');
  writeFileSync(ocStub, '#!/usr/bin/env node\nconsole.log(JSON.stringify({part:{type:"text",text:"FLOCK-VERDICT: OK"}}));\n');
  chmodSync(ocStub, 0o755);
  const d = runFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], null, { ...env, FLOCK_OPENCODE: ocStub });
  assert.match(d.r.stdout + d.r.stderr, /claude-lane DISABLED — claude-lane upstream/, 'degradation must name the upstream');
  assert.equal(d.runs[0]?.class, 'NOISY', `degraded round must execute the stub: ${JSON.stringify(d.runs)}`);
});

test('an empty FLOCK_LANE_API_KEYS does not shadow a real FLOCK_LANE_API_KEY', () => {
  const stub = stubClaudeLane([assistant([textPart('FLOCK-VERDICT: OK')])]);
  const { r } = runFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], stub,
    { FLOCK_LANE_API_KEYS: '', FLOCK_LANE_API_KEY: 'fi-test-key', FLOCK_LANE_UPSTREAM: 'http://127.0.0.1:1' });
  assert.equal(r.status, 0, `flock failed: ${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout + r.stderr, /1-key pool/, 'the single env key must resolve through the empty plural var');
});

test('a key pool without a resolvable claude refuses/degrades — never burns INFRA rounds', () => {
  // FLOCK_CLAUDE at filesystem root resolves to package dir '/', which the
  // wall-widening guard refuses — a deterministic "no claude" preflight.
  // (/bin/false is NOT deterministic: /bin symlinks to /usr/bin on this
  // host, so the package dir lands at /usr and the guard does not trip.)
  const env = { FLOCK_LANE_API_KEY: 'fi-test-key', FLOCK_CLAUDE: '/flock-no-such-claude-zz' };
  const { r } = runFlock(['--engine', 'claude-lane', '-n', '1', '-r', '1'], null, env);
  assert.equal(r.status, 3, `expected refusal exit 3, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, /REFUSED: --engine claude-lane/, 'refusal must name the lane');
  // Mixed lane degrades those workers to opencode, loudly — and the
  // degraded worker must actually RUN the opencode stub (INFRA proves nothing).
  const ocDir = path.join(work, 'oc-stub2', 'bin');
  mkdirSync(ocDir, { recursive: true });
  const ocStub = path.join(ocDir, 'opencode');
  writeFileSync(ocStub, '#!/usr/bin/env node\nconsole.log(JSON.stringify({part:{type:"text",text:"FLOCK-VERDICT: OK"}}));\n');
  chmodSync(ocStub, 0o755);
  const d = runFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], null, { ...env, FLOCK_OPENCODE: ocStub });
  assert.match(d.r.stdout + d.r.stderr, /claude-lane DISABLED/, 'degradation must be loud');
  assert.equal(d.runs.length, 1, `expected 1 opencode round: ${JSON.stringify(d.runs)}`);
  assert.ok(!d.runs.some((x) => x.model === 'claude-lane/deepseek-v4-flash'), 'no claude-lane round may run without claude');
  assert.equal(d.runs[0].class, 'NOISY', `degraded round must execute the stub: ${JSON.stringify(d.runs[0])}`);
});

// --- Brokered lane oracles: the re-armed design. A real net-relay broker
// runs against a local stub upstream; the in-wall worker stub posts its OWN
// env through the loopback endpoint, so the upstream capture proves (a) the
// key was injected host-side and (b) the key never entered the wall. ---

// An in-wall stub: POST its own process env to the loopback broker endpoint
// (carrying the dummy token — the broker must drop and replace it), then
// emit a verdict line so the round completes.
function stubClaudeLaneEnvPost() {
  const f = path.join(work, `claude-lane-stub-env-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(f, `import http from 'node:http';
import net from 'node:net';
// A loopback-only wall must not carry the CONNECT relay: probe 3128 and
// report it in the dumped body (closed/timeout both prove no relay).
const relayProbe = await new Promise((res) => {
  const s = net.connect(3128, '127.0.0.1');
  s.setTimeout(2000);
  s.on('connect', () => { s.destroy(); res('open'); });
  s.on('error', () => res('closed'));
  s.on('timeout', () => { s.destroy(); res('timeout'); });
});
const body = JSON.stringify({ ...process.env, RELAY_3128: relayProbe });
const go = (n) => {
  const req = http.request({ host: '127.0.0.1', port: 3129, path: '/anthropic/v1/messages', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      authorization: 'Bearer ' + (process.env.ANTHROPIC_AUTH_TOKEN || '') } },
    (res) => { res.resume(); res.on('end', () => console.log(${JSON.stringify(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'FLOCK-VERDICT: OK' }] } }))})); });
  req.setTimeout(10_000, () => req.destroy(new Error('broker response timeout')));
  req.on('error', (e) => { if (n > 0) setTimeout(() => go(n - 1), 250); else { console.error('BROKER-POST-FAILED: ' + e.message); process.exitCode = 3; } });
  req.end(body);
};
go(12);
`);
  chmodSync(f, 0o755);
  return f;
}

// A host-side stub upstream IN A CHILD PROCESS — runFlock's spawnSync blocks
// this process's event loop, so an in-process server could never answer the
// broker (the brokered-lane hang: POST forwarded, response never written,
// flock SIGTERM'd at the 120s bound). Captures append to an ndjson file.
function stubUpstream() {
  const cap = path.join(work, `upstream-cap-${Math.random().toString(36).slice(2)}.ndjson`);
  const src = `import http from 'node:http';import fs from 'node:fs';
http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => { fs.appendFileSync(${JSON.stringify(cap)}, JSON.stringify({
    method: req.method, url: req.url, authorization: req.headers.authorization,
    apiKey: req.headers['x-api-key'], xClient: req.headers['x-client'], body: b }) + '\\n');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
}).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => reject(new Error('upstream stub never listened')), 5_000);
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/\d+/);
      if (m) { clearTimeout(to); resolve({ proc, port: Number(m[0]) }); }
    });
    proc.on('exit', (c) => { clearTimeout(to); reject(new Error(`upstream stub exited ${c}`)); });
  }).then(({ proc, port }) => ({
    proc, port,
    captured: () => (existsSync(cap) ? readFileSync(cap, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []),
  }));
}

test('brokered lane: worker env carries ONLY the dummy — the broker injects the pool key host-side', async () => {
  const { proc, captured, port } = await stubUpstream();
  try {
    const { r, runs } = runFlock(['-n', '1', '--claude-lane-workers', '1', '-r', '1'], stubClaudeLaneEnvPost(),
      { FLOCK_LANE_API_KEYS: 'fi-test-key-AAAA\nfi-test-key-BBBB', FLOCK_LANE_UPSTREAM: `http://127.0.0.1:${port}` });
    assert.equal(r.status, 0, `flock failed: ${r.stderr}\n${r.stdout}`);
    assert.equal(runs[0]?.model, 'claude-lane/deepseek-v4-flash');
    const caps = captured();
    assert.equal(caps.length, 1, `expected 1 brokered upstream request: ${JSON.stringify(caps)}\n${r.stdout}${r.stderr}`);
    const c = caps[0];
    // Injection happened host-side: upstream saw the LANE key, not the
    // worker's dummy bearer (which the broker's allowlist must have dropped).
    assert.equal(c.authorization, 'Bearer fi-test-key-AAAA', `lane 0 must pin pool key 0: ${c.authorization}`);
    assert.equal(c.apiKey, 'fi-test-key-AAAA', 'x-api-key must be injected host-side too');
    assert.equal(c.xClient, 'zagent-flock-claude-lane-0', `broker must attribute the lane: ${c.xClient}`);
    assert.match(c.url, /^\/anthropic\//, `path confinement must forward /anthropic/*: ${c.url}`);
    // The worker's env dump (the posted body) proves the key never entered
    // the wall: dummy token + loopback base only.
    const env = JSON.parse(c.body);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'flock-claude-lane-dummy.0123456789abcdef0123456789abcdef', 'worker token must be the dummy');
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3129/anthropic', 'worker base must be the loopback broker');
    assert.equal(env.ANTHROPIC_MODEL, 'deepseek-v4-flash');
    for (const [k, v] of Object.entries(env)) {
      assert.ok(!/fi-test-key|FLOCK_LANE_API_KEY|FLOCK_LANE_KEY_CACHE|\.config\/claude-lane|ANTHROPIC_API_KEY|api_key/.test(`${k}=${v}`), `key material leaked into worker env: ${k}=${v}`);
    }
    assert.ok(!('HTTP_PROXY' in env || 'HTTPS_PROXY' in env), 'claude-lane worker must not carry proxy vars (loopback-only lane)');
    assert.notEqual(env.RELAY_3128, 'open', 'the CONNECT relay must not be bound into a claude-lane wall');
  } finally { proc.kill('SIGKILL'); }
});

test('two claude-lanes pin distinct pool keys (1 in-flight per key)', async () => {
  const { proc, captured, port } = await stubUpstream();
  try {
    const { r, runs } = runFlock(['-n', '2', '--claude-lane-workers', '2', '-r', '1'], stubClaudeLaneEnvPost(),
      { FLOCK_LANE_API_KEYS: 'fi-test-key-AAAA\nfi-test-key-BBBB', FLOCK_LANE_UPSTREAM: `http://127.0.0.1:${port}` });
    assert.equal(r.status, 0, `flock failed: ${r.stderr}\n${r.stdout}`);
    assert.equal(runs.length, 2, `expected 2 records: ${r.stdout}`);
    const caps = captured();
    const pairs = caps.map((c) => `${c.xClient}|${c.authorization}`).sort();
    assert.deepEqual(pairs, ['zagent-flock-claude-lane-0|Bearer fi-test-key-AAAA', 'zagent-flock-claude-lane-1|Bearer fi-test-key-BBBB'],
      `each lane must pin its own pool key: ${JSON.stringify(caps.map((c) => `${c.xClient} ${c.authorization}`))}`);
  } finally { proc.kill('SIGKILL'); }
});

let pass = 0, fail = 0;
for (const [n, f] of tests) {
  try { await f(); pass++; } catch (e) { fail++; console.error(`FAIL ${n}\n  ${e.message}`); }
}
rmSync(work, { recursive: true, force: true });
console.log(`${pass}/${tests.length} flock-claude-lane tests passed`);
process.exit(fail ? 1 : 0);
