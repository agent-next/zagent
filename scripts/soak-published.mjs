#!/usr/bin/env node
// Nightly real-user soak against the PUBLISHED npm artifact : individually safe merges can combine badly at ~20
// releases/day, so the artifact a stranger installs gets replayed end-to-end and
// the receipt carries version + transcript hashes a later run can diff against.
//
//   node scripts/soak-published.mjs                    # npm dist-tags.latest
//   node scripts/soak-published.mjs --version 0.0.238  # pin a release
//   node scripts/soak-published.mjs --bin ./bin/zagent # soak any binary (dev/test)
//   --no-pty        skip the interactive boot leg (hermetic gates, no script(1))
//   --receipt-dir D write the receipt somewhere else (default artifacts/verify)
//   --keep          leave the install prefix for inspection
//   --probe-timeout MS  per-probe kill bound (default 60000; gates use ~3000)
//   --version       in --bin mode this is the EXPECTED banner; without it the
//                   version check is UNBOUND and the receipt says so
//
// Credential-free BY DESIGN: probes run on a throwaway HOME with no key material
// in the environment — the same posture as the flock, so the soak can run
// unattended and never needs a credential. Exit 1 when any probe FAILs; this is
// a gate, not a report.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, arch } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const KNOWN = new Set(['version', 'bin', 'receipt-dir', 'no-pty', 'keep', 'probe-timeout']);
const VALUELESS = new Set(['no-pty', 'keep']);
for (const a of argv) {
  if (!a.startsWith('--')) continue;
  const name = a.slice(2).split('=')[0];
  if (!KNOWN.has(name)) {
    console.error(`soak-published: unknown flag ${a}`);
    process.exit(2);
  }
  if (VALUELESS.has(name) && a.includes('=')) {
    console.error(`soak-published: --${name} takes no value`);
    process.exit(2);
  }
}
const arg = (name) => {
  const glued = argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  if (glued !== undefined) {
    if (glued === '') {
      console.error(`soak-published: --${name} needs a value`);
      process.exit(2);
    }
    return glued;
  }
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`soak-published: --${name} needs a value`);
    process.exit(2);
  }
  return v;
};
const keep = argv.includes('--keep');
const withPty = !argv.includes('--no-pty');
const probeTimeout = (() => {
  const v = arg('probe-timeout');
  if (v === undefined) return 60_000;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1000) {
    console.error('soak-published: --probe-timeout needs integer ms >= 1000');
    process.exit(2);
  }
  return n;
})();
const receiptDir = arg('receipt-dir') ?? path.join(root, 'artifacts', 'verify');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

let installedVersion = arg('version') ?? null;
if (installedVersion !== null && !/^\d+\.\d+\.\d+$/.test(installedVersion)) {
  console.error(`soak-published: bad --version value`);
  process.exit(2);
}

const work = mkdtempSync(path.join(tmpdir(), 'zagent-soak-'));
const home = path.join(work, 'home');
mkdirSync(home);
const sha = (s) => createHash('sha256').update(s).digest('hex');

// Deliberately minimal: PATH + a credential-free HOME. ZCODE_RUNTIME passes
// through so the probe reports whatever the host's discovery finds — a missing
// runtime is honest output, not a soak failure.
const env = { PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color', LANG: 'C.UTF-8' };
if (process.env.ZCODE_RUNTIME) env.ZCODE_RUNTIME = process.env.ZCODE_RUNTIME;
for (const k of ['CI', 'ZAGENT_UPDATE_CHECK']) if (process.env[k]) env[k] = process.env[k];

let bin = arg('bin');
if (bin) bin = path.resolve(bin); // probes run with cwd=work; keep caller-relative paths working
let source;
let registry = 'n/a (--bin mode)';
if (bin && !installedVersion)
  console.error('note: --bin without --version — the banner check is UNBOUND and recorded as such');

const results = [];
const probe = (name, fn) => {
  const r = { name };
  try {
    const out = fn() ?? {};
    if (out.skip) {
      r.verdict = 'SKIP';
      r.detail = out.skip;
      console.log(`  skip ${name} — ${r.detail}`);
    } else {
      Object.assign(r, { ...out, name });
      const v = out.verdict ?? 'PASS';
      if (['PASS', 'UNBOUND', 'FAIL'].includes(v)) r.verdict = v;
      else {
        r.verdict = 'FAIL';
        r.detail = `probe returned an unknown verdict '${v}'`;
      }
      console.log(`  ${r.verdict === 'PASS' ? 'ok  ' : r.verdict.toLowerCase()} ${name}`);
    }
  } catch (e) {
    r.verdict = 'FAIL';
    r.detail = e.message.split('\n')[0];
    console.log(`  FAIL ${name}\n         ${r.detail}`);
  }
  results.push(r);
};

/** Run the soaked binary on the credential-free HOME; hash the transcript. */
function run(args, { timeout = probeTimeout, pty = false } = {}) {
  const r = pty
    // Keep stdin open while the TUI renders (a real stranger stares at the
    // first screen), then send ^C so a healthy TUI exits on its own; the
    // timeout still bounds a wedged one. `script` exits on stdin EOF, which is
    // why the keystroke is delayed rather than absent. The binary path goes
    // via env, not inline quoting — space/quote-bearing --bin paths stay one
    // word for the inner sh.
    ? spawnSync('bash', ['-c', `(sleep ${Math.max(2, Math.floor(timeout / 1000) - 4)}; printf '\\003') | script -qec 'timeout -k 2 ${Math.ceil(timeout / 1000)} "$ZSOAK_BIN" ${args.join(' ')}' /dev/null`],
        { encoding: 'utf8', timeout, killSignal: 'SIGKILL', cwd: work, env: { ...env, ZSOAK_BIN: bin } })
    : spawnSync(bin, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', cwd: work, env });
  // A wedged or crashed probe is a FAIL, not a PASS: timeout kills, signal
  // death and spawn errors all leave status null, and whatever the binary
  // printed beforehand must not satisfy the content checks. The PTY leg is
  // exempt — a healthy TUI stays resident, so ETIMEDOUT is its expected end
  // state.
  if (!pty && r.status === null) {
    const why = r.error?.code === 'ETIMEDOUT' ? `timed out after ${timeout / 1000}s (wedged)`
      : r.signal ? `killed by ${r.signal}`
      : `spawn error: ${r.error?.code ?? r.error?.message ?? 'unknown'}`;
    throw new Error(`zagent ${args.join(' ')} ${why}`);
  }
  const transcript = `${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`;
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', sha256: sha(transcript), timedOut: r.error?.code === 'ETIMEDOUT' };
}

try {
  if (bin) {
    if (!existsSync(bin)) throw new Error(`--bin not found: ${bin}`);
    source = `bin:${bin}`;
  } else {
    installedVersion ??= execFileSync('npm', ['view', 'zagent', 'dist-tags.latest'],
      // minimal env on purpose (credential-free posture); proxied/private-
      // registry hosts fail loudly in setup with a receipt, not silently
      { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', env: { PATH: env.PATH, HOME: home } }).trim();
    if (!/^\d+\.\d+\.\d+$/.test(installedVersion)) throw new Error(`bad version ${installedVersion}`);
    source = `npm:zagent@${installedVersion}`;
    try {
      registry = execFileSync('npm', ['config', 'get', 'registry'],
        { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', env: { PATH: env.PATH, HOME: home } }).trim() || 'unresolved';
    } catch { registry = 'unresolved'; }
    const prefix = path.join(work, 'prefix');
    // Stranger install needs PATH + a HOME for the npm cache — nothing else;
    // full process.env would hand lifecycle scripts every host credential.
    execFileSync('npm', ['install', '-g', `zagent@${installedVersion}`],
      { encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL', env: { PATH: env.PATH, HOME: home, npm_config_prefix: prefix }, stdio: ['ignore', 'pipe', 'pipe'] });
    bin = path.join(prefix, 'bin', 'zagent');
    if (!existsSync(bin)) throw new Error(`no zagent binary at ${bin}`);
  }
} catch (e) {
  // Infra failure before the battery: still leave a receipt so a nightly run
  // records what happened instead of dying silent.
  mkdirSync(receiptDir, { recursive: true });
  const rp = path.join(receiptDir, `soak-${(installedVersion ?? 'local').replace(/[^\w.-]/g, '_')}-${stamp}-${process.pid}-setup.md`);
  writeFileSync(rp, `# real-user soak — SETUP-FAIL\n\n- date: ${new Date().toISOString()}\n- error: ${e.message}\n`);
  console.error(`SOAK SETUP FAILED: ${e.message}\nreceipt: ${rp}`);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}
try {
  console.log(`soak of ${source} (${platform()}-${arch()}, node ${process.version})`);

  probe('version banner reports a real version', () => {
    const r = run(['--version']);
    if (r.code !== 0) throw new Error(`exit ${r.code}`);
    const m = r.out.trim().match(/^zagent (\d+\.\d+\.\d+)/m);
    if (!m) throw new Error(`unparseable banner: ${r.out.trim().slice(0, 60)}`);
    if (installedVersion && m[1] !== installedVersion)
      throw new Error(`reports ${m[1]}, expected ${installedVersion}`);
    // Unbound --bin: the banner parsed but no expected version was bound, so
    // the row must not read PASS — a differ scanning the table would take a
    // PASS as a performed check.
    return { sha256: r.sha256, detail: m[1], ...(installedVersion ? {} : { verdict: 'UNBOUND' }) };
  });

  probe('top-level --help lists the daily commands', () => {
    const r = run(['--help']);
    if (r.code !== 0) throw new Error(`exit ${r.code}`);
    for (const word of ['quota', 'doctor']) if (!r.out.includes(word)) throw new Error(`help missing '${word}'`);
    return { sha256: r.sha256 };
  });

  probe('doctor diagnoses without a stack trace', () => {
    const r = run(['doctor']);
    const all = `${r.out}${r.err}`;
    if (!/runtime:/.test(all)) throw new Error('no runtime line');
    if (/^\s*at .+\.[cm]?js:\d+/m.test(all)) throw new Error('a stack trace reached the user');
    return { sha256: r.sha256 };
  });

  probe('credential-free quota --json emits the honest envelope', () => {
    // F11/F15 contract: a stranger with no key gets {"error",class:"auth"}, not a crash.
    const r = run(['quota', '--json']);
    if (r.code === 0) throw new Error('exit 0 on a credential-free machine');
    const first = r.out.trim().split('\n')[0];
    let parsed; try { parsed = JSON.parse(first); } catch { throw new Error(`not JSON: ${first.slice(0, 60)}`); }
    if (!parsed.error || parsed.class !== 'auth')
      throw new Error(`envelope must be error+class:'auth': ${first.slice(0, 60)}`);
    return { sha256: r.sha256, detail: `class:${parsed.class}` };
  });

  probe('a mistyped command names its nearest neighbour', () => {
    // `zagent qouta` must exit non-zero AND say 'quota'.
    const r = run(['qouta']);
    if (r.code === 0) throw new Error('exit 0 on an unknown command');
    if (!/did you mean 'quota'/.test(`${r.out}${r.err}`)) throw new Error('no did-you-mean hint');
    return { sha256: r.sha256 };
  });

  probe('inspect --json parses on a fresh HOME', () => {
    // Runtime-free hosts legitimately exit 1 — the contract is parseable JSON,
    // not a 0 status (a crash printing a stack is the failure class).
    const r = run(['inspect', '--json']);
    try { JSON.parse(r.out); } catch { throw new Error(`exit ${r.code}, not JSON: ${r.out.slice(0, 60)}`); }
    return { sha256: r.sha256 };
  });

  probe('permissions list is honest about an empty store', () => {
    const r = run(['permissions', 'list']);
    if (r.code !== 0) throw new Error(`exit ${r.code}: ${(r.err || r.out).slice(0, 60)}`);
    if (!`${r.out}${r.err}`.trim()) throw new Error('printed nothing');
    return { sha256: r.sha256 };
  });

  probe('sqlite-backed help leaks no ExperimentalWarning', () => {
    // Composite over EVERY verb — a last-wins hash would hide drift in the
    // earlier ones.
    const parts = [];
    for (const verb of ['sessions', 'task']) {
      const r = run([verb, '--help']);
      parts.push(`${verb}=${r.sha256}`);
      if (/ExperimentalWarning/.test(`${r.out}${r.err}`)) throw new Error(`${verb} leaks ExperimentalWarning`);
    }
    return { sha256: sha(parts.join('\n')) };
  });

  probe('key subcommands still explain themselves', () => {
    const parts = [];
    for (const args of [['quota', '--help'], ['update', '--help'], ['models', '--help']]) {
      const r = run(args);
      parts.push(`${args[0]}=${r.sha256}`);
      if (r.code !== 0 || !r.out.trim()) throw new Error(`zagent ${args.join(' ')}: exit ${r.code}, empty=${!r.out.trim()}`);
    }
    return { sha256: sha(parts.join('\n')) };
  });

  if (withPty) {
    probe('PTY boot reaches an honest card, not a crash', () => {
      // util-linux script(1) only — BSD/macOS script lacks -e/-c, so a host
      // without it skips loudly in the receipt rather than faking the leg.
      if (spawnSync('script', ['--version'], { encoding: 'utf8' }).status !== 0)
        return { skip: 'no util-linux script(1) on this host' };
      // The real first-run: a stranger launches the TUI on a credential-free
      // machine. Whatever it shows (sign-in card, runtime warning) must be a
      // rendered card — a node stack or a silent exit is the failure class.
      const r = run([], { timeout: Math.min(20_000, Math.max(6_000, probeTimeout)), pty: true });
      const all = `${r.out}${r.err}`;
      // A healthy TUI stays resident waiting for input, so ETIMEDOUT is the
      // EXPECTED end state — the judgment is what the screen managed to render.
      // Two legs, not a word list: (1) a REAL surface — the sign-in chooser's
      // prompt row or the TUI's boxed input chrome (unicode or ASCII theme);
      // (2) an explicit crash list that must not appear. A stack dump
      // mentioning 'runtime'/'login' passed the old word list while never
      // drawing a card. Bare product nouns ('ZCode desktop', the install
      // hint) are NOT a surface on their own — a resident fatal frame can
      // name the product while rendering nothing. The runtime-free path
      // never reaches the chooser: the CLI runs the doctor diagnosis and
      // exits, so the anchored 'runtime:' line counts only when the process
      // exited VOLUNTARILY — a frame that prints the words and then hangs
      // until ^C/timeout kills it (code >=128 or 124) still fails.
      const SURFACE = /sign in \[1\/2\/3\]:|[╭╰]─{2,}|│\s*>|\+-{2,}\+|\|\s*>/;
      const CRASH = /^\s*at .+\.[cm]?js:\d+|node:internal|Uncaught|\b\w*Error:|Cannot find (?:module|package)|ExperimentalWarning|exited/im;
      const doctorExit = !r.timedOut && r.code !== null && r.code !== 124 && r.code < 128 && /^runtime: /m.test(all);
      if (!SURFACE.test(all) && !doctorExit)
        throw new Error(`no recognizable surface in the boot frame: ${all.slice(-120).replace(/\s+/g, ' ')}`);
      if (CRASH.test(all)) throw new Error('a crash reached the screen');
      return { sha256: r.sha256, detail: r.timedOut ? 'resident past ^C (timeout-killed)' : r.code === 124 ? 'resident past ^C (inner timeout)' : 'exited on ^C' };
    });
  }

  const fails = results.filter(r => r.verdict === 'FAIL');
  const verdict = fails.length ? 'FAIL' : 'PASS';
  mkdirSync(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, `soak-${(installedVersion ?? 'local').replace(/[^\w.-]/g, '_')}-${stamp}-${process.pid}.md`);
  writeFileSync(receiptPath, [
    `# real-user soak — ${verdict}`,
    ``,
    `- source: ${source}`,
    `- expected version: ${installedVersion ?? 'UNBOUND (--bin without --version)'}`,
    `- date: ${new Date().toISOString()} (${platform()}-${arch()}, node ${process.version})`,
    `- home: fresh credential-free sandbox; pty leg: ${withPty ? 'on' : 'off'}`,
    `- env passthrough: ZCODE_RUNTIME=${env.ZCODE_RUNTIME ?? 'unset'}, ZAGENT_UPDATE_CHECK=${env.ZAGENT_UPDATE_CHECK ?? 'unset'}, CI=${env.CI ?? 'unset'}`,
    `- registry: ${registry}`,
    ``,
    `| probe | verdict | transcript sha256 | detail |`,
    `| --- | --- | --- | --- |`,
    ...results.map(r => `| ${r.name} | ${r.verdict} | ${r.sha256?.slice(0, 16) ?? '—'} | ${(r.detail ?? '').replace(/\|/g, '/')} |`),
    ``,
    `Replay top workflows against the published artifact so`,
    `integration drift between rapid releases surfaces before users do.`,
    `Battery is deliberately credential-free; live-turn legs stay in the`,
    `ZAGENT_LIVE journeys. Scheduling (cron/systemd) is left to the operator.`,
    ``,
  ].join('\n'));
  console.log(`\nreceipt: ${receiptPath}`);
  if (fails.length) {
    console.error(`SOAK FAILED: ${fails.map(f => f.name).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`SOAK PASSED: ${results.length} probes against ${source}`);
  }
} finally {
  if (keep) console.log(`kept: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
