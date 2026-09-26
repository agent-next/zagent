// zagent feishu webhook guard: the 1MB request cap counts BYTES, not UTF-16
// chars — a payload of multibyte chars that slips under buf.length must still
// be destroyed. Server and probe both spawn as clean grandchildren because the
// offline harness blocks in-process socket connects.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') { console.log('SKIP zagent-feishu webhook (POSIX test)'); process.exit(0); }

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = path.join(root, 'packages/cli/zagent-feishu.mjs');
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zfeishu-'));
mkdirSync(path.join(sandbox, 'tmp'));

// Grab a free loopback port, then release it for the child server.
const port = await new Promise(res => {
  const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const env = Object.assign(
  Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
  { HOME: sandbox, USERPROFILE: sandbox, TMPDIR: path.join(sandbox, 'tmp'), TMP: path.join(sandbox, 'tmp'),
    TEMP: path.join(sandbox, 'tmp'), ZAGENT_TEST_SANDBOX: sandbox, NODE_OPTIONS: '',
    ZAGENT_FEISHU_APP_ID: 'a', ZAGENT_FEISHU_APP_SECRET: 's', ZAGENT_FEISHU_ALLOWED_CHATS: 'oc_1',
    ZAGENT_FEISHU_VERIFY_TOKEN: 'vt-test', ZAGENT_FEISHU_PORT: String(port) });

const server = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErr = '';
server.stderr.on('data', d => { serverErr += d; });
const up = await new Promise(res => {
  const t = setTimeout(() => res(false), 15000);
  server.stdout.on('data', d => { if (String(d).includes('webhook on')) { clearTimeout(t); res(true); } });
});
assert(up, `webhook server did not start: ${serverErr}`);

// A raw-socket probe as its own process: reports response bytes received. The
// big payload is generated inside the probe (a >128KB env var would E2BIG).
const PROBE_SRC = `import net from 'node:net';
const body = process.env.PROBE_BIG === '1'
  ? '{"type":"nope","pad":"' + '火'.repeat(400000) + '"}'
  : '{"type":"nope"}';
const s = net.connect(${port}, '127.0.0.1');
let resp = 0;
s.on('data', d => { resp += d.length; });
s.on('connect', () => s.end('POST / HTTP/1.1\\r\\nhost: x\\r\\ncontent-length: ' + Buffer.byteLength(body) + '\\r\\nconnection: close\\r\\n\\r\\n' + body));
s.on('error', () => {});
s.on('close', () => { console.log('PROBE ' + resp); process.exit(0); });
setTimeout(() => { console.log('PROBE_TIMEOUT ' + resp); process.exit(0); }, 10000);`;
const probe = (big) => {
  const c = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE_SRC],
    { env: { ...env, PROBE_BIG: big ? '1' : '0' }, encoding: 'utf8', timeout: 15000 });
  if (c.status !== 0) throw new Error(`probe failed: ${c.error ?? c.stderr}`);
  return c.stdout.trim();
};

try {
  // Control: a small forged body gets an answered HTTP status (401: bad token).
  assert.match(await probe(false), /^PROBE (\d*[1-9]\d*)$/, 'small request receives a response');

  // 400_000 CJK chars = 400K UTF-16 units (under the old char-counted cap) but
  // 1.2MB of bytes — the byte-counted guard must cut it before any reply.
  assert.equal(await probe(true), 'PROBE 0', 'over-1MB byte payload is destroyed unanswered');
  console.log('PASS zagent-feishu byte guard');
} finally {
  server.kill('SIGKILL');
  rmSync(sandbox, { recursive: true, force: true });
}
process.exit(0);
