// CP-1: cross-platform discovery table — platform dispatch with injected exists().
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRuntime, DEFAULT_RUNTIME } from './runtime.mjs';

// linux default unchanged
assert.equal(findRuntime({ env: {}, platform: 'linux', exists: p => p === DEFAULT_RUNTIME }).entry, DEFAULT_RUNTIME);
// linux second root
assert.equal(findRuntime({ env: {}, platform: 'linux', exists: p => p === '/usr/lib/zcode/resources/glm/zcode.cjs' }).entry,
  '/usr/lib/zcode/resources/glm/zcode.cjs');
// macOS: system Applications first, then ~/Applications
assert.equal(findRuntime({ env: {}, home: '/u/x', platform: 'darwin', exists: p => p === '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs' }).kind, 'desktop-bundle');
assert.equal(findRuntime({ env: {}, home: '/u/x', platform: 'darwin', exists: p => p === '/u/x/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs' }).entry,
  '/u/x/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs');
// windows: LOCALAPPDATA per-user first
const wenv = { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' };
assert.equal(findRuntime({ env: wenv, platform: 'win32', exists: p => p === 'C:\\Users\\x\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs' }).entry,
  'C:\\Users\\x\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs');
// windows: machine-wide when per-user absent
assert.equal(findRuntime({ env: wenv, platform: 'win32', exists: p => p === 'C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs' }).entry,
  'C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs');
// windows: app-cli global npm root (%APPDATA%\npm = standard per-user prefix) — exact path
assert.equal(findRuntime({ env: wenv, platform: 'win32', exists: p => p === 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\zcode-app-cli\\bin\\zcode.js' || p.includes('node_modules') }).entry.includes('Roaming'), true);
// LOCALAPPDATA-based npm fallback only when APPDATA root absent

// unix app-cli is still found when no desktop bundle exists
assert.equal(findRuntime({ env: {}, home: '/u', platform: 'linux', exists: p => p.includes('zcode-app-cli') }).kind, 'zcode-app-cli');
// the official desktop bundle outranks zcode-app-cli when both exist
assert.equal(findRuntime({ env: {}, home: '/u', platform: 'linux',
  exists: p => p === DEFAULT_RUNTIME || p.includes('zcode-app-cli') }).kind, 'desktop-bundle');
// explicit override wins everywhere
assert.equal(findRuntime({ env: { ZCODE_RUNTIME: '/any/z.cjs' }, platform: 'win32', exists: () => true }).kind, 'explicit');
// nothing anywhere → null (all platforms)
assert.equal(findRuntime({ env: {}, platform: 'win32', exists: () => false }), null);
assert.equal(findRuntime({ env: {}, platform: 'darwin', exists: () => false }), null);
// unknown platform falls back to linux roots
assert.equal(findRuntime({ env: {}, platform: 'freebsd', exists: p => p === DEFAULT_RUNTIME }).entry, DEFAULT_RUNTIME);

// version: zcode-app-cli reads its own package.json
const appCliEntry = '/u/.local/opt/zcode-app-cli/node_modules/zcode-app-cli/bin/zcode.js';
const appCliPkg = '/u/.local/opt/zcode-app-cli/node_modules/zcode-app-cli/package.json';
assert.equal(findRuntime({ env: {}, home: '/u', platform: 'linux', exists: p => p === appCliEntry,
  read: p => p === appCliPkg ? '{"version":"3.10.2-19"}' : '{}' }).version, '3.10.2-19');
// version: the desktop on linux reads the .deb metadata; the deb revision is the build number
// (noAsar keeps these probes hermetic — a real /opt/ZCode install would answer first)
const noAsar = () => null;
const dpkgStatus = 'Package: zcode\nStatus: install ok installed\nVersion: 3.11.2-6792\n';
assert.equal(findRuntime({ env: {}, platform: 'linux', exists: p => p === DEFAULT_RUNTIME, asar: noAsar,
  read: p => p === '/var/lib/dpkg/status' ? dpkgStatus : '' }).version, '3.11.2');
// version: resources/app-update.yml is the fallback when the deb metadata has none
assert.equal(findRuntime({ env: {}, platform: 'linux', exists: p => p === DEFAULT_RUNTIME, asar: noAsar,
  read: p => p === '/opt/ZCode/resources/app-update.yml' ? 'provider: generic\nversion: 3.11.3\n' : '' }).version, '3.11.3');
// version: resources/glm/.node-bundle-meta.json is the last resort
assert.equal(findRuntime({ env: {}, platform: 'linux', exists: p => p === DEFAULT_RUNTIME, asar: noAsar,
  read: p => p === '/opt/ZCode/resources/glm/.node-bundle-meta.json' ? '{"version":"9.9.9"}' : '' }).version, '9.9.9');
// version: unreadable or absent metadata stays null and never throws
assert.equal(findRuntime({ env: {}, platform: 'linux', exists: p => p === DEFAULT_RUNTIME, asar: noAsar,
  read: () => { throw new Error('unreadable'); } }).version, null);
assert.equal(findRuntime({ env: {}, platform: 'linux', exists: p => p === DEFAULT_RUNTIME, asar: noAsar,
  read: () => 'garbage' }).version, null);
// explicit override in an unknown layout carries no probed version
assert.equal(findRuntime({ env: { ZCODE_RUNTIME: '/any/z.cjs' }, platform: 'linux', exists: () => true }).version, null);

// explicit override inside a known desktop layout still resolves version
// (kind stays 'explicit'); the .deb metadata applies on linux
const explicitDeb = findRuntime({ env: { ZCODE_RUNTIME: '/opt/ZCode/resources/glm/zcode.cjs' },
  platform: 'linux', exists: () => true, asar: noAsar,
  read: p => p === '/var/lib/dpkg/status' ? dpkgStatus : '' });
assert.equal(explicitDeb.kind, 'explicit');
assert.equal(explicitDeb.version, '3.11.2');
// the .deb stanza is system-wide: a desktop-layout override OUTSIDE the
// dpkg-owned roots must not inherit it (the 3.12.1-mislabeled-3.11.2 bug)
assert.equal(findRuntime({ env: { ZCODE_RUNTIME: '/x/resources/glm/zcode.cjs' },
  platform: 'linux', exists: () => true, asar: noAsar,
  read: p => p === '/var/lib/dpkg/status' ? dpkgStatus : '' }).version, null);
// the second dpkg-owned root still qualifies
assert.equal(findRuntime({ env: { ZCODE_RUNTIME: '/usr/lib/zcode/resources/glm/zcode.cjs' },
  platform: 'linux', exists: () => true, asar: noAsar,
  read: p => p === '/var/lib/dpkg/status' ? dpkgStatus : '' }).version, '3.11.2');
// explicit desktop override falls back to resources/app-update.yml
assert.equal(findRuntime({ env: { ZCODE_RUNTIME: '/x/resources/glm/zcode.cjs' }, platform: 'linux',
  exists: () => true, asar: noAsar,
  read: p => p === '/x/resources/app-update.yml' ? 'version: 3.11.3\n' : '' }).version, '3.11.3');
// explicit zcode-app-cli override reads the package's own package.json
assert.equal(findRuntime({ env: { ZCODE_RUNTIME: appCliEntry }, platform: 'linux',
  exists: () => true, read: p => p === appCliPkg ? '{"version":"3.10.2-19"}' : '' }).version, '3.10.2-19');

// fixture dirs: the same probes through the real filesystem
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'zrt-'));
try {
  // real host paths → the host platform: a simulated platform makes findRuntime
  // resolve them under the OTHER os's path rules and they never exist
  const glm = path.join(fixtureRoot, 'ZCode.app', 'Contents', 'Resources', 'glm');
  mkdirSync(glm, { recursive: true });
  writeFileSync(path.join(glm, 'zcode.cjs'), '');
  writeFileSync(path.join(glm, '..', 'app-update.yml'), 'provider: generic\nversion: 9.8.7\n');
  const fxDesktop = findRuntime({ env: { ZCODE_RUNTIME: path.join(glm, 'zcode.cjs') }, platform: process.platform });
  assert.equal(fxDesktop.kind, 'explicit');
  assert.equal(fxDesktop.version, '9.8.7');
  // zcode-app-cli layout reads the adjacent package.json
  const cliBin = path.join(fixtureRoot, 'opt', 'node_modules', 'zcode-app-cli', 'bin');
  mkdirSync(cliBin, { recursive: true });
  writeFileSync(path.join(cliBin, 'zcode.js'), '');
  writeFileSync(path.join(cliBin, '..', 'package.json'), '{"version":"3.10.2-19"}');
  const fxCli = findRuntime({ env: { ZCODE_RUNTIME: path.join(cliBin, 'zcode.js') }, platform: process.platform });
  assert.equal(fxCli.kind, 'explicit');
  assert.equal(fxCli.version, '3.10.2-19');
  // a real lone file keeps version null even where a zcode .deb is installed
  const lone = path.join(fixtureRoot, 'z.cjs');
  writeFileSync(lone, '');
  assert.equal(findRuntime({ env: { ZCODE_RUNTIME: lone }, platform: process.platform }).version, null);

  // a real asar: out/metadata/build-meta.json appVersion is the app's own label
  const asarRoot = path.join(fixtureRoot, 'zcode121', 'resources');
  mkdirSync(path.join(asarRoot, 'glm'), { recursive: true });
  writeFileSync(path.join(asarRoot, 'glm', 'zcode.cjs'), '');
  const meta = Buffer.from('{"appVersion":"3.12.1","buildCommitId":"dfc10615"}');
  const hdr = Buffer.from(JSON.stringify({ files: { out: { files: { metadata: { files: {
    'build-meta.json': { offset: '0', size: meta.length } } } } } } }));
  const head = Buffer.alloc(16); head.writeUInt32LE(hdr.length, 12);
  const base = Math.ceil((16 + hdr.length) / 4) * 4;
  writeFileSync(path.join(asarRoot, 'app.asar'),
    Buffer.concat([head, hdr, Buffer.alloc(base - 16 - hdr.length), meta]));
  const fxAsar = findRuntime({ env: { ZCODE_RUNTIME: path.join(asarRoot, 'glm', 'zcode.cjs') }, platform: process.platform });
  assert.equal(fxAsar.kind, 'explicit');
  assert.equal(fxAsar.version, '3.12.1', 'asar build-meta labels a runtime outside the dpkg roots');
  // ...and it still wins where dpkg would answer (the stanza is for /opt, not here)
  assert.equal(findRuntime({ env: { ZCODE_RUNTIME: path.join(asarRoot, 'glm', 'zcode.cjs') },
    platform: process.platform, read: p => p === '/var/lib/dpkg/status' ? dpkgStatus : '' }).version, '3.12.1');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('PASS runtime-xplat');
