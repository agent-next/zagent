#!/usr/bin/env node
// Export the reviewed distribution sources, never repository history.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { allowed, forbidden, npmInvocation } from './verify-public-package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!target || !path.isAbsolute(target)) throw new Error('Supply an absolute path to a NEW export directory');
const output = path.resolve(target);
if (existsSync(output)) throw new Error('Export target already exists');
const realRoot = realpathSync(root);
const realParent = realpathSync(path.dirname(output));
const realOutput = path.join(realParent, path.basename(output));
if (realOutput === realRoot || realRoot.startsWith(realOutput + path.sep) || realOutput.startsWith(realRoot + path.sep))
  throw new Error('Export must be outside the source checkout');
const temp = mkdtempSync(path.join(os.tmpdir(), 'zagent-export-'));
let created = false;
try {
  const npm = npmInvocation();
  const packed = spawnSync(npm.command, [...npm.args, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root, encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: temp, USERPROFILE: temp, TMPDIR: temp, TMP: temp, TEMP: temp,
      npm_config_cache: path.join(temp, 'cache'), npm_config_userconfig: path.join(temp, 'absent-npmrc') },
  });
  if (packed.error || packed.status !== 0) throw new Error('npm payload enumeration failed');
  const files = JSON.parse(packed.stdout)[0].files.map(f => f.path);
  if (!files.every(rel => allowed(rel) && !forbidden.test(rel)))
    throw new Error('npm payload violates the public export allowlist');
  files.push('package-lock.json', 'scripts/verify-public-package.mjs', 'docs/README.zh-CN.md');
  mkdirSync(output); // exclusive: never overwrite an existing directory
  created = true;
  for (const rel of files) {
    if (path.isAbsolute(rel) || rel.split('/').includes('..') || rel.startsWith('.git/'))
      throw new Error('Unsafe export entry');
    const source = path.join(root, rel);
    if (!lstatSync(source).isFile()) throw new Error(`Non-regular export entry: ${rel}`);
    mkdirSync(path.dirname(path.join(output, rel)), { recursive: true });
    copyFileSync(source, path.join(output, rel));
  }
  // Files whose exported path differs from their source-tree path.
  //
  // The cross-platform matrix belongs on the public repo: it ships the
  // generated export, i.e. exactly the code users install, so it is the honest
  // place to make a cross-platform claim.
  const RENAMED = new Map([
    ['.github/public-workflows/test-matrix.yml', '.github/workflows/test-matrix.yml'],
    // The public repo's CHANGELOG.md is public-only (the overlay preserves it),
    // so nothing ever refreshed it — it sat at 0.0.180 while npm moved on. The
    // curated public changelog lives in the source tree and exports under its
    // public name.
    ['docs/public/CHANGELOG.md', 'CHANGELOG.md'],
  ]);
  for (const [from, to] of RENAMED) {
    const source = path.join(root, from);
    if (!existsSync(source)) throw new Error(`missing renamed export entry: ${from}`);
    mkdirSync(path.dirname(path.join(output, to)), { recursive: true });
    copyFileSync(source, path.join(output, to));
    files.push(to);
  }

  const pkg = JSON.parse(readFileSync(path.join(output, 'package.json'), 'utf8'));
  pkg.scripts = { test: 'node scripts/verify-public-package.mjs' };
  // Public package metadata (the source tree's repo url must not travel to npm).
  // The NAME is part of that metadata. The source manifest is named zagent too,
  // but this explicit rewrite stays as a defensive invariant: without it any
  // future rename of the source manifest would ship the wrong package AND
  // rewrite the public repo's package.json name away from zagent.
  pkg.name = 'zagent';
  // A source manifest may carry private:true so an accidental `npm publish`
  // from the source tree cannot touch the live public name; strip it here.
  delete pkg.private;
  // The lockfile is copied verbatim, so its name fields are forced to zagent
  // alongside the manifest — npm treats a manifest/lockfile name mismatch as a
  // different package and the mismatch travels to the public repo.
  try {
    const lockPath = path.join(output, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.name = 'zagent';
    if (lock.packages?.['']) lock.packages[''].name = 'zagent';
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  } catch { /* no lockfile in the payload: nothing to keep in sync */ }
  // The exported package's `npm test` runs the verify script, so it must actually
  // ship. files[] carried no scripts entry, so npm pack excluded it and a consumer
  // running `npm test` got "Cannot find module .../scripts/verify-public-package.mjs".
  pkg.files = [...new Set([...(pkg.files ?? []), 'scripts/verify-public-package.mjs'])].sort();
  pkg.repository = { type: 'git', url: 'git+https://github.com/agent-next/zagent.git' };
  pkg.homepage = 'https://github.com/agent-next/zagent#readme';
  pkg.bugs = { url: 'https://github.com/agent-next/zagent/issues' };
  pkg.keywords = [...new Set([...(pkg.keywords || []), 'zagent', 'glm', 'glm-coding-plan', 'coding-agent', 'terminal', 'tui', 'cli', 'ai', 'llm', 'agent'])].sort();
  writeFileSync(path.join(output, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  console.log(JSON.stringify({ output, files: files.length, historyIncluded: false,
    scope: 'distribution sources plus offline package smoke; development tests are not exported',
    reviewRequired: true }, null, 2));
} catch (error) {
  if (created) rmSync(output, { recursive: true, force: true });
  throw error;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
