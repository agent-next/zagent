#!/usr/bin/env node
// Offline oracle for net-relay `broker` mode (FLOCK-V2-SIGNIN key broker):
// the host-side reverse proxy overwrites sandbox-supplied auth headers with
// the host-resolved credential — the sandbox only ever holds a dummy key.
//
// The gate's offline preload blocks net in THIS process, so every socket lives
// in a child: a fake upstream (plain http on loopback — broker accepts http
// upstreams only for loopback), the broker itself on a tmp unix socket, and a
// small client that speaks HTTP over that socket.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitsSunPath, sunPathBudget } from '../usertest/swarm/sun-path.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELAY = path.join(root, 'usertest', 'swarm', 'net-relay.mjs');
// The bound leaves here run up to `b14-<random>.sock`; AF_UNIX sun_path is
// platform-sized (108 bytes on Linux, 104 on Darwin/BSD), and a long TMPDIR
// (this gate inherits one from its own runner) pushes a plain mkdtemp dir
// past it — the bind then fails behind stdio:'ignore' and the readiness wait
// is the only symptom. Root the work dir where the longest leaf provably
// fits, /tmp as fallback.
const work = (() => {
  for (const dir of [...new Set([tmpdir(), '/tmp'])]) {
    if (fitsSunPath(path.join(dir, 'flock-broker-xxxxxx', 'b14-xxxxxxxxxxxxxxxx.sock'))) {
      return mkdtempSync(path.join(dir, 'flock-broker-'));
    }
  }
  throw new Error(`no temp root can host the broker test sockets inside the ${sunPathBudget()}-byte AF_UNIX path cap (TMPDIR=${tmpdir()})`);
})();
const tests = [];
const test = (n, f) => tests.push([n, f]);

// Child-side helpers, written per run (kept out of the repo: test scaffolding).
const UPSTREAM = path.join(work, 'upstream.mjs');
writeFileSync(UPSTREAM, `import http from 'node:http';
import fs from 'node:fs';
const [cap, portFile] = process.argv.slice(2);
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    fs.appendFileSync(cap, JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: b }) + '\\n');
    // set-cookie exercises the broker's response-side credential drop.
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'session=must-not-reach-sandbox' });
    res.end('upstream-ok:' + b.length);
  });
});
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(srv.address().port)));
`);
const CLIENT = path.join(work, 'client.mjs');
writeFileSync(CLIENT, `import http from 'node:http';
const [sock, method, p, body, hdrs] = process.argv.slice(2);
const req = http.request({ socketPath: sock, method, path: p, headers: JSON.parse(hdrs) }, (res) => {
  let b = ''; res.on('data', (c) => b += c);
  res.on('end', () => console.log(JSON.stringify({ status: res.statusCode, headers: res.headers, body: b })));
});
req.on('error', (e) => console.log(JSON.stringify({ status: 0, error: String(e) })));
req.end(body);
`);

// Hermetic env for every child: sandboxed HOME so the `zai` key source could
// never resolve a real host credential even if a test forgot --key-source.
const childEnv = (extra = {}) => {
  const env = { ...process.env, NODE_OPTIONS: '', HOME: work, USERPROFILE: work, ...extra };
  delete env.ZAI_API_KEY; // an inherited real key must never resolve in-test
  return env;
};
function waitFor(file, ms = 8000) {
  const t0 = Date.now();
  while (!existsSync(file) && Date.now() - t0 < ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  if (!existsSync(file)) throw new Error(`never appeared: ${file}`);
  return file;
}
function startUpstream() {
  const cap = path.join(work, `cap-${tests.length}-${Math.random().toString(36).slice(2)}.ndjson`);
  const portFile = cap + '.port';
  const proc = spawn(process.execPath, [UPSTREAM, cap, portFile], { env: childEnv(), stdio: 'ignore' });
  waitFor(portFile);
  return { proc, cap, port: readFileSync(portFile, 'utf8').trim() };
}
function startBroker(sock, args, env = {}) {
  const proc = spawn(process.execPath, [RELAY, 'broker', sock, ...args], { env: childEnv(env), stdio: 'ignore' });
  waitFor(sock);
  return proc;
}
function client(sock, method, p, headers = {}, body = '') {
  const r = spawnSync(process.execPath, [CLIENT, sock, method, p, body, JSON.stringify(headers)], {
    env: childEnv(), encoding: 'utf8', timeout: 15000,
  });
  assert.equal(r.status, 0, `client failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const captured = (cap) => existsSync(cap)
  ? readFileSync(cap, 'utf8').trim().split('\n').map(JSON.parse) : [];

const procs = [];
const keep = (p) => (procs.push(p), p);

test('broker injects the host key over every sandbox-supplied credential carrier', () => {
  const up = keep(startUpstream());
  const sock = path.join(work, 'b1.sock');
  keep(startBroker(sock, ['--upstream', `http://127.0.0.1:${up.port}`,
    '--key-source', 'env:FLOCK_BROKER_KEY'], { FLOCK_BROKER_KEY: 'real-key-123' }));
  const res = client(sock, 'POST', '/api/anthropic/v1/messages', {
    authorization: 'Bearer dummy-sandbox-key', 'x-api-key': 'dummy-sandbox-key',
    cookie: 'session=steal-me', 'proxy-authorization': 'Basic x',
    'x-bigmodel-authorization': 'dummy', 'x-auth-token': 'dummy', 'x-forwarded-for': '1.2.3.4',
    connection: 'x-api-key, keep-alive', 'keep-alive': 'timeout=5', te: 'trailers',
    'transfer-encoding': 'chunked', upgrade: 'websocket', expect: '100-continue',
    'anthropic-version': '2023-06-01', 'x-stainless-lang': 'js',
    'content-type': 'application/json',
  }, '{"model":"glm-5.3"}');
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(res.body, `upstream-ok:${'{"model":"glm-5.3"}'.length}`, 'response body must stream back intact');
  const recs = captured(up.cap);
  assert.equal(recs.length, 1, 'upstream saw exactly one request');
  const h = recs[0].headers;
  assert.equal(h.authorization, 'Bearer real-key-123', 'authorization must be the HOST key');
  assert.equal(h['x-api-key'], 'real-key-123', 'x-api-key must be the HOST key');
  for (const k of ['cookie', 'proxy-authorization', 'x-bigmodel-authorization', 'x-auth-token',
    'keep-alive', 'te', 'trailer', 'upgrade', 'expect', 'x-forwarded-for']) {
    assert.ok(!(k in h), `${k} must not reach upstream, got ${h[k]}`);
  }
  // Node's agent adds its own connection value; what must not survive is the
  // sandbox's nomination (`connection: x-api-key` would strip the injected
  // credential at a spec-compliant upstream).
  assert.ok(!String(h.connection ?? '').includes('x-api-key'),
    `connection must not nominate a credential header, got ${h.connection}`);
  assert.ok(!JSON.stringify(h).includes('dummy-sandbox-key'), 'sandbox dummy key must never reach upstream');
  assert.equal(h['anthropic-version'], '2023-06-01', 'anthropic-* headers pass through');
  assert.equal(h['x-stainless-lang'], 'js', 'x-stainless-* headers pass through');
  assert.equal(recs[0].body, '{"model":"glm-5.3"}', 'request body streams through intact');
  // The upstream's own credential material must not flow back into the sandbox.
  assert.ok(!('set-cookie' in (res.headers ?? {})), 'set-cookie must be dropped from the response');
});

test('path outside --path-prefix is refused before touching upstream', () => {
  const up = keep(startUpstream());
  const sock = path.join(work, 'b2.sock');
  keep(startBroker(sock, ['--upstream', `http://127.0.0.1:${up.port}`, '--path-prefix', '/api/anthropic',
    '--key-source', 'env:FLOCK_BROKER_KEY'], { FLOCK_BROKER_KEY: 'k' }));
  const res = client(sock, 'GET', '/admin/keys', { authorization: 'Bearer d' });
  assert.equal(res.status, 403, JSON.stringify(res));
  assert.equal(captured(up.cap).length, 0, 'refused request must never reach upstream');
});

test('missing key source fails closed with no key material in the error', () => {
  const up = keep(startUpstream());
  const sock = path.join(work, 'b3.sock');
  const env = childEnv();
  delete env.FLOCK_BROKER_ABSENT;
  keep(spawn(process.execPath, [RELAY, 'broker', sock, '--upstream', `http://127.0.0.1:${up.port}`,
    '--key-source', 'env:FLOCK_BROKER_ABSENT'], { env, stdio: 'ignore' }));
  waitFor(sock);
  const res = client(sock, 'POST', '/api/anthropic/v1/messages', {}, 'x');
  assert.equal(res.status, 502, JSON.stringify(res));
  assert.equal(captured(up.cap).length, 0, 'unauthenticated request must never reach upstream');
  assert.ok(!String(res.body).includes('FLOCK_BROKER_ABSENT') && !/real-key/.test(String(res.body)),
    'error body must not carry key material or source detail');
});

test('--key-source file:<path> reads the host-side key file', () => {
  const keyFile = path.join(work, 'broker.key');
  writeFileSync(keyFile, 'file-key-456\n', { mode: 0o600 });
  const up = keep(startUpstream());
  const sock = path.join(work, 'b4.sock');
  keep(startBroker(sock, ['--upstream', `http://127.0.0.1:${up.port}`, '--key-source', `file:${keyFile}`]));
  const res = client(sock, 'POST', '/api/anthropic/v1/messages', {}, 'y');
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(captured(up.cap)[0].headers.authorization, 'Bearer file-key-456');
});

test('non-https upstream is refused unless the host is loopback', () => {
  const sock = path.join(work, 'b5.sock');
  const bad = spawnSync(process.execPath, [RELAY, 'broker', sock,
    '--upstream', 'http://169.254.1.1', '--key-source', 'env:FLOCK_BROKER_KEY'],
    { env: childEnv({ FLOCK_BROKER_KEY: 'k' }), encoding: 'utf8', timeout: 10000 });
  assert.notEqual(bad.status, 0, 'http upstream off-loopback must refuse');
  assert.ok(!existsSync(sock), 'refused broker must not leave a socket');
});

test('confinement holds on the normalized path — traversal and sibling-prefix escapes refused', () => {
  const up = keep(startUpstream());
  const sock = path.join(work, 'b7.sock');
  keep(startBroker(sock, ['--upstream', `http://127.0.0.1:${up.port}`, '--path-prefix', '/api/anthropic',
    '--key-source', 'env:FLOCK_BROKER_KEY'], { FLOCK_BROKER_KEY: 'k' }));
  // Each probe must be refused BEFORE upstream (403/400). status 0 means the
  // client itself refused the target — also acceptable, never a pass-through.
  for (const p of ['/api/anthropic/../admin', '/api/anthropic/%2e%2e/admin', '/api/anthropic/.%2e/x',
    '/api/anthropic-evil/keys', '/api/anthropic%2f..%2fadmin', '/api/anthropic/v1/messages%00/x',
    // %25 = encoded percent: a double-decoding upstream would resolve
    // %252e%252e to '..' AFTER our normalized-path check — refused outright.
    '/api/anthropic/%252e%252e/admin', '/api/anthropic%252f..%252fpaas']) {
    const res = client(sock, 'GET', p, {});
    assert.ok(res.status === 403 || res.status === 400 || res.status === 0,
      `${p} must be refused, got ${res.status}`);
  }
  assert.equal(captured(up.cap).length, 0, 'no escape probe may reach upstream');
  // The legitimate in-prefix path still passes, forwarded in normalized form.
  const ok = client(sock, 'GET', '/api/anthropic/v1/models', {});
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.equal(captured(up.cap)[0].url, '/api/anthropic/v1/models');
});

test('credential-looking query params are refused before upstream', () => {
  const up = keep(startUpstream());
  const sock = path.join(work, 'b8.sock');
  keep(startBroker(sock, ['--upstream', `http://127.0.0.1:${up.port}`,
    '--key-source', 'env:FLOCK_BROKER_KEY'], { FLOCK_BROKER_KEY: 'k' }));
  for (const p of ['/api/anthropic/v1/messages?api_key=dummy', '/api/x?access_token=d',
    '/api/x?foo=1&key=d', '/api/x?api-key=d', '/api/x?auth_token=d', '/api/x?client_secret=d']) {
    assert.equal(client(sock, 'POST', p, {}, 'x').status, 403, p);
  }
  assert.equal(captured(up.cap).length, 0);
  // A benign query rides through untouched.
  assert.equal(client(sock, 'GET', '/api/v1/models?beta=true', {}).status, 200);
  assert.equal(captured(up.cap)[0].url, '/api/v1/models?beta=true');
});

test('the broker socket is user-only — it is credential-equivalent', () => {
  const up = keep(startUpstream());
  const sock = path.join(work, 'b9.sock');
  keep(startBroker(sock, ['--upstream', `http://127.0.0.1:${up.port}`,
    '--key-source', 'env:FLOCK_BROKER_KEY'], { FLOCK_BROKER_KEY: 'k' }));
  assert.equal(statSync(sock).mode & 0o777, 0o600, 'socket must be 0600');
});

test('valueless flags exit 2 with a clean error, no socket left', () => {
  for (const extra of [['--upstream'], ['--path-prefix'], ['--key-source', 'bogus-source']]) {
    const sock = path.join(work, `b10-${extra.length}-${Math.random().toString(36).slice(2)}.sock`);
    const r = spawnSync(process.execPath, [RELAY, 'broker', sock, ...extra],
      { env: childEnv({ FLOCK_BROKER_KEY: 'k' }), encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 2, `${extra}: got ${r.status} ${r.stderr.slice(0, 120)}`);
    assert.ok(!existsSync(sock), 'refused broker must not leave a socket');
  }
});

test('repeatable --path-prefix admits both anthropic and signing surfaces only', () => {
  const up = keep(startUpstream());
  const sock = path.join(work, 'b11.sock');
  keep(startBroker(sock, ['--upstream', `http://127.0.0.1:${up.port}`,
    '--path-prefix', '/api/anthropic', '--path-prefix', '/api/paas/c1f3a7e2/v2/client',
    '--key-source', 'env:FLOCK_BROKER_KEY'], { FLOCK_BROKER_KEY: 'k' }));
  // Both listed surfaces pass…
  assert.equal(client(sock, 'POST', '/api/anthropic/v1/messages', {}, 'x').status, 200);
  assert.equal(client(sock, 'POST', '/api/paas/c1f3a7e2/v2/client', {}, 'x').status, 200);
  assert.equal(client(sock, 'POST', '/api/paas/c1f3a7e2/v2/client/sub', {}, 'x').status, 200);
  assert.equal(captured(up.cap).length, 3, 'in-prefix requests must all reach upstream');
  // …everything else under /api/ is still refused — sibling paas paths included.
  for (const p of ['/api/paas/c1f3a7e2/v2/other', '/api/paas', '/api/keys', '/api/anthropic-evil',
    '/v1/chat/completions', '/api/anthropic%2f..%2fpaas']) {
    const res = client(sock, 'POST', p, {}, 'x');
    assert.ok(res.status === 403 || res.status === 400 || res.status === 0, `${p} must be refused, got ${res.status}`);
  }
  assert.equal(captured(up.cap).length, 3, 'no refused request may reach upstream');
});

test('kernel client-signing headers pass; sandbox x-client is still overwritten by --client-name', () => {
  const up = keep(startUpstream());
  const sock = path.join(work, 'b12.sock');
  keep(startBroker(sock, ['--upstream', `http://127.0.0.1:${up.port}`, '--client-name', 'flock-test',
    '--key-source', 'env:FLOCK_BROKER_KEY'], { FLOCK_BROKER_KEY: 'k' }));
  const res = client(sock, 'POST', '/api/anthropic/v1/messages', {
    'x-app-id': 'zcode', 'x-session-id': 'sess-1',
    'x-client-sig': 'sig', 'x-client-ts': '1', 'x-client-nonce': 'n', 'x-client-pow': 'p',
    'x-zcode-device': 'dev', 'anthropic-beta': 'tools-1', 'x-client': 'sandbox-spoof',
    'content-type': 'application/json',
  }, '{}');
  assert.equal(res.status, 200, JSON.stringify(res));
  const h = captured(up.cap)[0].headers;
  for (const k of ['x-app-id', 'x-session-id', 'x-client-sig', 'x-client-ts',
    'x-client-nonce', 'x-client-pow', 'x-zcode-device', 'anthropic-beta']) {
    assert.ok(k in h, `signing header ${k} must reach upstream`);
  }
  assert.equal(h['x-client'], 'flock-test', 'sandbox x-client must be overwritten by --client-name');
});

const haveOpenssl = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;

test('the TLS twin listener terminates https and forwards through the same confinement', () => {
  if (!haveOpenssl) { console.log('  skip: openssl unavailable — TLS leg untestable here'); return; }
  const cert = path.join(work, 't-cert.pem'), key = path.join(work, 't-key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const up = keep(startUpstream());
  const sock = path.join(work, 'b13.sock'), tlsSock = path.join(work, 'b13-tls.sock');
  keep(startBroker(sock, ['--upstream', `http://127.0.0.1:${up.port}`,
    '--path-prefix', '/api/anthropic',
    '--key-source', 'env:FLOCK_BROKER_KEY',
    '--tls-sock', tlsSock, '--tls-cert', cert, '--tls-key', key], { FLOCK_BROKER_KEY: 'tls-key-9' }));
  waitFor(tlsSock);
  assert.equal(statSync(tlsSock).mode & 0o777, 0o600, 'TLS socket must be 0600 too');
  // A TLS client over the unix socket — self-signed, so rejectUnauthorized:0.
  const TLSCLIENT = path.join(work, 'tls-client.mjs');
  writeFileSync(TLSCLIENT, `import https from 'node:https';
const [sock, p] = process.argv.slice(2);
const req = https.request({ socketPath: sock, method: 'POST', path: p, rejectUnauthorized: false }, (res) => {
  let b = ''; res.on('data', (c) => b += c); res.on('end', () => console.log(JSON.stringify({ status: res.statusCode, body: b })));
});
req.on('error', (e) => console.log(JSON.stringify({ status: 0, error: String(e) })));
req.end('x');
`);
  const run = (p) => JSON.parse(spawnSync(process.execPath, [TLSCLIENT, tlsSock, p],
    { env: childEnv(), encoding: 'utf8', timeout: 15000 }).stdout);
  assert.equal(run('/api/anthropic/v1/messages').status, 200, 'in-prefix TLS request must forward');
  assert.equal(captured(up.cap)[0].headers.authorization, 'Bearer tls-key-9', 'TLS leg must inject the host key');
  assert.equal(run('/api/paas/anything').status, 403, 'TLS leg enforces the same prefix confinement');
});

test('TLS args validate: missing material, unreadable files, or tlsSock===sockPath exit 2', () => {
  const up = keep(startUpstream());
  for (const extra of [
    ['--tls-sock', path.join(work, 'x1.sock')], // missing --tls-cert/--tls-key
    ['--tls-sock', path.join(work, 'x2.sock'), '--tls-cert', path.join(work, 'nope.pem'), '--tls-key', path.join(work, 'nope2.pem')],
  ]) {
    const sock = path.join(work, `b14-${Math.random().toString(36).slice(2)}.sock`);
    const r = spawnSync(process.execPath, [RELAY, 'broker', sock, '--upstream', `http://127.0.0.1:${up.port}`,
      '--key-source', 'env:FLOCK_BROKER_KEY', ...extra],
      { env: childEnv({ FLOCK_BROKER_KEY: 'k' }), encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 2, `${extra.join(' ')}: got ${r.status} ${r.stderr.slice(0, 120)}`);
    assert.ok(!existsSync(sock), 'refused broker must not leave a socket');
  }
  // tlsSock === sockPath would unlink+rebind the live plain socket — refused.
  const same = path.join(work, 'b15-same.sock');
  const r = spawnSync(process.execPath, [RELAY, 'broker', same, '--upstream', `http://127.0.0.1:${up.port}`,
    '--key-source', 'env:FLOCK_BROKER_KEY', '--tls-sock', same, '--tls-cert', 'x', '--tls-key', 'y'],
    { env: childEnv({ FLOCK_BROKER_KEY: 'k' }), encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 2, `tlsSock===sockPath: got ${r.status} ${r.stderr.slice(0, 120)}`);
  assert.ok(!existsSync(same), 'refused broker must not leave a socket');
});

test('a socket path past the platform AF_UNIX cap is refused with the reason', () => {
  // Past sun_path's platform budget (108 bytes on Linux, 104 on Darwin/BSD)
  // the bind fails opaquely (or listen() never settles at all), so a caller
  // learns nothing but a readiness timeout. The broker must name THIS host's
  // cap and exit 2 before touching the filesystem.
  const long = path.join(work, `${'x'.repeat(sunPathBudget())}.sock`);
  assert.ok(Buffer.byteLength(long) > sunPathBudget(), 'fixture must actually exceed the cap');
  const r = spawnSync(process.execPath, [RELAY, 'broker', long, '--upstream', 'http://127.0.0.1:9',
    '--key-source', 'env:FLOCK_BROKER_KEY'],
    { env: childEnv({ FLOCK_BROKER_KEY: 'k' }), encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 2, `got ${r.status}: ${(r.stderr || r.error?.message || '').slice(0, 160)}`);
  assert.match(r.stderr, new RegExp(`AF_UNIX paths are capped at ${sunPathBudget()}`), 'the refusal must name the cap');
  assert.ok(!existsSync(long), 'refused broker must not leave a socket');
  // The TLS twin is refused by the same cap, not silently degraded.
  const short = path.join(work, 'tls-ok.sock');
  const tls = spawnSync(process.execPath, [RELAY, 'broker', short, '--upstream', 'http://127.0.0.1:9',
    '--key-source', 'env:FLOCK_BROKER_KEY', '--tls-sock', long, '--tls-cert', 'x', '--tls-key', 'y'],
    { env: childEnv({ FLOCK_BROKER_KEY: 'k' }), encoding: 'utf8', timeout: 10_000 });
  assert.equal(tls.status, 2, `tls twin: got ${tls.status}: ${(tls.stderr || '').slice(0, 160)}`);
  assert.match(tls.stderr, new RegExp(`AF_UNIX paths are capped at ${sunPathBudget()}`));
});

test('the sun_path budget is platform-sized: 104 on Darwin/BSD, 108 on Linux', () => {
  // sun-path.mjs answers for the swarm's socket planning; a hardcoded 108
  // would wave a 105-byte path through on a 104-byte host. Platforms are
  // injected so both budgets are exercised on every host.
  const caps = new Map([['darwin', 104], ['freebsd', 104], ['openbsd', 104],
    ['netbsd', 104], ['linux', 108], ['sunos', 108]]);
  for (const [plat, cap] of caps) {
    assert.equal(sunPathBudget(plat), cap, `${plat} must budget ${cap} bytes`);
  }
  assert.equal(sunPathBudget(), caps.get(process.platform) ?? 108,
    'the host default must follow the host platform');
  // Boundary at both caps: exactly-budget bytes fit; one byte past does not.
  for (const plat of ['darwin', 'linux']) {
    const cap = sunPathBudget(plat);
    assert.ok(fitsSunPath('a'.repeat(cap), plat), `${plat}: a ${cap}-byte path must fit`);
    assert.ok(!fitsSunPath('a'.repeat(cap + 1), plat), `${plat}: a ${cap + 1}-byte path must not fit`);
  }
});

test('non-GET/POST/HEAD methods are refused', () => {
  const up = keep(startUpstream());
  const sock = path.join(work, 'b6.sock');
  keep(startBroker(sock, ['--upstream', `http://127.0.0.1:${up.port}`,
    '--key-source', 'env:FLOCK_BROKER_KEY'], { FLOCK_BROKER_KEY: 'k' }));
  const res = client(sock, 'DELETE', '/api/anthropic/v1/messages', {}, 'z');
  assert.equal(res.status, 405, JSON.stringify(res));
  assert.equal(captured(up.cap).length, 0);
});

let failed = 0;
try {
  for (const [name, f] of tests) {
    try { f(); console.log(`ok ${name}`); }
    catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
  }
} finally {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  rmSync(work, { recursive: true, force: true });
}
console.log(failed ? `${failed} failure(s)` : 'all broker oracles passed');
process.exit(failed ? 1 : 0);
