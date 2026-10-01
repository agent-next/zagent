#!/usr/bin/env node
// Offline oracle for the flock's qwen lane (--engine qwen / --qwen-workers K):
// a loopback stub upstream + FLOCK_QWEN_KEY exercise the real broker chain —
// worker inside bwrap -> inner :3129 -> unix socket -> host broker (injects
// the key, confines to /v1/) -> stub upstream. The stub opencode POSTs with a
// WRONG key through 3129; a correct canned reply proves host-side injection.
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
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
const work = mkdtempSync(path.join(tmpdir(), 'flock-qwen-'));

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

// Stub upstream as a CHILD PROCESS — spawnSync in runFlock blocks this
// process's event loop, so an in-process server would never accept. It logs
// every auth header + path to a file the assertions read afterwards; only the
// REAL key gets a 200.
const seenFile = path.join(work, 'upstream-seen.ndjson');
const upScript = path.join(work, 'stub-upstream.cjs');
writeFileSync(upScript, `const http = require('node:http'), fs = require('node:fs');
http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => body += d);
  req.on('end', () => {
    fs.appendFileSync(process.env.SEEN, JSON.stringify({ url: req.url, auth: req.headers.authorization || null, client: req.headers['x-client'] || null }) + '\\n');
    if (req.headers.authorization !== 'Bearer REAL-QWEN-KEY') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'invalid_api_key' } }));
      return;
    }
    // The lane's judge pass is recognized by its prompt signature; answer it
    // with a clean verdict so judge-extraction is exercised end to end.
    const judged = body.includes('ended by narrating instead of emitting');
    const content = judged ? 'FLOCK-VERDICT: OK' : 'QWEN-UPSTREAM-OK';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'c1', choices: [{ message: { role: 'assistant', content } }] }));
  });
}).listen(0, '127.0.0.1', function () { fs.writeFileSync(process.env.PORTF, String(this.address().port)); });
`);
const portFile = path.join(work, 'upstream-port');
const upProc = spawn(process.execPath, [upScript], { env: { SEEN: seenFile, PORTF: portFile }, stdio: 'ignore' });
{ const t0 = Date.now(); while (!existsSync(portFile) && Date.now() - t0 < 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
const UP = `http://127.0.0.1:${readFileSync(portFile, 'utf8').trim()}`;
const seenReqs = () => (existsSync(seenFile) ? readFileSync(seenFile, 'utf8').trim().split('\n').map(JSON.parse) : []);

// Stub opencode: behaves like a worker that tries the model endpoint with a
// WRONG key (a leak attempt is the honest case — the broker must overwrite).
// Emits opencode-style stream-json with the upstream body inside a text part.
const ocDir = path.join(work, 'oc-stub', 'bin');
mkdirSync(ocDir, { recursive: true });
const ocStub = path.join(ocDir, 'opencode');
writeFileSync(ocStub, `#!/usr/bin/env node
const http = require('node:http');
const card = process.argv[process.argv.length - 1] || '';
const seed = (card.match(/SEED:(\\d+)/) || [])[1] || '0';
const req = http.request('http://127.0.0.1:3129/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer WRONG-KEY' },
}, (res) => {
  let b = '';
  res.on('data', (d) => b += d);
  res.on('end', () => {
    console.log(JSON.stringify({ part: { type: 'tool', tool: 'bash', state: { input: { command: 'echo SEED:' + seed } } } }));
    console.log(JSON.stringify({ part: { type: 'tool', tool: 'bash', state: { input: { command: 'zagent --version' } } } }));
    console.log(JSON.stringify({ part: { type: 'text', text: 'upstream=' + res.statusCode + ' ' + b.slice(0, 200) } }));
    console.log(JSON.stringify({ part: { type: 'text', text: 'FLOCK-VERDICT: OK' } }));
  });
});
req.on('error', (e) => { console.log(JSON.stringify({ part: { type: 'text', text: 'upstream-error ' + e.message } })); });
req.end('{"model":"x","messages":[]}');
`);
chmodSync(ocStub, 0o755);

// Quiet variant: runs zagent and echoes the seed but never emits the verdict
// line — the NOISY round that exercises the judge pass.
const ocQuiet = path.join(ocDir, 'opencode-quiet');
writeFileSync(ocQuiet, `#!/usr/bin/env node
const http = require('node:http');
const card = process.argv[process.argv.length - 1] || '';
const seed = (card.match(/SEED:(\\d+)/) || [])[1] || '0';
const req = http.request('http://127.0.0.1:3129/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer WRONG-KEY' },
}, (res) => {
  let b = '';
  res.on('data', (d) => b += d);
  res.on('end', () => {
    console.log(JSON.stringify({ part: { type: 'tool', tool: 'bash', state: { input: { command: 'echo SEED:' + seed } } } }));
    console.log(JSON.stringify({ part: { type: 'tool', tool: 'bash', state: { input: { command: 'zagent --version' } } } }));
    console.log(JSON.stringify({ part: { type: 'text', text: 'Interesting. The tool worked fine, upstream=' + res.statusCode } }));
  });
});
req.on('error', (e) => { console.log(JSON.stringify({ part: { type: 'text', text: 'upstream-error ' + e.message } })); });
req.end('{"model":"x","messages":[]}');
`);
chmodSync(ocQuiet, 0o755);

function runFlock(args, extraEnv) {
  const flockDir = mkdtempSync(path.join(work, 'flockdir-'));
  const home = mkdtempSync(path.join(work, 'home-')); // hermetic: no host opencode auth/cache
  const env = { ...process.env, NODE_OPTIONS: '', FLOCK_DIR: flockDir, HOME: home, USERPROFILE: home,
    FLOCK_OPENCODE: ocStub, FLOCK_QWEN_UPSTREAM: UP, ...extraEnv };
  delete env.FLOCK_QWEN_KEY; delete env.FLOCK_QWEN_KEY_FILE; // no inheritance leaks
  if (extraEnv?.FLOCK_QWEN_KEY) env.FLOCK_QWEN_KEY = extraEnv.FLOCK_QWEN_KEY;
  if (extraEnv?.FLOCK_QWEN_KEY_FILE) env.FLOCK_QWEN_KEY_FILE = extraEnv.FLOCK_QWEN_KEY_FILE;
  const r = spawnSync(process.execPath, [FLOCK, '--tarball', tarball, '--seed', '7', '--max-hours', '0.01', ...args], {
    encoding: 'utf8', timeout: 180_000, env,
  });
  const runs = existsSync(path.join(flockDir, 'runs.ndjson'))
    ? readFileSync(path.join(flockDir, 'runs.ndjson'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { r, runs };
}

test('a qwen worker reaches the brokered upstream with the real key injected', () => {
  const { r, runs } = runFlock(['--engine', 'qwen', '-n', '1', '-r', '1'], { FLOCK_QWEN_KEY: 'REAL-QWEN-KEY' });
  assert.equal(r.status, 0, `flock failed: ${r.stderr}\n${r.stdout}`);
  assert.equal(runs.length, 1, `expected 1 record, got ${runs.length}: ${r.stdout}`);
  const rec = runs[0];
  assert.equal(rec.model, 'qwen/Qwen3-32B', `model label: ${rec.model}`);
  // The stub upstream only answers 200 to the REAL key — a 200 body in the
  // agent text proves broker-side injection overwrote the worker's WRONG-KEY.
  assert.equal(rec.class, 'OK', `expected OK (upstream 200 + verdict + seed echo), got ${rec.class}: ${rec.note}`);
  const seen = seenReqs();
  assert.ok(seen.some((s) => s.auth === 'Bearer REAL-QWEN-KEY'), `upstream never saw the real key: ${JSON.stringify(seen)}`);
  assert.ok(seen.every((s) => s.auth !== 'Bearer WRONG-KEY'), 'worker key reached upstream un-rewritten');
  assert.ok(seen.every((s) => s.url.startsWith('/v1/')), `path escaped /v1/: ${JSON.stringify(seen)}`);
  assert.ok(seen.some((s) => s.client === 'zagent-flock'), `x-client attribution missing: ${JSON.stringify(seen)}`);
});

test('a NOISY qwen round is judged through the broker — extracted OK marks rec.judged', () => {
  const { r, runs } = runFlock(['--engine', 'qwen', '-n', '1', '-r', '1'],
    { FLOCK_QWEN_KEY: 'REAL-QWEN-KEY', FLOCK_OPENCODE: ocQuiet });
  assert.equal(r.status, 0, `flock failed: ${r.stderr}\n${r.stdout}`);
  const rec = runs[0];
  assert.equal(rec.class, 'OK', `judge should convert evidenced NOISY to OK, got ${rec.class}: ${rec.note}`);
  assert.equal(rec.judged, true, 'judge-derived verdict must be marked');
});

test('--qwen-workers mixes lanes: worker 1 qwen, worker 2 opencode', () => {
  const { r, runs } = runFlock(['-n', '2', '--qwen-workers', '1', '-r', '1'], { FLOCK_QWEN_KEY: 'REAL-QWEN-KEY' });
  assert.equal(r.status, 0, `flock failed: ${r.stderr}\n${r.stdout}`);
  assert.equal(runs.length, 2, `expected 2 records: ${JSON.stringify(runs)}`);
  const byWorker = Object.fromEntries(runs.map((x) => [x.worker, x]));
  assert.match(byWorker[1].model, /^qwen\//, `worker1 should be qwen: ${byWorker[1].model}`);
  assert.match(byWorker[2].model, /^opencode\//, `worker2 should be opencode: ${byWorker[2].model}`);
});

test('--engine qwen refuses without a key source (fail-closed)', () => {
  const { r } = runFlock(['--engine', 'qwen', '-n', '1', '-r', '1'], {});
  assert.equal(r.status, 3, `expected refusal exit 3, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, /REFUSED: --engine qwen/, 'refusal must name the lane');
});

test('a dead upstream degrades --qwen-workers to opencode loudly', () => {
  const dead = { FLOCK_QWEN_KEY: 'REAL-QWEN-KEY', FLOCK_QWEN_UPSTREAM: 'http://127.0.0.1:1' };
  const { r, runs } = runFlock(['-n', '1', '--qwen-workers', '1', '-r', '1'], dead);
  assert.equal(r.status, 0, `degraded run must still complete: ${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout + r.stderr, /qwen lane DISABLED/, 'degradation must be loud');
  assert.match(runs[0]?.model ?? '', /^opencode\//, `degraded worker must run opencode: ${runs[0]?.model}`);
});

test('a dead upstream refuses --engine qwen', () => {
  const dead = { FLOCK_QWEN_KEY: 'REAL-QWEN-KEY', FLOCK_QWEN_UPSTREAM: 'http://127.0.0.1:1' };
  const { r } = runFlock(['--engine', 'qwen', '-n', '1', '-r', '1'], dead);
  assert.equal(r.status, 3, `expected refusal exit 3, got ${r.status}: ${r.stdout}${r.stderr}`);
});

let pass = 0, fail = 0;
for (const [n, f] of tests) {
  try { await f(); pass++; } catch (e) { fail++; console.error(`FAIL ${n}\n  ${e.message}`); }
}
upProc.kill();
rmSync(work, { recursive: true, force: true });
console.log(`${pass}/${tests.length} flock-qwen tests passed`);
process.exit(fail ? 1 : 0);
