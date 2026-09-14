import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CP-1: cross-platform runtime discovery. Preference order: ZCODE_RUNTIME, then
// the official desktop bundle (the same kernel the GUI runs), then the
// third-party zcode-app-cli. The desktop ships the same kernel bundle
// (resources/glm/zcode.cjs) under per-OS install roots:
//   Linux   .deb → /opt/ZCode
//   macOS   .dmg → /Applications/ZCode.app/Contents (+ ~/Applications user install)
//   Windows NSIS machine-wide → C:\Program Files\ZCode ; Squirrel per-user →
//           %LOCALAPPDATA%\Programs\ZCode  (standard Electron layouts; CP-7 verifies)
// The third-party zcode-app-cli is an npm package: Unix ~/.local/opt layout vs
// Windows %APPDATA%\npm global root.
const DESKTOP_BUNDLES = {
  linux: ['/opt/ZCode/resources/glm/zcode.cjs', '/usr/lib/zcode/resources/glm/zcode.cjs'],
  darwin: ['/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
           p => `${p.home}/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`],
  win32: [p => `${p.localAppData}\\Programs\\ZCode\\resources\\glm\\zcode.cjs`,
          'C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs',
          'C:\\Program Files (x86)\\ZCode\\resources\\glm\\zcode.cjs'],
};

export const DEFAULT_RUNTIME = DESKTOP_BUNDLES.linux[0]; // legacy alias (linux deb path)

export function desktopRuntimeEntries({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const p = { home, localAppData: env.LOCALAPPDATA ?? '', appData: env.APPDATA ?? '' };
  return (DESKTOP_BUNDLES[platform] ?? DESKTOP_BUNDLES.linux)
    .map(entry => typeof entry === 'function' ? entry({ ...p, ...env }) : entry);
}

// The installed app version, best-effort and never throwing: zcode-app-cli
// carries its own package.json. The desktop's image is an asar blob, so on
// Linux the version is read from the .deb metadata (the deb revision is the
// build number: 3.11.2-6792 → 3.11.2), then resources/app-update.yml, then
// resources/glm/.node-bundle-meta.json — each only when it carries a version.
function jsonVersion(file, read) {
  try {
    const v = JSON.parse(read(file))?.version;
    return typeof v === 'string' && v ? v : null;
  } catch { return null; }
}

function debVersion(read) {
  try {
    const stanza = read('/var/lib/dpkg/status').split(/\r?\n\r?\n/)
      .find(s => /^Package: zcode$/m.test(s) && /^Status: install ok installed$/m.test(s));
    const v = stanza?.match(/^Version:[ \t]*(\S+)/m)?.[1];
    return v ? v.replace(/-[^-]+$/, '') : null;
  } catch { return null; }
}

function desktopVersion(glmDir, platform, read) {
  if (platform === 'linux') {
    const v = debVersion(read);
    if (v) return v;
  }
  try {
    const v = read(path.join(glmDir, '..', 'app-update.yml'))
      .match(/^version:[ \t]*['"]?([^\s'"]+)['"]?[ \t]*$/m)?.[1];
    if (v) return v;
  } catch { /* absent on some installs */ }
  return jsonVersion(path.join(glmDir, '.node-bundle-meta.json'), read);
}

// An explicit override keeps kind 'explicit' but still reports a version when
// its parent tree matches a known layout — the desktop resources/glm bundle or
// a zcode-app-cli npm install. The .deb metadata is only consulted through the
// desktop layout check, never for an arbitrary path.
function explicitVersion(entry, platform, read) {
  const dir = path.dirname(entry);
  const tail = entry.replaceAll('\\', '/').toLowerCase(); // macOS uses Resources/, others resources/
  if (tail.endsWith('/resources/glm/zcode.cjs')) return desktopVersion(dir, platform, read);
  if (tail.endsWith('/zcode-app-cli/bin/zcode.js')) return jsonVersion(path.join(dir, '..', 'package.json'), read);
  return null;
}

function runtimeVersion(entry, kind, { platform, read }) {
  try {
    if (kind === 'zcode-app-cli') return jsonVersion(path.join(path.dirname(entry), '..', 'package.json'), read);
    if (kind === 'desktop-bundle') return desktopVersion(path.dirname(entry), platform, read);
    if (kind === 'explicit') return explicitVersion(entry, platform, read);
  } catch { /* version probing must never break discovery */ }
  return null;
}

export function findRuntime({ env = process.env, home = os.homedir(), cwd = process.cwd(),
                              platform = process.platform, exists = existsSync,
                              read = p => readFileSync(p, 'utf8') } = {}) {
  const p = { home, localAppData: env.LOCALAPPDATA ?? '', appData: env.APPDATA ?? '' };
  const candidate = (entry, kind) => entry && exists(entry)
    ? { entry, kind, root: path.dirname(entry), version: runtimeVersion(entry, kind, { platform, read }) }
    : null;
  // An explicit override is authoritative, including when it is invalid.
  if (env.ZCODE_RUNTIME) return candidate(path.resolve(cwd, env.ZCODE_RUNTIME), 'explicit');
  // official desktop bundle, per-OS install roots in priority order
  for (const entry of desktopRuntimeEntries({ env, home, platform })) {
    const found = candidate(entry, 'desktop-bundle');
    if (found) return found;
  }
  // third-party zcode-app-cli (npm layout per-OS), then cwd install
  const appCliRoots = platform === 'win32'
    ? [path.join(p.appData ?? '', 'npm'), path.join(p.localAppData ?? '', 'npm'), cwd] // r1: %APPDATA%\npm is the standard per-user prefix
    : [`${home}/.local/opt/zcode-app-cli`, cwd];
  for (const root of appCliRoots) {
    const found = candidate(path.join(root, 'node_modules', 'zcode-app-cli', 'bin', 'zcode.js'), 'zcode-app-cli');
    if (found) return found;
  }
  return null;
}
