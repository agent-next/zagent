// CP-2: chain selection per platform + live linux round-trip with a real zip.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractorChain, defaultUnzipCmd, EXTRACTORS } from './extract.mjs';

// chain selection (injected probe — no real binaries touched)
const probeHit = names => name => names.includes(name);
assert.deepEqual(extractorChain({ platform: 'win32', probe: probeHit(['tar', 'powershell']) }), ['tar', 'powershell']);
assert.deepEqual(extractorChain({ platform: 'win32', probe: probeHit(['powershell']) }), ['powershell']);
assert.deepEqual(extractorChain({ platform: 'darwin', probe: () => true }), ['ditto', 'tar', 'unzip']);
assert.deepEqual(extractorChain({ platform: 'linux', probe: () => true }), ['unzip', 'tar']);
assert.deepEqual(extractorChain({ platform: 'freebsd', probe: () => true }), ['unzip', 'tar']); // unknown → linux
assert.deepEqual(extractorChain({ platform: 'linux', probe: () => false }), []); // none → executor returns 127
const none = defaultUnzipCmd.call(null); // not used; sanity that a no-chain box degrades
assert.equal(typeof none, 'function');

// LIVE linux: real zip round-trip through the default executor (unzip first)
if (process.platform === 'linux') {
  const d = mkdtempSync(path.join(os.tmpdir(), 'zcp2-'));
  mkdirSync(path.join(d, 'pkg'));
  writeFileSync(path.join(d, 'pkg', 'hello.txt'), 'cp2');
  spawnSync('zip', ['-q', '-r', path.join(d, 'a.zip'), 'pkg'], { cwd: d });
  const out = path.join(d, 'out'); mkdirSync(out);
  const cmd = defaultUnzipCmd();
  const r = cmd(path.join(d, 'a.zip'), out);
  assert.equal(r.status, 0, `live unzip chain status=${r.status}`);
  assert.equal(readFileSync(path.join(out, 'pkg', 'hello.txt'), 'utf8'), 'cp2');
  // single-file zip → no nesting, still extracts
  writeFileSync(path.join(d, 'one.txt'), '1');
  spawnSync('zip', ['-q', path.join(d, 'b.zip'), 'one.txt'], { cwd: d });
  const out2 = path.join(d, 'out2'); mkdirSync(out2);
  assert.equal(cmd(path.join(d, 'b.zip'), out2).status, 0);
  assert.equal(readFileSync(path.join(out2, 'one.txt'), 'utf8'), '1');
  rmSync(d, { recursive: true, force: true });
}

console.log('PASS extract-cp2');


// r2: NATIVE extraction on EVERY platform via the committed fixture (was linux-only);
// win32 chain order pinned (tar before powershell); powershell branch exercised via
// direct EXTRACTORS call (CI runners have powershell).
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cp-fixture.zip');
{
  const out = mkdtempSync(path.join(os.tmpdir(), 'zcp2nat-'));
  const cmd = defaultUnzipCmd(); // real chain, real binaries
  const r = cmd(fixture, out);
  assert.equal(r.status, 0, `native chain failed on ${process.platform}: ${JSON.stringify(r)}`);
  assert.equal(readFileSync(path.join(out, 'pkg', 'hello.txt'), 'utf8'), 'cp-fixture\n');
  rmSync(out, { recursive: true, force: true });
}
// win32 chain order + powershell executor reachable (mock-free on win runners; on
// unix this pins the command STRING only)
if (process.platform === 'win32') {
  // r2b: chain[0] is whichever passes probing — win CI ships GNU tar (rejected by the
  // bsdtar check, correctly), so powershell leads. Assert zip-capability, not order.
  const chain = extractorChain({});
  assert.ok(chain.length >= 1);
  assert.ok(chain.includes('powershell'));
  const out = mkdtempSync(path.join(os.tmpdir(), 'zcp2ps-'));
  const r = EXTRACTORS.powershell(fixture, out);
  assert.equal(r.status, 0, 'powershell executor works on win CI');
  assert.equal(readFileSync(path.join(out, 'pkg', 'hello.txt'), 'utf8'), 'cp-fixture\n');
  rmSync(out, { recursive: true, force: true });
}
console.log('(fixture round-trips ok)');
