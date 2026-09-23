#!/usr/bin/env node
// Criterion-level UX tests: grouped help, package-vs-runtime --version, the
// unknown-command contract (with the explicit kernel-passthrough allowlist),
// GLM-first models, empty-memory guidance, and the doctor TUI line. The
// cross-command oracle lives in scripts/test-ux-audit.mjs.
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { COMMANDS, GROUPS, commandFor, COMMAND_DETAILS, HEADLESS_OPTIONS, NON_PRINT_OPTIONS, verbOf } from './commands.mjs';
import { isNotRunning, isSessionScopedNotRunning } from './session-errors.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bin = path.join(root, 'bin', 'zagent');
const home = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-'));
const tmp = path.join(home, 'tmp');
mkdirSync(tmp, { recursive: true });

// The kernel fixture sits outside every layout findRuntime versions
// (…/resources/glm/zcode.cjs, …/zcode-app-cli/bin/zcode.js) so rt.version stays
// null and the labeled kernel fallback is exercised deterministically.
const kernel = path.join(home, 'kernel', 'zcode.cjs');
mkdirSync(path.dirname(kernel), { recursive: true });
writeFileSync(kernel, `const a = process.argv.slice(2);
if (a.includes('--version')) console.log('9.9.9-fixture');
else if (process.env.FIXTURE_KERNEL_MODE === 'err-envelope')
  console.log('{"error":{"code":1302,"message":"[1302][rate limited][r]"}}');
else if (process.env.FIXTURE_KERNEL_MODE === 'quota-fail')
  { process.stderr.write('[1308][Usage limit reached for 5 hour. Your limit will reset at 2030-01-01 00:00:00][r]\\n'); process.exit(1); }
else console.log('fixture-kernel:' + a.join(' '));
`);
const catalogDir = path.join(home, 'model-providers'); // <kernel dir>/../model-providers
mkdirSync(catalogDir, { recursive: true });
writeFileSync(path.join(catalogDir, 'models_catalog_1.json'), JSON.stringify({
  schemaVersion: 'zcode.model-providers.v1',
  providers: [
    { id: 'fixture', models: [{ id: 'fixture-alpha' }] },
    { id: 'zai', models: [{ id: 'glm-5.3' }, { id: 'glm-5.3-flash' }] },
  ],
}));
mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
writeFileSync(path.join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({
  model: { main: 'zai/glm-5.3', lite: 'zai/glm-5.3-flash' },
  provider: { zai: { kind: 'anthropic', options: { baseURL: 'https://api.z.ai/api/anthropic/', apiKey: 'fixture' } } },
}));

const env = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  ZAGENT_TEST_SANDBOX: home,
  TMPDIR: tmp,
  TEMP: tmp,
  TMP: tmp,
  ZCODE_RUNTIME: kernel,
  ZAI_API_KEY: 'fixture-key',
  ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
};
const run = (args, cwd = home) => spawnSync(process.execPath, [bin, ...args], {
  encoding: 'utf8', timeout: 15000, env, cwd,
});

const BANNED = [
  /retry-on-envelope/i, /chain.?proof/i, /degraded.?posture/i, /raw service codes/i,
  /\bD1\b/, /\bD2\b/, /dossier/i, /receipt/i, /\bpanel\b/i, /envelope/i,
  /\bparity\b/i, /GUI task store/i, /both worlds/i, /product path/i,
];

// Criterion 1: the table itself carries the groups and clean prose.
assert.equal(GROUPS.join('|'), 'Run|Set up|Account|Project|Extend|Debug');
for (const row of COMMANDS) {
  assert.equal(row.length, 3, `row needs [signature, sentence, group]: ${row[0]}`);
  assert.ok(GROUPS.includes(row[2]), `unknown group '${row[2]}' for ${row[0]}`);
  for (const re of BANNED) assert.doesNotMatch(row[1], re, `banned term in row ${row[0]}`);
}
for (const g of GROUPS) assert.ok(COMMANDS.some((r) => r[2] === g), `empty group ${g}`);

const help = run(['help']);
assert.equal(help.status, 0, help.stderr);
let cursor = 0;
for (const g of GROUPS) {
  const at = help.stdout.indexOf(`${g}\n`);
  assert.ok(at > cursor, `help section '${g}' missing or out of order`);
  cursor = at;
}
for (const re of BANNED) assert.doesNotMatch(help.stdout, re, `banned term ${re} in help`);
for (const [sig, desc] of [...HEADLESS_OPTIONS, ...NON_PRINT_OPTIONS])
  for (const re of BANNED) assert.doesNotMatch(`${sig} ${desc}`, re, `banned term ${re} in headless row ${sig}`);
assert.equal(run(['--help']).status, 0, '--help prints the same palette');

// A new user reads `zagent --help`
// BEFORE guessing `-p --help` exists, so the palette's -p row itself must
// disclose the dangerous default — what yolo does AND how to opt out.
assert.match(help.stdout, /-p "…"[^\n]*yolo[^\n]*no confirmation/i,
  'main help -p row must disclose that the yolo default skips confirmations');
assert.match(help.stdout, /-p "…"[^\n]*--mode plan/,
  'main help -p row must name the safer-mode opt-out');

// `offpeak … | tools …` / `usage … | stats …` read as bare
// `zagent tools`/`zagent stats` — both answer 'unknown command'. Every
// ' | '-separated form in a signature must start with the row's own verb.
for (const [sig] of COMMANDS) {
  const parts = sig.split(' | ');
  for (const p of parts) {
    assert.equal(verbOf(p), verbOf(sig), `'${sig}' names a phantom command in '${p}'`);
  }
}
// Working commands must be advertised — login/logout are real
// kernel-passthrough verbs and were absent from the palette.
for (const v of ['login', 'logout']) {
  assert.ok(commandFor(v), `${v} missing from the command table`);
  assert.match(help.stdout, new RegExp(`zagent ${v}\\b`), `help omits ${v}`);
}
assert.doesNotMatch(help.stdout, /zagent tools|zagent stats/, 'phantom command advertised');

// Criterion 2: --version names the package, then the runtime when one exists.
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const ver = run(['--version']);
assert.equal(ver.status, 0, ver.stderr);
const verLines = ver.stdout.trim().split('\n');
assert.equal(verLines[0], `zagent ${pkg.version}`);
assert.match(verLines[1], /^runtime: explicit \(kernel 9\.9\.9-fixture\) \(.+zcode\.cjs\)$/);
// A runtime in a known install layout reports its real product version — the
// kernel's internal string must never be shown in its place.
const rtVerHome = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-rtver-'));
try {
  const cliPkg = path.join(rtVerHome, 'node_modules', 'zcode-app-cli');
  mkdirSync(path.join(cliPkg, 'bin'), { recursive: true });
  writeFileSync(path.join(cliPkg, 'package.json'), JSON.stringify({ version: '8.8.8-product' }));
  const rtKernel = path.join(cliPkg, 'bin', 'zcode.js');
  writeFileSync(rtKernel, `console.log('7.7.7-internal');`);
  const rtEnv = { ...env, HOME: rtVerHome, USERPROFILE: rtVerHome, ZAGENT_TEST_SANDBOX: rtVerHome, ZCODE_RUNTIME: rtKernel };
  const v = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', timeout: 15000, env: rtEnv });
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /^runtime: explicit 8\.8\.8-product \(.+zcode\.js\)$/m);
  assert.doesNotMatch(v.stdout, /7\.7\.7/, 'kernel string must not appear as the product version');
  const d = spawnSync(process.execPath, [bin, 'doctor'], { encoding: 'utf8', timeout: 15000, env: rtEnv });
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /^runtime: explicit 8\.8\.8-product \(/m);
  assert.doesNotMatch(d.stdout, /7\.7\.7/, 'doctor must not probe the kernel string either');
} finally { rmSync(rtVerHome, { recursive: true, force: true }); }
// A runtime whose --version fails still reports, just without a version.
const deadHome = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-dead-'));
try {
  const deadKernel = path.join(deadHome, 'zcode.cjs');
  writeFileSync(deadKernel, 'process.exit(3)');
  const dead = spawnSync(process.execPath, [bin, '--version'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...env, HOME: deadHome, USERPROFILE: deadHome, ZAGENT_TEST_SANDBOX: deadHome, ZCODE_RUNTIME: deadKernel },
  });
  assert.equal(dead.status, 0, dead.stderr);
  assert.match(dead.stdout, /^runtime: explicit \(/m, 'missing kernel version degrades to kind+path');
} finally { rmSync(deadHome, { recursive: true, force: true }); }

// Criterion 3: unknown commands get our error; the kernel usage never leaks.
for (const bogus of ['foo', 'such-nonexistent-command']) {
  const r = run([bogus]);
  assert.equal(r.status, 2, `${bogus}: ${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, `zagent: unknown command '${bogus}'\nRun 'zagent help' for the command list.\n`);
}
// An obvious command typo names the closest real command — the same hint the
// option path gives for '--efort' (a 'quota stauts' typo had one, the
// top-level dispatcher did not). Distant garbage gets none (pinned above).
// 'ssesion' is a transposition+insertion —
// Levenshtein 3 but Damerau 2 — and used to fall off the d<3 bound.
for (const [typo, want] of [['qouta', 'quota'], ['sessoins', 'sessions'], ['ssesion', 'sessions'], ['sessinos', 'sessions'], ['logni', 'login'], ['hepl', 'help'], ['docotr', 'doctor']]) {
  const r = run([typo]);
  assert.equal(r.status, 2, `${typo}: ${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, new RegExp(`unknown command '${typo}' — did you mean '${want}'\\?`));
  assert.match(r.stderr, /Run 'zagent help' for the command list\./);
}
// Source-only verbs are never suggested: the hint would dead-end the user on
// a "not in this distribution" error.
assert.doesNotMatch(run(['telegrm']).stderr, /did you mean 'telegram'/);
// The bound stays strict: 'sesio' is 3 edits from 'sessions' with no
// transposition to save it — still no hint (the fix was a Damerau leg, not a
// widened bound, so distance-3 non-transpositions keep getting nothing).
assert.doesNotMatch(run(['sesio']).stderr, /did you mean/);
// The same refusals under --json keep stdout machine-
// readable — the {"error"} envelope every routed verb honors — while the
// human lines stay on stderr and the exit code is unchanged.
for (const [typo, want] of [['qouta', 'quota'], ['sessoins', 'sessions'], ['ssesion', 'sessions'], ['foo', null], ['sesio', null]]) {
  const r = run([typo, '--json']);
  assert.equal(r.status, 2, `${typo} --json: ${r.stderr}`);
  const env = JSON.parse(r.stdout);
  assert.match(env.error, new RegExp(`unknown command '${typo}'`));
  if (want) assert.match(env.error, new RegExp(`did you mean '${want}'\\?`));
  assert.match(r.stderr, new RegExp(`unknown command '${typo}'`));
  assert.match(r.stderr, /Run 'zagent help' for the command list\./);
}
// Unknown options — leading position and mid-argv after an entry flag — take
// the same envelope, and the envelope carries the option did-you-mean.
{
  const lead = run(['--bogus', '--json']);
  assert.equal(lead.status, 2, lead.stderr);
  assert.match(JSON.parse(lead.stdout).error, /unknown option '--bogus'/);
  assert.match(lead.stderr, /unknown option '--bogus'/);
  const mid = run(['-p', 'hi', '--efort', '--json']);
  assert.equal(mid.status, 2, mid.stderr);
  assert.match(JSON.parse(mid.stdout).error, /unknown option '--efort' — did you mean '--effort'\?/);
}
// A previous review round found: --json in LEADING position is the flag too — it is an entry
// flag, so a flag-led argv still reaches dispatcher refusals and must emit
// the envelope just like the trailing form.
{
  const lead = run(['--json', '--bogus']);
  assert.equal(lead.status, 2, lead.stderr);
  assert.match(JSON.parse(lead.stdout).error, /unknown option '--bogus'/);
  const mid = run(['--json', '-p', 'hi', '--efort', 'low']);
  assert.equal(mid.status, 2, mid.stderr);
  assert.match(JSON.parse(mid.stdout).error, /unknown option '--efort'/);
}
// A `--` in command position already IS the separator: the token after it is
// payload, so `-- --json` refuses without an envelope — stderr still names it.
{
  const r = run(['--', '--json']);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /unknown option '--'/);
}
// A post-`--` "--json" is positional payload, not the flag: no envelope.
{
  const r = run(['qouta', '--', '--json']);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /unknown command 'qouta'/);
}
// The glued "--json=<x>" spelling still asks for the envelope (the same grace
// `logout --json=1` gets — a script reader gets a parseable answer either way).
{
  const r = run(['qouta', '--json=1']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(JSON.parse(r.stdout).error, /unknown command 'qouta'/);
}
// The source-only refusal takes the envelope too.
{
  const r = run(['telegram', '--json']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(JSON.parse(r.stdout).error, /source-only experimental functionality/);
  assert.match(r.stderr, /source-only experimental functionality/);
}
// The passthrough allowlist is explicit in the dispatcher and reachable:
// 'login' and 'app-server' are kernel subcommands, so the fixture kernel must
// answer them.
const zagentSrc = readFileSync(bin, 'utf8');
assert.match(zagentSrc, /MAIN_ENTRY_COMMANDS = new Set\(\['doctor', 'login', 'logout', 'app-server'\]\)/);
const login = run(['login']);
assert.equal(login.status, 0, login.stderr);
assert.match(login.stdout, /fixture-kernel:login/, 'allowlisted login reaches the runtime');
// `login --no-browser` on a stdin that can never deliver the
// pasted sign-in code (fd closed / /dev/null) must refuse fast with the
// working paths named — the kernel flow waits on that paste forever.
const deadLogin = spawnSync(process.execPath, [bin, 'login', '--no-browser'], {
  encoding: 'utf8', timeout: 15000, env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'],
});
assert.equal(deadLogin.status, 2, deadLogin.stderr);
assert.equal(deadLogin.stdout, '');
assert.match(deadLogin.stderr, /stdin|terminal|ZAI_API_KEY/, 'closed-stdin login must name the working paths');
assert.doesNotMatch(deadLogin.stderr, /fixture-kernel/, 'must be refused before the runtime is spawned');
// The fd-closed-outright branch (EBADF) — POSIX only; `exec 0<&-` drops fd 0.
if (process.platform !== 'win32') {
  const closedFd = spawnSync('bash', ['-c', 'exec 0<&-; exec "$@"', 'bash', process.execPath, bin, 'login', '--no-browser'], {
    encoding: 'utf8', timeout: 15000, env, cwd: home,
  });
  assert.equal(closedFd.status, 2, closedFd.stderr);
  assert.match(closedFd.stderr, /stdin|terminal|ZAI_API_KEY/, 'closed-fd login must refuse like /dev/null');
}
// The glued `--no-browser=` spelling is the same flag, same refusal.
const gluedLogin = spawnSync(process.execPath, [bin, 'login', '--no-browser=true'], {
  encoding: 'utf8', timeout: 15000, env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'],
});
assert.equal(gluedLogin.status, 2, gluedLogin.stderr);
// A piped stdin still forwards — it can legitimately carry the pasted code.
const pipedLogin = run(['login', '--no-browser']);
assert.equal(pipedLogin.status, 0, pipedLogin.stderr);
assert.match(pipedLogin.stdout, /fixture-kernel:login --no-browser/, 'piped stdin keeps the kernel flow');
// `--` escapes the flag: post-separator --no-browser is a kernel positional.
const postSepLogin = run(['login', '--', '--no-browser'], home);
assert.equal(postSepLogin.status, 0, postSepLogin.stderr);
assert.match(postSepLogin.stdout, /fixture-kernel:login/, 'post-`--` --no-browser is not the flag');
// Kernel `logout` prints "Logged out from Coding Plan accounts"
// + exit 0 on a machine that never signed in — naming a credentials file that
// does not exist. zagent refuses when the OAuth store has provably nothing to
// clear. (This fixture home has a plan key but no v2/credentials.json.)
const noSessionLogout = run(['logout']);
assert.equal(noSessionLogout.status, 1, noSessionLogout.stderr);
assert.match(noSessionLogout.stderr, /not signed in/, 'empty-store logout must say so');
assert.doesNotMatch(noSessionLogout.stdout, /Logged out/, 'no session may not print a success line');
// Same refusal, --json shape: envelope on stdout (kernel keys: status/provider),
// human line on stderr, nonzero exit.
const noSessionLogoutJson = run(['logout', '--json']);
assert.equal(noSessionLogoutJson.status, 1, noSessionLogoutJson.stderr);
assert.deepEqual(JSON.parse(noSessionLogoutJson.stdout).status, 'not_signed_in');
assert.match(noSessionLogoutJson.stderr, /not signed in/);
// An empty or oauth-free store is equally "nothing to clear".
{
  const emptyHome = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-lo-empty-'));
  mkdirSync(path.join(emptyHome, '.zcode', 'v2'), { recursive: true });
  writeFileSync(path.join(emptyHome, '.zcode', 'v2', 'credentials.json'), '{}');
  const r = spawnSync(process.execPath, [bin, 'logout'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...env, HOME: emptyHome, USERPROFILE: emptyHome, ZAGENT_TEST_SANDBOX: emptyHome }, cwd: home,
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /not signed in/);
}
// Any oauth:* material in the store means there IS something to sign out of —
// forward to the kernel (fixture echoes the verb back).
{
  const inHome = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-lo-in-'));
  mkdirSync(path.join(inHome, '.zcode', 'v2'), { recursive: true });
  writeFileSync(path.join(inHome, '.zcode', 'v2', 'credentials.json'),
    JSON.stringify({ 'oauth:zai:refresh_token': 'fixture-refresh' }));
  const r = spawnSync(process.execPath, [bin, 'logout'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...env, HOME: inHome, USERPROFILE: inHome, ZAGENT_TEST_SANDBOX: inHome }, cwd: home,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fixture-kernel:logout/, 'a real OAuth session reaches the kernel');
}
// A corrupt store also forwards — logout is the recovery path for it (the
// kernel answers its own honest corrupt-credentials error).
{
  const badHome = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-lo-bad-'));
  mkdirSync(path.join(badHome, '.zcode', 'v2'), { recursive: true });
  writeFileSync(path.join(badHome, '.zcode', 'v2', 'credentials.json'), 'not json{{');
  const r = spawnSync(process.execPath, [bin, 'logout'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...env, HOME: badHome, USERPROFILE: badHome, ZAGENT_TEST_SANDBOX: badHome }, cwd: home,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fixture-kernel:logout/, 'corrupt store still reaches the kernel (recovery path)');
}
// The kernel's clear-set (zcode.cjs logoutZCodeCli) is wider than oauth:* —
// zcodejwttoken and account-provider:* records are sign-in material too.
{
  for (const [name, key] of [['jwt', 'zcodejwttoken'], ['ap', 'account-provider:zai:identity']]) {
    const h = mkdtempSync(path.join(tmpdir(), `zagent-cli-ux-lo-${name}-`));
    mkdirSync(path.join(h, '.zcode', 'v2'), { recursive: true });
    writeFileSync(path.join(h, '.zcode', 'v2', 'credentials.json'), JSON.stringify({ [key]: 'fixture' }));
    const r = spawnSync(process.execPath, [bin, 'logout'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...env, HOME: h, USERPROFILE: h, ZAGENT_TEST_SANDBOX: h }, cwd: home,
    });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.match(r.stdout, /fixture-kernel:logout/, `${key} store reaches the kernel`);
  }
  // A store with only unrelated keys is still "nothing to clear".
  const misc = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-lo-misc-'));
  mkdirSync(path.join(misc, '.zcode', 'v2'), { recursive: true });
  writeFileSync(path.join(misc, '.zcode', 'v2', 'credentials.json'), JSON.stringify({ theme: 'dark' }));
  const r = spawnSync(process.execPath, [bin, 'logout'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...env, HOME: misc, USERPROFILE: misc, ZAGENT_TEST_SANDBOX: misc }, cwd: home,
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /not signed in/);
}
// ZCODE_DATA_BASE_DIR relocates the kernel store root (same rule as inspect):
// a session under the relocated root must not be refused, and HOME's store is
// ignored when the variable is set — the kernel ignores it too.
{
  const homeStore = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-lo-home-'));
  const base = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-lo-base-'));
  mkdirSync(path.join(base, '.zcode', 'v2'), { recursive: true });
  writeFileSync(path.join(base, '.zcode', 'v2', 'credentials.json'),
    JSON.stringify({ 'oauth:zai:access_token': 'fixture' }));
  const relocated = spawnSync(process.execPath, [bin, 'logout'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...env, HOME: homeStore, USERPROFILE: homeStore, ZAGENT_TEST_SANDBOX: homeStore, ZCODE_DATA_BASE_DIR: base }, cwd: home,
  });
  assert.equal(relocated.status, 0, relocated.stderr);
  assert.match(relocated.stdout, /fixture-kernel:logout/, 'relocated store reaches the kernel');
  // …and the reverse: material only under HOME while the root is relocated.
  mkdirSync(path.join(homeStore, '.zcode', 'v2'), { recursive: true });
  writeFileSync(path.join(homeStore, '.zcode', 'v2', 'credentials.json'),
    JSON.stringify({ 'oauth:zai:access_token': 'fixture' }));
  const emptyBase = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-lo-eb-'));
  const ignored = spawnSync(process.execPath, [bin, 'logout'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...env, HOME: homeStore, USERPROFILE: homeStore, ZAGENT_TEST_SANDBOX: homeStore, ZCODE_DATA_BASE_DIR: emptyBase }, cwd: home,
  });
  assert.equal(ignored.status, 1, ignored.stderr);
  assert.match(ignored.stderr, /not signed in/, 'relocated empty root refuses despite HOME material');
}
// An unreadable store still forwards — EACCES is not "nothing to clear", the
// kernel answers its own honest error for a wedged file. (Skipped under root:
// permission bits do not gate uid 0, so the read would succeed.)
if (process.platform !== 'win32' && process.geteuid?.() !== 0) {
  const locked = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-lo-lock-'));
  mkdirSync(path.join(locked, '.zcode', 'v2'), { recursive: true });
  writeFileSync(path.join(locked, '.zcode', 'v2', 'credentials.json'), '{}');
  chmodSync(path.join(locked, '.zcode', 'v2'), 0o000);
  try {
    const r = spawnSync(process.execPath, [bin, 'logout'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...env, HOME: locked, USERPROFILE: locked, ZAGENT_TEST_SANDBOX: locked }, cwd: home,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /fixture-kernel:logout/, 'unreadable store reaches the kernel');
  } finally {
    chmodSync(path.join(locked, '.zcode', 'v2'), 0o700);
  }
}
// Glued --json=<x> still emits the envelope (the kernel would usage-error it,
// but a script reader still gets a parseable answer from the refusal).
{
  const r = run(['logout', '--json=1']);
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).status, 'not_signed_in');
}
// The gate keys on the kernel's positionals[0], not args[0] — a flag-led or
// value-flag-led invocation still reaches the kernel's logout dispatch, so it
// must refuse the same way. (A `-p logout` prompt value is NOT the verb: -p
// is in KERNEL_VALUE_FLAGS and the sweep consumes it.)
{
  const flagLed = run(['--json', 'logout']);
  assert.equal(flagLed.status, 1, flagLed.stderr);
  assert.deepEqual(JSON.parse(flagLed.stdout).status, 'not_signed_in');
  assert.match(flagLed.stderr, /not signed in/);
  const valLed = run(['--cwd', '.', 'logout']);
  assert.equal(valLed.status, 1, valLed.stderr);
  assert.match(valLed.stderr, /not signed in/);
  // The credential gate must not pre-empt the refusal — a flag-led logout on a
  // TRULY credential-less machine (no ZAI_API_KEY, no cli config, no store)
  // emits the not_signed_in envelope, not the sign-in card + exit 2.
  const bare = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-lo-bare-'));
  const bareEnv = { ...env, HOME: bare, USERPROFILE: bare, ZAGENT_TEST_SANDBOX: bare };
  delete bareEnv.ZAI_API_KEY;
  const credLess = spawnSync(process.execPath, [bin, '--json', 'logout'], {
    encoding: 'utf8', timeout: 15000, env: bareEnv, cwd: home,
  });
  assert.equal(credLess.status, 1, credLess.stderr);
  assert.deepEqual(JSON.parse(credLess.stdout).status, 'not_signed_in');
  assert.match(credLess.stderr, /not signed in/);
  // Same class: a flag-led `login --no-browser` on a credentialed machine
  // still hits the dead-stdin gate (fd 0 = /dev/null via stdio 'ignore').
  const deadLogin = spawnSync(process.execPath, [bin, '--json', 'login', '--no-browser'], {
    encoding: 'utf8', timeout: 15000, env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(deadLogin.status, 2, deadLogin.stderr);
  assert.match(deadLogin.stderr, /cannot supply it/);
  // The kernel clears by key NAME — a falsy-valued session key still forwards.
  const falsyHome = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-lo-falsy-'));
  mkdirSync(path.join(falsyHome, '.zcode', 'v2'), { recursive: true });
  writeFileSync(path.join(falsyHome, '.zcode', 'v2', 'credentials.json'),
    JSON.stringify({ 'oauth:zai:refresh_token': '' }));
  const falsy = spawnSync(process.execPath, [bin, 'logout'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...env, HOME: falsyHome, USERPROFILE: falsyHome, ZAGENT_TEST_SANDBOX: falsyHome }, cwd: home,
  });
  assert.equal(falsy.status, 0, falsy.stderr);
  assert.match(falsy.stdout, /fixture-kernel:logout/, 'falsy-valued session key reaches the kernel');
}
const appServer = run(['app-server']);
assert.equal(appServer.status, 0, appServer.stderr);
assert.match(appServer.stdout, /fixture-kernel:app-server/, 'allowlisted app-server reaches the runtime');

// Leading options are kernel entry flags, not unknown commands: forward every
// one the kernel's parser accepts (ENTRY_FLAGS in commands.mjs — the parseArgs
// table, identical on 3.11.2/3.12.1, verified by execution), and still reject
// real typos — including bare --capabilities, which only exists on the doctor
// path, and the flags the official --help documents but its parser rejects.
for (const flagArgs of [
  ['--cwd', tmp],
  ['--prompt', 'hi'],
  ['-p', 'hi'],
  ['--json', '-p', 'hi'],
  ['--mode', 'plan', '-p', 'hi'],
  ['--mode=plan', '-p', 'hi'],
  ['--output-format=stream-json', '-p', 'hi'],
  ['--attach', fileURLToPath(import.meta.url), '-p', 'hi'],
  ['--disallowed-tools', 'Bash', '-p', 'hi'],
  ['--disallowedTools', 'Bash', '-p', 'hi'],
  ['--resume', 'sess_abc', '-p', 'hi'],
  ['-c'],
  ['--continue', '-p', 'hi'],
  ['-c', '-p', 'hi', '--json'],
  ['--resume', 'sess_abc', '-p', 'hi', '--json'],
  ['--target', 'goal text'],
  ['--target-replace', '--target', 'goal text'],
  ['--locale', 'zh-CN', '-p', 'hi'],
  ['--no-color', '-p', 'hi'],
  ['--verbose', '-p', 'hi'],
  ['--browser-use', 'headless', '-p', 'hi'],
  // The kernel refuses --browser-executable without --browser-use=headless —
  // the forward-verbatim row must carry the pair (extracted 3.12.1:
  // '--browser-executable requires --browser-use=headless'). POSIX-only:
  // win32 reads /bin/true as relative ('must be absolute') and its X_OK is a
  // no-op, so the exec-bit asserts below cannot discriminate there either.
  ...(process.platform === 'win32' ? [] : [
    ['--browser-use', 'headless', '--browser-executable', '/bin/true', '-p', 'hi'],
  ]),
  ['--surface', 'terminal', '-p', 'hi'],
  ['--output-format', 'stream-json', '-p', 'hi'],
  ['--force-mcs', '-p', 'hi'],
  ['-f', '-p', 'hi'],
  ['--force', '-p', 'hi'],
  ['--stdio'],
  ['--no-browser', '-p', 'hi'],
  // A lone '-' is a legitimate VALUE (kernel: `-p -` runs; `--cwd -` satisfies
  // arity then dies at the kernel's path-accessibility check, asserted with
  // the semantic-gate refusals below) — only option-shaped tokens (len>1)
  // trip the kernel's ambiguous rule. `--mode -` satisfies arity but the
  // kernel's enum check still refuses it ('Unsupported --mode value: -'),
  // so it is asserted with the enum refusals below, not here.
  ['-p', '-'],
  // Post-`--` tokens are the kernel's positionals, not our flags: a `-p` or
  // `--attach` there must not trip the missing-value/file-path pre-checks.
  ['-p', 'hi', '--', '-p'],
  ['-p', 'hi', '--', '--attach'],
  // Same rule for the zagent selection extension: post-`--` --model/--effort
  // are positionals the kernel sees verbatim — never parsed as flags, never
  // diverting the run onto the app-server selection path.
  ['-p', 'hi', '--', '--model', 'fixture/glm-5.3'],
  ['-p', 'hi', '--', '--effort', 'low'],
]) {
  const r = run(flagArgs);
  assert.equal(r.status, 0, `${flagArgs.join(' ')}: ${r.stderr}`);
  assert.match(r.stdout, new RegExp(`fixture-kernel:${flagArgs.map(a => a.replace(/[.[\]]/g, '\\$&')).join(' ')}`),
    `${flagArgs.join(' ')} must reach the runtime verbatim`);
}
// --browser-use preflight: the kernel's browser backend does
// `await import("playwright-core")` resolved from the kernel file's own
// directory. A runtime with no node_modules on that walk-up (the desktop
// bundle ships none — the GUI uses the in-app browser instead) makes every
// browser command fail inside an otherwise-green turn, so zagent warns BEFORE
// the turn is spent. The flag itself still forwards verbatim.
// (Positive case assumes no ancestor of os.tmpdir() carries
// node_modules/playwright-core — a host-level install there would mask it.)
const bu = run(['--browser-use', 'headless', '-p', 'hi']);
assert.equal(bu.status, 0, bu.stderr);
assert.match(bu.stderr, /playwright-core/, 'warns that the runtime cannot resolve playwright-core');
assert.match(bu.stdout, /fixture-kernel:--browser-use headless -p hi/, 'flag still reaches the kernel verbatim');
// A runtime whose kernel CAN resolve playwright-core stays quiet.
const pwHome = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-pw-'));
try {
  const pwKernel = path.join(pwHome, 'kernel', 'zcode.cjs');
  const pwPkg = path.join(pwHome, 'kernel', 'node_modules', 'playwright-core');
  mkdirSync(pwPkg, { recursive: true });
  writeFileSync(path.join(pwPkg, 'package.json'), '{"name":"playwright-core","version":"0.0.0","main":"index.js"}');
  writeFileSync(path.join(pwPkg, 'index.js'), 'module.exports = {};');
  writeFileSync(pwKernel, `console.log('fixture-kernel:' + process.argv.slice(2).join(' '));`);
  const r = spawnSync(process.execPath, [bin, '--browser-use', 'headless', '-p', 'hi'], {
    encoding: 'utf8', timeout: 15000, env: { ...env, ZCODE_RUNTIME: pwKernel }, cwd: home,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fixture-kernel:--browser-use/, 'flag still reaches the kernel');
  assert.doesNotMatch(r.stderr, /playwright-core/, 'resolvable runtime stays quiet');
} finally { rmSync(pwHome, { recursive: true, force: true }); }
// A `--browser-use` AFTER `--` is a kernel positional, not the flag — no warn.
const buPost = run(['-p', 'hi', '--', '--browser-use']);
assert.equal(buPost.status, 0, buPost.stderr);
assert.doesNotMatch(buPost.stderr, /playwright-core/, 'post-`--` token is a positional, not the flag');
// A post-`--` --json is a kernel positional too: the headless JSON retry path
// must not engage on it. The err-envelope fixture makes the retry observable —
// engaged, it retries and notes 'attempt 1 error envelope' on stderr.
{
  const r = spawnSync(process.execPath, [bin, '-p', 'hi', '--', '--json'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...env, FIXTURE_KERNEL_MODE: 'err-envelope' }, cwd: home,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"code":1302/, 'kernel output forwards verbatim');
  assert.doesNotMatch(r.stderr, /attempt 1/,
    'post-`--` --json must not arm the JSON retry path');
}
// On the selection path itself, post-`--` positionals stay refused as data —
// named in the error, never parsed as flags, and the separator is not itself
// listed as an argument.
const selPost = run(['-p', 'hi', '--model', 'fixture/glm-5.3', '--', 'stray']);
assert.equal(selPost.status, 2, selPost.stderr);
assert.match(selPost.stderr, /unrecognized arguments with --model\/--effort: stray\n/,
  'post-`--` positional named as data');

// `zagent -p --help` documents the headless surface instead of leaking the
// kernel's usage text — including flags the official help omits.
for (const head of [['-p', '--help'], ['--prompt', '--help'], ['--mode', '--help']]) {
  const r = run(head);
  assert.equal(r.status, 0, `${head.join(' ')}: ${r.stderr}`);
  assert.match(r.stdout, /run one headless prompt/);
  assert.match(r.stdout, /--output-format/, 'hidden-but-real flag documented');
  assert.match(r.stdout, /--max-turns/, 'dead upstream flags called out');
  // The yolo default must be disclosed at its point of mention —
  // what it does AND how to opt out, not a bare "(default yolo)".
  assert.match(r.stdout, /yolo[^\n]*no confirmation/i, 'yolo default must say it skips confirmations');
  assert.match(r.stdout, /--mode plan/, 'yolo disclosure must name the opt-out');
  // Options the runtime refuses under -p must sit in their
  // own group — an inline "(not with -p)" note was missed by real users.
  const refusedAt = r.stdout.indexOf('not valid with -p');
  assert.ok(refusedAt > -1, 'session-only options are grouped separately');
  const optBlock = r.stdout.slice(r.stdout.indexOf('options forwarded'), refusedAt);
  assert.doesNotMatch(optBlock, /--target/, '--target must not sit inside the -p options list');
  assert.match(r.stdout.slice(refusedAt), /--target <text>/, '--target is still documented');
  // …and every permission mode a -p run can take is explained (kernel-verified
  // semantics), not just named — new-user review asked for exactly this.
  assert.match(r.stdout, /plan = read-only/);
  assert.match(r.stdout, /build = asks before each change/);
  assert.match(r.stdout, /edit = applies file edits/);
  assert.match(r.stdout, /yolo = full access/);
  assert.match(r.stdout, /auto = reserved/, 'the runtime\'s unimplemented mode is called out');
  // The --mode enum row must not advertise `auto` — the
  // parser refuses it ('--mode must be one of build|edit|plan|yolo'). It
  // belongs only in the legend as reserved, never inline as choosable.
  const modeRow = r.stdout.split('\n').find((l) => l.includes('--mode <'));
  assert.ok(modeRow, 'the --mode enum row is present');
  assert.match(modeRow, /--mode <build\|edit\|plan\|yolo>/, 'enum lists only the launchable modes');
  const enumSeg = modeRow.match(/--mode <([^>]*)>/);
  assert.ok(enumSeg, 'the --mode enum segment parses');
  assert.doesNotMatch(enumSeg[1], /auto/, 'enum must not advertise the refused auto mode');
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Usage: zcode/, 'kernel usage must not leak');
}
// `zagent <cmd> --help` used to echo only the palette row — one line, no flag
// notes, no example (a real user learned nothing from `onboard --help`). Every
// routed verb, plus the kernel-passthrough verbs, now answers with the usage
// row, detail lines, and one example — and the kernel's own usage never leaks.
{
  const tableVerbs = COMMANDS.map(([sig]) => sig.split(/[\s[]/)[0])
    .filter(v => !v.startsWith('-') && v !== '(default)');
  const helpVerbs = [...tableVerbs, 'help', 'app-server'];
  for (const v of helpVerbs) {
    assert.ok(COMMAND_DETAILS[v]?.length, `${v} missing a --help detail block`);
    assert.ok(COMMAND_DETAILS[v].at(-1).startsWith('  example: '), `${v} detail must end with an example`);
    for (const re of BANNED) for (const line of COMMAND_DETAILS[v])
      assert.doesNotMatch(line, re, `banned term ${re} in ${v} --help`);
    const r = run([v, '--help']);
    assert.equal(r.status, 0, `${v} --help: ${r.stderr}`);
    assert.ok(r.stdout.trim().split('\n').length > 3, `${v} --help must print more than the one-line row`);
    assert.match(r.stdout, /example: zagent /, `${v} --help must carry an example`);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Usage: zcode/, `${v} --help leaked kernel usage`);
  }
  // No orphan detail blocks — every key must answer a real verb.
  for (const k of Object.keys(COMMAND_DETAILS))
    assert.ok(helpVerbs.includes(k), `COMMAND_DETAILS key '${k}' is unreachable`);
  // Subcommand-level help still resolves to the command's block.
  const sub = run(['task', 'list', '--help']);
  assert.equal(sub.status, 0, sub.stderr);
  assert.match(sub.stdout, /task list/);
  // The original repro: the answer is more than the command-list line.
  const onboard = run(['onboard', '--help']);
  assert.ok(onboard.stdout.includes('test prompt'), 'onboard --help keeps its description');
  assert.ok(onboard.stdout.trim().split('\n').length > 3, 'onboard --help grew past one line');
  // login --help must tell a user with no
  // account where sign-up happens, or name the API-key alternative.
  const loginHelp = run(['login', '--help']);
  assert.equal(loginHelp.status, 0, loginHelp.stderr);
  assert.match(loginHelp.stdout, /sign-up|sign up/i, 'login --help names the account-creation path');
  assert.match(loginHelp.stdout, /ZAI_API_KEY/, 'login --help names the API-key alternative');
  // The `--` separator escapes the help answer — a free-text subcommand must
  // receive the literal "--help" (POSIX), not the detail block.
  const literal = run(['memory', 'append', '--', '--help'], tmp); // tmp cwd: must not seed home's memory (criterion 9 asserts it empty)
  assert.equal(literal.status, 0, literal.stderr);
  assert.match(literal.stdout, /appended to /);
  assert.doesNotMatch(literal.stdout, /example: zagent/);
}

// The official --help advertises flags its own parser rejects; they are dead
// documentation, so the dispatcher refuses them like any other typo rather
// than forwarding a guaranteed kernel usage dump.
for (const dead of ['--print', '--max-turns', '--allowed-tools', '--permission-mode', '--settings', '--allow-main-worktree-yolo']) {
  const r = run([dead, '-p', 'hi']);
  assert.equal(r.status, 2, `${dead}: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(`zagent: unknown option '${dead}'`));
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Usage: zcode/);
}
const caps = run(['--capabilities']);
assert.equal(caps.status, 2, caps.stderr);
assert.match(caps.stderr, /zagent: unknown option '--capabilities'/);
assert.match(caps.stderr, /zagent doctor --capabilities/, 'points at the doctor path');
assert.doesNotMatch(`${caps.stdout}${caps.stderr}`, /Usage: zcode/);
const bogus = run(['--bogus']);
assert.equal(bogus.status, 2, bogus.stderr);
assert.match(bogus.stderr, /zagent: unknown option '--bogus'/);

// A typo'd option later in a -p argv used to sail past dispatch into the
// credential gate — a signed-out user was told to sign in (the sign-in card,
// exit 2) for what is really an unknown flag, and a signed-in one got the
// kernel's own "Usage: zcode" text. The dispatcher sweeps every pre-`--`
// option against the kernel's verified flag table before anything else runs
// (parseArgs never takes a dash-token as an option value, so none are legal).
for (const args of [
  ['-p', 'hi', '--efort', 'low'],
  ['-p', 'hi', '--efort=low'],
  ['-p', 'hi', '--bogusflag', 'foo'],
  ['--json', '-p', 'hi', '--xyz123'],
  ['-p', 'hi', '-vv'],
  ['--mode', 'plan', '-p', 'hi', '--max-turns', '3'], // kernel-dead flag mid-argv too
]) {
  const r = run(args);
  assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /zagent: unknown option '/, args.join(' '));
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /fixture-kernel|Usage: zcode/,
    `${args.join(' ')}: must be refused before the runtime is spawned`);
}
// A near-miss names the real flag; a far miss gets no bogus suggestion, and
// short typos get none at all (-x is 1 edit from every short — unguessable).
assert.match(run(['-p', 'hi', '--efort', 'low']).stderr, /did you mean '--effort'/);
assert.doesNotMatch(run(['-p', 'hi', '--xyz123']).stderr, /did you mean/);
assert.doesNotMatch(run(['-p', 'hi', '-x']).stderr, /did you mean/);
assert.match(run(['--versoin']).stderr, /did you mean '--version'/);
// --capabilities keeps its doctor hint mid-argv too (leading already has it).
assert.match(run(['-p', 'hi', '--capabilities']).stderr, /zagent doctor --capabilities/);
// Deliberate, pinned divergence: glued short clusters (-pfoo, -cf) are
// kernel-legal via parseArgs expansion, but zagent refuses them at leading
// position already — mid-argv holds the same line, it does not widen it.
for (const args of [['-p', 'hi', '-pfoo'], ['-p', 'hi', '-cf']]) {
  const r = run(args);
  assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /zagent: unknown option '-/, args.join(' '));
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /fixture-kernel/);
}
// The credential gate must never see the typo: on a credential-less home the
// answer is the option error, NOT the sign-in card (the original report).
const noCredHome = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-nocred-'));
try {
  const { ZAI_API_KEY: _drop, ...envNoKey } = env;
  const noCred = spawnSync(process.execPath, [bin, '-p', 'hi', '--efort', 'low'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...envNoKey, HOME: noCredHome, USERPROFILE: noCredHome, ZAGENT_TEST_SANDBOX: noCredHome },
  });
  assert.equal(noCred.status, 2, noCred.stdout + noCred.stderr);
  assert.match(noCred.stderr, /zagent: unknown option '--efort'/);
  assert.doesNotMatch(noCred.stderr, /sign-in|credential/, 'the sign-in card must not mask a flag typo');
  // A KNOWN selection flag trailing with no value is the same masked-usage
  // class: the kernel's parseArgs refuses before any credential question
  // ('Unknown option'/​'argument missing'), so "requires a value" must beat
  // the sign-in card too (a reported failure: `-p hi --model` → credential card).
  for (const spell of [['-p', 'hi', '--model'], ['-p', 'hi', '--effort'], ['-p', 'hi', '--model', '--json']]) {
    const r = spawnSync(process.execPath, [bin, ...spell], {
      encoding: 'utf8', timeout: 15000,
      env: { ...envNoKey, HOME: noCredHome, USERPROFILE: noCredHome, ZAGENT_TEST_SANDBOX: noCredHome },
    });
    assert.equal(r.status, 2, `${spell.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /requires a value/, spell.join(' '));
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /sign-in path|credential/, 'the sign-in card must not mask a missing flag value');
  }
  // The kernel's OWN value-flags are the same masked-usage class on the
  // kernel-forwarded path (no --model/--effort): extracted 3.12.1 answers
  // "Option '--mode <value>' argument missing" / "argument is ambiguous"
  // before any credential question (verified by execution). The credential
  // gate must not beat that usage error. `--x=` forms are self-contained and
  // post-`--` tokens are positionals — neither is an arity error.
  const arityEnv = { ...envNoKey, HOME: noCredHome, USERPROFILE: noCredHome, ZAGENT_TEST_SANDBOX: noCredHome };
  for (const spell of [
    ['-p', 'hi', '--mode'], ['-p', 'hi', '--cwd'], ['-p', 'hi', '--resume'],
    ['-p', 'hi', '--target'], ['-p', 'hi', '--output-format'], ['-p', 'hi', '--locale'],
    ['-p', 'hi', '--surface'], ['-p', 'hi', '--browser-use'], ['-p', 'hi', '--browser-executable'],
    ['-p', 'hi', '--mode', '-c'],           // flag-shaped value: kernel 'ambiguous'
    ['--mode', '-p', 'hi'],                  // leading form, flag-shaped value
  ]) {
    const r = spawnSync(process.execPath, [bin, ...spell], { encoding: 'utf8', timeout: 15000, env: arityEnv });
    assert.equal(r.status, 2, `${spell.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /requires a value/, spell.join(' '));
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /sign-in path|credential/, 'the sign-in card must not mask a missing flag value');
  }
  // The list-valued flags answer "requires at least one tool" instead — and
  // their pre-parse stops at ANY '-' token, so a lone '-' is no tool either.
  for (const spell of [['-p', 'hi', '--disallowed-tools'], ['-p', 'hi', '--disallowedTools'], ['-p', 'hi', '--disallowed-tools', '-c'], ['-p', 'hi', '--disallowed-tools', '-']]) {
    const r = spawnSync(process.execPath, [bin, ...spell], { encoding: 'utf8', timeout: 15000, env: arityEnv });
    assert.equal(r.status, 2, `${spell.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /requires at least one tool/, spell.join(' '));
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /sign-in path|credential/, 'the sign-in card must not mask a missing flag value');
  }
  // Kernel-enum values are the same masked-usage class: extracted 3.12.1
  // refuses `--mode=bogus` → 'Unsupported --mode value: bogus. Supported
  // modes: build, edit, plan, yolo.' BEFORE any credential question
  // (--output-format/--locale/--surface/--browser-use likewise), so a bogus
  // value must beat the sign-in card exactly like a missing one. Space and
  // `=` forms; --locale is case-exact kernel-side ('zh-cn' refused); 'auto'
  // is a selection-path mode the kernel's own -p parser does not accept.
  for (const spell of [
    ['-p', 'hi', '--mode', 'bogus'], ['-p', 'hi', '--mode=bogus'],
    ['-p', 'hi', '--mode=auto'], ['-p', 'hi', '--mode='],
    ['-p', 'hi', '--output-format', 'bogus'], ['-p', 'hi', '--output-format=xml'],
    ['-p', 'hi', '--locale', 'bogus'], ['-p', 'hi', '--locale=zh-cn'],
    ['-p', 'hi', '--surface=bogus'], ['-p', 'hi', '--browser-use', 'headed'],
    ['-p', 'hi', '--mode', '-'],               // '-' passes arity, not the enum
    ['--mode', 'bogus', '-p', 'hi'],
  ]) {
    const r = spawnSync(process.execPath, [bin, ...spell], { encoding: 'utf8', timeout: 15000, env: arityEnv });
    assert.equal(r.status, 2, `${spell.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /must be one of/, spell.join(' '));
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /sign-in path|credential/, 'the sign-in card must not mask a bad flag value');
  }
  // Kernel semantic gates are the same masked-usage family one layer deeper:
  // extracted 3.12.1 answers each BEFORE any credential question, in this
  // verified order — --browser-executable's --browser-use=headless
  // requirement, then --target vs --prompt, then the --cwd stat, then the
  // --browser-executable stat (parse-level enum beats all of them:
  // `--target x -p hi --mode bogus` → 'Unsupported --mode value').
  const missingDir = path.join(noCredHome, 'no-such-dir');
  const notExec = path.join(noCredHome, 'plain-file.txt');
  writeFileSync(notExec, 'x'); // 0644 — exists but is not executable
  for (const [spell, re] of [
    [['-p', 'hi', '--target', 'x'], /cannot be used with --prompt/],
    [['--target', 'x', '-p', 'hi'], /cannot be used with --prompt/],
    [['-p', 'hi', '--target=x'], /cannot be used with --prompt/],
    [['-p', 'hi', '--prompt=hi', '--target', 'x'], /cannot be used with --prompt/],
    [['-p', 'hi', '--target='], /requires non-empty text/],   // kernel: empty goal refused before the conflict
    [['-p', 'hi', '--target', ''], /requires non-empty text/],
    [['--target-replace'], /requires --target/],              // boolean flag needs its target
    [['-p', 'hi', '--target-replace'], /requires --target/],
    [['--resume', 'sess_x', '-c'], /cannot be used together/],
    [['--resume', 'sess_x', '--continue'], /cannot be used together/],
    [['-c', '--resume', 'sess_x', '-p', 'hi'], /cannot be used together/],
    [['--surface', 'desktop'], /can only be used with/],      // bare TUI launch is not a surface carrier
    [['--surface', 'terminal'], /can only be used with/],
    [['-p', 'hi', '--browser-executable', '/x'], /requires --browser-use/],
    [['-p', 'hi', '--browser-executable=/x'], /requires --browser-use/],
    [['-p', 'hi', '--browser-executable='], /requires --browser-use/],
    [['-p', 'hi', '--cwd', missingDir], /not accessible/],
    [['-p', 'hi', '--cwd', 'no-such-dir'], /not accessible/], // relative form resolves then refuses
    [['-p', 'hi', '--cwd', '-'], /not accessible/],           // '-' is a value; the stat refuses it
    [['-p', 'hi', '--cwd', notExec], /must point to a directory/],
    // Kernel: exact-empty --cwd is its own pre-stat refusal ('--cwd requires
    // a non-empty path.'); NO trim — ' ' stays 'not accessible'.
    [['-p', 'hi', '--cwd='], /requires a non-empty path/],
    [['-p', 'hi', '--cwd', ''], /requires a non-empty path/],
    [['-p', 'hi', '--cwd', missingDir, '--cwd='], /requires a non-empty path/], // last-wins empty
    [['-p', ' ', '--cwd='], /requires a non-empty path/],      // beats blank-prompt (kernel order)
    [['-p', 'hi', '--cwd= ', '--target', 'x'], /cannot be used with --prompt/], // loses to target×prompt
    [['-p', 'hi', '--cwd', ' '], /not accessible/],            // whitespace is not empty kernel-side
    [['--browser-use', 'headless', '--browser-executable', 'relbin', '-p', 'hi'], /must be absolute/],
    // POSIX-only: on win32 '/no-such-bin-xyzzy' is not absolute (earlier
    // refusal) and X_OK is a no-op (notExec would pass the stat).
    ...(process.platform === 'win32' ? [] : [
      [['--browser-use', 'headless', '--browser-executable', '/no-such-bin-xyzzy', '-p', 'hi'], /missing or not executable/],
      [['--browser-use', 'headless', '--browser-executable', notExec, '-p', 'hi'], /missing or not executable/],
    ]),
    [['--browser-use', 'headless', '--browser-executable', tmpdir(), '-p', 'hi'], /missing or not executable/], // a directory is not an executable
    // Kernel-verified ordering between the gates (and vs the parse-level ones).
    [['-p', 'hi', '--cwd', missingDir, '--browser-executable', '/x'], /requires --browser-use/],
    [['-p', 'hi', '--target', 'x', '--cwd', missingDir], /cannot be used with --prompt/],
    [['--browser-use', 'headless', '--browser-executable', '/bad', '-p', 'hi', '--cwd', missingDir], /not accessible/],
    [['-p', 'hi', '--target', 'x', '--mode', 'bogus'], /must be one of/],
    [['-p', 'hi', '--attach', '--cwd', missingDir], /requires a file path/], // attach arity is parse-level, before the cwd stat
    [['-p', 'hi', '--attach', 'missing.txt', '--cwd', missingDir], /not accessible/], // attach stat waits for the cwd gate
    [['-p', 'hi', '--attach', tmpdir()], /is not a file/],   // a directory is no attachment
    [['-p', 'hi', '--mode', '--attach'], /requires a value/], // kernel: the EARLIER flag's parse error wins
    [['-p', 'hi', '--mode=-x'], /must be one of/],            // glued hyphen value is a value, not a flag
    // The -p missing-value check is IN the left-to-right sweep — an earlier
    // token's parse error wins (kernel-verified: `--json=x -p` → "Option
    // '--json' does not take an argument", `--mode -p`/`--attach -p` →
    // "argument is ambiguous" naming the earlier flag).
    [['--json=x', '-p'], /does not take an argument/],
    [['--mode', '-p'], /--mode requires a value/],
    [['--attach', '-p'], /--attach requires a file path/],
    // Parse-level beats the semantic blank-prompt refusal (kernel-verified:
    // `-p ' ' --json=x` → "Option '--json' does not take an argument").
    [['-p', ' ', '--json=x'], /does not take an argument/],
    [['-p', '', '--mode=bogus'], /must be one of/],
    // Kernel-verified blank-prompt slot: every flag gate beats it, it still
    // beats the --attach stat (`-p ' ' --attach /missing` → non-empty text).
    [['-p', ' ', '--resume', 'sess_x', '-c'], /cannot be used together/],
    [['-p', ' ', '--browser-executable', '/x'], /requires --browser-use/],
    [['-p', ' ', '--target', 'x'], /cannot be used with --prompt/],
    [['-p', ' ', '--cwd', missingDir], /not accessible/],
    [['-p', ' ', '--target-replace'], /requires --target/],
    [['-p', ' ', '--attach', 'missing.txt'], /non-empty text/],
    [['--prompt='], /non-empty text/],
    [['-p', 'hi', '--attach='], /requires a file path/],       // glued empty carries no file
    // Selection path: the --attach refusal beats the file stat.
    [['-p', 'hi', '--model', 'm', '--attach', 'missing.txt'], /cannot be combined with --model/],
    // Kernel-verified extras: whitespace-only prompt/target, glued value on
    // a boolean flag, and the surface gate keyed on positionals[0] (a flag
    // VALUE spelling 'app-server' does not exempt it).
    [['-p', ' '], /non-empty text/],
    [['-p', 'hi', '--target', ' '], /non-empty text/],
    [['-p', 'hi', '--json=x'], /does not take an argument/],
    [['-p', 'hi', '--continue=x'], /does not take an argument/],
    [['-p', 'hi', '--force-mcs=x'], /does not take an argument/],
    [['--target-replace=x', '--target', 'x'], /does not take an argument/],
    [['--surface', 'desktop', '--cwd', 'app-server'], /can only be used with/],
    [['--surface', 'desktop', 'x', 'app-server'], /can only be used with/],
    [['-p', 'hi', '-c=x'], /unknown option '-='/],  // parseArgs cluster expansion; kernel answers Unknown option '-='
    [['-p', 'hi', '-f=x'], /unknown option '-='/],
  ]) {
    const r = spawnSync(process.execPath, [bin, ...spell], { encoding: 'utf8', timeout: 15000, env: arityEnv });
    assert.equal(r.status, 2, `${spell.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, re, spell.join(' '));
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /sign-in path|credential/, 'the sign-in card must not mask a semantic gate');
  }
  // Valid values — including kernel-folded --mode=PLAN, selection-path
  // 'auto', and last-wins repeats (kernel parseArgs keeps the final value) —
  // still reach the credential gate unchanged.
  for (const spell of [
    ['-p', 'hi', '--mode', 'bogus', '--mode', 'plan'],   // last-wins: plan is what the kernel sees
    ['-p', 'hi', '--output-format', 'xml', '--output-format', 'json'],
    ['-p', 'hi', '--mode', 'plan'], ['-p', 'hi', '--mode=PLAN'],
    ['-p', 'hi', '--output-format', 'json'], ['-p', 'hi', '--output-format=stream-json'],
    ['-p', 'hi', '--locale=zh-CN'], ['-p', 'hi', '--locale', 'auto'],
    ['-p', 'hi', '--surface', 'terminal'], ['-p', 'hi', '--browser-use=headless'],
    ['-p', 'hi', '--model', 'm', '--mode', 'auto'],
    // Semantic-gate pass-throughs: a real executable behind
    // --browser-use=headless, a real --cwd directory, post-`--` tokens (not
    // flags at all), last-wins repeats, and an empty `--resume=` (unset
    // kernel-side) all stay legal.
    ['--browser-use', 'headless', '--browser-executable', process.execPath, '-p', 'hi'],
    ['-p', 'hi', '--cwd', noCredHome],
    ['-p', 'hi', '--', '--target', 'x'],
    ['-p', 'hi', '--cwd', missingDir, '--cwd', noCredHome],
    ['--resume=', '-c'],
    ['--target', 'goal text', '--target-replace'],
    ['--surface', 'desktop', 'app-server'],
    ['--surface', 'desktop', '--', 'app-server'],  // post-`--` positional exempts (kernel positionals[0])
    ['-p='],                                       // kernel accepts: parseArgs short form gives '=' as the value
  ]) {
    const r = spawnSync(process.execPath, [bin, ...spell], { encoding: 'utf8', timeout: 15000, env: arityEnv });
    assert.equal(r.status, 2, `${spell.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /sign-in path|credential/, `${spell.join(' ')}: a valid value must reach the credential gate`);
    assert.doesNotMatch(r.stderr, /must be one of|requires a value|requires at least one tool|cannot be used|not accessible|must point to|must be absolute|missing or not executable/, spell.join(' '));
  }
} finally { rmSync(noCredHome, { recursive: true, force: true }); }
// A `-p --json` run dying on the credential gate must still answer
// with a parseable error envelope on stdout — a script piping stdout used to
// get an empty stream with human prose on stderr.
const noCredJsonHome = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-nocredjson-'));
try {
  const { ZAI_API_KEY: _drop2, ...envNoKey2 } = env;
  const env2 = { ...envNoKey2, HOME: noCredJsonHome, USERPROFILE: noCredJsonHome, ZAGENT_TEST_SANDBOX: noCredJsonHome };
  for (const spell of [['-p', 'hi', '--json'], ['--json', '-p', 'hi'],
      ['--prompt=hi', '--json'], ['-p', 'hi', '--output-format', 'json'],
      ['-p', 'hi', '--output-format=stream-json'],
      ['-p', 'hi', '--model', 'zai/glm-5.3', '--json']]) {
    const r = spawnSync(process.execPath, [bin, ...spell], {
      encoding: 'utf8', timeout: 15000, env: env2 });
    assert.equal(r.status, 2, `${spell.join(' ')}: ${r.stdout}${r.stderr}`);
    const envelope = JSON.parse(r.stdout.trim());
    assert.equal(envelope.is_error, true, `${spell.join(' ')}: stdout must carry the error envelope`);
    assert.match(envelope.error, /credential/, `${spell.join(' ')}: envelope names the cause`);
    assert.match(r.stderr, /sign-in path/, 'the human card stays on stderr');
  }
  // Plain -p on the same credential-less home keeps the human-only answer.
  const plain = spawnSync(process.execPath, [bin, '-p', 'hi'], { encoding: 'utf8', timeout: 15000, env: env2 });
  assert.equal(plain.status, 2, plain.stdout + plain.stderr);
  assert.equal(plain.stdout, '', 'non-json -p keeps stdout clean');
  // A post-`--` --json is a kernel positional, not the flag — no envelope.
  const escJson = spawnSync(process.execPath, [bin, '-p', 'hi', '--', '--json'],
    { encoding: 'utf8', timeout: 15000, env: env2 });
  assert.equal(escJson.status, 2, escJson.stdout + escJson.stderr);
  assert.equal(escJson.stdout, '', 'post-`--` --json must not trigger the envelope');
  // No runtime at all: `-p --json` still answers with a parseable envelope.
  const noRt = spawnSync(process.execPath, [bin, '-p', 'hi', '--json'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...env2, ZCODE_RUNTIME: path.join(noCredJsonHome, 'no-such-kernel.cjs') },
  });
  assert.equal(noRt.status, 1, noRt.stdout + noRt.stderr);
  assert.match(JSON.parse(noRt.stdout.trim()).error, /runtime/);
} finally { rmSync(noCredJsonHome, { recursive: true, force: true }); }
// `--` still escapes: post-separator tokens are the kernel's positionals, not
// our options to police — the argv reaches the runtime verbatim.
{
  const esc = run(['-p', 'hi', '--', '--efort']);
  assert.match(esc.stdout, /fixture-kernel:-p hi -- --efort/);
  assert.doesNotMatch(`${esc.stdout}${esc.stderr}`, /unknown option/);
}

// `zagent mode` persists a default -p permission mode
// (permissions.defaultMode in ~/.zcode/cli/config.json); a -p run without an
// explicit --mode picks it up. A FRESH home per case — the shared sandbox
// config stays unset so the forward-verbatim sweep above keeps its
// no-injection oracle.
const modeHome = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-mode-'));
try {
  const modeCfg = path.join(modeHome, '.zcode', 'cli', 'config.json');
  mkdirSync(path.dirname(modeCfg), { recursive: true });
  const modeEnv = { ...env, HOME: modeHome, USERPROFILE: modeHome, ZAGENT_TEST_SANDBOX: modeHome };
  const modeRun = (a) => spawnSync(process.execPath, [bin, ...a], { encoding: 'utf8', timeout: 15000, env: modeEnv, cwd: home });
  writeFileSync(modeCfg, JSON.stringify({ permissions: { defaultMode: 'plan' } }));
  // The persisted default reaches the kernel verbatim — the fixture echoes
  // the exact argv it was spawned with.
  const inj = modeRun(['-p', 'hi']);
  assert.equal(inj.status, 0, inj.stderr);
  assert.match(inj.stdout, /fixture-kernel:-p hi --mode plan\n?$/, 'persisted default injects --mode plan');
  // A passthrough verb carrying -p owns its argv — `-p` there is not the
  // prompt flag, so nothing may be injected (kernelPositional0 guard).
  const verbP = modeRun(['login', '-p', 'hi']);
  assert.equal(verbP.status, 0, verbP.stderr);
  assert.match(verbP.stdout, /fixture-kernel:login -p hi\n?$/,
    'a kernel verb with -p in its argv gets no injected --mode');
  assert.doesNotMatch(verbP.stdout, /--mode/, 'passthrough argv is verbatim');
  // An explicit --mode wins — and nothing is injected beside it.
  const explicit = modeRun(['-p', 'hi', '--mode', 'build']);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /fixture-kernel:-p hi --mode build\n?$/, 'explicit --mode beats the default');
  assert.doesNotMatch(explicit.stdout, /plan/, 'the persisted value is not injected alongside the flag');
  const explicitEq = modeRun(['-p', 'hi', '--mode=build']);
  assert.match(explicitEq.stdout, /fixture-kernel:-p hi --mode=build\n?$/, 'the = form beats the default too');
  // Injection lands BEFORE the `--` — post-separator tokens stay positionals.
  const sep = modeRun(['-p', 'hi', '--', '--mode']);
  assert.equal(sep.status, 0, sep.stderr);
  assert.match(sep.stdout, /fixture-kernel:-p hi --mode plan -- --mode\n?$/, 'injection precedes the `--` separator');
  // No default (or a non-launchable stored value) leaves argv untouched.
  writeFileSync(modeCfg, '{}');
  assert.match(modeRun(['-p', 'hi']).stdout, /fixture-kernel:-p hi\n?$/, 'unset default injects nothing');
  writeFileSync(modeCfg, JSON.stringify({ permissions: { defaultMode: 'auto' } }));
  assert.match(modeRun(['-p', 'hi']).stdout, /fixture-kernel:-p hi\n?$/, "'auto' is not launchable — injects nothing");
  // The verb itself round-trips and refuses honestly.
  const modeVerb = (a) => spawnSync(process.execPath, [bin, 'mode', ...a], { encoding: 'utf8', timeout: 15000, env: modeEnv, cwd: home });
  const showUnset = modeVerb([]);
  assert.equal(showUnset.status, 0, showUnset.stderr);
  assert.match(showUnset.stdout, /not set/, "stored 'auto' reads as unset");
  assert.match(showUnset.stdout, /--mode/, 'show explains the precedence');
  assert.equal(modeVerb(['set', 'plan']).status, 0);
  assert.match(modeVerb([]).stdout, /plan/, 'set is visible to the next show');
  assert.equal(modeVerb(['set', 'PLAN']).status, 0, 'values fold like the kernel --mode enum');
  assert.deepEqual(JSON.parse(modeVerb(['--json']).stdout), { defaultMode: 'plan', state: 'ok' });
  assert.deepEqual(JSON.parse(modeVerb(['set', 'edit', '--json']).stdout), { defaultMode: 'edit' });
  for (const bad of [['set', 'bogus'], ['set', 'auto'], ['bogus'], ['set'], ['set', 'plan', 'extra'], ['--bogus']]) {
    const r = modeVerb(bad);
    assert.equal(r.status, 2, `mode ${bad.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage:|must be one of|reserved/, `mode ${bad.join(' ')}`);
    assert.equal(r.stdout, '', `mode ${bad.join(' ')}: refusal stays off stdout`);
  }
  assert.match(modeVerb(['set', 'auto']).stderr, /reserved/, "'auto' is refused as reserved");
  const clr = modeVerb(['clear', '--json']);
  assert.equal(clr.status, 0, clr.stderr);
  assert.deepEqual(JSON.parse(clr.stdout), { defaultMode: null, cleared: true });
  assert.deepEqual(JSON.parse(modeVerb(['clear', '--json']).stdout), { defaultMode: null, cleared: false });
  assert.equal(modeVerb(['set', 'plan']).status, 0);
  assert.equal(modeVerb(['clear']).status, 0);
  assert.match(modeRun(['-p', 'hi']).stdout, /fixture-kernel:-p hi\n?$/, 'cleared default injects nothing');
  // A config that cannot be read is a different diagnosis than "not set" —
  // show must say so instead of silently reporting yolo-default.
  writeFileSync(modeCfg, '{oops');
  const badCfg = modeVerb([]);
  assert.equal(badCfg.status, 0, badCfg.stderr);
  assert.match(badCfg.stdout, /not valid JSON/, 'a malformed config is diagnosed, not called unset');
  assert.deepEqual(JSON.parse(modeVerb(['--json']).stdout), { defaultMode: null, state: 'malformed' },
    '--json reports the malformed state instead of collapsing to null');
  writeFileSync(modeCfg, JSON.stringify({ permissions: { defaultMode: 'bogus' } }));
  assert.match(modeVerb([]).stdout, /not a launchable mode/, 'an ignored stored value is named');
  assert.deepEqual(JSON.parse(modeVerb(['--json']).stdout), { defaultMode: null, state: 'invalid' },
    '--json reports the invalid state instead of collapsing to null');
  // `mode --help` answers from the shared table, never the kernel usage.
  const modeHelp = modeVerb(['--help']);
  assert.equal(modeHelp.status, 0, modeHelp.stderr);
  assert.match(modeHelp.stdout, /example: zagent mode/);
  assert.doesNotMatch(`${modeHelp.stdout}${modeHelp.stderr}`, /Usage: zcode/);
} finally { rmSync(modeHome, { recursive: true, force: true }); }
// No config file at all: set must refuse honestly, never create one to hold
// the key, and show still reports unset.
const noCfgHome = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-nocfg-'));
try {
  const ncEnv = { ...env, HOME: noCfgHome, USERPROFILE: noCfgHome, ZAGENT_TEST_SANDBOX: noCfgHome };
  const nc = (a) => spawnSync(process.execPath, [bin, 'mode', ...a], { encoding: 'utf8', timeout: 15000, env: ncEnv, cwd: home });
  const set = nc(['set', 'plan']);
  assert.equal(set.status, 1, set.stderr);
  assert.match(set.stderr, /no ~\/.zcode\/cli\/config\.json yet/, 'set on a missing config names the fix');
  const show = nc([]);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /not set/);
  // ...but `clear` on a missing config is a no-op success, not a refusal —
  // 'no default set' is already true; idempotent clears must not exit 1.
  const clearAbsent = nc(['clear', '--json']);
  assert.equal(clearAbsent.status, 0, clearAbsent.stderr);
  assert.deepEqual(JSON.parse(clearAbsent.stdout), { defaultMode: null, cleared: false });
  assert.equal(nc(['clear']).status, 0, 'human-form clear on missing config also exits 0');
} finally { rmSync(noCfgHome, { recursive: true, force: true }); }

// --model/--effort are zagent extensions accepted leading (they reach zagent.mjs,
// not the kernel parser); without -p there is nothing to select on.
const selNoPrint = run(['--model', 'glm-5.3-flash']);
assert.equal(selNoPrint.status, 2, selNoPrint.stderr);
assert.match(selNoPrint.stderr, /--model\/|--model/, 'selection without -p explains itself');
assert.match(selNoPrint.stderr, /\/model/, 'points at the TUI command');
const selRefused = run(['-p', 'hi', '--model', 'glm-5.3', '--resume', 'sess_1']);
assert.equal(selRefused.status, 2, selRefused.stderr);
assert.match(selRefused.stderr, /cannot be combined/, 'refuses flags the selection path cannot honor');

// Criterion 4: Coding Plan header, GLM first, provider-aware search.
const models = run(['models']);
assert.equal(models.status, 0, models.stderr);
assert.match(models.stdout, /^Your Coding Plan: main zai\/glm-5\.3 · lite zai\/glm-5\.3-flash\n/);
assert.ok(models.stdout.indexOf('zai/glm-5.3-flash') < models.stdout.indexOf('fixture\t'),
  'plan models precede other providers');
for (const q of ['zai', 'glm']) {
  const r = run(['models', q]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /zai\/glm-5\.3/);
}
// No configured plan degrades to "not configured", not a crash.
const bareHome = mkdtempSync(path.join(tmpdir(), 'zagent-cli-ux-bare-'));
try {
  const bare = spawnSync(process.execPath, [bin, 'models'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...env, HOME: bareHome, USERPROFILE: bareHome, ZAGENT_TEST_SANDBOX: bareHome },
  });
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /^Your Coding Plan: not configured\n/);
} finally { rmSync(bareHome, { recursive: true, force: true }); }

// Criterion 9: empty memory is a state, not an error.
const mem = run(['memory', 'show']);
assert.equal(mem.status, 0, mem.stderr);
assert.match(mem.stdout, /^No memory for .+\. Add one with: zagent memory append "…"\n$/);

// Criterion 10: doctor keeps the checks, reports runtime kind+version, and
// describes the built-in TUI without implying a separate binary.
const doc = run(['doctor']);
assert.equal(doc.status, 0, doc.stderr);
assert.match(doc.stdout, /^runtime: explicit \(kernel 9\.9\.9-fixture\) \(/m);
assert.match(doc.stdout, /^TUI: built in$/m);
assert.doesNotMatch(doc.stdout, /interactive TUI: zagent/);

// commandFor keeps working for every routed verb including new help paths.
for (const v of ['doctor', 'models', 'memory', 'offpeak', 'remote']) assert.ok(commandFor(v), v);

// Silent-argv class: 'doctor bogus'/'inspect bogus' used to run anyway (exit 0),
// and 'onboard bogus' would have fired a live smoke turn on a typo.
for (const [args, usage] of [
  [['doctor', 'bogus'], /usage: zagent doctor/],
  [['doctor', '--json'], /usage: zagent doctor/],
  [['doctor', '-p'], /usage: zagent doctor/],
  [['inspect', 'bogus'], /usage: zagent inspect/],
  [['inspect', '--bogus'], /usage: zagent inspect/],
  [['onboard', 'bogus'], /usage: zagent onboard/],
  [['onboard', '--json'], /usage: zagent onboard/],
]) {
  const r = run(args);
  assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, usage, args.join(' '));
}
// Legal doctor args still run (config exists in this fixture → fix is a no-op).
{
  const r = run(['doctor', 'fix']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^runtime: /m);
}

// A -p/--prompt with no value must be OUR usage error — forwarding it used to
// dump the kernel's "Usage: zcode" block, the wrong product's usage text.
// Kernel 3.12.1 splits this class: missing/flag-shaped next token → "argument
// missing"; empty or whitespace value → "requires non-empty text"; and `-p=`
// is ACCEPTED (parseArgs gives the short form '=' as the prompt value).
for (const args of [['-p'], ['-p', '--json'], ['--prompt'], ['-p', '--model', 'glm-5.3'],
  ['-p', 'hi', '-p'], ['--prompt', 'x', '--prompt']]) {
  const r = run(args);
  assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /-p\/--prompt requires a prompt text/, args.join(' '));
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Usage: zcode/, 'kernel usage must not leak');
}
for (const args of [['--prompt='], ['-p', ''], ['-p', ' '], ['-p', 'hi', '--prompt='], ['--prompt', ' ']]) {
  const r = run(args);
  assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /requires non-empty text/, args.join(' '));
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Usage: zcode/, 'kernel usage must not leak');
}

// --attach forwards verbatim; a missing file used to spend a provider call
// before the runtime noticed. It is OUR usage error, before inference.
{
  const real = path.join(home, 'attach-me.txt');
  writeFileSync(real, 'x');
  for (const args of [
    ['-p', 'hi', '--attach', path.join(home, 'no-such-file')],
    ['-p', 'hi', '--attach=' + path.join(home, 'no-such-file')],
    ['-p', 'hi', '--attach'],          // value missing
    ['-p', 'hi', '--attach', '--json'], // flag-shaped value
    ['--attach='],                     // empty = form
  ]) {
    const r = run(args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--attach (requires a file path|file not found)/, args.join(' '));
  }
  // An existing file passes the check — it then reaches the kernel path
  // (which here exits on the sandbox's stub runtime, NOT with a usage error).
  const ok = run(['-p', 'hi', '--attach', real]);
  assert.notEqual(ok.status, 2, ok.stderr);
  assert.doesNotMatch(ok.stderr, /--attach file not found/);
  // --cwd rebases relative attach paths the way the kernel does.
  const projDir = path.join(home, 'proj');
  mkdirSync(projDir, { recursive: true });
  writeFileSync(path.join(projDir, 'spec.md'), 'x');
  const cwdOk = run(['--cwd', projDir, '-p', 'hi', '--attach', 'spec.md']);
  assert.notEqual(cwdOk.status, 2, cwdOk.stderr);
  const cwdEq = run(['--cwd=' + projDir, '-p', 'hi', '--attach', 'spec.md']);
  assert.notEqual(cwdEq.status, 2, cwdEq.stderr);
  // A dash-named file is legal through the = form (the value is unambiguous).
  writeFileSync(path.join(home, '-notes.md'), 'x');
  const dashFile = run(['-p', 'hi', '--attach=-notes.md'], home);
  assert.notEqual(dashFile.status, 2, dashFile.stderr);
}

// A --model/--effort run is owned by the selection path — its async write owns
// the exit, and the kernel paths below must NOT run a second time. Un-gated,
// `-p --model m --json` spawned the kernel again with flags parseArgs rejects:
// "attempt N empty output" retries + the kernel's usage text on stderr.
for (const args of [
  ['-p', 'hi', '--model', 'zai/glm-5.3', '--json'],
  ['-p', 'hi', '--effort', 'low', '--json'],
  ['-p', 'hi', '--model', 'zai/glm-5.3'],
  ['-p', 'hi', '--model=zai/glm-5.3', '--json'],
  ['-p', 'hi', '--effort=low', '--json'],
  ['-p=hi', '--model', 'zai/glm-5.3', '--json'],
]) {
  const r = run(args);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /fixture-kernel|attempt \d/,
    `${args.join(' ')}: kernel path must not run after selection`);
  // Positive marker — the selection runner must actually execute (the fixture
  // exits at spawn, so the protocol client reports 'runtime exited'); without
  // this, an early exit-2 regression would pass the absence check vacuously.
  assert.equal(r.status, 1, `${args.join(' ')}: selection runner should fail on the dead fixture, not exit early`);
  assert.match(`${r.stdout}${r.stderr}`, /runtime exited/,
    `${args.join(' ')}: selection runner must reach the protocol client`);
}

// --prompt/-p= spellings must take the SAME headless machinery as -p (parity —
// on the installed build, '--prompt hi --json' bypassed the retry wrapper and
// the exit-code normalization entirely: an error envelope exited 0 and any
// transient empty-stdout race never retried).
// err-envelope makes the fixture emit a retryable 1302 envelope: only a run
// through runHeadlessWithRetry produces 'attempt N' + a failure exit; the
// interactive spawn would just relay the echo. quota-fail pins the non-json
// path: only the headless stderr tee explains provider errors after exit.
const envMode = m => ({ ...env, FIXTURE_KERNEL_MODE: m });
for (const spell of [['--prompt', 'hi'], ['-p=hi'], ['--prompt=hi']]) {
  const j = spawnSync(process.execPath, [bin, ...spell, '--json'],
    { encoding: 'utf8', timeout: 30000, env: envMode('err-envelope'), cwd: home });
  assert.match(j.stderr, /attempt 1 error envelope/,
    `${spell.join(' ')} --json must run through the headless retry wrapper`);
  assert.equal(j.status, 1, `${spell.join(' ')}: a still-retryable final envelope is failure`);
  const t = spawnSync(process.execPath, [bin, ...spell],
    { encoding: 'utf8', timeout: 15000, env: envMode('quota-fail'), cwd: home });
  assert.match(t.stderr, /Usage limit reached for this plan window/,
    `${spell.join(' ')}: headless stderr tee must explain provider errors`);
  assert.equal(t.status, 1);
}

rmSync(home, { recursive: true, force: true });
// Session-error classification: only the kernel's not-live answers count.
assert.equal(isNotRunning({ code: -32004, message: 'Session not found' }), true);
assert.equal(isNotRunning(new Error('Session is not active: sess_abc')), true);
assert.equal(isNotRunning(new Error('session/goal method not found')), false);
assert.equal(isNotRunning(new Error('session database: file not found')), false);
// Session-scoped form (rewind refusal copy): a -32004 with an unrelated
// message is ambiguous and must not be attributed to the session.
assert.equal(isSessionScopedNotRunning({ code: -32004, message: 'Session not found' }), true);
assert.equal(isSessionScopedNotRunning({ code: -32004, message: '' }), true); // bare code = documented stale-id answer
assert.equal(isSessionScopedNotRunning({ code: -32004 }), true); // bare object, no message prop — same bare-code answer
assert.equal(isSessionScopedNotRunning(new Error('Session is not active: sess_abc')), true);
assert.equal(isSessionScopedNotRunning({ code: -32004, message: 'checkpoint row inactive' }), false);
assert.equal(isSessionScopedNotRunning(new Error('session database: file not found')), false);

console.log('PASS cli ux criteria');
