// Self-update check against the npm registry, shared by `zagent update` and
// the doctor hint. The registry answer is cached under ~/.zcode/cli so a
// passive check pays at most one npm round-trip per TTL window.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'zagent';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** The version this running copy reports — the root package.json in both the
 *  source checkout and the installed npm artifact. */
export const installedVersion = () =>
  JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version;

/** Spawnable npm invocation. Bare `npm` resolves through the PATH shim on
 *  POSIX, but on Windows npm is npm.cmd — CreateProcess only appends .exe, so
 *  spawnSync('npm') is ENOENT there. verify-public-package.mjs hit this first:
 *  run the CLI under this node when its npm-cli.js is locatable. */
export function npmInvocation({ platform = process.platform, env = process.env,
  execPath = process.execPath, exists = existsSync } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const cli = [env.npm_execpath, paths.join(paths.dirname(execPath), 'node_modules/npm/bin/npm-cli.js')]
    .find(file => file && /\.js$/i.test(file) && exists(file));
  if (cli) return { command: execPath, args: [cli] };
  return { command: 'npm', args: [] };
}

/** -1/0/1 for dotted numeric versions; null when either side is not exactly
 *  x.y.z (a prerelease suffix is NOT equal to the release it prefixes). */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = String(v ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** `npm view zagent version` — {latest} or {latest:null, error}. Never throws. */
export function fetchLatest({ exec = spawnSync, timeoutMs = 15000, env = process.env } = {}) {
  const npm = npmInvocation({ env });
  let r;
  try {
    r = exec(npm.command, [...npm.args, 'view', PACKAGE_NAME, 'version'], { encoding: 'utf8', timeout: timeoutMs, env });
  } catch (e) {
    return { latest: null, error: String(e?.message ?? e) };
  }
  if (r.error) return { latest: null, error: r.error.code === 'ENOENT' ? 'npm not found on PATH' : String(r.error.message ?? r.error) };
  if (r.status !== 0) return { latest: null, error: `npm view exited ${r.status ?? `signal ${r.signal}`}` };
  const latest = String(r.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
  return compareVersions(latest, latest) === 0
    ? { latest }
    : { latest: null, error: `unexpected registry answer: ${latest.slice(0, 40)}` };
}

const cachePath = (home) => path.join(home, '.zcode', 'cli', 'update-check.json');

const readCache = (home, ttlMs, now = Date.now()) => {
  try {
    const c = JSON.parse(readFileSync(cachePath(home), 'utf8'));
    if (typeof c.latest === 'string' && compareVersions(c.latest, c.latest) === 0
      && typeof c.checkedAt === 'number' && c.checkedAt <= now && now - c.checkedAt < ttlMs)
      return c;
  } catch { /* absent or corrupt cache is just a miss */ }
  return null;
};

/** Registry check with the TTL cache. fresh:true skips the read (an explicit
 *  `zagent update` asks for the answer NOW) but still writes, so the next
 *  passive check is free. {latest, source:'cache'|'live'} or
 *  {latest:null, source:'none', error}. */
export function checkLatest({ home = os.homedir(), ttlMs = CACHE_TTL_MS, fresh = false, exec, timeoutMs = 15000, env = process.env } = {}) {
  if (!fresh) {
    const cached = readCache(home, ttlMs);
    if (cached) return { latest: cached.latest, source: 'cache', checkedAt: cached.checkedAt };
  }
  const r = fetchLatest({ exec, timeoutMs, env });
  if (!r.latest) return { latest: null, source: 'none', error: r.error };
  // The cache is an optimization for homes that already HAVE a zagent
  // profile — it must never CREATE ~/.zcode on a fresh machine (the shipped
  // package verifier asserts offline use leaves no runtime profile behind).
  if (existsSync(path.join(home, '.zcode'))) {
    try {
      mkdirSync(path.dirname(cachePath(home)), { recursive: true });
      writeFileSync(cachePath(home), JSON.stringify({ latest: r.latest, checkedAt: Date.now() }));
    } catch { /* a read-only home must not fail the check itself */ }
  }
  return { latest: r.latest, source: 'live' };
}

/** Passive checks (the doctor hint) never spawn npm inside the test sandbox or
 *  CI — the child would escape the offline gate — and honor an explicit
 *  opt-out for airgapped shells. zmax-remote's live connect makes the same
 *  exception. The explicit `zagent update` command always checks. */
export const passiveCheckAllowed = (env = process.env) =>
  !env.ZMAX_TEST_SANDBOX && !env.CI && !env.GITHUB_ACTIONS && env.ZAGENT_UPDATE_CHECK !== '0';
