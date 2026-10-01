import { buildLaunchArgs, isInteractive, runtimeShipsTui, tuiPreference, kernelEntry, TUI_LOADER, tuiNodeSupported, nodeSqliteSupported } from './tui-launch.mjs';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

// --- interactive detection ----------------------------------------------------
ok(isInteractive([]) === true, 'no args is interactive');
ok(isInteractive(['-p', 'hi']) === false, '-p is headless');
ok(isInteractive(['--print', 'hi']) === false, '--print is headless');
ok(isInteractive(['--prompt', 'hi']) === false, '--prompt is headless');
ok(isInteractive(['-p=hi']) === false, '-p= is headless');
ok(isInteractive(['--prompt=hi']) === false && isInteractive(['--print=hi']) === false,
  '--prompt=/--print= are headless');
ok(isInteractive(['app-server']) === false, 'app-server is not an interactive session');
ok(isInteractive(['login']) === false && isInteractive(['logout']) === false,
   'login/logout never import @zcode/tui — no loader needed (works below the node floor)');
ok(isInteractive(['--cwd', '/tmp']) === true, 'plain flags stay interactive');

// --- runtime TUI discovery ----------------------------------------------------
const desktop = path.join(path.sep + 'opt', 'ZCode', 'resources', 'glm', 'zcode.cjs');
// Built with path.join, not written as a literal: on Windows path.dirname/join
// produce backslashes, so a hardcoded forward-slash string never matches what
// the code computes and these tests failed only on the windows matrix lane.
const appCliRoot = path.join(path.sep + 'home', 'u', '.local', 'opt', 'zcode-app-cli',
  'node_modules', 'zcode-app-cli');
const appCliJs = path.join(appCliRoot, 'bin', 'zcode.js');
const appCli = appCliJs;
const vendored = new Set([path.join(appCliRoot, 'vendor', 'node_modules', '@zcode', 'tui', 'package.json')]);
ok(runtimeShipsTui(desktop, () => false) === false, 'official desktop bundle ships no TUI');
ok(runtimeShipsTui(appCli, (p) => p.includes('zcode-app-cli') && p.endsWith(path.join('@zcode', 'tui', 'package.json'))) === true,
   'a vendored @zcode/tui beside the entry is found');
ok(runtimeShipsTui(null, () => true) === false, 'a missing entry ships nothing');
ok(runtimeShipsTui('/a/b/c.js', () => false) === false, 'walking up terminates at the filesystem root');

// --- kernel resolution --------------------------------------------------------
// zcode-app-cli's entry is a LAUNCHER that spawns a fresh child node for the
// kernel, so a --import hook on the launcher never reaches it. Injecting into
// the launcher silently rendered the third-party TUI instead of ours.
const appCliKernel = path.join(appCliRoot, 'vendor', 'zcode.cjs');
ok(kernelEntry(appCliJs, (f) => f === appCliKernel) === appCliKernel,
   "a launcher entry resolves to its vendored kernel");
ok(kernelEntry(desktop, () => false) === desktop, 'the desktop bundle entry is already the kernel');
ok(kernelEntry(null, () => true) === null, 'a missing entry resolves to itself');

// --- the REAL layout, on a real filesystem ------------------------------------
// A mocked `exists` that matched on the package name hid a real bug: zcode-app-cli
// vendors BOTH the kernel and @zcode/tui under <pkg>/vendor/, so walking up from
// the launcher never reached vendor/node_modules and doctor reported
// "ships no @zcode/tui" for a runtime that ships one. Build the tree for real.
{
  const root = mkdtempSync(path.join(tmpdir(), 'zagent-launch-'));
  try {
    const pkg = path.join(root, 'node_modules', 'zcode-app-cli');
    mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    mkdirSync(path.join(pkg, 'vendor', 'node_modules', '@zcode', 'tui'), { recursive: true });
    const launcher = path.join(pkg, 'bin', 'zcode.js');
    writeFileSync(launcher, '');
    writeFileSync(path.join(pkg, 'vendor', 'zcode.cjs'), '');
    writeFileSync(path.join(pkg, 'vendor', 'node_modules', '@zcode', 'tui', 'package.json'), '{}');

    ok(kernelEntry(launcher) === path.join(pkg, 'vendor', 'zcode.cjs'),
       'the launcher resolves to the vendored kernel on a real tree');
    ok(runtimeShipsTui(launcher) === true,
       'a TUI vendored under vendor/node_modules IS found — the walk starts at the kernel');
    ok(buildLaunchArgs({ entry: launcher, args: [], preference: 'auto' }).tui === 'runtime',
       'auto defers to the vendored TUI on a real tree');

    // a desktop-style bundle: entry IS the kernel, nothing vendored beside it
    const glm = path.join(root, 'opt', 'ZCode', 'resources', 'glm');
    mkdirSync(glm, { recursive: true });
    const kernel = path.join(glm, 'zcode.cjs');
    writeFileSync(kernel, '');
    ok(runtimeShipsTui(kernel) === false, 'a desktop bundle really ships no TUI');
    ok(buildLaunchArgs({ entry: kernel, args: [], preference: 'auto' }).tui === 'zagent',
       'auto uses ours when the runtime ships none, on a real tree');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// --- launch args --------------------------------------------------------------
let r = buildLaunchArgs({ entry: desktop, args: [], exists: () => false });
ok(r.tui === 'zagent', 'default preference uses our TUI');
// --import consumes a module specifier: on Windows a bare absolute path throws
// ERR_UNSUPPORTED_ESM_URL_SCHEME, so the loader must be passed as a file: URL.
ok(r.argv[0] === '--import' && r.argv[1] === pathToFileURL(TUI_LOADER).href && r.argv[2] === desktop,
   'our TUI is injected as a file: URL with --import BEFORE the runtime entry');
ok(r.argv.at(-1) === 'tui', 'the tui subcommand is passed explicitly');

r = buildLaunchArgs({ entry: desktop, args: ['--cwd', '/w'], exists: () => false });
ok(r.argv.slice(-2).join(' ') === '--cwd /w', 'user args are forwarded verbatim');
ok(!r.argv.includes('tui'), 'the explicit tui subcommand is not added when the user passed args');

r = buildLaunchArgs({ entry: desktop, args: ['-p', 'hi'], exists: () => false });
ok(r.tui === 'none' && r.argv[0] === desktop, 'headless runs are never wrapped');

r = buildLaunchArgs({ entry: appCli, args: [], preference: 'runtime', exists: () => true });
ok(r.tui === 'runtime' && r.argv[0] === appCli, 'preference=runtime hands off untouched');

r = buildLaunchArgs({ entry: appCli, args: [], preference: 'auto', exists: () => true });
ok(r.tui === 'runtime', 'auto defers to a runtime that ships its own TUI');

r = buildLaunchArgs({ entry: appCli, args: [], preference: 'zagent', exists: (f) => f === appCliKernel });
ok(r.argv[2] === appCliKernel, 'our TUI is injected into the KERNEL, never into a launcher');
r = buildLaunchArgs({ entry: desktop, args: [], preference: 'auto', exists: () => false });
ok(r.tui === 'zagent', 'auto uses ours when the runtime ships none');

// --- ships is returned so callers never re-derive the rule ---------------------
// doctor used to hand-copy this decision AND re-run the filesystem walk; a
// hand-copied verdict keeps reporting healthy after the rule here changes.
ok(buildLaunchArgs({ entry: desktop, args: [], exists: () => false }).ships === false,
   'ships=false for a runtime with no vendored TUI');
ok(buildLaunchArgs({ entry: appCli, args: [], exists: () => true }).ships === true,
   'ships=true for a runtime that vendors one');
ok(buildLaunchArgs({ entry: desktop, args: ['-p', 'hi'], exists: () => false }).ships === false,
   'ships is reported for headless runs too, not just interactive ones');
for (const [pref, ships, tui] of [['zagent', true, 'zagent'], ['zagent', false, 'zagent'],
                                  ['runtime', true, 'runtime'], ['runtime', false, 'runtime'],
                                  ['auto', true, 'runtime'], ['auto', false, 'zagent']]) {
  const got = buildLaunchArgs({ entry: desktop, args: [], preference: pref, exists: () => ships });
  ok(got.tui === tui && got.ships === ships, `preference=${pref} ships=${ships} -> tui=${tui}`);
}

// --- node floor for the built-in TUI -------------------------------------------
// registerHooks first shipped in Node 22.15.0 / 23.5.0; below it the spawned
// child dies on a bare SyntaxError. The predicate feature-detects so the parent
// can refuse with an actionable message instead (macOS: stale /usr/local/bin/node).
ok(tuiNodeSupported() === true, 'this test node supports the TUI loader (engines floor)');
ok(tuiNodeSupported({}) === false, 'a node:module without registerHooks is detected');
ok(tuiNodeSupported({ registerHooks: null }) === false, 'a non-function registerHooks is rejected');

// --- node:sqlite floor (the kernel child always spawns --experimental-sqlite) -
ok(nodeSqliteSupported('22.4.1') === false, 'node 22.4 is below the sqlite floor');
ok(nodeSqliteSupported('22.5.0') === true, 'node 22.5 is the sqlite floor');
ok(nodeSqliteSupported('22.14.0') === true, 'node 22.14 supports sqlite (below the TUI floor only)');
ok(nodeSqliteSupported('23.0.0') === true, 'node 23 supports sqlite');
ok(nodeSqliteSupported('20.19.0') === false, 'node 20 is below the sqlite floor');

// --- preference parsing -------------------------------------------------------
ok(tuiPreference({}) === 'zagent', 'default preference is our TUI');
ok(tuiPreference({ ZAGENT_TUI: 'runtime' }) === 'runtime', 'ZAGENT_TUI=runtime honored');
ok(tuiPreference({ ZAGENT_TUI: ' AUTO ' }) === 'auto', 'preference is trimmed and case-insensitive');
ok(tuiPreference({ ZAGENT_TUI: 'nonsense' }) === 'zagent', 'an unknown preference falls back to ours');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
