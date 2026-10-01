#!/usr/bin/env node
// Gate for scripts/soak-published.mjs: a soak that cannot fail is not a gate.
// Runs the real battery against this checkout's own bin (--bin) and against a
// stub binary that behaves like a broken release — the second run MUST fail.
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const soak = path.join(root, 'scripts', 'soak-published.mjs');
const tests = [];
const test = (n, f) => tests.push([n, f]);

const work = mkdtempSync(path.join(tmpdir(), 'zagent-soak-test-'));
// ZAGENT_UPDATE_CHECK=0 keeps doctor deterministic in the hermetic gate —
// otherwise the probed child would try the real npm registry.
const env = { ...process.env, ZAGENT_UPDATE_CHECK: '0', ZAI_API_KEY: 'must-not-reach-the-probe' };

function runSoak(extra, dir = work) {
  return spawnSync(process.execPath, [soak, '--no-pty', '--receipt-dir', dir, ...extra],
    { encoding: 'utf8', timeout: 180_000, env });
}
const receipts = (dir = work) =>
  readdirSync(dir).filter(f => /^soak-.*\.md$/.test(f)).sort();
const receiptText = (dir, i = 0) => readFileSync(path.join(dir, receipts(dir)[i]), 'utf8');
const rowHash = (receipt, probeName) =>
  receipt.match(new RegExp(`\\| ${probeName}[^|]*\\| PASS \\| ([0-9a-f]{16})`))?.[1] ?? null;

// A stub satisfying every non-PTY probe — variants flip one behavior each so a
// failing oracle can be attributed to exactly one probe row.
function writeGoodStub(dir, { version = '9.9.9', hangDoctor = false, doctorStack = false, crashDoctor = false, sessionsHelp = 'ok', sigtermProof = false } = {}) {
  const stub = path.join(dir, 'stub-zagent');
  writeFileSync(stub, `#!/usr/bin/env node
${sigtermProof ? "process.on('SIGTERM', () => {});" : ''}
const a = process.argv.slice(2).join(' ');
if (a === '--version') console.log('zagent ${version}');
else if (a === '--help') console.log('Commands: quota doctor sessions task update models permissions inspect');
else if (a === 'doctor') { console.log('runtime: stub-rt');${doctorStack ? " console.log('    at go (/app/dist/cli.js:3:1)');" : ''}${hangDoctor ? ' setInterval(() => {}, 1000);' : '' }${crashDoctor ? ' process.abort();' : '' } }
else if (a === 'quota --json') { console.log(JSON.stringify({ error: 'no cred', class: 'auth' })); process.exit(1); }
else if (a === 'qouta') { console.error("did you mean 'quota'?"); process.exit(2); }
else if (a === 'inspect --json') console.log('{"storage":{"totalBytes":0}}');
else if (a === 'permissions list') console.log('no grants recorded');
else if (a === 'sessions --help') console.log('sessions help ${sessionsHelp}');
else console.log('ok');
`);
  chmodSync(stub, 0o755);
  return stub;
}

try {
  let passDir, passRun, failRun;
  const pkgVersion = readFileSync(path.join(root, 'VERSION'), 'utf8').trim();

  test('a healthy binary passes the battery and writes a hashed receipt', () => {
    passDir = mkdtempSync(path.join(tmpdir(), 'zagent-soak-pass-'));
    // --version binds the banner check on the --bin path — the gate's own
    // positive run must exercise the bound leg, not the unbound one.
    passRun = runSoak(['--bin', path.join(root, 'bin', 'zagent'), '--version', pkgVersion], passDir);
    assert.equal(passRun.status, 0, `soak exited ${passRun.status}: ${(passRun.stderr || passRun.stdout).slice(-300)}`);
    assert.match(passRun.stdout, /SOAK PASSED/);
    const files = receipts(passDir);
    assert.equal(files.length, 1, `expected 1 receipt, got ${files.length}`);
    const receipt = readFileSync(path.join(passDir, files[0]), 'utf8');
    assert.match(receipt, /real-user soak — PASS/);
    assert.match(receipt, /source: bin:/);
    // every probe row carries a transcript hash a later soak can diff against
    const rows = receipt.match(/^\| [^|]+ \| PASS \| [0-9a-f]{16}/gm) ?? [];
    assert.ok(rows.length >= 8, `expected >=8 hashed probe rows, got ${rows.length}`);
  });

  test('a broken binary FAILs the gate — the soak is not a rubber stamp', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zagent-soak-fail-'));
    const stub = path.join(dir, 'stub-zagent');
    writeFileSync(stub, '#!/usr/bin/env node\nconsole.error("boom"); process.exit(3);\n');
    chmodSync(stub, 0o755);
    failRun = runSoak(['--bin', stub], dir);
    assert.equal(failRun.status, 1, `broken bin must exit 1, got ${failRun.status}`);
    assert.match(failRun.stdout + failRun.stderr, /SOAK FAILED/);
    const receipt = receiptText(dir);
    assert.match(receipt, /\| version banner[^|]*\| FAIL \|/);
  });

  test('a wedged probe FAILs the gate — a hang is not a PASS', () => {
    // review F1: a stub that prints acceptable doctor output then hangs
    // used to soak green — the kill left status null and the printed bytes
    // satisfied the content checks. The timeout must FAIL the probe.
    const dir = mkdtempSync(path.join(tmpdir(), 'zagent-soak-hang-'));
    const stub = writeGoodStub(dir, { hangDoctor: true });
    const r = runSoak(['--bin', stub, '--version', '9.9.9', '--probe-timeout', '3000'], dir);
    assert.equal(r.status, 1, `wedged bin must exit 1, got ${r.status}`);
    const receipt = receiptText(dir);
    assert.match(receipt, /doctor diagnoses[^\n]*FAIL[^\n]*timed out/,
      'wedged doctor probe must FAIL with the timeout recorded');
    assert.match(receipt, /\| version banner[^|]*\| PASS \|/, 'healthy probes still pass around the wedge');
  });

  test('--bin version binding: a stub whose banner lies must FAIL', () => {
    // review F2: --bin without --version used to leave the banner check
    // unbound and unrecorded. Bound+match passes; bound+lie fails on the
    // version row; unbound is recorded UNBOUND in the receipt header.
    const dirA = mkdtempSync(path.join(tmpdir(), 'zagent-soak-bind-'));
    const stub = writeGoodStub(dirA);
    const ok = runSoak(['--bin', stub, '--version', '9.9.9'], dirA);
    assert.equal(ok.status, 0, `bound-match soak should pass: ${(ok.stderr || ok.stdout).slice(-200)}`);
    assert.match(receiptText(dirA), /expected version: 9\.9\.9/);

    const dirB = mkdtempSync(path.join(tmpdir(), 'zagent-soak-lie-'));
    const bad = runSoak(['--bin', stub, '--version', '1.2.3'], dirB);
    assert.equal(bad.status, 1, 'a lying banner must fail the soak');
    assert.match(receiptText(dirB), /version banner[^\n]*FAIL[^\n]*expected 1\.2\.3/);

    const dirC = mkdtempSync(path.join(tmpdir(), 'zagent-soak-unbound-'));
    const un = runSoak(['--bin', stub], dirC);
    assert.equal(un.status, 0);
    assert.match(un.stderr, /UNBOUND/, 'unbound --bin must be disclosed on stderr');
    assert.match(receiptText(dirC), /expected version: UNBOUND/);
    // review LOW: the row a differ scans must not read PASS for a check
    // whose binding leg was never performed.
    assert.match(receiptText(dirC), /\| version banner[^|]*\| UNBOUND \|/,
      'unbound version check must render UNBOUND, not PASS');
  });

  test('a SIGTERM-ignoring wedged probe still FAILs inside the bound', () => {
    // review MINOR: spawnSync's default timeout signal is SIGTERM, which
    // a stub can trap — the gate then wedged forever with no receipt and no
    // verdict. killSignal SIGKILL cannot be ignored, so the bound still
    // produces a FAIL row.
    const dir = mkdtempSync(path.join(tmpdir(), 'zagent-soak-sigkill-'));
    const stub = writeGoodStub(dir, { hangDoctor: true, sigtermProof: true });
    const t0 = Date.now();
    const r = runSoak(['--bin', stub, '--version', '9.9.9', '--probe-timeout', '3000'], dir);
    assert.equal(r.status, 1, `SIGTERM-proof wedge must exit 1, got ${r.status}`);
    assert.ok(Date.now() - t0 < 60_000, 'the gate wedged on a SIGTERM-proof child');
    assert.match(receiptText(dir), /doctor diagnoses[^\n]*FAIL[^\n]*(timed out|SIGKILL)/);
    assert.match(receiptText(dir), /\| version banner[^|]*\| PASS \|/, 'healthy probes still pass around the wedge');
  });

  test('multi-verb probes hash ALL verbs, not just the last', () => {
    // review F5: the row hash used to be last-wins, so drift in
    // `sessions --help` was invisible when `task --help` stayed identical.
    const dirA = mkdtempSync(path.join(tmpdir(), 'zagent-soak-mva-'));
    const stubA = writeGoodStub(dirA, { sessionsHelp: 'A' });
    const dirB = mkdtempSync(path.join(tmpdir(), 'zagent-soak-mvb-'));
    const stubB = writeGoodStub(dirB, { sessionsHelp: 'B' });
    assert.equal(runSoak(['--bin', stubA, '--version', '9.9.9'], dirA).status, 0);
    assert.equal(runSoak(['--bin', stubB, '--version', '9.9.9'], dirB).status, 0);
    const ha = rowHash(receiptText(dirA), 'sqlite-backed help');
    const hb = rowHash(receiptText(dirB), 'sqlite-backed help');
    assert.ok(ha && hb, 'composite row hash missing from a receipt');
    assert.notEqual(ha, hb, 'sessions --help drift must change the composite hash');
  });

  test('a .js stack frame in doctor output FAILs (bundled releases are .js)', () => {
    // review F4: the detector required a literal .mjs — a bundled
    // dist/cli.js frame slipped through.
    const dir = mkdtempSync(path.join(tmpdir(), 'zagent-soak-jsstack-'));
    const stub = writeGoodStub(dir, { doctorStack: true });
    const r = runSoak(['--bin', stub, '--version', '9.9.9'], dir);
    assert.equal(r.status, 1);
    assert.match(receiptText(dir), /doctor diagnoses[^\n]*FAIL[^\n]*stack trace/);
  });

  test('a signal-killed probe FAILs the gate — status null is not a clean exit', () => {
    // r1 MINOR: F1 covered ETIMEDOUT only; a signal death (SIGSEGV/SIGABRT/OOM)
    // leaves the same null status with pre-crash bytes intact — same class.
    const dir = mkdtempSync(path.join(tmpdir(), 'zagent-soak-crash-'));
    const stub = writeGoodStub(dir, { crashDoctor: true });
    const r = runSoak(['--bin', stub, '--version', '9.9.9'], dir);
    assert.equal(r.status, 1);
    assert.match(receiptText(dir), /doctor diagnoses[^\n]*FAIL[^\n]*killed by SIGABRT/);
    assert.match(receiptText(dir), /\| version banner[^|]*\| PASS \|/, 'healthy probes still pass around the crash');
  });

  test('glued-empty values and valueless-glued flags are usage errors', () => {
    // r1 LOW/NIT: `--bin=` silently fell into npm-install mode, `--version=`
    // recorded a blank expected version, and `--no-pty=x`/`--keep=x` no-oped.
    const dir = mkdtempSync(path.join(tmpdir(), 'zagent-soak-args-'));
    const stub = writeGoodStub(dir);
    for (const bad of [['--bin='], [`--bin=${stub}`, '--version='], ['--receipt-dir='], ['--no-pty=x'], ['--keep=1']]) {
      const r = runSoak(bad, dir);
      assert.equal(r.status, 2, `${bad.join(' ')} must exit 2, got ${r.status}`);
      assert.match(r.stderr, /needs a value|takes no value/);
    }
    // review NIT: an unsanitized --version could inject receipt lines.
    const inj = runSoak(['--bin', stub, '--version', '9.9.9\n- fake: injected'], dir);
    assert.equal(inj.status, 2, 'non-semver --version must exit 2');
    assert.match(inj.stderr, /bad --version value/);
  });

  test('a host without util-linux script(1) skips the PTY leg loudly', () => {
    // r1 LOW: BSD script(1) lacks -e/-c — the leg used to FAIL the whole gate
    // on a macOS host instead of recording a SKIP.
    const dir = mkdtempSync(path.join(tmpdir(), 'zagent-soak-noscript-'));
    const stub = writeGoodStub(dir);
    const r = spawnSync(process.execPath, [soak, '--receipt-dir', dir,
      '--bin', stub, '--version', '9.9.9', '--probe-timeout', '3000'],
      { encoding: 'utf8', timeout: 120_000, env: { ...env, PATH: '/nonexistent-zz' } });
    // Other probes fail too (the stub shebang's env can't find node on a dead
    // PATH) — the point is the PTY row is a recorded SKIP, not a fake leg.
    assert.equal(r.status, 1);
    assert.match(receiptText(dir), /PTY boot[^\n]*SKIP[^\n]*script\(1\)/);
  });

  test('the receipt records the env passthrough fingerprint and registry', () => {
    // review F6/F7: ZCODE_RUNTIME changes recorded hashes but was never
    // recorded; the npm registry override was invisible too.
    const receipt = receiptText(passDir);
    assert.match(receipt, /env passthrough: ZCODE_RUNTIME=[^,]+, ZAGENT_UPDATE_CHECK=0/);
    assert.ok(receipt.includes(`ZCODE_RUNTIME=${process.env.ZCODE_RUNTIME ?? 'unset'}`),
      'receipt must record the host-visible ZCODE_RUNTIME value verbatim');
    assert.match(receipt, /registry: n\/a \(--bin mode\)/);
  });

  test('the soaked process provably runs credential-free (behavioral oracle)', () => {
    // A source-literal scan can miss `env.ZAI_API_KEY = ...` statement-form or
    // `{...process.env}` spread leaks. The stub records what it ACTUALLY saw.
    const dir = mkdtempSync(path.join(tmpdir(), 'zagent-soak-env-'));
    const dump = path.join(dir, 'env-dump.txt');
    const stub = path.join(dir, 'stub-zagent');
    writeFileSync(stub, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(dump)}, process.env.HOME + '\\n' + Object.keys(process.env).sort().join('\\n'));
process.exit(0);
`);
    chmodSync(stub, 0o755);
    runSoak(['--bin', stub], dir);
    assert.ok(existsSync(dump), 'stub never ran — env capture missing');
    const [homeLine, ...keys] = readFileSync(dump, 'utf8').trim().split('\n');
    assert.match(homeLine, /zagent-soak-/, `probe HOME is the caller's, not the sandbox: ${homeLine}`);
    assert.ok(!keys.includes('ZAI_API_KEY'), 'ZAI_API_KEY reached the soaked process');
    assert.ok(!keys.some(k => /KEY|TOKEN|SECRET/i.test(k)), `credential-shaped env leaked: ${keys.filter(k => /KEY|TOKEN|SECRET/i.test(k)).join(',')}`);
  });

  test('the PTY leg demands a real surface, not word-list luck (F3)', () => {
    // review F3: the old check was a word list — a crash dump mentioning
    // 'runtime'/'login' passed. Requires script(1); skips loudly without it.
    if (spawnSync('script', ['--version'], { encoding: 'utf8' }).status !== 0) {
      console.log('     (skipped: no script(1) on this host)');
      return;
    }
    // crash stub: word-list vocabulary inside a stack dump, stays resident
    const dirA = mkdtempSync(path.join(tmpdir(), 'zagent-soak-ptycrash-'));
    const crashStub = path.join(dirA, 'stub-zagent');
    writeFileSync(crashStub, `#!/usr/bin/env node
console.log('Error: runtime ZCODE credential login failure');
console.log('    at boot (/app/dist/cli.js:1:1)');
setInterval(() => {}, 1000);
`);
    chmodSync(crashStub, 0o755);
    const bad = spawnSync(process.execPath, [soak, '--receipt-dir', dirA,
      '--bin', crashStub, '--version', '9.9.9', '--probe-timeout', '6000'],
      { encoding: 'utf8', timeout: 120_000, env });
    assert.equal(bad.status, 1, `crash-dump boot must fail, got ${bad.status}`);
    assert.match(receiptText(dirA), /PTY boot[^\n]*FAIL/);

    // card stub: the real credential-free surface (chooser prompt), resident
    const dirB = mkdtempSync(path.join(tmpdir(), 'zagent-soak-ptyok-'));
    const cardStub = path.join(dirB, 'stub-zagent');
    writeFileSync(cardStub, `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
if (a === '--version') console.log('zagent 9.9.9');
else if (a === '--help') console.log('Commands: quota doctor sessions task update models permissions inspect');
else if (a === 'doctor') console.log('runtime: stub-rt');
else if (a === 'quota --json') { console.log(JSON.stringify({ error: 'no cred', class: 'auth' })); process.exit(1); }
else if (a === 'qouta') { console.error("did you mean 'quota'?"); process.exit(2); }
else if (a === 'inspect --json') console.log('{"storage":{}}');
else if (a === 'permissions list') console.log('no grants recorded');
else if (a === '') {
  console.log('zagent: no GLM Coding Plan credential — choose a sign-in path:');
  console.log('  3. quit');
  process.stderr.write('sign in [1/2/3]: ');
  setInterval(() => {}, 1000);
}
else console.log('ok');
`);
    chmodSync(cardStub, 0o755);
    const good = spawnSync(process.execPath, [soak, '--receipt-dir', dirB,
      '--bin', cardStub, '--version', '9.9.9', '--probe-timeout', '6000'],
      { encoding: 'utf8', timeout: 120_000, env });
    assert.equal(good.status, 0, `honest card boot must pass: ${(good.stderr || good.stdout).slice(-300)}`);
    assert.match(receiptText(dirB), /PTY boot[^\n]*PASS/);

    // review MAJOR: a resident fatal frame whose only "surface" is the
    // product noun ('ZCode desktop' / the install hint) must FAIL — bare
    // nouns are not a drawn card. This frame matches NO crash word either;
    // the old regex passed it on the noun alone.
    const dirC = mkdtempSync(path.join(tmpdir(), 'zagent-soak-ptynoun-'));
    const nounStub = path.join(dirC, 'stub-zagent');
    writeFileSync(nounStub, `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
if (a === '--version') console.log('zagent 9.9.9');
else if (a === '--help') console.log('Commands: quota doctor sessions task update models permissions inspect');
else if (a === 'doctor') console.log('runtime: stub-rt');
else if (a === 'quota --json') { console.log(JSON.stringify({ error: 'no cred', class: 'auth' })); process.exit(1); }
else if (a === 'qouta') { console.error("did you mean 'quota'?"); process.exit(2); }
else if (a === 'inspect --json') console.log('{"storage":{}}');
else if (a === 'permissions list') console.log('no grants recorded');
else if (a === '') {
  console.log('zagent: ZCode desktop runtime unavailable; install zcode-app-cli and retry');
  setInterval(() => {}, 1000);
}
else console.log('ok');
`);
    chmodSync(nounStub, 0o755);
    const noun = spawnSync(process.execPath, [soak, '--receipt-dir', dirC,
      '--bin', nounStub, '--version', '9.9.9', '--probe-timeout', '6000'],
      { encoding: 'utf8', timeout: 120_000, env });
    assert.equal(noun.status, 1, `a bare-noun resident frame must fail, got ${noun.status}`);
    assert.match(receiptText(dirC), /PTY boot[^\n]*FAIL[^\n]*no recognizable surface/);

    // review MAJOR: the runtime-free path never reaches the chooser — the
    // CLI runs the doctor diagnosis and exits 1 (zagent.mjs), so the anchored
    // 'runtime:' line on a really-exited process is the honest surface.
    const dirD = mkdtempSync(path.join(tmpdir(), 'zagent-soak-ptyrtfree-'));
    const rtFreeStub = path.join(dirD, 'stub-zagent');
    writeFileSync(rtFreeStub, `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
if (a === '--version') console.log('zagent 9.9.9');
else if (a === '--help') console.log('Commands: quota doctor sessions task update models permissions inspect');
else if (a === 'doctor') console.log('runtime: stub-rt');
else if (a === 'quota --json') { console.log(JSON.stringify({ error: 'no cred', class: 'auth' })); process.exit(1); }
else if (a === 'qouta') { console.error("did you mean 'quota'?"); process.exit(2); }
else if (a === 'inspect --json') console.log('{"storage":{}}');
else if (a === 'permissions list') console.log('no grants recorded');
else if (a === '') {
  console.log('runtime: NOT FOUND — install zcode-app-cli or the ZCode desktop app');
  process.exit(1);
}
else console.log('ok');
`);
    chmodSync(rtFreeStub, 0o755);
    const rtfree = spawnSync(process.execPath, [soak, '--receipt-dir', dirD,
      '--bin', rtFreeStub, '--version', '9.9.9', '--probe-timeout', '6000'],
      { encoding: 'utf8', timeout: 120_000, env });
    assert.equal(rtfree.status, 0, `runtime-free honest boot must pass: ${(rtfree.stderr || rtfree.stdout).slice(-300)}`);
    assert.match(receiptText(dirD), /PTY boot[^\n]*PASS/);

    // review MAJOR: a resident frame that prints an anchored 'runtime:' line
    // and then HANGS is not an honest surface — ^C/timeout death (code >=128
    // or 124) must not satisfy doctorExit.
    const dirE = mkdtempSync(path.join(tmpdir(), 'zagent-soak-ptyrthang-'));
    const rtHangStub = path.join(dirE, 'stub-zagent');
    writeFileSync(rtHangStub, `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
if (a === '--version') console.log('zagent 9.9.9');
else if (a === '--help') console.log('Commands: quota doctor sessions task update models permissions inspect');
else if (a === 'doctor') console.log('runtime: stub-rt');
else if (a === 'quota --json') { console.log(JSON.stringify({ error: 'no cred', class: 'auth' })); process.exit(1); }
else if (a === 'qouta') { console.error("did you mean 'quota'?"); process.exit(2); }
else if (a === 'inspect --json') console.log('{"storage":{}}');
else if (a === 'permissions list') console.log('no grants recorded');
else if (a === '') {
  console.log('runtime: NOT FOUND — install zcode-app-cli or the ZCode desktop app');
  setInterval(() => {}, 1000);
}
else console.log('ok');
`);
    chmodSync(rtHangStub, 0o755);
    const rthang = spawnSync(process.execPath, [soak, '--receipt-dir', dirE,
      '--bin', rtHangStub, '--version', '9.9.9', '--probe-timeout', '6000'],
      { encoding: 'utf8', timeout: 120_000, env });
    assert.equal(rthang.status, 1, `a resident 'runtime:' frame must fail, got ${rthang.status}`);
    assert.match(receiptText(dirE), /PTY boot[^\n]*FAIL[^\n]*no recognizable surface/);

    // review MINOR: a --bin path containing spaces must reach the PTY probe
    // as one word (the inner sh splits an unquoted inline path).
    const dirF = mkdtempSync(path.join(tmpdir(), 'zagent-soak-ptyspace-'));
    const spaceDir = path.join(dirF, 'dir with space');
    mkdirSync(spaceDir);
    const spaceStub = path.join(spaceDir, 'stub-zagent');
    writeFileSync(spaceStub, `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
if (a === '--version') console.log('zagent 9.9.9');
else if (a === '--help') console.log('Commands: quota doctor sessions task update models permissions inspect');
else if (a === 'doctor') console.log('runtime: stub-rt');
else if (a === 'quota --json') { console.log(JSON.stringify({ error: 'no cred', class: 'auth' })); process.exit(1); }
else if (a === 'qouta') { console.error("did you mean 'quota'?"); process.exit(2); }
else if (a === 'inspect --json') console.log('{"storage":{}}');
else if (a === 'permissions list') console.log('no grants recorded');
else if (a === '') {
  console.log('runtime: NOT FOUND — install zcode-app-cli or the ZCode desktop app');
  process.exit(1);
}
else console.log('ok');
`);
    chmodSync(spaceStub, 0o755);
    const spaced = spawnSync(process.execPath, [soak, '--receipt-dir', dirF,
      '--bin', spaceStub, '--version', '9.9.9', '--probe-timeout', '6000'],
      { encoding: 'utf8', timeout: 120_000, env });
    assert.equal(spaced.status, 0, `space-bearing --bin path must pass: ${(spaced.stderr || spaced.stdout).slice(-300)}`);
    assert.match(receiptText(dirF), /PTY boot[^\n]*PASS/);
  });

  test('a missing --bin fails loudly in setup, not as ten probe failures', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zagent-soak-nobin-'));
    const r = runSoak(['--bin', path.join(dir, 'no-such-zagent')], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SETUP FAILED.*not found/s);
    assert.ok(receipts(dir).some(f => f.endsWith('-setup.md')), 'no setup-fail receipt');
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

let bad = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { bad++; console.log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 4).join('\n     ')}`); }
}
console.log(bad ? `\n${bad} FAILED` : '\nall soak gate tests passed');
process.exit(bad ? 1 : 0);
