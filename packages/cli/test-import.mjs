#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, 'packages/cli/zagent-import.mjs');
const bin = path.join(root, 'bin/zagent');
const home = mkdtempSync(path.join(tmpdir(), 'zagent-import-cli-home-'));
const cwd = mkdtempSync(path.join(tmpdir(), 'zagent-import-cli-cwd-'));
const secret = 'dummy-secret-0001';

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  ZAGENT_TEST_SANDBOX: home,
  TMPDIR: path.join(home, 'tmp'),
  TEMP: path.join(home, 'tmp'),
  TMP: path.join(home, 'tmp'),
};
mkdirSync(path.join(home, 'tmp'), { recursive: true });

const run = (entry, args) => spawnSync(process.execPath, [entry, ...args], {
  encoding: 'utf8',
  timeout: 15000,
  cwd,
  env,
});

try {
  mkdirSync(path.join(home, '.claude', 'commands'), { recursive: true });
  mkdirSync(path.join(home, '.claude', 'skills', 'demo'), { recursive: true });
  mkdirSync(path.join(cwd, '.claude', 'commands'), { recursive: true });
  writeFileSync(path.join(cwd, 'CLAUDE.md'), `do not leak ${secret}\n`);
  writeFileSync(path.join(home, '.claude', 'commands', 'review.md'), '# /review\n');
  writeFileSync(path.join(cwd, '.claude', 'commands', 'ship.md'), '# /ship\n');
  writeFileSync(path.join(home, '.claude', 'skills', 'demo', 'SKILL.md'), '# Demo\n');

  const dry = run(cli, ['--dry-run', '--json']);
  assert.equal(dry.status, 0, dry.stderr);
  const report = JSON.parse(dry.stdout);
  assert.equal(report.mode, 'dry-run');
  assert.deepEqual(report.sources.map((s) => s.id),
    ['claude-md', 'user-commands', 'workspace-commands', 'user-skills']);
  assert.ok(report.items.some((i) => i.name === 'CLAUDE.md'));
  assert.ok(report.items.some((i) => i.name === 'review.md'));
  assert.ok(report.items.some((i) => i.name === 'ship.md'));
  assert.ok(report.items.some((i) => i.name === 'demo'));
  assert.equal(existsSync(path.join(cwd, 'AGENTS.md')), false, 'dry-run must not write AGENTS.md');
  assert.equal(existsSync(path.join(home, '.zcode')), false, 'dry-run must not write ~/.zcode');
  assert.equal(dry.stdout.includes(secret), false, 'dry-run JSON must not print secrets');
  assert.equal(dry.stderr.includes(secret), false, 'dry-run stderr must not print secrets');
  assert.equal(dry.stdout.includes(home), false, 'dry-run JSON must not print the absolute home path');

  const human = run(cli, ['--dry-run']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /CLAUDE\.md/);
  assert.match(human.stdout, /~\/\.claude\/commands/);
  assert.match(human.stdout, /\.claude\/commands/);
  assert.match(human.stdout, /~\/\.claude\/skills/);
  assert.match(human.stdout, /no writes/);
  assert.equal(human.stdout.includes(secret), false);
  assert.equal(human.stdout.includes(home), false, 'dry-run human output must not print the absolute home path');

  const def = run(cli, ['--json']);
  assert.equal(def.status, 0, def.stderr);
  assert.equal(JSON.parse(def.stdout).mode, 'dry-run', 'default without --apply is dry-run');

  const applied = run(cli, ['--apply', '--json']);
  assert.equal(applied.status, 0, applied.stderr);
  const after = JSON.parse(applied.stdout);
  assert.equal(after.mode, 'apply');
  assert.ok(after.summary.written >= 3);
  const agents = readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');
  assert.match(agents, /<!-- zagent-import:claude -->/);
  assert.match(agents, /<!-- \/zagent-import:claude -->/);
  assert.equal(existsSync(path.join(home, '.zcode', 'commands', 'review.md')), true);
  assert.equal(existsSync(path.join(cwd, '.zcode', 'commands', 'ship.md')), true);
  assert.equal(existsSync(path.join(home, '.zcode', 'commands', 'ship.md')), false);
  assert.equal(existsSync(path.join(home, '.zcode', 'skills', 'demo', 'SKILL.md')), true);
  assert.equal(applied.stdout.includes(secret), false, 'apply JSON must not print secrets');

  writeFileSync(path.join(home, '.zcode', 'commands', 'review.md'), 'KEEP\n');
  const again = run(cli, ['--apply', '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(path.join(home, '.zcode', 'commands', 'review.md'), 'utf8'), 'KEEP\n');
  assert.equal(JSON.parse(again.stdout).items.find((i) => i.name === 'review.md').action, 'skipped');

  const forced = run(cli, ['--apply', '--force', '--json']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(readFileSync(path.join(home, '.zcode', 'commands', 'review.md'), 'utf8'), '# /review\n');

  const both = run(cli, ['--apply', '--dry-run', '--json']);
  assert.equal(both.status, 0, both.stderr);
  assert.equal(JSON.parse(both.stdout).mode, 'dry-run', '--dry-run wins over --apply');

  const bad = run(cli, ['--unknown']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage: zagent import/);

  const help = spawnSync(process.execPath, [bin, 'import', '--help'], {
    encoding: 'utf8', timeout: 15000, cwd, env,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /zagent import/);

  console.log('ok - import CLI dry-run/apply/json/force/redaction');
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
process.exit(0);
