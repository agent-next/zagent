import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = mkdtempSync(path.join(os.tmpdir(), 'zagent-export-test-'));
const rejectedName = `.zagent-rejected-${path.basename(fixture)}`;
const rejectedSourcePath = path.join(root, rejectedName);
const run = target => spawnSync(process.execPath, ['scripts/export-public-source.mjs', target], {
  cwd: root,
  encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: fixture, USERPROFILE: fixture,
    npm_config_cache: path.join(fixture, 'cache'), npm_config_userconfig: path.join(fixture, 'absent-npmrc') },
  timeout: 120000,
});

try {
  symlinkSync(root, path.join(fixture, 'source-link'));
  const throughSymlink = path.join(fixture, 'source-link', rejectedName);
  let result = run(throughSymlink);
  assert.notEqual(result.status, 0, 'export through a symlink parent into source must fail');
  assert(!existsSync(throughSymlink), 'rejected export must not create a source child');

  const existing = path.join(fixture, 'existing');
  mkdirSync(existing);
  writeFileSync(path.join(existing, 'keep'), 'untouched');
  result = run(existing);
  assert.notEqual(result.status, 0, 'existing export target must fail');
  assert.equal(readFileSync(path.join(existing, 'keep'), 'utf8'), 'untouched');

  const output = path.join(fixture, 'public-source');
  result = run(output);
  assert.equal(result.status, 0, result.stderr);
  assert(existsSync(path.join(output, 'package.json')), 'outside export must succeed');
  assert(!existsSync(path.join(output, '.git')), 'export must not contain Git history');

  // The published identity. The private manifest is also named zagent now, but the
  // exporter's explicit rewrite stays as a defensive invariant so a future private
  // rename can never ship the wrong package.
  const exported = JSON.parse(readFileSync(path.join(output, 'package.json'), 'utf8'));
  assert.equal(exported.name, 'zagent', 'the exported package must be named zagent');
  assert.equal(exported.private, undefined, 'the exported package must not carry private:true');
  assert.deepEqual(Object.keys(exported.bin ?? {}).sort(), ['za', 'zagent'],
    'the exported package installs the zagent and za commands');
  assert(String(exported.repository?.url ?? '').includes('agent-next/zagent'),
    'the exported repository url must point at the public repo, never the private one');
  // The private source repo name, assembled so this guard file never carries it.
  const privateRepoName = ['zcode', 'cli'].join('-');
  assert(!JSON.stringify(exported).includes(privateRepoName),
    'no reference to the private source repo may travel to npm');
  assert.equal(exported.scripts.test, 'node scripts/verify-public-package.mjs');
  assert(existsSync(path.join(output, 'scripts/verify-public-package.mjs')),
    'the exported test command must have its implementation');
  const workflow = readFileSync(path.join(output, '.github/workflows/test-matrix.yml'), 'utf8');
  for (const [, script] of workflow.matchAll(/\b(packages\/[\w./-]+\.mjs)\b/g)) {
    assert(existsSync(path.join(output, script)), `public workflow references missing exported test: ${script}`);
  }
  assert.match(workflow, /run: npm test\s*$/m, 'public matrix must run the exported package verifier');
  // The public repo's changelog is public-only, so the overlay never refreshed
  // it — it froze at the first-release entry while npm moved on. The curated
  // changelog now exports via the rename map; pin that it names THIS version so
  // a release that forgets to update it fails here, not on the public repo.
  const changelog = readFileSync(path.join(output, 'CHANGELOG.md'), 'utf8');
  assert(changelog.includes(`## ${exported.version} —`),
    'exported CHANGELOG.md must name the current version (docs/public/CHANGELOG.md)');
  // Nothing in the published payload may point at material a public reader cannot
  // reach. Found by checksumming a release candidate: four shipped modules cited
  // private verification receipts a public reader cannot open, and the
  // LICENSE still carried the pre-rename project name.
  const privateReceiptDir = ['artifacts', 'verify'].join('/');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  for (const file of walk(output)) {
    const body = readFileSync(file, 'utf8');
    const rel = path.relative(output, file);
    assert(!body.includes(privateReceiptDir),
      `${rel} cites a private receipt path that a public reader cannot open`);
    assert(!/out\/(host|renderer|main)\//.test(body),
      `${rel} cites decompiled runtime source`);
  }
  const license = readFileSync(path.join(output, 'LICENSE'), 'utf8');
  assert(license.includes('zagent contributors'),
    'LICENSE must carry the published project name, not the pre-rename one');
  console.log('PASS public export target safety');
} finally {
  if (existsSync(rejectedSourcePath)) rmSync(rejectedSourcePath, { recursive: true, force: true });
  rmSync(fixture, { recursive: true, force: true });
}
