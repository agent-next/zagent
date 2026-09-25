#!/usr/bin/env node
// Install the package the way a stranger would, then use it.
//
// Every defect in 0.0.185 lived in the same blind spot: the gate tested the
// SOURCE TREE and nothing ever exercised the shipped artifact. So what broke was
// exactly what only a real user touches — `zagent models --help` printed nothing
// and exited 0, `diff --help` was read as a session id, both READMEs advertised a
// Node version the manifest did not enforce, and the gate did not even discover
// packages/ClI, so a test for those commands would never have run.
//
// This exports, packs, installs into a throwaway prefix, and drives the installed
// binary. It asserts behaviour a user depends on, not the presence of files.
//
//   node scripts/outsider-smoke.mjs            # full run
//   node scripts/outsider-smoke.mjs --keep     # leave the install for inspection
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, verbOf } from '../packages/cli/commands.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const version = readFileSync(path.join(root, 'VERSION'), 'utf8').trim();

const fails = [];
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { fails.push(name); console.log(`  FAIL ${name}\n         ${e.message.split('\n')[0]}`); }
};

const work = mkdtempSync(path.join(tmpdir(), 'zagent-outsider-'));
const prefix = path.join(work, 'prefix');
const bin = path.join(prefix, 'bin', 'zagent');

/** Run the INSTALLED binary, never the source tree. */
function zagent(args, opts = {}) {
  const r = spawnSync(bin, args, {
    encoding: 'utf8', timeout: 120_000, cwd: opts.cwd ?? work,
    env: { ...process.env, npm_config_prefix: prefix },
  });
  return { code: r.status, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}` };
}

try {
  console.log(`outsider smoke for ${version}`);
  console.log('[1] export + pack');
  const src = path.join(work, 'src');
  execFileSync(process.execPath, ['scripts/export-public-source.mjs', src],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('npm', ['pack', '--silent'], { cwd: src, encoding: 'utf8' });
  const tgz = readdirSync(src).find(f => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack produced no tarball');
  console.log(`    ${tgz}`);

  console.log('[2] install into a throwaway prefix (the documented command)');
  execFileSync('npm', ['install', '-g', path.join(src, tgz)],
    { cwd: work, encoding: 'utf8', env: { ...process.env, npm_config_prefix: prefix }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!existsSync(bin)) throw new Error(`no zagent binary at ${bin}`);

  console.log('[3] use it');

  check('the installed binary reports the version being released', () => {
    const { code, out } = zagent(['--version']);
    if (code !== 0) throw new Error(`exit ${code}`);
    const line = out.trim().split('\n')[0];
    if (line !== `zagent ${version}`) throw new Error(`reported ${line}, releasing ${version}`);
  });

  check('the `za` alias is installed and works', () => {
    const za = path.join(prefix, 'bin', 'za');
    if (!existsSync(za)) throw new Error('za is not installed');
    const r = spawnSync(za, ['--version'], { encoding: 'utf8', timeout: 60_000 });
    const line = `${r.stdout}`.trim().split('\n')[0];
    if (line !== `zagent ${version}`) throw new Error(`za reported ${line}`);
  });

  // The defect that started this: --help was passed through to scripts that had
  // no notion of it, so several commands printed NOTHING and exited 0.
  for (const [sig] of COMMANDS) {
    const verb = verbOf(sig);
    if (verb.startsWith('-') || verb === '(default)') continue;
    check(`\`zagent ${verb} --help\` explains itself`, () => {
      const { code, out, err } = zagent([verb, '--help']);
      if (code !== 0) throw new Error(`exit ${code}: ${(err || out).slice(0, 80)}`);
      if (!out.trim()) throw new Error('printed nothing');
      if (!out.includes(verb)) throw new Error(`help does not mention ${verb}: ${out.slice(0, 60)}`);
    });
  }

  // J8 (ux-inventory-20260914.md §10): a stranger's first diagnostic commands —
  // doctor explains, inspect --json parses. Neither may need a runtime.
  check('J8 `zagent doctor` diagnoses instead of printing a stack', () => {
    const { out, err } = zagent(['doctor']);
    if (!/runtime:/.test(out)) throw new Error(`no runtime line: ${(out || err).slice(0, 80)}`);
    if (/^\s*at .*\.mjs:\d+/m.test(`${out}${err}`)) throw new Error('a stack trace reached the user');
  });

  check('J8 `zagent inspect --json` prints parseable JSON', () => {
    const { code, out, err } = zagent(['inspect', '--json']);
    if (code !== 0) throw new Error(`exit ${code}: ${err.slice(0, 80)}`);
    try { JSON.parse(out); } catch { throw new Error(`not JSON: ${out.slice(0, 80)}`); }
  });

  check('an unknown command fails, so a typo cannot pass in a script', () => {
    const { code } = zagent(['definitely-not-a-command']);
    if (code === 0) throw new Error('exited 0');
  });

  check('a source-only command is refused, not half-run', () => {
    const { code } = zagent(['telegram']);
    if (code !== 2) throw new Error(`exit ${code}, expected 2`);
  });

  check('a search that matches nothing says so instead of printing nothing', () => {
    const { code, out, err } = zagent(['models', 'zzz-no-such-model-zzz']);
    if (code === 0) throw new Error('exited 0 — indistinguishable from a broken command');
    if (!`${out}${err}`.trim()) throw new Error('printed nothing');
  });

  check('sqlite-backed commands do not leak node\'s experimental warning', () => {
    for (const verb of ['sessions', 'task']) {
      const { out, err } = zagent([verb, '--help']);
      if (/ExperimentalWarning/.test(`${out}${err}`)) throw new Error(`${verb} leaks ExperimentalWarning`);
    }
  });

  check('the README install command is the one that actually works', () => {
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    if (!/npm install -g zagent/.test(readme)) throw new Error('README no longer documents `npm install -g zagent`');
  });

  check('the shipped package passes its own tests from inside the install', () => {
    const installed = path.join(prefix, 'lib', 'node_modules', 'zagent');
    const r = spawnSync('npm', ['test'], { cwd: installed, encoding: 'utf8', timeout: 300_000 });
    if (r.status !== 0) throw new Error(`npm test exit ${r.status}`);
    if (!/"status":\s*"PASS"/.test(`${r.stdout}`)) throw new Error('no PASS verdict in output');
  });

  console.log();
  if (fails.length) {
    console.error(`OUTSIDER SMOKE FAILED: ${fails.length} check(s): ${fails.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`outsider smoke PASSED for ${version} — installed from a tarball and driven as a user`);
  }
} finally {
  if (keep) console.log(`\nkept: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
