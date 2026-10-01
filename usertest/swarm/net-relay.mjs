#!/usr/bin/env node
// net-relay — the outbound-only bridge for the flock's private netns.
//
// The wall is bwrap --unshare-net (no host loopback, no abstract sockets, no
// X11 — they all live in the netns). The model API still needs egress, so:
//
//   [wall: 127.0.0.1:3128]  ← HTTPS_PROXY — client speaks HTTP CONNECT
//        ↕ (raw bytes, private netns loopback)
//   [unix socket bound INTO the wall]  ← filesystem socket: crosses netns
//        ↕
//   [host relay]  parses CONNECT, opens the target, pipes both ways
//
// Egress policy: CONNECT is only honored for port 443, and (with
// --allowlist) only for listed host suffixes — the agent's whole network
// world is the model API. DNS never runs inside the wall (the CONNECT
// hostname carries it out).
//
//   node net-relay.mjs host  /tmp/relay.sock [--allowlist opencode.ai]
//   node net-relay.mjs inner 3128 /tmp/relay.sock   # runs INSIDE the netns
//   node net-relay.mjs broker /tmp/broker.sock --key-source zai  # host-side
//     auth-injecting proxy for signed-in flock turns (FLOCK-V2-SIGNIN)
import * as fs from 'node:fs';
import * as path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

const mode = process.argv[2];          // 'host' | 'inner'
// host/reverse/broker: argv[3]=sockPath, rest=options | inner: argv[3]=port argv[4]=sockPath
const sockPath = mode === 'inner' ? process.argv[4] : process.argv[3];
const rest = process.argv.slice(mode === 'inner' ? 5 : 4);
const port = mode === 'inner' ? parseInt(process.argv[3], 10) : NaN;

// AF_UNIX sun_path is 108 bytes (a full 108-byte path binds; 109 does not).
// Past it the bind fails opaquely — or worse, listen() sits silent forever —
// and the caller's readiness wait is the only symptom. Refuse up front with
// the reason, for the plain socket and the TLS twin alike.
const tlsIdx = rest.indexOf('--tls-sock');
for (const s of [sockPath, tlsIdx >= 0 ? rest[tlsIdx + 1] : null]) {
  if (s && Buffer.byteLength(s) > 108) {
    console.error(`[net-relay] socket path is ${Buffer.byteLength(s)} bytes; AF_UNIX paths are capped at 108: ${s}`);
    process.exit(2);
  }
}

if (mode === 'host') {
  // '--allowlist ""' parses to [] — deny EVERYTHING (fail closed), not any-host.
  const allow = rest[0] === '--allowlist' ? String(rest[1] ?? '').split(',').map((x) => x.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean) : null;
  try { fs.unlinkSync(sockPath); } catch {}
  const server = net.createServer((inner) => {
    // One connection = one CONNECT tunnel. Parse the request head, then pipe.
    let head = Buffer.alloc(0);
    const dial = (host, port) => {
      if (port !== 443) { inner.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      if (allow && !allow.some((suf) => host === suf || host.endsWith('.' + suf))) {
        inner.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
      }
      const out = net.connect({ host, port }, () => inner.write('HTTP/1.1 200 Connection Established\r\n\r\n'));
      inner.pipe(out); out.pipe(inner);
      const kill = () => { inner.destroy(); out.destroy(); };
      inner.on('error', kill); out.on('error', kill); inner.on('close', kill); out.on('close', kill);
    };
    inner.on('data', function onData(chunk) {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) { if (head.length > 8192) inner.destroy(); return; } // bounded CONNECT head
      inner.off('data', onData);
      const first = head.slice(0, end).toString('latin1');
      const m = /^CONNECT (\[[^\]]+\]|[^:]+):(\d+) HTTP\/1\.[01]/i.exec(first);
      if (!m) { inner.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n'); return; }
      const host = m[1].replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, ''); // strip trailing FQDN dot
      const port = parseInt(m[2], 10);
      const restBuf = head.slice(end + 4); // early payload bytes (e.g. TLS hello)
      dial(host, port);
      if (restBuf.length) inner.unshift(restBuf); // replay what followed the head
    });
  });
  const dir = path.dirname(sockPath);
  fs.mkdirSync(dir, { recursive: true });
  server.listen(sockPath, () => console.log(`[net-relay] host listening on ${sockPath} allow=${allow ?? 'any-host'} port=443-only`));
  process.on('SIGINT', () => { try { fs.unlinkSync(sockPath); } catch {} process.exit(0); });
  process.on('SIGTERM', () => { try { fs.unlinkSync(sockPath); } catch {} process.exit(0); });
} else if (mode === 'inner') {
  const listenPort = port;
  // Plain byte pipe: private-loopback TCP ⇄ the bound-in unix socket. The
  // HTTP CONNECT protocol is spoken end-to-end by the client and host relay.
  const server = net.createServer((client) => {
    const up = net.connect(sockPath);
    client.pipe(up); up.pipe(client);
    const kill = () => { client.destroy(); up.destroy(); };
    client.on('error', kill); up.on('error', kill);
  });
  server.listen(listenPort, '127.0.0.1', () => console.log(`[net-relay] inner piping 127.0.0.1:${listenPort} -> ${sockPath}`));
} else if (mode === 'reverse') {
  // HTTP reverse proxy ON the unix socket: the sandboxed opencode points its
  // gateway baseURL at http://127.0.0.1:<port> (plain fetch — no CONNECT, no
  // proxy env, no CONNECT race). Requests stream through to
  // https://<allowlisted-host> with headers preserved (the muse token rides
  // Authorization as before). Upstream is fixed per --upstream (default
  // opencode.ai); nothing else is reachable.
  const upstream = rest[0] === '--upstream' && rest[1] ? rest[1] : 'opencode.ai';
  try { fs.unlinkSync(sockPath); } catch {}
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: upstream };
    delete headers['accept-encoding']; // we stream raw; avoid compressed passthrough surprises
    const up = https.request({ host: upstream, port: 443, method: req.method, path: req.url, headers }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => { try { res.writeHead(502); res.end('relay: upstream unreachable'); } catch {} });
    req.pipe(up);
  });
  server.listen(sockPath, () => console.log(`[net-relay] reverse ${sockPath} -> https://${upstream} (allowlist by construction)`));
  process.on('SIGINT', () => { try { fs.unlinkSync(sockPath); } catch {} process.exit(0); });
  process.on('SIGTERM', () => { try { fs.unlinkSync(sockPath); } catch {} process.exit(0); });
} else if (mode === 'broker') {
  // FLOCK-V2-SIGNIN key broker: a host-side reverse proxy that INJECTS the real
  // credential. The sandboxed zagent is seeded with a provider whose baseURL is
  // http://127.0.0.1:<port> (piped here by `inner` mode) carrying a dummy
  // apiKey; every forwarded request gets its auth headers overwritten with the
  // host-resolved key. The key never enters the sandbox — not its env, args,
  // store, or logs — which is what lets a free-model worker drive signed-in
  // turns without ever being able to read the credential.
  //
  //   node net-relay.mjs broker <sockPath> [--upstream https://api.z.ai]
  //     [--path-prefix /api/] [--key-source zai|env:VAR|file:<path>]
  //
  // --upstream must be https; http is accepted for loopback hosts only (the
  // offline test's fake upstream). --key-source `zai` lazily resolves the host
  // coding-plan key via the driver's own resolver — nothing is copied into a
  // file or flag. Key resolution runs per request so rotation is picked up.
  //
  // Accepted residual (reviewed): the client-signing handshake prefix
  // (/api/paas/…/v2/client, the kernel's `get_sign_key` action) returns
  // session-scoped signing material which IS piped back to the sandbox —
  // a signed-in session necessarily holds that material in-process anyway,
  // and it is useless without the account credential, which stays host-side.
  // What must never cross is the account key itself: it is injected only into
  // upstream-bound headers after the sandbox's own copies are stripped.
  const opt = (name, dflt) => {
    const i = rest.indexOf(name);
    if (i === -1) return dflt;
    if (rest[i + 1] === undefined || String(rest[i + 1]).startsWith('--')) {
      console.error(`[net-relay] broker: ${name} needs a value`); process.exit(2);
    }
    return rest[i + 1];
  };
  let upstream;
  try { upstream = new URL(opt('--upstream', 'https://api.z.ai')); }
  catch { console.error('[net-relay] broker: --upstream must be a URL'); process.exit(2); }
  // --path-prefix is repeatable: the anthropic business surface AND the
  // client-signing handshake (/api/paas/…) are both legitimate for a signed-in
  // TUI turn; each listed prefix is confinement-checked the same way.
  const prefixes = rest.flatMap((a, i) => a === '--path-prefix' ? [String(rest[i + 1] ?? '')] : []);
  if (!prefixes.length) prefixes.push('/api/');
  if (prefixes.some((p) => !p.startsWith('/') || p === '/')) {
    console.error('[net-relay] broker: every --path-prefix must start with / and be narrower than /'); process.exit(2);
  }
  const keySource = opt('--key-source', 'zai');
  // --client-name injects an x-client attribution header host-side — the
  // header is NOT in ALLOW_HEADER, so a sandbox can neither set nor spoof it.
  const clientName = opt('--client-name', '');
  const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (upstream.protocol !== 'https:' && !(upstream.protocol === 'http:' && LOOPBACK.has(upstream.hostname))) {
    console.error(`[net-relay] broker: --upstream must be https (http is loopback-test-only), got ${upstream}`);
    process.exit(2);
  }
  if (keySource !== 'zai' && !keySource.startsWith('env:') && !keySource.startsWith('file:')) {
    console.error('[net-relay] broker: unknown --key-source (want zai|env:VAR|file:<path>)'); process.exit(2);
  }
  if ((keySource.startsWith('env:') || keySource.startsWith('file:')) && keySource.split(':')[1] === '') {
    console.error('[net-relay] broker: --key-source needs a non-empty operand'); process.exit(2);
  }
  let quotaMod = null;
  const resolveKey = async () => {
    if (keySource.startsWith('env:')) {
      const k = process.env[keySource.slice(4)];
      if (typeof k !== 'string' || k.trim() === '') throw new Error('key source empty');
      return k.trim();
    }
    if (keySource.startsWith('file:')) {
      const k = fs.readFileSync(keySource.slice(5), 'utf8').trim();
      if (!k) throw new Error('key file empty');
      return k;
    }
    if (keySource === 'zai') {
      quotaMod ??= await import('../../packages/driver/quota.mjs');
      const r = quotaMod.resolveCodingPlanKey();
      if (typeof r?.key !== 'string' || r.key === '') throw new Error('no host coding-plan key');
      return r.key;
    }
    throw new Error('unknown --key-source (want zai|env:VAR|file:<path>)');
  };
  // Header posture is an ALLOWLIST — the anthropic-messages request shape is
  // fixed (SDK x-stainless-* + anthropic-* + content headers), so anything
  // else the sandbox sends is dropped by construction. That closes the whole
  // denylist class at once: credential carriers, cookies, hop-by-hop headers
  // (and anything `Connection:` would nominate), IP-spoofing x-forwarded-*.
  const ALLOW_HEADER = (h) =>
    h === 'content-type' || h === 'accept' ||
    h === 'accept-language' || h === 'user-agent' ||
    h === 'content-length' || // upstream routers may refuse chunked bodies (found by execution)
    // Kernel client-signing material (x-client-sig/ts/nonce/pow, x-session-id,
    // x-app-id, x-zcode-*): signed turns carry these; they are derived from the
    // sandbox's placeholder key, never the injected one.
    h === 'x-app-id' || h === 'x-session-id' ||
    h.startsWith('x-client-') || h.startsWith('x-zcode-') ||
    h.startsWith('anthropic-') || h.startsWith('x-stainless-');
  // Credential-looking query params are refused outright — a sandbox token in
  // the URL must never ride to upstream on a request carrying the host key.
  const QUERY_CRED = /^(key|api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|session[-_]?id|token|secret|passwd|password|sig|signature|auth|credential|jwt|x[-_]?token)$/i;
  const METHODS = new Set(['GET', 'POST', 'HEAD']);
  try { fs.unlinkSync(sockPath); } catch {}
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
  const inPrefix = (pathname) => prefixes.some((p) =>
    pathname === p || pathname.startsWith(p.endsWith('/') ? p : p + '/'));
  const handler = (req, res) => {
    const fail = (code, msg) => { try { res.writeHead(code); res.end(msg); } catch {} };
    if (!METHODS.has(req.method)) return fail(405, 'broker: method not allowed');
    // Confinement runs on the NORMALIZED pathname: upstream stacks decode
    // %2e and collapse dot-segments, so a raw startsWith is bypassable
    // (/api/../admin, /api/%2e%2e/..., sibling-prefix /api/anthropic-evil).
    if (typeof req.url !== 'string' || !req.url.startsWith('/')) return fail(400, 'broker: bad request target');
    let target;
    try { target = new URL(req.url, 'http://broker.local'); }
    catch { return fail(400, 'broker: bad request target'); }
    if (!inPrefix(target.pathname)) {
      return fail(403, 'broker: path outside --path-prefix');
    }
    // %2f/%5c survive WHATWG normalization but some upstream stacks decode
    // them into separators — refuse rather than forward a path we didn't
    // check. %25 (encoded percent) is refused too: an upstream that decodes
    // percent-encoding twice would resolve %252e%252e to .. AFTER our check.
    if (/%2f|%5c|%00|%25|\\/i.test(req.url)) return fail(403, 'broker: encoded separator refused');
    for (const k of target.searchParams.keys()) {
      if (QUERY_CRED.test(k)) return fail(403, 'broker: credential-looking query param refused');
    }
    resolveKey().then((key) => {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (ALLOW_HEADER(k)) headers[k] = v;
      headers.host = upstream.host;
      headers.authorization = `Bearer ${key}`;
      headers['x-api-key'] = key;
      if (clientName) headers['x-client'] = clientName;
      const lib = upstream.protocol === 'https:' ? https : http;
      const up = lib.request({
        host: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        method: req.method,
        // Forward the normalized target — the checked form IS the sent form.
        path: upstream.pathname.replace(/\/$/, '') + target.pathname + target.search,
        headers,
        // No keep-alive pooling: the sandbox controls content-length while
        // req.pipe streams the true body — a mismatch on a reused upstream
        // connection could splice a second, unchecked request past confinement.
        agent: false,
      }, (ur) => {
        // Credential material must not flow BACK into the sandbox either;
        // upstream hop-by-hop headers are likewise the broker's business.
        const rh = { ...ur.headers };
        for (const h of ['set-cookie', 'set-cookie2', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']) delete rh[h];
        res.writeHead(ur.statusCode, rh);
        ur.pipe(res);
        ur.on('error', () => { try { res.destroy(); } catch {} });
      });
      up.setTimeout(300_000, () => { up.destroy(); try { res.destroy(); } catch {} });
      up.on('error', () => fail(502, 'broker: upstream unreachable'));
      req.on('aborted', () => up.destroy());
      req.on('error', () => up.destroy());
      req.pipe(up);
    }).catch(() => fail(502, 'broker: credential unavailable'));
  };
  const server = http.createServer(handler);
  server.on('clientError', (err, sock) => { try { sock.destroy(); } catch {} });
  // Optional TLS twin: --tls-sock/--tls-cert/--tls-key run the SAME handler on
  // a second socket terminated with the given cert. The kernel's
  // client-signing handshake refuses plain http, so signed-in TUI turns ride
  // this listener while the plain socket keeps serving -p turns.
  const tlsSock = opt('--tls-sock', '');
  let tlsServer = null;
  if (tlsSock) {
    if (tlsSock === sockPath) { console.error('[net-relay] broker: --tls-sock must differ from the plain socket'); process.exit(2); }
    const certFile = opt('--tls-cert', ''), keyFile = opt('--tls-key', '');
    if (!certFile || !keyFile) { console.error('[net-relay] broker: --tls-sock needs --tls-cert and --tls-key'); process.exit(2); }
    fs.mkdirSync(path.dirname(tlsSock), { recursive: true, mode: 0o700 });
    let tlsOpts;
    try { tlsOpts = { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }; }
    catch (e) { console.error(`[net-relay] broker: tls material unreadable: ${e.message}`); process.exit(2); }
    tlsServer = https.createServer(tlsOpts, handler);
    tlsServer.on('clientError', (err, sock) => { try { sock.destroy(); } catch {} });
    tlsServer.on('tlsClientError', (err, sock) => { try { sock.destroy(); } catch {} });
    // A listen/stack error on the twin must not take the plain leg down with
    // it — degrade TLS-only and log; the flock's tlsSock readiness check then
    // honestly reports the leg missing instead of crash-looping the broker.
    // Restore the umask (the error path otherwise leaves it narrowed for the
    // broker's whole life) and drop any stale socket file so existsSync
    // liveness gates downstream can't pass on a dead leg.
    tlsServer.on('error', (e) => {
      console.error(`[net-relay] broker tls listener failed: ${e.message}`);
      try { process.umask(oldUmask); } catch {}
      try { tlsServer.close(); } catch {}
      try { fs.unlinkSync(tlsSock); } catch {}
    });
  }
  // umask during listen closes the create-before-chmod window on the socket —
  // it is credential-equivalent, so it must never be world-connectable.
  const socks = [sockPath, ...(tlsSock ? [tlsSock] : [])];
  const oldUmask = process.umask(0o177);
  server.listen(sockPath, () => {
    try { fs.chmodSync(sockPath, 0o600); } catch {}
    if (tlsServer) {
      try { fs.unlinkSync(tlsSock); } catch {}
      tlsServer.listen(tlsSock, () => { process.umask(oldUmask); try { fs.chmodSync(tlsSock, 0o600); } catch {} });
    } else process.umask(oldUmask);
    console.log(
      `[net-relay] broker ${sockPath}${tlsSock ? ` +tls:${tlsSock}` : ''} -> ${upstream.origin} prefix=${prefixes.join(',')} key-source=${keySource.startsWith('env:') || keySource.startsWith('file:') ? keySource.split(':')[0] : keySource} (auth injected host-side)`);
  });
  const cleanup = () => { for (const s of socks) { try { fs.unlinkSync(s); } catch {} } };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
} else {
  console.error('usage: node net-relay.mjs host <sockPath> [--allowlist a.com,b.com] | reverse <sockPath> [--upstream host] | broker <sockPath> [--upstream url] [--path-prefix p]... [--key-source zai|env:VAR|file:path] [--tls-sock <path> --tls-cert <pem> --tls-key <pem>] | inner <port> <sockPath>');
  process.exit(2);
}
