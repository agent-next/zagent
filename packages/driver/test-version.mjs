// Release oracle — the VERSION file is what the release lane bumps, but npm
// publishes the version in the root package.json. They drifted to 0.0.111 vs
// 0.0.78 (33 releases), so a publish would have shipped a stale version number.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, ok, summary } from './test-util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const versionFile = readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

ok(/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(versionFile), `VERSION is semver-shaped (${versionFile})`);
eq(pkg.version, versionFile, 'root package.json version matches the VERSION file');
eq(JSON.parse(readFileSync(path.join(root, 'packages/driver/package.json'), 'utf8')).version,
  versionFile, 'driver package version matches VERSION');

summary('version');
