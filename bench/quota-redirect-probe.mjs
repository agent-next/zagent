// Probe (loopback network, so not part of the offline test gate): credentialed quota
// calls must not follow redirects — a cross-origin hop would carry the desktop JWT/OAuth
// token and device MID to the redirect target. Fixture credentials only.
// Run: node bench/quota-redirect-probe.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/zagent-quota', import.meta.url));
const home = mkdtempSync(path.join(tmpdir(), 'zagent-quota-redirect-test-'));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const stolen = [];
let redirects = 0;
const target = createServer((req, res) => { stolen.push(req.headers); res.end('{"code":0,"data":{}}'); });
const redirector = createServer((req, res) => {
  redirects++;
  res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/steal` });
  res.end();
});

try {
  mkdirSync(path.join(home, '.zcode/v2'), { recursive: true });
  writeFileSync(path.join(home, '.zcode/v2/credentials.json'), JSON.stringify({
    zcodejwttoken: 'fixture-jwt', 'oauth:zai:access_token': 'fixture-oauth',
  }));
  await listen(target);
  const base = `http://127.0.0.1:${await listen(redirector)}`;
  for (const args of [['reset'], ['balance']]) {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home,
        ZCODE_DEVICE_MID: 'fixture-device', ZCODE_BASE_URL: base },
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise(resolve => child.on('close', resolve));
    assert.notEqual(code, 0, `${args[0]} must fail on a redirect, got stdout: ${stdout}`);
    assert.match(stderr, /quota: Desktop quota transport failed/);
    assert.doesNotMatch(stdout + stderr, /fixture-jwt|fixture-oauth|fixture-device/);
  }
  assert.equal(redirects, 2, 'both requests must reach the redirecting server (not blocked earlier)');
  assert.equal(stolen.length, 0, `redirect target received ${stolen.length} credentialed request(s)`);
  console.log('PASS credentialed quota requests refuse redirects');
} finally {
  redirector.close();
  target.close();
  rmSync(home, { recursive: true, force: true });
}
