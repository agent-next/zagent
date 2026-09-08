import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CP-1: cross-platform runtime discovery. The official desktop ships the same kernel
// bundle (resources/glm/zcode.cjs) under per-OS install roots:
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

export function findRuntime({ env = process.env, home = os.homedir(), cwd = process.cwd(),
                              platform = process.platform, exists = existsSync } = {}) {
  const p = { home, localAppData: env.LOCALAPPDATA ?? '', appData: env.APPDATA ?? '' };
  const candidate = (entry, kind) => entry && exists(entry) ? { entry, kind, root: path.dirname(entry) } : null;
  // An explicit override is authoritative, including when it is invalid.
  if (env.ZCODE_RUNTIME) return candidate(path.resolve(cwd, env.ZCODE_RUNTIME), 'explicit');
  // third-party zcode-app-cli (npm layout per-OS), then cwd install
  const appCliRoots = platform === 'win32'
    ? [path.join(p.appData ?? '', 'npm'), path.join(p.localAppData ?? '', 'npm'), cwd] // r1: %APPDATA%\npm is the standard per-user prefix
    : [`${home}/.local/opt/zcode-app-cli`, cwd];
  for (const root of appCliRoots) {
    const found = candidate(path.join(root, 'node_modules', 'zcode-app-cli', 'bin', 'zcode.js'), 'zcode-app-cli');
    if (found) return found;
  }
  // official desktop bundle, per-OS install roots in priority order
  for (const entry of desktopRuntimeEntries({ env, home, platform })) {
    const found = candidate(entry, 'desktop-bundle');
    if (found) return found;
  }
  return null;
}
