import { existsSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
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

// The desktop image is an asar blob: the JSON file index sits at offset 16
// (its length is the u32 at 12) and file content follows the 4-aligned header
// — the layout research/gui/asar.py walks. Reading is ranged: never the whole
// ~300MB archive for one small JSON.
export function asarFile(asarPath, inner) {
  let fd;
  try {
    fd = openSync(asarPath, 'r');
    const head = Buffer.alloc(16);
    if (readSync(fd, head, 0, 16, 0) < 16) return null;
    const len = head.readUInt32LE(12);
    const hdr = Buffer.alloc(len);
    if (readSync(fd, hdr, 0, len, 16) < len) return null;
    let node = { files: JSON.parse(hdr.toString('utf8')).files };
    for (const part of inner.split('/')) node = node?.files?.[part];
    if (!node || node.files || node.size > 1 << 20) return null;
    const buf = Buffer.alloc(node.size);
    const base = Math.ceil((16 + len) / 4) * 4;
    if (readSync(fd, buf, 0, node.size, base + Number(node.offset)) < node.size) return null;
    return buf;
  } catch { return null; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

// The .deb stanza is system-wide, so it only applies under the install roots
// the package actually owns — an explicit runtime elsewhere must not inherit it.
const DPKG_ROOTS = DESKTOP_BUNDLES.linux.map(e => path.resolve(path.dirname(e), '..', '..'));
const dpkgOwned = entry => {
  const e = path.resolve(entry);
  return DPKG_ROOTS.some(r => e === r || e.startsWith(r + path.sep));
};

function desktopVersion(entry, platform, read, asar) {
  const glmDir = path.dirname(entry);
  // out/metadata/build-meta.json carries the app's own appVersion in every
  // layout (3.11.2 and 3.12.1 both ship it) — authoritative where dpkg is not.
  try {
    const v = JSON.parse(asar(path.join(glmDir, '..', 'app.asar'), 'out/metadata/build-meta.json'))?.appVersion;
    if (typeof v === 'string' && v) return v;
  } catch { /* older or partial installs may lack the asar index or the file */ }
  if (platform === 'linux' && dpkgOwned(entry)) {
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
function explicitVersion(entry, platform, read, asar) {
  const dir = path.dirname(entry);
  const tail = entry.replaceAll('\\', '/').toLowerCase(); // macOS uses Resources/, others resources/
  if (tail.endsWith('/resources/glm/zcode.cjs')) return desktopVersion(entry, platform, read, asar);
  if (tail.endsWith('/zcode-app-cli/bin/zcode.js')) return jsonVersion(path.join(dir, '..', 'package.json'), read);
  return null;
}

function runtimeVersion(entry, kind, { platform, read, asar }) {
  try {
    if (kind === 'zcode-app-cli') return jsonVersion(path.join(path.dirname(entry), '..', 'package.json'), read);
    if (kind === 'desktop-bundle') return desktopVersion(entry, platform, read, asar);
    if (kind === 'explicit') return explicitVersion(entry, platform, read, asar);
  } catch { /* version probing must never break discovery */ }
  return null;
}

// Desktop 3.12.1's kernel locates its built-in provider config only through
// ZCODE_BUILTIN_PROVIDER_CONFIG_FILE (the Electron host sets it before spawning
// zcode.cjs); without it the kernel probes the monorepo dev layout and exits
// "无法定位 CLI ZCode Built-in Provider Config". The bundled copy sits at
// <resources>/config/provider/zcode-builtin.json beside resources/glm/zcode.cjs.
// 3.11.2 never reads the variable, so setting it is safe on both — only when
// the caller has not set it and the file exists.
export function kernelEnv(entry, env = process.env, exists = existsSync) {
  if (env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) return env;
  const cfg = path.resolve(path.dirname(entry), '..', 'config', 'provider', 'zcode-builtin.json');
  return exists(cfg) ? { ...env, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: cfg } : env;
}

// Whether a bare specifier resolves from the kernel file's own directory —
// approximates the node_modules walk-up the kernel's dynamic
// `await import("playwright-core")` performs (ESM ignores NODE_PATH, so a
// manual walk is closer than require.resolve with its globalPaths fallback).
// The desktop bundle ships no node_modules beside resources/glm/zcode.cjs
// (the GUI uses the in-app browser instead), so --browser-use fails inside
// every turn on that runtime — live-verified on desktop 3.12.1 ("failed to
// load the pinned Playwright runtime"). Preflight hint, never a launch
// blocker.
export function kernelResolves(entry, specifier) {
  for (let dir = path.dirname(path.resolve(entry)); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'node_modules', specifier, 'package.json'))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

export function findRuntime({ env = process.env, home = os.homedir(), cwd = process.cwd(),
                              platform = process.platform, exists = existsSync,
                              read = p => readFileSync(p, 'utf8'), asar = asarFile } = {}) {
  const p = { home, localAppData: env.LOCALAPPDATA ?? '', appData: env.APPDATA ?? '' };
  const candidate = (entry, kind) => entry && exists(entry)
    ? { entry, kind, root: path.dirname(entry), version: runtimeVersion(entry, kind, { platform, read, asar }) }
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
