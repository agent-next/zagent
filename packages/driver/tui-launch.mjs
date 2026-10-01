// How zagent launches the runtime for an interactive session.
//
// The official ZCode kernel imports '@zcode/tui' and z.ai ships no
// implementation, so `zcode tui` on a desktop-only install dies with
// "Cannot find package '@zcode/tui'". zagent supplies its own via a Node ESM
// resolve hook, which leaves the kernel byte-for-byte untouched.

import { existsSync } from 'node:fs';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TUI_LOADER = fileURLToPath(new URL('../tui/loader.mjs', import.meta.url));

// The loader named-imports module.registerHooks, which first shipped in Node
// 22.15.0 / 23.5.0 (the package's engines floor). On older Node the child dies at
// link time with a bare SyntaxError — a named import CANNOT be probed by import,
// so check the namespace here in the parent before spawning. Users hit this on
// macOS whenever an old /usr/local/bin/node wins PATH over the Homebrew one.
export const TUI_NODE_FLOOR = '>=22.15.0 (or >=23.5.0)';
export function tuiNodeSupported(m = nodeModule) {
  return typeof m.registerHooks === 'function';
}

// The kernel child is always spawned with --experimental-sqlite and itself
// imports node:sqlite — both first shipped in Node 22.5.0. Below that NOTHING
// works, headless included: the child dies on the flag before reaching the
// kernel, so the TUI-floor guard's "headless -p still works" would overclaim.
export const NODE_SQLITE_FLOOR = '>=22.5.0';
export function nodeSqliteSupported(v = process.versions.node) {
  const [maj, min] = v.split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 5);
}

/** Interactive means: no headless flag and no kernel passthrough that never
 *  touches '@zcode/tui' (the kernel's only import of it is a lazy `await import`
 *  on the TUI path — verified against the desktop bundle). Excluding
 *  login/logout also keeps them working on Node below the registerHooks floor. */
export function isInteractive(args = []) {
  return !args.some(a => a === '-p' || a === '--print' || a === '--prompt'
    || a.startsWith('-p=') || a.startsWith('--print=') || a.startsWith('--prompt=')
    || a === 'app-server' || a === 'login' || a === 'logout');
}

/**
 * Resolve a runtime entry to the KERNEL that actually imports '@zcode/tui'.
 *
 * The official desktop bundle's entry IS the kernel. zcode-app-cli's entry is a
 * launcher that does `spawn(node, [vendor/zcode.cjs, ...args])` — a fresh child
 * with no execArgv and no NODE_OPTIONS passthrough, so a --import hook installed
 * on the launcher never reaches the kernel and the launcher's own TUI renders
 * instead. Verified by running it: scripts/tui-smoke.mjs showed the third-party
 * TUI until this resolution was added.
 */
export function kernelEntry(entry, exists = existsSync) {
  if (!entry) return entry;
  const dir = path.dirname(entry);
  // .../<pkg>/bin/zcode.js  ->  .../<pkg>/vendor/zcode.cjs
  const vendored = path.join(path.dirname(dir), 'vendor', 'zcode.cjs');
  return exists(vendored) ? vendored : entry;
}

/**
 * A runtime "ships a TUI" when @zcode/tui resolves next to its entry. Only the
 * third-party zcode-app-cli vendors one; the official desktop bundle does not.
 */
export function runtimeShipsTui(entry, exists = existsSync) {
  if (!entry) return false;
  // Ask the question where NODE will ask it: resolution happens from the KERNEL,
  // and zcode-app-cli vendors both under <pkg>/vendor/, so walking up from the
  // launcher never reached vendor/node_modules and reported "ships none" for a
  // runtime that ships one. The unit test missed it because its mocked `exists`
  // matched on the package name rather than the real layout.
  let dir = path.dirname(kernelEntry(entry, exists));
  for (let i = 0; i < 6; i++) {
    if (exists(path.join(dir, 'node_modules', '@zcode', 'tui', 'package.json'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/**
 * Build the argv for spawning the runtime.
 *
 * preference: 'zagent'  — always use our TUI (default: it is the product)
 *             'runtime' — use whatever the runtime ships; error out if none
 *             'auto'    — ours only when the runtime ships none
 * `ships` is returned so callers never re-derive the decision: doctor used to
 * hand-copy this rule AND re-run the filesystem walk, which is exactly the drift
 * doctor exists to catch.
 * @returns {{argv: string[], tui: 'zagent'|'runtime'|'none', ships: boolean}}
 */
export function buildLaunchArgs({ entry, args = [], preference = 'zagent', loader = TUI_LOADER, exists = existsSync }) {
  const ships = runtimeShipsTui(entry, exists);
  if (!isInteractive(args)) return { argv: [entry, ...args], tui: 'none', ships };
  const mine = preference === 'zagent' || (preference === 'auto' && !ships);
  if (!mine) return { argv: [entry, ...args], tui: 'runtime', ships };
  // `tui` is explicit so the kernel takes the interactive path even when a
  // future build changes its default-subcommand behaviour.
  const forwarded = args.length > 0 ? args : ['tui'];
  // --import takes a module specifier: a bare absolute path crashes on Windows
  // ("Only URLs with a scheme in: file, data, and node are supported").
  return { argv: ['--import', pathToFileURL(loader).href, kernelEntry(entry, exists), ...forwarded], tui: 'zagent', ships };
}

export function tuiPreference(env = process.env) {
  const raw = String(env.ZAGENT_TUI ?? '').trim().toLowerCase();
  return raw === 'runtime' || raw === 'auto' ? raw : 'zagent';
}
