#!/usr/bin/env node
// opencode-flock — continuous random real-user testing of zagent by free
// opencode agents: continuous, randomized, large-scale testing of zagent the way
// a real human user would use it, finding problems and closing the loop.
//
// Each round drops one opencode agent (opencode/muse-spark-1.3-contributor-free)
// into a throwaway sandbox that has zagent installed and NO credential, hands
// it ONE persona card from scenarios.mjs, and collects its verdict.
//
// ISOLATION (hard, FS-level — not prompt-enforced): the agent runs under
// bubblewrap. Visible host paths: /usr,/bin,/lib,/etc,/var,/opt read-only
// (system + ZCode runtime; /etc/resolv.conf is overlaid with a plain file so
// /run is NEVER bound — docker.sock and /run/user sockets stay unreachable),
// the opencode INSTALLER dir read-only (binary + its node_modules only — not
// ~/.local/bin), and the sandbox itself rw. the host $HOME is a tmpfs: the
// checkout, ~/.npmrc, ~/.local/bin, key files are unreachable by
// construction; IPC, PID AND NETWORK namespaces are all unshared — private
// netns means no host loopback services, no abstract unix sockets, no X11.
// Egress is ONLY the relay: an HTTP-CONNECT chain (inner listener on the
// private loopback -> a unix socket bound through the wall -> a host relay
// that dials port 443 for allowlisted hosts). The ONLY host secret
// inside the wall is
// the muse provider's own token, FILTERED to that single auth.json entry
// (the host file also carries openai/opencode-go/openrouter keys — they
// never enter). A post-round audit of every command classifies ESCAPE
// attempts (host-anchored paths, sockets, env dumps) and kills the flock
// loudly; --probe-isolation is the acceptance oracle.
//
//   node usertest/swarm/opencode-flock.mjs                  # 4 workers, forever, 8h cap
//   node usertest/swarm/opencode-flock.mjs -n 6 -r 12      # 6 workers, 12 rounds each
//   node usertest/swarm/opencode-flock.mjs --seed 42       # reproducible scenario sequence
//   node usertest/swarm/opencode-flock.mjs --tarball ./zagent-latest.tgz
//   node usertest/swarm/opencode-flock.mjs --signin        # every --signin-every-th round runs a signed-in card
//   node usertest/swarm/opencode-flock.mjs --engine claude-lane   # claude-CLI lane on the brokered FreeInference endpoint
//   node usertest/swarm/opencode-flock.mjs --claude-lane-workers 1 # mix: first K workers run the claude-lane
//   FLOCK_QWEN_KEY=… node usertest/swarm/opencode-flock.mjs --engine qwen   # OpenAI-compatible vLLM lane, brokered
//   FLOCK_QWEN_KEY_FILE=~/.config/zagent-flock-qwen.key node usertest/swarm/opencode-flock.mjs --qwen-workers 2
//   node usertest/swarm/opencode-flock.mjs --triage        # deduped findings
//   node usertest/swarm/opencode-flock.mjs --probe-isolation # verify the bwrap wall
//
// Findings land in FLOCK_DIR (default artifacts/verify/flock-data/,
// gitignored) as NDJSON; --triage dedupes by normalized title signature so
// one bug surfaces once no matter how agents word it.
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir, userInfo, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS as BASE_SCENARIOS, SIGNIN_SCENARIOS, SIGNIN_PTY_SCENARIOS, pickScenario } from './scenarios.mjs';
import { findRuntime } from '../../packages/driver/runtime.mjs';
import { provisionStandaloneAccounts } from '../../packages/driver/account-provider.mjs';
import { EXTRA_SCENARIOS } from './scenarios-extra.mjs';

// Living pool: base cards + cards born from
// real findings and user reports accumulate here — the pool self-improves
// in time; it is not a one-time fix.
const SCENARIOS = [...BASE_SCENARIOS, ...EXTRA_SCENARIOS];
const pickFromPool = (rng, recent) => pickScenario(rng, recent, SCENARIOS);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const workers = Math.max(1, Math.min(10, Number.parseInt(flag('-n', '4'), 10) || 4));
const rounds = Number.parseInt(flag('-r', '0'), 10) || 0; // 0 = until maxHours
// --engine claude-lane switches EVERY worker to the claude-lane (fleet-service compat);
// --claude-lane-workers K mixes: workers 1..K run claude-lane, the rest the opencode pool.
// claude-lane is a claude-CLI lane (deepseek-v4-flash via the logged FreeInference
// gateway) — free additive capacity when the opencode gateway is saturated.
const ENGINE = flag('--engine', 'opencode'); // opencode | claude-lane | qwen
if (!['opencode', 'claude-lane', 'qwen'].includes(ENGINE)) { console.error(`--engine must be opencode|claude-lane|qwen, got ${ENGINE}`); process.exit(2); }
const FLOCK_LANE_WORKERS = Math.max(0, Math.min(workers, Number.parseInt(flag('--claude-lane-workers', '0'), 10) || 0));
const QWEN_WORKERS = Math.max(0, Math.min(workers, Number.parseInt(flag('--qwen-workers', '0'), 10) || 0));
// BROKERED RE-ARM (FLOCK-V2-SIGNIN remainder; re-arms the earlier
// fail-close): the original lane put the real FreeInference key inside the
// model-driven worker's reach twice over — FLOCK_LANE_KEY_CACHE named a
// same-uid-readable file AND claude-lane exports ANTHROPIC_AUTH_TOKEN into the
// claude env every Bash tool child inherits. Same-uid means no path or env
// var the worker can see is safe; the post-round ESCAPE audit is too late
// (disclosure already happened). The re-armed lane keeps the FULL bwrap
// netns wall like every other lane: the worker's claude gets a dummy
// ANTHROPIC_AUTH_TOKEN + a loopback ANTHROPIC_BASE_URL piped to a bound-in
// broker socket, and the host-side net-relay broker injects the real key
// per request — it never enters the worker's env, filesystem, or argv.
// Pool resolution: FLOCK_LANE_API_KEYS (newline-sep) >
// FLOCK_LANE_API_KEY > the file named by FLOCK_LANE_KEY_CACHE (no default). Each
// worker lane pins pool key lane%pool.length — deepseek-v4-flash caps at 1
// in-flight per key, so lanes beyond the pool share keys (logged, not
// silent). FLOCK_LANE_BIN remains the offline-test seam: the stub is copied
// INSIDE the sandbox and holds no key either way.
function claudeLaneKeyPool() {
  // First non-empty source wins — mirrors the publish gate's independent
  // trim-OR (an empty FLOCK_LANE_API_KEYS must not shadow a real FLOCK_LANE_API_KEY/file).
  let raw = process.env.FLOCK_LANE_API_KEYS;
  if (!(raw ?? '').trim()) raw = process.env.FLOCK_LANE_API_KEY;
  if (!(raw ?? '').trim()) {
    const f = process.env.FLOCK_LANE_KEY_CACHE;
    try { raw = readFileSync(f, 'utf8'); } catch { raw = ''; }
  }
  return `${raw ?? ''}`.split('\n').map((k) => k.trim()).filter(Boolean);
}
const FLOCK_LANE_POOL = claudeLaneKeyPool(); // host-side only — never enters worker env
const FLOCK_LANE_LIVE = FLOCK_LANE_POOL.length > 0 || Boolean(process.env.FLOCK_LANE_BIN);
const FLOCK_LANE_UPSTREAM = process.env.FLOCK_LANE_UPSTREAM || 'https://freeinference.org';
const FLOCK_LANE_MODEL = process.env.FLOCK_LANE_MODEL || 'deepseek-v4-flash';
const FLOCK_LANE_HAIKU = process.env.FLOCK_LANE_HAIKU_MODEL || 'qwen3.6-35b';
// Dotted placeholder shape (the SIGNIN_DUMMY_KEY precedent): key-shaped but
// worthless upstream, and honest about what it is on any leak.
const FLOCK_LANE_DUMMY = 'flock-claude-lane-dummy.0123456789abcdef0123456789abcdef';
// run() flips this off when the real lane cannot resolve a claude binary —
// the degraded decision must reach workerEngine, not just the log line.
let claudeLaneActive = FLOCK_LANE_LIVE;
// FLOCK-V2-SIGNIN (slice 2): --signin mixes signed-in cards into the pool.
// Every SIGNIN_EVERY-th round per worker seeds a broker-backed placeholder
// credential (SIGNIN_DUMMY_KEY — a dotted literal, worthless upstream) and wires a
// second inner listener, 127.0.0.1:3129 -> a bound-in broker.sock whose host
// end (net-relay `broker`) injects the real coding-plan key per request.
// Real turns spend real quota — the cadence bounds the burn. The key source
// is a seam: 'zai' (the host resolver), env:VAR, file:path (tests/claude-lane).
const HOST_HOME = process.env.FLOCK_HOST_HOME || process.env.HOME || homedir(); // masked by a tmpfs inside the wall
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SIGNIN = argv.includes('--signin') || process.env.FLOCK_SIGNIN === '1';
const SIGNIN_EVERY = Math.max(1, Number.parseInt(flag('--signin-every', '6'), 10) || 6);
const BROKER_KEY_SOURCE = process.env.FLOCK_BROKER_KEY_SOURCE || 'zai';
// qwen lane: an OpenAI-compatible vLLM endpoint reached through the net-relay BROKER —
// the real upstream key lives only in the host-side broker process (env or
// file source, resolved per request); inside the wall the worker gets a
// dummy apiKey and a loopback baseURL piped to the broker's unix socket.
// Unlike the disabled claude-lane this keeps the FULL bwrap netns wall — the
// model is untrusted free capacity, not a fleet-trusted binary.
// FLOCK_QWEN_UPSTREAM defaults to a local OpenAI-compatible endpoint
// (127.0.0.1:18000); the key comes from FLOCK_QWEN_KEY or FLOCK_QWEN_KEY_FILE
// and is resolved host-side per request.
const QWEN_KEY_SOURCE = process.env.FLOCK_QWEN_KEY ? 'env:FLOCK_QWEN_KEY'
  : process.env.FLOCK_QWEN_KEY_FILE ? `file:${process.env.FLOCK_QWEN_KEY_FILE}`
  : null;
const QWEN_LIVE = Boolean(QWEN_KEY_SOURCE);
const QWEN_UPSTREAM = process.env.FLOCK_QWEN_UPSTREAM || 'http://127.0.0.1:18000';
const QWEN_CLIENT = process.env.FLOCK_QWEN_CLIENT || 'zagent-flock'; // x-client attribution (broker-injected, unspoofable)
const QWEN_MODEL = process.env.FLOCK_QWEN_MODEL || 'Qwen3-32B';
// run() flips this off when the upstream preflight fails — the degraded
// decision must reach workerEngine, not just the log line.
let qwenActive = QWEN_LIVE;
// worker ids are 1-based (created as i + 1 in run()). Mixed pools: workers
// 1..FLOCK_LANE_WORKERS run claude-lane (when live), the next QWEN_WORKERS run qwen.
const workerEngine = (id) => {
  if (ENGINE !== 'opencode') return ENGINE;
  // A disabled claude-lane degrades to opencode — it must NOT slide onto the
  // qwen offset (that would hand qwen K+Q workers while only Q were armed).
  if (id <= FLOCK_LANE_WORKERS) return claudeLaneActive ? 'claude-lane' : 'opencode';
  if (qwenActive && id <= FLOCK_LANE_WORKERS + QWEN_WORKERS) return 'qwen';
  return 'opencode';
};
const maxHours = Number.parseFloat(flag('--max-hours', '8')) || 8;
const mode = argv.includes('--triage') ? 'triage' : argv.includes('--probe-isolation') ? 'probe' : 'run';
const FLOCK_DIR = process.env.FLOCK_DIR || path.join(root, 'artifacts', 'verify', 'flock-data');
const RUNS = path.join(FLOCK_DIR, 'runs.ndjson');
const KNOWN = path.join(FLOCK_DIR, 'known-findings.md');
// Model pool: muse is not the only free model.
// All entries ride the SAME filtered 'opencode' gateway auth — zero new
// secrets enter the wall. Rounds rotate; the record names its model so
// triage can weight cross-model agreement (one finding from two model
// families beats two from one).
const MODELS = (process.env.FLOCK_MODELS || 'opencode/muse-spark-1.3-contributor-free,opencode/union-alpha,opencode/nemotron-3-ultra-free')
  .split(',').map((x) => x.trim()).filter(Boolean);
const MODEL = MODELS[0];
// Resolved lazily — --triage must work on a box without opencode installed.
let _opencodeReal = null;
function opencodeReal() {
  if (_opencodeReal) return _opencodeReal;
  const oc = process.env.FLOCK_OPENCODE || execFileSync('which', ['opencode'], { encoding: 'utf8' }).trim();
  const real = execFileSync('readlink', ['-f', oc], { encoding: 'utf8' }).trim(); // bun binary
  // The installer dir is ro-bound INTO the wall ON TOP of the home tmpfs —
  // if FLOCK_OPENCODE ever resolves so its grandparent is an ancestor of a
  // tmpfs-covered path (~/bin/opencode -> binds the real $HOME, credentials
  // included), refuse rather than silently widen the wall.
  const installDir = path.dirname(path.dirname(real));
  // Residual scope: only root/HOME/tmpdir ancestors are refused — a
  // FLOCK_OPENCODE under another top-level dir (e.g. /srv/oc) still ro-binds
  // that whole dir. Operator-controlled input; accepted.
  for (const covered of [process.env.HOME, tmpdir()].filter(Boolean)) {
    // installDir === '/' (a top-level binary like /x/opencode) would ro-bind
    // the whole host filesystem into the wall — startsWith('//') never fires.
    if (installDir === path.parse(installDir).root || covered === installDir || covered.startsWith(installDir + path.sep)) {
      throw new Error(`FLOCK_OPENCODE resolves to ${real}: installer dir ${installDir} would expose ${covered} inside the wall — refusing`);
    }
  }
  _opencodeReal = real;
  return real;
}
// Resolved lazily like opencodeReal — --triage works on a box without
// claude installed. The claude-lane ro-binds the package dir (binary +
// node_modules only) ON TOP of the home tmpfs, same shape as the opencode
// installer bind — FLOCK_CLAUDE is the test seam.
let _claudeReal = null;
function claudeReal() {
  if (_claudeReal) return _claudeReal;
  const c = process.env.FLOCK_CLAUDE || execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  const real = execFileSync('readlink', ['-f', c], { encoding: 'utf8' }).trim();
  // Same wall-widening refusal as opencodeReal: a package dir that is an
  // ancestor of a tmpfs-covered path would re-expose it inside the wall.
  const pkgDir = path.dirname(path.dirname(real));
  // real/pkgDir are `readlink -f`-resolved — the compared dirs must be too,
  // else a symlinked $HOME (or a symlinked sens component) slips the check.
  const resx = (p) => { try { return execFileSync('readlink', ['-f', p], { encoding: 'utf8' }).trim(); } catch { return p; } };
  for (const covered of [process.env.HOME, tmpdir()].map(resx).filter(Boolean)) {
    if (pkgDir === path.parse(pkgDir).root || covered === pkgDir || covered.startsWith(pkgDir + path.sep)) {
      throw new Error(`FLOCK_CLAUDE resolves to ${real}: package dir ${pkgDir} would expose ${covered} inside the wall — refusing`);
    }
  }
  // The symmetric direction: a pkgDir INSIDE a covered path but broad
  // (~/.local/bin/claude -> ~/.local, ~/.local/share/claude/claude ->
  // ~/.local/share) ro-binds that whole dir over the tmpfs, re-exposing
  // credential stores like ~/.local/share/opencode/auth.json. Refuse when
  // the package dir is an ancestor-or-self of a sensitive dir; a dedicated
  // leaf (…/claude/versions, the @anthropic-ai scope dir) stays allowed.
  for (const sens of [OPENC_DATA, `${process.env.HOME}/.config`, `${process.env.HOME}/.zcode`, `${process.env.HOME}/.ssh`, `${process.env.HOME}/.gnupg`].map(resx).filter(Boolean)) {
    if (pkgDir === sens || sens.startsWith(pkgDir + path.sep)) {
      throw new Error(`FLOCK_CLAUDE resolves to ${real}: package dir ${pkgDir} would expose ${sens} inside the wall — refusing`);
    }
  }
  _claudeReal = real;
  return real;
}
const OPENC_DATA = `${process.env.HOME}/.local/share/opencode`; // auth source (muse token only)
const SEED = parseInt(flag('--seed', String((Date.now() ^ (process.pid << 8)) >>> 0)), 10) >>> 0;

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// Per-worker deterministic stream: given --seed and worker id, the scenario
// sequence and run seeds are reconstructible (no shared interleaved stream).
const workerRng = (id) => mulberry32((SEED ^ Math.imul(id, 2654435761)) >>> 0);

function resolveTarball() {
  const explicit = flag('--tarball', '');
  if (explicit) return explicit;
  const fast = process.env.FLOCK_FAST_TARBALL ?? '';
  if (fast && existsSync(fast)) return fast;
  // npm pack writes to cwd — pack in the repo, then move the tgz out so the
  // repo root is never left littered.
  const packed = execFileSync('npm', ['pack', '--quiet'], { encoding: 'utf8', cwd: root }).trim().split('\n').pop();
  const from = path.join(root, packed);
  const to = path.join(tmpdir(), `flock-sut-${Date.now()}-${packed}`);
  try { execFileSync('mv', [from, to]); return to; } catch { return from; }
}

function record(obj) { mkdirSync(FLOCK_DIR, { recursive: true }); appendFileSync(RUNS, JSON.stringify(obj) + '\n'); }
const log = (m) => console.log(`${new Date().toISOString()} [flock] ${m}`);

/** Sandbox teardown: the SUT's own snapshot guard may have locked
 *  <home>/.zcode/v2/checkpoints inside the sandbox (sentinel + chattr/chmod
 *  0000) — that's the feature working under a real agent. Restore
 *  traversability before rmSync, which cannot descend a locked dir. */
// The ENOTEMPTY/EBUSY transient class — a sandboxed straggler can still be
// writing while teardown runs (the signal handlers do not kill the in-flight
// spawn first) — is NOT fixed by rmSync's own maxRetries: that retries only
// the failing rmdir syscall and never re-unlinks entries created during the
// descent (verified 2026-09-19: 8 native retries, 5.6s, 90k files left).
// Recovery needs the whole rm re-run — this bounded loop. A dir that still
// resists throws to the caller's guard. (2026-09-18 claude-lane crash: one
// ENOTEMPTY escaped a process.on handler, exit 1, systemd start-limit, 13h
// dead lane.)
// Env tuning must be clamped finite: FLOCK_RM_ATTEMPTS=abc/Infinity makes
// `i >= RM_ATTEMPTS` never true (unbounded retry inside a signal handler —
// the same dead-lane class through another door), and a NaN/negative
// FLOCK_RM_RETRY_MS makes Atomics.wait block forever on the first error.
const rmNum = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d; };
const RM_ATTEMPTS = Math.min(Math.max(1, rmNum(process.env.FLOCK_RM_ATTEMPTS, 8)), 32);
const RM_RETRY_MS = Math.min(rmNum(process.env.FLOCK_RM_RETRY_MS, 150), 2000);
// Per-dir dwell ceiling: teardown runs inside SIGTERM handlers under systemd
// TimeoutStopSec — past the budget the stubborn dir throws to the caller's
// guard rather than risk a SIGKILL mid-cleanup.
const RM_BUDGET_MS = 20000;
const RM_RETRY_CODES = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM']);
function rmSandbox(dir, budgetMs = RM_BUDGET_MS) {
  const t0 = Date.now();
  for (let i = 1; ; i++) {
    // Re-unlock inside the loop — a straggler (e.g. the snapshot guard) can
    // re-lock checkpoints between attempts.
    try { execFileSync('chattr', ['-R', '-i', dir], { stdio: 'ignore' }); } catch {}
    try { execFileSync('chmod', ['-R', 'u+rwX', dir], { stdio: 'ignore' }); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch (e) {
      const left = budgetMs - (Date.now() - t0);
      if (!RM_RETRY_CODES.has(e.code) || i >= RM_ATTEMPTS || left <= 0) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(RM_RETRY_MS * i, left));
    }
  }
}

function makeSandbox(tarball, id, opts = {}) {
  const sbx = mkdtempSync(path.join(tmpdir(), `flock-${id}-`));
  try {
    return makeSandboxIn(sbx, tarball, opts);
  } catch (e) {
    try { rmSandbox(sbx); } catch {} // no leak on a failed install; a teardown throw must not mask the real error
    throw e;
  }
}
// FLOCK-V2-SIGNIN seed: a signed-in-looking HOME whose only credential is the
// placeholder SIGNIN_DUMMY_KEY pointing at the in-wall broker listeners
// (127.0.0.1:3129 plain + 127.0.0.1:3130 TLS -> broker socks -> host-injected
// real key). Mirrors the real config shapes: cli/config.json (provider.zai) +
// the kernel-provisioned v2/provider_config.json (providerRules[].config.
// access.apiKey). The key's shape is load-bearing, not cosmetic: the kernel's
// client-signing splits the plan key on its single '.' (id.secret) and fails
// CLOSED on a separatorless placeholder — `flock-dummy-key` never reached the
// wire in a TUI turn. Dotted form verified by execution against the real
// kernel (signed-in PTY turn -> real `pong`).
const SIGNIN_DUMMY_KEY = 'flock-dummy.0123456789abcdef0123456789abcdef';
// The signed-in TUI's extra wiring (all proven on-host before this landed):
//   - v2/config.json `builtin:*` provider key -> zagent's standalone
//     provisioner writes the account-provider:* records the kernel TUI
//     resolves entitlement from (cli/config.json alone => "No model access")
//   - the account rule's api.baseUrl must point at the broker — a rewritten
//     copy of the runtime's bundled builtin config + ZCODE_BUILTIN_..._FILE
//   - the client-signing handshake requires HTTPS, so account traffic rides
//     the broker's TLS twin on 127.0.0.1:3130 (plain 3129 keeps serving the
//     api-key -p path) under NODE_TLS_REJECT_UNAUTHORIZED=0 — inside the wall
//     the only TLS endpoints are ours, so the blast radius is nil.
const SIGNIN_TLS_PORT = 3130;
const SIGNIN_TLS_BASE = `https://127.0.0.1:${SIGNIN_TLS_PORT}/api/anthropic`;

// The runtime's bundled builtin provider config, resolved host-side — env
// first (a fleet deploy can pin it), then the driver's own discovery. Null =
// signed-in TUI cards can't run this run (gated at the pick, loudly).
let builtinSrc; // undefined=unprobed, null=none, string=path
function signinBuiltinSrc() {
  if (builtinSrc !== undefined) return builtinSrc;
  builtinSrc = null;
  try {
    const p = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    if (p && existsSync(p)) builtinSrc = p;
  } catch {}
  if (!builtinSrc) {
    try {
      const r = findRuntime();
      if (r?.entry) {
        const cfg = path.resolve(path.dirname(r.entry), '..', 'config', 'provider', 'zcode-builtin.json');
        if (existsSync(cfg)) builtinSrc = cfg;
      }
    } catch {}
  }
  return builtinSrc;
}

// Throwaway self-signed material for the broker's TLS twin, generated once
// per flock run into the (already private) socket dir. The key signs nothing
// real — it exists only to satisfy the kernel's HTTPS handshake requirement.
let tlsMaterial; // undefined=unprobed, null=failed, {cert,key}
function signinTlsMaterial(dir) {
  if (tlsMaterial !== undefined) return tlsMaterial;
  tlsMaterial = null;
  try {
    const cert = path.join(dir, 'broker-cert.pem'), key = path.join(dir, 'broker-key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore', timeout: 15000 });
    chmodSync(key, 0o600);
    tlsMaterial = { cert, key };
  } catch {}
  return tlsMaterial;
}

function seedSigninHome(home) {
  const zdir = path.join(home, '.zcode');
  mkdirSync(path.join(zdir, 'cli'), { recursive: true });
  writeFileSync(path.join(zdir, 'cli', 'config.json'), JSON.stringify({
    provider: { zai: { kind: 'anthropic', name: 'Z.AI Coding Plan',
      options: { apiKeyRequired: true, apiKey: SIGNIN_DUMMY_KEY, baseURL: 'http://127.0.0.1:3129/api/anthropic' },
      models: { 'glm-5.3': { name: 'GLM-5.3' },
        'glm-5.3-flash': { name: 'GLM-5.3-Flash', limit: { context: 1000000, output: 128000 },
          modalities: { input: ['text', 'image', 'video'], output: ['text'] } } } } },
    model: { main: 'zai/glm-5.3', lite: 'zai/glm-5.3-flash' },
  }, null, 2), { mode: 0o600 });
  mkdirSync(path.join(zdir, 'v2'), { recursive: true });
  // Same shape the kernel provisions on a real signed-in install (verified
  // against this host's v2/provider_config.json): api.baseUrl carries the
  // endpoint, access.apiKey the credential — both placeholder here.
  writeFileSync(path.join(zdir, 'v2', 'provider_config.json'), JSON.stringify({
    config: { providerConfigRules: { providerRules: [
      { providerId: 'zai', providerName: 'Z.AI Coding Plan',
        config: { group: 'standard-personal',
          access: { type: 'api-key', apiKey: SIGNIN_DUMMY_KEY },
          api: { type: 'anthropic-messages', baseUrl: 'http://127.0.0.1:3129/api/anthropic' },
          personalModelIds: ['glm-5.3', 'glm-5.3-flash'],
          modelOrder: ['glm-5.3', 'glm-5.3-flash'] } } ] } },
  }), { mode: 0o600 });
  // The GUI-pushed provider map the standalone account provisioner reads —
  // without it no account-provider:* records are written and the TUI boots
  // to "No model access configured" even with the cli config seeded.
  writeFileSync(path.join(zdir, 'v2', 'config.json'), JSON.stringify({
    provider: { 'builtin:zai-coding-plan': {
      name: 'Z.AI Coding Plan', kind: 'anthropic', enabled: true, source: 'user',
      options: { apiKey: SIGNIN_DUMMY_KEY, apiKeyRequired: true, baseURL: SIGNIN_TLS_BASE },
      models: { 'GLM-5.3': { limit: { context: 200000, output: 32000 } },
        'GLM-5.3-Flash': { limit: { context: 1000000, output: 128000 },
          modalities: { input: ['text', 'image', 'video'], output: ['text'] } } } } },
  }, null, 2), { mode: 0o600 });
}

// The TUI half of the seed: a copy of the runtime's bundled builtin provider
// config with every api.z.ai account endpoint repointed at the TLS broker.
// Written as ~/.zcode/zcode-builtin-flock.json; the round's spawn env pins
// ZCODE_BUILTIN_PROVIDER_CONFIG_FILE to it (kernelEnv honors a preset value,
// so the kernel AND zagent's provisioner both read the redirected rules).
// Returns false when the source config cannot be resolved — the round then
// never picks a signed-in pty card (gated at the pick, not a silent dead turn).
function seedSigninTui(home) {
  const src = signinBuiltinSrc();
  if (!src) return false;
  try {
    const builtin = JSON.parse(readFileSync(src, 'utf8'));
    const rules = builtin?.config?.providerConfigRules?.providerRules;
    if (!Array.isArray(rules) || !rules.length) return false;
    // Rewrite every api.z.ai baseUrl in BOTH rule maps — providerRules feeds
    // the provisioner today, templateRules feed account creation flows; a
    // missed one would fail closed (egress is relay-allowlisted anyway) but
    // louder is better. zcode.z.ai-plan endpoints are left untouched — the
    // broker only fronts api.z.ai.
    const retarget = (r) => {
      const api = r?.config?.api;
      if (typeof api?.baseUrl === 'string' && api.baseUrl.startsWith('https://api.z.ai'))
        api.baseUrl = api.baseUrl.replace('https://api.z.ai', `https://127.0.0.1:${SIGNIN_TLS_PORT}`);
    };
    rules.forEach(retarget);
    const templates = builtin?.config?.providerConfigRules?.templateRules;
    if (Array.isArray(templates)) templates.forEach(retarget);
    // Credential-shaped fields must not ride the copy into the sandbox: the
    // bundled config carries none today, but an operator-pinned
    // ZCODE_BUILTIN_PROVIDER_CONFIG_FILE could carry a real access.apiKey —
    // strip every key-shaped VALUE field before the write (apiKeyRequired
    // and friends are flags, not material, and stay).
    const CRED_FIELD = /^(api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|token|secret|password|authorization|credential)$/i;
    const stripCreds = (n) => {
      if (Array.isArray(n)) { n.forEach(stripCreds); return; }
      if (!n || typeof n !== 'object') return;
      for (const k of Object.keys(n)) { if (CRED_FIELD.test(k)) delete n[k]; else stripCreds(n[k]); }
    };
    stripCreds(builtin);
    writeFileSync(path.join(home, '.zcode', 'zcode-builtin-flock.json'), JSON.stringify(builtin), { mode: 0o600 });
    return true;
  } catch { return false; }
}
// Headless -p never runs the TUI-launch provisioner (zagent.mjs gates it on
// !headless), so a seeded HOME without the account-provider:* records in
// v2/credentials.json resolves no entitled account and every signed-in `-p`
// fails 'Model creation failed' — live-proven 2026-09-19.
// Write what the first TUI launch would have
// written. The enc:v1 fallback secret derives from the DECRYPTING context's
// homedir — inside the wall that is this sandbox's HOME (/etc/passwd is
// ro-bound, so platform/username match the host) — so the records must be
// encrypted under the in-wall derivation, not this process's.
function provisionSigninAccounts(home) {
  try {
    const r = provisionStandaloneAccounts({
      env: {
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: path.join(home, '.zcode', 'zcode-builtin-flock.json'),
        ZCODE_CREDENTIAL_SECRET: `zcode-credential-fallback:${process.platform}:${home}:${userInfo().username}`,
      },
      home,
    });
    return r.provisioned.length > 0;
  } catch { return false; }
}
function makeSandboxIn(sbx, tarball, { signin = false } = {}) {
  const home = path.join(sbx, 'home');
  const prefix = path.join(sbx, 'prefix');
  mkdirSync(home);
  execFileSync('npm', ['install', '-g', tarball, '--prefix', prefix], { encoding: 'utf8', timeout: 300_000, stdio: 'ignore' });
  let signinTui = false;
  if (signin) {
    // The whole signin contract needs the broker's TLS twin: provisioned
    // records point at 127.0.0.1:3130 and the builtin-override env only
    // rides with brokerTls — a sandbox seeded without it is a SIGNED machine
    // running an unsigned card (broker bound, records present), which farms
    // guaranteed-false findings. Degrade before seeding.
    try { signin = !!ensureBroker().tlsSock; } catch { signin = false; }
  }
  if (signin) {
    seedSigninHome(home);
    signinTui = seedSigninTui(home) && provisionSigninAccounts(home);
    if (!signinTui) {
      // A half-signed sandbox can only farm guaranteed-false 'Model creation
      // failed' findings — unseed it so the round runs the unsigned pool on a
      // genuinely credential-free machine (the card premise holds).
      rmSync(path.join(home, '.zcode'), { recursive: true, force: true });
      signin = false;
    }
  }
  // The ONLY host secret inside the wall: the muse (opencode provider) token,
  // FILTERED to that single entry — the host auth.json also carries openai /
  // opencode-go / openrouter keys and must never enter the sandbox whole
  // (that whole-file leak is what the filter exists to prevent). mcp-auth.json is not copied at all.
  const dataDir = path.join(home, '.local', 'share', 'opencode');
  mkdirSync(dataDir, { recursive: true });
  try {
    const auth = JSON.parse(readFileSync(path.join(OPENC_DATA, 'auth.json'), 'utf8'));
    if (auth?.opencode) writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ opencode: auth.opencode }));
  } catch { /* no auth -> opencode fails loudly; INFRA, not a leak */ }
  // Model catalog cache — WITHOUT it the gateway rejects cache-less fresh
  // clients with a server-side "Unexpected server error" (found by execution:
  // host-direct fresh-HOME failed identically, proving the netns wall and the
  // CONNECT relay were innocent; the cache is machine-generated public
  // catalog data — no credentials — and .config/opencode is NOT copied).
  const cacheDir = path.join(home, '.cache', 'opencode');
  mkdirSync(cacheDir, { recursive: true });
  for (const f of ['models.json', 'version']) {
    const src = path.join(process.env.HOME, '.cache', 'opencode', f);
    if (existsSync(src)) copyFileSync(src, path.join(cacheDir, f));
  }
  // DNS: a plain resolv.conf file (the host's resolved text) — /run is NOT
  // bound (docker.sock and /run/user sockets must stay unreachable). Inside
  // the private netns nothing answers on the host stub, but proxied egress
  // does not need local DNS: the CONNECT hostname is resolved by the host
  // relay. The file exists so tools that read resolv.conf still behave.
  try { copyFileSync('/etc/resolv.conf', path.join(sbx, 'resolv.conf')); } catch { /* resolve later */ }
  // The wall hides the private repo — the inner relay script must live IN the
  // sandbox (node itself is /usr/bin/node inside the ro-bind).
  copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'net-relay.mjs'), path.join(sbx, 'net-relay.mjs'));
  // FLOCK-PTY: the interactive-TUI driver rides along too — pty:true cards
  // tell the agent to script zagent under `python3 pty-drive.py` (the /usr
  // ro-bind makes python3 reachable; stdlib-only, nothing to install).
  copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'pty-drive.py'), path.join(sbx, 'pty-drive.py'));
  return { sbx, home, prefix, bin: path.join(prefix, 'bin'), signin, signinTui };
}

/** The bwrap wall. Host paths under the host $HOME (except the opencode
 *  INSTALLER dir, which holds only the binary + its node_modules) are
 *  replaced by a tmpfs; /run is never bound (AF_UNIX sockets — docker.sock
 *  above all — must stay unreachable); /tmp is a tmpfs with only the sandbox
 *  itself bound through; IPC, PID and NETWORK namespaces are unshared —
 *  private netns, egress only via the unix-socket CONNECT relay below. */
function bwrapArgs(sbx) {
  return [
    '--ro-bind', '/usr', '/usr',
    '--unshare-net',
    '--unshare-pid', // bwrap is ns-init: killing it tears down the whole tree (no orphans holding pipes)
    '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind', '/etc', '/etc',
    // DNS without /run: create just the resolved dir and file-bind the stub
    // (the /etc/resolv.conf symlink resolves inside; no sockets exposed).
    '--dir', '/run/systemd/resolve',
    '--ro-bind-try', path.join(sbx, 'resolv.conf'), '/run/systemd/resolve/stub-resolv.conf',
    '--ro-bind', '/var/lib/dpkg', '/var/lib/dpkg', // zagent deb-version probe only
    '--ro-bind', '/opt', '/opt',
    '--tmpfs', HOST_HOME,
    '--tmpfs', '/tmp',
    // AFTER the /tmp tmpfs so a tmp-resident FLOCK_OPENCODE stub stays visible
    // inside the wall (a bind before it would be masked — silent INFRA).
    '--ro-bind', path.dirname(path.dirname(opencodeReal())), path.dirname(path.dirname(opencodeReal())), // ~/.opencode installer dir only
    '--bind', sbx, sbx,
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/dev/shm',
    '--unshare-ipc',
    '--new-session',
    '--die-with-parent',
  ];
}

/** Spawn the agent inside the wall. --unshare-net gives a private netns
 *  (no host loopback, no abstract sockets, no X11 — demonstrated unreachable);
 *  egress is ONLY the relay: an HTTP-CONNECT chain (inner listener on the
 *  private loopback -> unix socket bound through the wall -> host relay that
 *  dials 443 for allowlisted hosts). DNS never runs inside the wall. */
// Empty entries filtered; an EMPTY allowlist reaches the relay as
// '--allowlist ""' which denies every host (fail-closed), never allow-all.
const RELAY_HOSTS = (process.env.FLOCK_RELAY_HOSTS || 'opencode.ai').split(',').map((x) => x.trim()).filter(Boolean);
let relayProc = null, relaySock = null;
let brokerProc = null, brokerSock = null;
const sockDirs = new Set(); // every socket dir ever spawned — a relay respawn must not strand a live broker.sock
// AF_UNIX sun_path is 108 bytes (a full 108-byte path binds; 109 does not).
// On a host whose TMPDIR is long, a socket under a plain mkdtemp dir blows
// past it and the broker dies behind stdio:'ignore' — surfacing only as a
// readiness timeout with no cause. Root every socket dir where its longest
// bound leaf provably fits, falling back to /tmp before giving up loudly.
function socketDir(prefix, longestLeaf) {
  for (const dir of [...new Set([tmpdir(), '/tmp'])]) {
    // +6 for mkdtemp's random suffix
    if (Buffer.byteLength(path.join(dir, prefix + 'xxxxxx', longestLeaf)) <= 108) {
      return mkdtempSync(path.join(dir, prefix));
    }
  }
  throw new Error(`no temp root can host ${prefix}*/${longestLeaf} inside the 108-byte AF_UNIX path cap (TMPDIR=${tmpdir()})`);
}
// Registered once, not per-respawn (the listener pile-up tripped
// MaxListenersExceededWarning on long runs).
process.on('exit', () => { try { relayProc?.kill(); } catch {} try { brokerProc?.kill(); } catch {} for (const d of sockDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });
function ensureRelay() {
  if (relayProc && !relayProc.killed) return relaySock;
  const dir = socketDir('flock-relay-', 'broker-tls.sock'); // the broker shares this dir (see ensureBroker)
  sockDirs.add(dir);
  relaySock = path.join(dir, 'relay.sock');
  relayProc = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'net-relay.mjs'), 'host', relaySock, '--allowlist', RELAY_HOSTS.join(',')], { stdio: 'ignore' });
  const die = () => { relayProc = null; };
  relayProc.on('exit', die); relayProc.on('error', die);
  relayProc.unref(); // keep the parent's event loop free to exit (the exit hook kills it)
  // Wait for the socket to exist — bwrap's ro-bind needs the real file.
  const t0 = Date.now();
  while (!existsSync(relaySock) && Date.now() - t0 < 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  if (!existsSync(relaySock)) throw new Error(`relay socket never appeared: ${relaySock}`);
  return relaySock;
}
// The signin lane's host end: a broker (auth-injecting reverse proxy) sharing
// the relay's socket dir so the exit-hook rm covers both. The sandbox holds
// only a placeholder key; the real credential is resolved host-side per
// request and never crosses the wall.
let brokerTlsSock = null;
function ensureBroker() {
  if (brokerProc && !brokerProc.killed) return { sock: brokerSock, tlsSock: brokerTlsSock };
  const dir = path.dirname(ensureRelay());
  brokerSock = path.join(dir, 'broker.sock');
  const args = [path.join(path.dirname(fileURLToPath(import.meta.url)), 'net-relay.mjs'), 'broker', brokerSock,
    '--key-source', BROKER_KEY_SOURCE, '--upstream', 'https://api.z.ai',
    // Two prefixes, both still narrow: the anthropic-messages surface is the
    // only thing the seeded baseURL legitimately calls, and the kernel's
    // client-signing handshake posts to /api/paas/c1f3a7e2/v2/client (proven
    // by the live signed-in turn — a /api/anthropic-only broker let the
    // message through but failed the turn on the handshake). Anything else
    // under /api/ (account/quota/key-management endpoints) still rides the
    // injected real key nowhere — it is refused before auth is injected.
    '--path-prefix', '/api/anthropic', '--path-prefix', '/api/paas/c1f3a7e2/v2/client'];
  const tls = signinTlsMaterial(dir);
  brokerTlsSock = null;
  if (tls) {
    // The signing handshake refuses plain http — the same handler serves a
    // TLS twin on its own unix socket (throwaway self-signed material; inside
    // the wall the only TLS endpoint is ours).
    brokerTlsSock = path.join(dir, 'broker-tls.sock');
    args.push('--tls-sock', brokerTlsSock, '--tls-cert', tls.cert, '--tls-key', tls.key);
  }
  // Pin NODE_TLS_REJECT_UNAUTHORIZED=1 on the broker child: it inherits our
  // env, and an ambient =0 on the operator's shell would silently disable
  // cert validation on the broker's upstream https calls to api.z.ai.
  brokerProc = spawn(process.execPath, args, { stdio: 'ignore', env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '1' } });
  const die = () => { brokerProc = null; };
  brokerProc.on('exit', die); brokerProc.on('error', die);
  brokerProc.unref();
  const t0 = Date.now();
  while (!existsSync(brokerSock) && Date.now() - t0 < 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  if (!existsSync(brokerSock)) throw new Error(`broker socket never appeared: ${brokerSock}`);
  // A TLS sock that never appeared is degraded, not fatal: unsigned signin
  // cards still work; the TUI leg falls back to the seeded unsigned boot.
  if (brokerTlsSock) {
    while (!existsSync(brokerTlsSock) && Date.now() - t0 < 8000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    if (!existsSync(brokerTlsSock)) brokerTlsSock = null;
  }
  return { sock: brokerSock, tlsSock: brokerTlsSock };
}
// One pre-check before the first signin round: a host with no resolvable
// credential degrades to the unsigned pool loudly instead of farming false
// "turn refused" findings on every cadence tick. The source shape is
// validated against the broker's own grammar first — a malformed source must
// not false-enable into a broker that refuses it on every round.
async function signinKeyOk() {
  try {
    if (!/^(zai|env:.+|file:.+)$/.test(BROKER_KEY_SOURCE)) return false;
    if (BROKER_KEY_SOURCE.startsWith('env:')) return (process.env[BROKER_KEY_SOURCE.slice(4)] ?? '').trim() !== '';
    if (BROKER_KEY_SOURCE.startsWith('file:')) return readFileSync(BROKER_KEY_SOURCE.slice(5), 'utf8').trim() !== '';
    const m = await import(new URL('../../packages/driver/quota.mjs', import.meta.url));
    return typeof m.resolveCodingPlanKey().key === 'string';
  } catch { return false; }
}
/** qwen lane: a SECOND unix socket bound through the wall, owned by its own
 *  net-relay broker (separate from the signin broker — different upstream,
 *  different key, different path confinement). The broker injects the real
 *  upstream Authorization host-side and confines forwarded paths to /v1/; the
 *  worker's opencode points its provider baseURL at 127.0.0.1:3129/v1 with a
 *  dummy key. */
let qbrokerProc = null, qbrokerSock = null;
process.on('exit', () => { try { qbrokerProc?.kill(); } catch {} try { if (qbrokerSock) rmSync(path.dirname(qbrokerSock), { recursive: true, force: true }); } catch {} });
function ensureQwenBroker() {
  if (qbrokerProc && !qbrokerProc.killed) return qbrokerSock;
  const dir = socketDir('flock-qbroker-', 'broker.sock');
  qbrokerSock = path.join(dir, 'broker.sock');
  qbrokerProc = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'net-relay.mjs'), 'broker', qbrokerSock,
    '--upstream', QWEN_UPSTREAM, '--path-prefix', '/v1/', '--key-source', QWEN_KEY_SOURCE, '--client-name', QWEN_CLIENT],
    { stdio: 'ignore', env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '1' } });
  const die = () => { qbrokerProc = null; };
  qbrokerProc.on('exit', die); qbrokerProc.on('error', die);
  qbrokerProc.unref();
  const t0 = Date.now();
  while (!existsSync(qbrokerSock) && Date.now() - t0 < 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  if (!existsSync(qbrokerSock)) throw new Error(`qwen broker socket never appeared: ${qbrokerSock}`);
  return qbrokerSock;
}
/** claude-lane: one broker PER LANE (deepseek-v4-flash caps one in-flight
 *  per key) — lane % pool.length pins its key, so workers beyond the pool
 *  size share a key's slot; the sharing is logged in run(), never silent.
 *  The broker's own socket dir and the
 *  `env:` key source keep the real FreeInference key out of BOTH the flock
 *  process env and the sandbox: the key is handed to the broker child only.
 *  Path confinement is /anthropic — the only surface a loopback-pointed
 *  ANTHROPIC_BASE_URL legitimately calls. */
const claudeLaneBrokers = new Map(); // lane -> { proc, sock }
// The broker child gets exactly ONE lane key in its env — never the whole
// pool (its /proc/*/environ is same-uid readable). Pool-carrier vars are
// stripped before the spread lands; other ambient env inherits the host
// same-uid trust domain — identical posture to the qwen/signin brokers.
function claudeLaneBrokerEnv(lane) {
  const env = { ...process.env, FLOCK_LANE_KEY: FLOCK_LANE_POOL[lane % FLOCK_LANE_POOL.length], NODE_TLS_REJECT_UNAUTHORIZED: '1' };
  delete env.FLOCK_LANE_API_KEY; delete env.FLOCK_LANE_API_KEYS; delete env.FLOCK_LANE_KEY_CACHE;
  return env;
}
process.on('exit', () => { for (const b of claudeLaneBrokers.values()) { try { b.proc?.kill(); } catch {} try { if (b.sock) rmSync(path.dirname(b.sock), { recursive: true, force: true }); } catch {} } });
function ensureClaudeLaneBroker(lane) {
  const cur = claudeLaneBrokers.get(lane);
  if (cur?.proc && !cur.proc.killed) return cur.sock;
  const dir = socketDir('flock-claude-lane-broker-', 'broker.sock');
  const sock = path.join(dir, 'broker.sock');
  const proc = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'net-relay.mjs'), 'broker', sock,
    '--upstream', FLOCK_LANE_UPSTREAM, '--path-prefix', '/anthropic',
    // The key reaches the broker through ITS OWN env — not the flock's argv
    // (visible in ps) and not any file the sandbox can see.
    '--key-source', 'env:FLOCK_LANE_KEY', '--client-name', `zagent-flock-claude-lane-${lane}`],
    { stdio: 'ignore', env: claudeLaneBrokerEnv(lane) });
  const die = () => { if (claudeLaneBrokers.get(lane)?.proc === proc) { claudeLaneBrokers.delete(lane); try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
  proc.on('exit', die); proc.on('error', die);
  proc.unref();
  const t0 = Date.now();
  while (!existsSync(sock) && Date.now() - t0 < 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  if (!existsSync(sock)) { try { proc.kill('SIGKILL'); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} throw new Error(`claude-lane broker socket never appeared: ${sock}`); }
  claudeLaneBrokers.set(lane, { proc, sock });
  return sock;
}
/** Judge pass for the qwen lane: one bounded completion through the broker's
 *  unix socket (key stays broker-side — this process never reads it). Feeds
 *  the narration tail; returns 'OK', an array of finding strings, or [] when
 *  the judge can't decide (caller treats [] as "keep NOISY"). */
function qwenJudge(scenarioId, tail) {
  const prompt = `A test agent exercised a CLI in a sandbox on card "${scenarioId}" but ended by narrating instead of emitting the required verdict line. Here is the tail of its narration:\n\n${tail}\n\nDecide: did it observe a real defect (crash, hang, silent exit-0 on error, nonsense output, behavior contradicting the card's RIGHT/WRONG rules)? If yes, reply with one line per defect:\nFLOCK-FINDING: <title> | CMD: <exact command it ran> | EXPECTED: <expected> | GOT: <observed>\nIf no defect, reply with exactly:\nFLOCK-VERDICT: OK\nOutput ONLY those line(s), nothing else.`;
  const body = JSON.stringify({ model: QWEN_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 400, stream: false });
  return new Promise((resolve) => {
    let sock;
    try { sock = ensureQwenBroker(); } catch { return resolve([]); }
    const req = http.request({ socketPath: sock, method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let b = '';
      res.on('data', (d) => { if (b.length < 200_000) b += d; });
      res.on('end', () => {
        try {
          const text = JSON.parse(b).choices?.[0]?.message?.content ?? '';
          // Findings win over a co-emitted OK — a defect is the informative answer.
          const fs = [...text.matchAll(/FLOCK-FINDING:\s*(.+)/g)].map((m) => m[1].trim()).filter(Boolean)
            .filter((f) => !isTemplateEcho(f));
          if (fs.length) return resolve(fs);
          resolve(/FLOCK-VERDICT:\s*OK/i.test(text) ? 'OK' : []);
        } catch { resolve([]); }
      });
    });
    req.setTimeout(60_000, () => { req.destroy(); resolve([]); });
    req.on('error', () => resolve([]));
    req.end(body);
  });
}
function spawnNetns(sbx, cmdv, opts) {
  const relay = path.join(sbx.sbx, 'net-relay.mjs');
  // A SECOND bound-in socket for lanes that need one: signin rounds ride the
  // z.ai broker; qwen workers ride the qwen broker; claude-lane workers ride their
  // lane's FreeInference broker (only when a key pool resolved — the test
  // stub needs none). At most ONE broker sock is bound per sandbox, so all
  // three pipe to the same inner port, 127.0.0.1:3129. The signin broker
  // also carries a TLS twin on broker-tls.sock -> 127.0.0.1:3130, bound in
  // only when the builtin override seeded (sbx.signinTui) — the kernel's
  // client-signing handshake refuses plain http.
  const broker = sbx.signin ? ensureBroker()
    : (opts.qwen ? ensureQwenBroker()
    : (opts.claudeLane != null && FLOCK_LANE_POOL.length ? ensureClaudeLaneBroker(opts.claudeLane) : null));
  const brokerSock = sbx.signin ? broker?.sock : broker;
  const brokerTls = sbx.signin && sbx.signinTui ? broker?.tlsSock : null;
  // claude-lane walls are loopback-ONLY: the CONNECT relay socket is neither
  // spawned nor bound in (its allowlist would still serve opencode.ai to a
  // hand-rolled CONNECT — residual egress the lane does not need). The
  // worker can reach exactly its lane broker on 127.0.0.1:3129 and nothing
  // else.
  const relaySock = opts.claudeLane == null ? ensureRelay() : null;
  // Run the command as a CHILD (not exec) so this shell can kill the relay
  // on exit — an orphaned relay holds the stdout pipe open and the parent's
  // 'close' never fires (learned the hard way, twice).
  const inner = `${relaySock ? `node ${relay} inner 3128 ${relaySock} & RP=$!; ` : ''}${brokerSock ? `node ${relay} inner 3129 ${brokerSock} & RP2=$!; ` : ''}${brokerTls ? `node ${relay} inner ${SIGNIN_TLS_PORT} ${brokerTls} & RP3=$!; ` : ''}sleep 0.4; "$@" & CP=$!; wait $CP; RC=$?; kill $RP $RP2 $RP3 2>/dev/null; exit $RC`;
  const env = { ...opts.env,
    // claude-lane workers carry no proxy vars either — a proxy-honoring claude
    // would CONNECT 127.0.0.1 and fail closed.
    ...(opts.claudeLane == null ? { HTTP_PROXY: 'http://127.0.0.1:3128', HTTPS_PROXY: 'http://127.0.0.1:3128', NO_PROXY: '127.0.0.1' } : {}),
    // Signed-in TUI legs: point the kernel (and zagent's own provisioner) at
    // the repointed builtin config and accept the broker's throwaway cert.
    // Propagates to every child incl. `zagent` under pty-drive (execvpe).
    ...(brokerTls ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: path.join(sbx.home, '.zcode', 'zcode-builtin-flock.json'),
      NODE_TLS_REJECT_UNAUTHORIZED: '0' } : {}) };
  // The real claude-lane also ro-binds the claude package dir (binary +
  // node_modules) ON TOP of the home tmpfs — same shape as the opencode
  // installer bind; the FLOCK_LANE_BIN stub needs nothing (it is copied into sbx).
  const claudeLaneBind = opts.claudeLane != null && !process.env.FLOCK_LANE_BIN
    ? (() => { const pkg = path.dirname(path.dirname(claudeReal())); return ['--ro-bind', pkg, pkg]; })() : [];
  return spawn('bwrap', [...bwrapArgs(sbx.sbx), ...(relaySock ? ['--ro-bind', relaySock, relaySock] : []), ...claudeLaneBind, ...(brokerSock ? ['--ro-bind', brokerSock, brokerSock] : []), ...(brokerTls ? ['--ro-bind', brokerTls, brokerTls] : []), '/bin/sh', '-c', inner, 'sh', ...cmdv], { ...opts, env });
}

/** Post-round escape audit — belt over the bwrap suspenders. Any attempt to
 *  reach host-anchored paths, host sockets, or dump another process's
 *  environment is an ESCAPE: recorded, never trusted, and the flock kills
 *  itself loudly. Patterns are host-anchored on purpose — sandbox-local
 *  idioms (`grep -ri api_key .`, `env TERM=x zagent …`) are NOT escapes. */
const CREDENTIAL_PATTERN = /ANTHROPIC_|AUTH_TOKEN|API_KEY=|api_key[.=]|Bearer /i; // env-carried gateway keys (claude-lane)
const ESCAPE_PATTERNS = [
  // Host-anchored SPECIFIC names only — the agent's own tmpfs home and the
  // harness's own DNS file are NOT escapes (bare $HOME /run/ prefixes
  // false-positived on them and killed healthy flocks).
  new RegExp(REPO_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), // the host checkout
  /\.npmrc|id_rsa|\.ssh\/|\.gnupg/i,
  /docker\.sock|\/run\/user\//,
  /(^|[\s;&|])(xwd|xdotool|xinput)(\s|-|$)/, // X11 capture/inject tools
  /(^|[;&|\s])printenv(\s|$|;|&|\|)/,
  CREDENTIAL_PATTERN,
  /FLOCK_LANE_KEY_CACHE|\.api_key/, // the claude-lane's own key cache — reads/exfil of it
  /\/proc\/[0-9]+\/environ/,
];
// The signin pool's placeholder literal is not secret: a command naming the
// exact dummy key (e.g. `ZAI_API_KEY=flock-dummy.01… zagent quota`) can only
// be probing the seeded dummy — exempt it from the credential-carrier pattern
// alone, not from the rest of the audit. The exemption names the FULL literal
// — a bare 'flock-dummy' substring would let `KEY=<real-token> # flock-dummy`
// slip past the pattern. Same for 'flock-test-000' — the
// scenarios-extra pty cards declare `env ZAI_API_KEY=flock-test-000 zagent`
// as an explicit prop; a worker obeying the card is not exfiltrating, and the
// exact literal keeps `KEY=<real> # flock-test-` from riding the exemption.
// 'dummy-not-a-real-key' was the onboard-bad-key-fast-fail card's literal —
// the verbatim card command ESCAPEd and killed the 0.0.238 release-gate flock
// 2026-09-19 (a worker obeying its card, not a wall probe); the card now
// declares flock-test-000 and the old literal stays exempt defensively.
// 'dummy-key-123' — same class, 2026-09-23: the quota-nocred-class-agreement
// card prescribes NO env prefix, but a worker improvised
// `ZAI_API_KEY=dummy-key-123 zagent quota` to check the class flips with a key;
// obviously-synthetic value, SUT-only command, no host paths — a scenario
// probe, not a wall probe. Exact literal per the design rule above.
// Self-labelling synthetic API_KEY values (workers invent their own dummies
// when scenario cards exercise key handling — dummy-key-123 and fake-key-123
// both killed gate flocks 2026-09-23; exact literals cannot converge). The
// synthetic assignment is STRIPPED before any pattern runs, so an exemption
// can never mask a different credential carrier in the same command (seen
// 2026-09-23: `curl -H "Authorization: Bearer <real>" ".../?API_KEY=example"`
// escaped when the whole-pattern exemption keyed off the URL parameter). Value
// length ≤ 40 keeps a marker SUFFIX on a real key (z.ai hex.id is 49, sk-ant
// bodies 95+) from disguising it; a plain `# fake` comment never matched the
// value-bounded regex in the first place.
// Value-end anchored (found 2026-09-23): without the lookahead the strip ate only the
// first ~15 chars of `API_KEY=example<real-49-char-key>`, leaving the real key's
// remainder riding as a bare token. The lookahead forces the WHOLE value to end
// within the bounds, so a marker can never prefix/suffix a real key: total value
// ≤ 16+7+8 chars — worker dummies (≤14) fit, real keys (49+) cannot.
const SYNTHETIC_KEY_VALUE = /API_KEY=[^\s;&|]{0,16}(?:dummy|fake|placeholder|not-a-real|example)[^\s;&|]{0,8}(?=[\s;&|]|$)/i;
function stripSyntheticKeyValues(cmd) {
  return cmd.replace(SYNTHETIC_KEY_VALUE, 'SYNTHETIC'); // bare marker: an API_KEY=-bearing replacement would re-trigger the pattern
}
function auditCmds(cmds) {
  return cmds.filter((raw) => {
    const c = stripSyntheticKeyValues(raw);
    return ESCAPE_PATTERNS.some((p) =>
      !(p === CREDENTIAL_PATTERN && (
        c.includes(SIGNIN_DUMMY_KEY) || c.includes('flock-test-000') || c.includes('dummy-not-a-real-key') || c.includes('dummy-key-123')
      )) && p.test(c));
  });
}
export { auditCmds as _auditCmdsForTest, SYNTHETIC_KEY_VALUE as _syntheticKeyValueForTest };

/** claude-lane engine: a claude-CLI lane on the brokered FreeInference endpoint.
 *  Re-armed through the net-relay broker (fixing a key-exposure
 *  defect): the worker runs INSIDE the same bwrap netns wall as every other
 *  lane, with a dummy token + loopback baseURL — the host-side broker
 *  injects the real key per request, so the key never enters the worker's
 *  env, filesystem, or argv. FLOCK_LANE_BIN is the offline-test seam: the stub is
 *  copied INTO the sandbox (the wall would hide its host tmpdir path) and
 *  needs no broker. The lane arg pins the pool key (lane % pool.length). */
function spawnClaudeLane(sbx, card, lane) {
  let cmdv;
  if (process.env.FLOCK_LANE_BIN) {
    // Seam contract: the stub must be a node-loadable .mjs — it is copied
    // in-wall and run under `node` (a shell/compiled stub fails INFRA).
    const inWall = path.join(sbx.sbx, 'claude-lane-stub.mjs');
    copyFileSync(process.env.FLOCK_LANE_BIN, inWall);
    cmdv = ['node', inWall, '-p', card, '--output-format', 'stream-json', '--verbose'];
  } else {
    // The same env contract the claude-lane wrapper exports — minus the real key:
    // the worker's claude sees a loopback base + dummy token only.
    cmdv = [claudeReal(), '-p', card, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  }
  return spawnNetns(sbx, cmdv, {
    claudeLane: lane,
    cwd: sbx.sbx,
    env: {
      PATH: `${sbx.bin}:/usr/local/bin:/usr/bin:/bin`,
      HOME: sbx.home, USERPROFILE: sbx.home,
      XDG_CONFIG_HOME: path.join(sbx.home, '.config'), XDG_DATA_HOME: path.join(sbx.home, '.local', 'share'),
      XDG_CACHE_HOME: path.join(sbx.home, '.cache'), LANG: 'C.UTF-8', TERM: 'dumb',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3129/anthropic',
      ANTHROPIC_AUTH_TOKEN: FLOCK_LANE_DUMMY,
      ANTHROPIC_MODEL: FLOCK_LANE_MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: FLOCK_LANE_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: FLOCK_LANE_MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: FLOCK_LANE_HAIKU,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // No FLOCK_LANE_*, no ANTHROPIC_API_KEY — the key never enters the wall
      //. The env stays a whitelist, never a process.env spread.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

let signinOk = false; // resolved once in run() — a keyless host degrades
/** Run one opencode agent on one scenario; resolves to a classified record. */
async function oneRound(tarball, worker, rng) {
  const eng = workerEngine(worker.id);
  // Signin cards need the signin broker listener — only opencode rounds
  // pick them; claude-lane/qwen workers ride their own lanes' brokers instead.
  const useSignin = signinOk && eng === 'opencode' && worker.round % SIGNIN_EVERY === 0;
  let sbx = null, scenario = null;
  try {
    sbx = makeSandbox(tarball, `${worker.id}-${worker.round}`, { signin: useSignin });
    liveSandboxes.add(sbx.sbx);
    // Signed-in cards need the WHOLE contract: builtin override AND
    // provisioned account records (sbx.signinTui now means both) AND the
    // broker's TLS twin live — a half-seeded sandbox is unseeded at build
    // time, so a degraded signin round runs the unsigned pool rather than
    // farming a false "Model creation failed" / "No model access" finding.
    const signinLive = !!(useSignin && sbx.signinTui && ensureBroker().tlsSock);
    if (useSignin && !signinLive) log(`W${worker.id} r${worker.round}: signin seed degraded — running unsigned pool`);
    scenario = signinLive
      ? pickScenario(rng, worker.recent, [...SIGNIN_SCENARIOS, ...SIGNIN_PTY_SCENARIOS])
      : pickFromPool(rng, worker.recent);
    worker.recent = [scenario.id, ...worker.recent].slice(0, 3);
    const runSeed = Math.floor(rng() * 2 ** 31);
    const roundModel = eng === 'claude-lane' ? 'claude-lane/deepseek-v4-flash'
      : eng === 'qwen' ? `qwen/${QWEN_MODEL}` : MODELS[Math.floor(rng() * MODELS.length)];
    const rec = { ts: new Date().toISOString(), worker: worker.id, round: worker.round, scenario: scenario.id, seed: SEED, runSeed, model: roundModel, tarball: path.basename(tarball) };
    if (signinLive) rec.signin = true; // triage weight: a real-turn round (degraded seeds run unsigned and must not carry the marker)
    const out = await new Promise((resolve) => {
      const cardText = scenario.card().replace('RULES (obey exactly):', `RULES (obey exactly):\n- Reproducibility: your first command must be \`echo SEED:${runSeed}\`.`)
        // Weak-model lane: qwen follows mid-card rules (seed echo verified)
        // but drifts into narration instead of the closing protocol line —
        // repeat it as a hard tail.
        + (eng === 'qwen' ? `\n\nMANDATORY FINAL OUTPUT (overrides everything): your LAST line must be exactly \`FLOCK-VERDICT: OK\`, or one line per defect \`FLOCK-FINDING: <title> | CMD: <command> | EXPECTED: <expected> | GOT: <observed>\`. Nothing may follow the verdict line.` : '');
      let spawnFn;
      if (eng === 'claude-lane') {
        spawnFn = () => spawnClaudeLane(sbx, cardText, worker.id - 1);
      } else {
        if (eng === 'qwen') {
          // Custom OpenAI-compatible provider aimed at the broker's inner
          // listener; the dummy apiKey is overwritten host-side. Written per
          // sandbox so the opencode pool is untouched.
          const cfgDir = path.join(sbx.home, '.config', 'opencode');
          mkdirSync(cfgDir, { recursive: true });
          writeFileSync(path.join(cfgDir, 'opencode.json'), JSON.stringify({
            provider: { qwenlane: {
              npm: '@ai-sdk/openai-compatible', name: 'qwen-lane',
              options: { baseURL: 'http://127.0.0.1:3129/v1', apiKey: 'flock-brokered' },
              models: { [QWEN_MODEL]: { name: QWEN_MODEL } },
            } },
          }));
        }
        const modelArg = eng === 'qwen' ? `qwenlane/${QWEN_MODEL}` : roundModel;
        spawnFn = () => spawnNetns(sbx, [opencodeReal(), 'run', '--format', 'json', '--auto', '-m', modelArg, cardText], {
          qwen: eng === 'qwen',
        cwd: sbx.sbx,
        env: {
          PATH: `${sbx.bin}:/usr/local/bin:/usr/bin:/bin`, HOME: sbx.home, USERPROFILE: sbx.home,
          XDG_CONFIG_HOME: path.join(sbx.home, '.config'), XDG_DATA_HOME: path.join(sbx.home, '.local', 'share'),
          XDG_CACHE_HOME: path.join(sbx.home, '.cache'), LANG: 'C.UTF-8', TERM: 'dumb',
        }, stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
      const p = spawnFn();
      // Bounded buffers — a runaway writer (`yes >&2`) must not OOM the
      // supervisor mid-run; classification only needs the head of the stream.
      let so = '', se = '';
      p.stdout.on('data', (d) => { if (so.length < 4_000_000) so += d; });
      p.stderr.on('data', (d) => { if (se.length < 1_000_000) se += d; });
      const kill = setTimeout(() => p.kill('SIGKILL'), 420_000);
      p.on('error', (e) => { clearTimeout(kill); resolve({ code: 127, so: '', se: `spawn failed: ${e.message}` }); });
      p.on('close', (code) => { clearTimeout(kill); resolve({ code, so, se }); });
    });
    rec.agentExit = out.code;
    const texts = [], cmds = [];
    let bashParts = 0; // bash tool parts seen, parsed or not — schema-drift alarm
    for (const line of out.so.split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        const part = j.part;
        if (part?.type === 'text' && part.text) texts.push(part.text);
        if (part?.type === 'tool' && part.tool === 'bash') {
          bashParts += 1;
          if (part.state?.input?.command) cmds.push(part.state.input.command);
        }
        // claude-lane engine: claude-CLI stream shape (assistant.message.content[]).
        if (j.type === 'assistant') {
          for (const c of j.message?.content ?? []) {
            if (c.type === 'text' && c.text) texts.push(c.text);
            if (c.type === 'tool_use' && c.name === 'Bash') {
              bashParts += 1;
              if (c.input?.command) cmds.push(c.input.command);
            }
          }
        }
      } catch { /* stream noise */ }
    }
    rec.bashParts = bashParts;
    if (bashParts > 0 && cmds.length === 0) rec.auditGap = `${bashParts} bash tool part(s) but 0 commands parsed — opencode stream schema drift; ESCAPE audit saw nothing`; // disarmed audit must be loud
    rec.cmds = cmds.slice(0, 40);
    // Audit the FULL command list — the record is capped for size, the audit
    // must not be (cmds 41+ were unaudited before).
    const escaped = auditCmds(cmds);
    if (escaped.length) {
      rec.class = 'ESCAPE'; rec.escaped = escaped;
      record(rec);
      log(`ESCAPE DETECTED (worker ${worker.id}): ${escaped[0].slice(0, 120)} — FLOCK SHUTTING DOWN`);
      for (const d of liveSandboxes) { try { rmSandbox(d); } catch (e) { log(`teardown ${path.basename(d)}: ${e.code || e.message}`); } }
      process.exit(42); // loud kill, clean sandboxes first
    }
    // Findings are scanned across ALL text parts (an agent may narrate a
    // finding mid-run and then summarize) — not just the final message.
    const allFindings = [...texts.join('\n').matchAll(/FLOCK-FINDING:\s*(.+)/g)].map((m) => m[1].trim()).filter(Boolean);
    const findings = allFindings.filter((f) => !isTemplateEcho(f));
    if (findings.length !== allFindings.length) rec.templateEchoes = allFindings.length - findings.length;
    const ranZagent = rec.cmds.some((c) => /(^|[\s;&|])(zagent|za)(\s|$)|prefix\/bin\/zagent/.test(c));
    const echoedSeed = rec.cmds.some((c) => new RegExp(`echo SEED:${runSeed}\\b`).test(c));
    // A finding whose CMD the agent never actually ran is a hallucination
    // risk: keep it, but tag it so triage shows the doubt.
    const ranCmd = (f) => {
      const cmd = (f.match(/CMD:\s*([^|]+)/)?.[1] ?? '').trim().replace(/\s+/g, ' ');
      if (!cmd) return false;
      return rec.cmds.some((c) => c.replace(/\s+/g, ' ').includes(cmd.slice(0, Math.min(24, cmd.length))));
    };
    // FLOCK-PTY oracle floor : an interactive
    // card's finding must cite the SCREEN line it was judged from — a CMD
    // cite alone cannot prove a screen-state claim.
    const backed = (f) => scenario.pty ? /SCREEN\s*:/i.test(f) : ranCmd(f);
    if (out.code !== 0 && !texts.length) {
      rec.class = 'INFRA'; rec.note = `${eng} exit ${out.code}; stderr: ${out.se.slice(0, 200)}`;
    } else if (findings.length) {
      rec.class = 'FINDING'; rec.findings = findings;
      rec.unbackedFindings = findings.filter((f) => !backed(f));
    } else if (!ranZagent) {
      rec.class = 'NOISY'; rec.note = `agent never invoked zagent (${rec.cmds.length} cmds) — no evidence, not an OK`;
    } else if (/FLOCK-VERDICT:\s*OK/i.test(texts[texts.length - 1] ?? '')) {
      // An OK verdict without the round's seed echo cannot be tied to THIS
      // round (a lazy agent may be summarizing nothing) — not an OK.
      if (!echoedSeed) { rec.class = 'NOISY'; rec.note = 'OK verdict but no SEED echo'; }
      else rec.class = 'OK';
    } else {
      rec.class = 'NOISY'; rec.note = `no verdict line; last text: ${(texts[texts.length - 1] ?? '').slice(0, 160)}`;
    }
    // Qwen-lane judge pass: the weak model often does real exploration then
    // narrates instead of emitting the protocol line — a NOISY with commands
    // run can hide a narrated finding (observed: a real flag-arity defect
    // described in prose, never formatted). One bounded judge completion
    // through the broker converts the evidence — rec.judged marks the
    // verdict as extracted, not self-reported, so triage can weigh it.
    if (eng === 'qwen' && rec.class === 'NOISY' && rec.cmds.length && echoedSeed) {
      const verdict = await qwenJudge(scenario.id, texts.join('\n').slice(-4000));
      if (verdict === 'OK') { rec.class = 'OK'; rec.judged = true; }
      else if (verdict.length) {
        rec.class = 'FINDING'; rec.judged = true;
        rec.findings = verdict;
        rec.unbackedFindings = verdict.filter((f) => !backed(f));
      }
    }
    record(rec);
    return rec;
  } catch (e) {
    const rec = { ts: new Date().toISOString(), worker: worker.id, round: worker.round, scenario: scenario?.id ?? 'unpicked', class: 'INFRA', note: String(e.message).slice(0, 300) };
    record(rec);
    return rec;
  } finally {
    if (sbx) {
      try { rmSandbox(sbx.sbx); } catch (e) { log(`teardown ${path.basename(sbx.sbx)}: ${e.code || e.message}`); }
      liveSandboxes.delete(sbx.sbx);
    }
  }
}

const liveSandboxes = new Set();
// A teardown that still fails after the retries must not convert a clean
// signal exit into an exit-1 crash: log the stubborn dir, keep cleaning the
// rest, keep the signal's exit code.
function teardownAll(code) {
  // The dwell budget is shared across dirs: N stubborn sandboxes must still
  // fit under systemd TimeoutStopSec in aggregate, not 20s each.
  let budget = RM_BUDGET_MS;
  for (const s of liveSandboxes) {
    const t = Date.now();
    try { rmSandbox(s, budget); } catch (e) { log(`teardown ${path.basename(s)}: ${e.code || e.message}`); }
    budget = Math.max(0, budget - (Date.now() - t));
  }
  process.exit(code);
}
process.on('SIGINT', () => teardownAll(130));
process.on('SIGTERM', () => teardownAll(143));

async function run() {
  const claudeLaneLanes = FLOCK_LANE_LIVE ? (ENGINE === 'claude-lane' ? workers : FLOCK_LANE_WORKERS) : 0;
  if (!FLOCK_LANE_LIVE && (ENGINE === 'claude-lane' || FLOCK_LANE_WORKERS > 0)) {
    if (ENGINE === 'claude-lane') {
      log('REFUSED: --engine claude-lane needs a key pool (FLOCK_LANE_API_KEYS / FLOCK_LANE_API_KEY / FLOCK_LANE_KEY_CACHE) — the broker holds it host-side so the worker never sees it. Run --engine opencode.');
      process.exit(3);
    }
    log(`claude-lane DISABLED (no FreeInference key pool for the broker) — ${FLOCK_LANE_WORKERS} worker(s) run opencode instead`);
  }
  if (claudeLaneLanes > 0 && !process.env.FLOCK_LANE_BIN) {
    // Preflight the real binary once (the qwen-upstream pattern): a host
    // with a key pool but no claude install must refuse or degrade loudly,
    // never burn rounds into INFRA records on a spawn that always throws.
    try { claudeReal(); }
    catch (e) {
      const why = `claude binary unresolvable (${String(e.message).slice(0, 120)})`;
      if (ENGINE === 'claude-lane') { log(`REFUSED: --engine claude-lane — ${why}`); process.exit(3); }
      log(`claude-lane DISABLED — ${why} — ${FLOCK_LANE_WORKERS} worker(s) run opencode instead`);
      claudeLaneActive = false;
    }
    // The wall ro-binds opencode unconditionally (bwrapArgs) — a claude-only
    // host would burn every round as spawn-throw INFRA; refuse/degrade here.
    if (claudeLaneActive) {
      try { opencodeReal(); }
      catch (e) {
        const why = `opencode binary unresolvable (${String(e.message).slice(0, 120)})`;
        if (ENGINE === 'claude-lane') { log(`REFUSED: --engine claude-lane — ${why}`); process.exit(3); }
        log(`claude-lane DISABLED — ${why} — ${FLOCK_LANE_WORKERS} worker(s) run opencode instead`);
        claudeLaneActive = false;
      }
    }
    // Upstream preflight (the qwen pattern completed): a dead FreeInference
    // gateway must refuse or degrade loudly, never burn an all-INFRA sweep.
    // Unauthed — ANY HTTP response proves reachability; the broker injects
    // the key host-side, so a stale pool key can still arm (fail-safe: its
    // rounds land INFRA, which never counts as exercised).
    if (claudeLaneActive) {
      try {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
        await fetch(`${FLOCK_LANE_UPSTREAM}/anthropic/v1/messages`, { signal: ctrl.signal }).finally(() => clearTimeout(t));
      } catch (e) {
        const why = `claude-lane upstream ${FLOCK_LANE_UPSTREAM} unreachable (${e.name === 'AbortError' ? 'timeout' : e.cause?.code || e.message})`;
        if (ENGINE === 'claude-lane') { log(`REFUSED: --engine claude-lane — ${why}`); process.exit(3); }
        log(`claude-lane DISABLED — ${why} — ${FLOCK_LANE_WORKERS} worker(s) run opencode instead`);
        claudeLaneActive = false;
      }
    }
  }
  if (claudeLaneActive && claudeLaneLanes > 0) {
    const lanes = FLOCK_LANE_POOL.length ? Math.min(claudeLaneLanes, FLOCK_LANE_POOL.length) : 0;
    log(`claude-lane ENABLED: ${claudeLaneLanes} worker(s) brokered (${FLOCK_LANE_POOL.length ? `${lanes} lane(s) over a ${FLOCK_LANE_POOL.length}-key pool -> ${FLOCK_LANE_UPSTREAM}` : 'FLOCK_LANE_BIN test seam'}${claudeLaneLanes > lanes && FLOCK_LANE_POOL.length ? `; ${claudeLaneLanes - lanes} worker(s) SHARE key lanes (1 in-flight/key cap)` : ''})`);
  }
  if (SIGNIN) {
    signinOk = await signinKeyOk();
    if (!signinOk) log('signin DISABLED: broker key source resolves no host credential — running the unsigned pool only');
    else {
      const tuiLeg = !signinBuiltinSrc()
        ? 'NO builtin provider config found — signin-pty cards will gate out'
        : signinTlsMaterial(path.dirname(ensureRelay()))
          ? 'TUI leg wired (builtin override + TLS twin)' : 'openssl missing — no TLS twin, signin-pty cards will gate out';
      log(`signin ENABLED: every ${SIGNIN_EVERY}th round per worker is a signed-in card (key-source ${BROKER_KEY_SOURCE.split(':')[0]}; ${tuiLeg})`);
    }
  }
  let qwenLanes = QWEN_LIVE ? (ENGINE === 'qwen' ? workers : QWEN_WORKERS) : 0;
  if (qwenLanes > 0) {
    // Preflight the upstream once: a dead tunnel/vLLM must refuse or degrade
    // loudly, never burn rounds into INFRA records. /v1/models is unauthed on
    // vLLM? no — send no key; ANY HTTP response proves reachability.
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
      await fetch(`${QWEN_UPSTREAM}/v1/models`, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    } catch (e) {
      const why = `qwen upstream ${QWEN_UPSTREAM} unreachable (${e.name === 'AbortError' ? 'timeout' : e.cause?.code || e.message})`;
      if (ENGINE === 'qwen') { log(`REFUSED: --engine qwen — ${why}`); process.exit(3); }
      log(`qwen lane DISABLED — ${why} — ${QWEN_WORKERS} worker(s) run opencode instead`);
      qwenLanes = 0;
      qwenActive = false;
    }
  }
  if (!QWEN_LIVE && (ENGINE === 'qwen' || QWEN_WORKERS > 0)) {
    if (ENGINE === 'qwen') {
      log('REFUSED: --engine qwen needs FLOCK_QWEN_KEY or FLOCK_QWEN_KEY_FILE (the broker-held upstream key — the key never enters the sandbox).');
      process.exit(3);
    }
    log(`qwen lane DISABLED (no FLOCK_QWEN_KEY/FLOCK_QWEN_KEY_FILE) — ${QWEN_WORKERS} worker(s) run opencode instead`);
  }
  const tarball = resolveTarball();
  const deadline = Date.now() + maxHours * 3600_000;
  log(`start: ${workers} workers x ${rounds || '∞'} rounds, max ${maxHours}h, SUT=${path.basename(tarball)}, model=${MODEL}${claudeLaneActive && claudeLaneLanes ? ` +claude-lane×${claudeLaneLanes}` : ''}${qwenLanes ? ` +qwen×${qwenLanes}(${QWEN_MODEL})` : ''}, seed=${SEED}, bwrap=on`);
  const ran = [];
  await Promise.all(Array.from({ length: workers }, async (_, i) => {
    const worker = { id: i + 1, round: 0, recent: [], fails: 0 };
    ran.push(worker);
    const rng = workerRng(worker.id);
    while (Date.now() < deadline && (rounds === 0 || worker.round < rounds)) {
      worker.round += 1;
      const rec = await oneRound(tarball, worker, rng);
      if (rec.class === 'FINDING') log(`W${worker.id} r${worker.round} ${rec.scenario}: FINDING x${rec.findings.length}`);
      else if (rec.class === 'INFRA') { worker.fails += 1; log(`W${worker.id} r${worker.round} ${rec.scenario}: INFRA (${rec.note?.slice(0, 80)})`); }
      else { worker.fails = 0; log(`W${worker.id} r${worker.round} ${rec.scenario}: ${rec.class}`); } // fails = consecutive, not cumulative
      if (worker.fails >= 3) { log(`W${worker.id}: 3 consecutive infra failures — backoff 120s`); await new Promise((r) => setTimeout(r, 120_000)); worker.fails = 0; }
      else await new Promise((r) => setTimeout(r, 5_000 + Math.floor(rng() * 10_000)));
    }
    log(`worker ${worker.id} done: ${worker.round} rounds`);
  }));
  log(`stop: deadline/rounds reached. Run --triage for deduped findings.`);
  // Exit 3 when a requested round count was cut short by the deadline: callers
  // that asked for N rounds (the publish gate asks for 4x8) must not read a
  // partial sweep as a completed one. -r 0 (the standing service) is exempt —
  // it is BY DESIGN deadline-bounded.
  if (rounds !== 0 && ran.some((w) => w.round < rounds)) {
    log(`incomplete: workers finished ${ran.map((w) => w.round).join('/')}/${rounds} rounds — exiting 3`);
    process.exitCode = 3;
  }
}

/** Isolation acceptance probe — MACHINE-DIRECTED, no model in the loop (the
 *  free model declines "reconnaissance" cards; the wall is what's under test
 *  anyway). Runs the probe commands inside the wall and parses them itself:
 *  PASS = zero reachable host paths + zagent works + network works. */
async function probeIsolation() {
  const tarball = resolveTarball();
  const sbx = makeSandbox(tarball, 'probe');
  const script = [
    `for p in ${HOST_HOME}/.npmrc ${REPO_ROOT} ${HOST_HOME}/.ssh ${HOST_HOME}/.local/bin /run/docker.sock /run/user; do test -e "$p" && echo "REACHABLE:$p"; done`,
    // The honest X11 oracle: with a private netns the X11 abstract socket is
    // unreachable outright; xdpyinfo performs the full handshake anyway — any
    // X11-AUTHORIZED here means the netns wall failed open.
    'DISPLAY=:1 timeout 5 xdpyinfo >/dev/null 2>&1 && echo X11-AUTHORIZED || echo X11-denied',
    '(timeout 4 bash -c \'</dev/tcp/127.0.0.1/22\' 2>/dev/null && echo SSH-REACHABLE) || echo SSH-unreachable',
    'zagent --version >/dev/null 2>&1 && echo ZAGENT-OK || echo ZAGENT-BROKEN',
    'curl -sS -m 15 -o /dev/null -w "NET=%{http_code}" https://opencode.ai/',
  ].join('\n');
  const out = await new Promise((resolve) => {
    const p = spawnNetns(sbx, ['/bin/sh', '-c', script], {
      cwd: sbx.sbx,
      env: { PATH: `${sbx.bin}:/usr/local/bin:/usr/bin:/bin`, HOME: sbx.home, LANG: 'C.UTF-8', TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let so = '', se = ''; p.stdout.on('data', (d) => { if (so.length < 4_000_000) so += d; }); p.stderr.on('data', (d) => { if (se.length < 1_000_000) se += d; });
    const kill = setTimeout(() => p.kill('SIGKILL'), 120_000);
    p.on('error', (e) => { clearTimeout(kill); resolve({ so: `SPAWN-FAIL ${e.message}`, se: '' }); });
    p.on('close', () => { clearTimeout(kill); resolve({ so, se }); });
  });
  try { rmSandbox(sbx.sbx); } catch (e) { log(`teardown ${path.basename(sbx.sbx)}: ${e.code || e.message}`); }
  console.log(out.so.trim()); if (out.se.trim()) console.log(`stderr: ${out.se.trim().slice(0, 200)}`);
  const reachable = [...out.so.matchAll(/REACHABLE:(\S+)/g)].map((m) => m[1]);
  const ok = !reachable.length && /ZAGENT-OK/.test(out.so) && /NET=200/.test(out.so)
    && /X11-denied/.test(out.so) && !/X11-AUTHORIZED/.test(out.so)
    && /SSH-unreachable/.test(out.so) && !/SSH-REACHABLE/.test(out.so);
  console.log(ok ? 'ISOLATION: VERIFIED (private netns: no host path, X11 denied, host loopback unreachable; egress = allowlisted 443 relay only)' : `ISOLATION: BROKEN — reachable: ${reachable.join(', ') || '(see output above)'}`);
  process.exitCode = ok ? 0 : 1;
}

/** Title signature: sorted unique tokens, so wording variance still collides.
 *  Subset containment also merges (short rephrase of a known finding). */
function signature(title) {
  return [...new Set(title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length > 2))].sort();
}
function sameFinding(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return false;
  let inter = 0; for (const t of A) if (B.has(t)) inter += 1;
  const min = Math.min(A.size, B.size);
  // A sub-2-token signature must match EXACTLY — otherwise a lazy one-word
  // waiver ('- crash | wontfix') suppresses every finding containing that
  // word, hiding a real escape from the release gate.
  if (min < 2) return inter === A.size && A.size === B.size;
  return inter / min >= 0.6;
}

// One normalization for BOTH sides of the dedupe. A finding is `title | CMD…`
// and a known-findings bullet is `- title | disposition`; the title half is
// what signature() sees, and a title that tokenizes to nothing (pure CJK,
// symbols) still dedupes on its normalized text via the __raw__ fallback —
// without it, CJK findings can never match a waiver and re-report forever.
function findingSig(rawTitle) {
  const sig = signature(rawTitle);
  return sig.length ? sig : ['__raw__', rawTitle.toLowerCase().replace(/\s+/g, ' ').trim()];
}

// A degraded model sometimes parrots the verdict FORMAT back instead of a
// verdict — `FLOCK-FINDING: <title> | CMD: <exact command it ran> | …` is the
// prompt's literal template, malformed output (INFRA-side noise), never a
// product defect (observed: a gate refused on 4 of these under a dead
// gateway pool). Tell: a <placeholder> literal as the title, or >=2 field
// values that are placeholders — a SINGLE `GOT: <empty>`-style field stays a
// real finding (fail toward keeping). Residual parrot shapes (empty <>,
// [title], ‹title›, unclosed <observed) still slip through — bounded, they
// refuse the gate (fail-closed) rather than ship a defect.
function isTemplateEcho(f) {
  if (/^<[^>]+>/.test(f.trim())) return true;
  const ph = f.match(/(?:^|\|)\s*(?:CMD|EXPECTED|GOT|SCREEN)\s*:\s*<[^>]+>(?=\s*(?:\||$))/gi);
  return (ph?.length ?? 0) >= 2;
}

// Waivers end their title at the FIRST `|`, em-dash, or spaced en-dash — the
// dominant real form is `- title — FIXED in a later release (verified …)`, and letting
// disposition prose (verified/fresh/exit/home…) into the signature suppresses
// unrelated NEW findings by containment. Cutting loses
// title tokens, which can only weaken a waiver — the safe direction.
function waiverTitle(line) {
  return line.slice(2).split(/—|\s–\s|\|/)[0];
}

function triage() {
  if (!existsSync(RUNS)) { console.log('no runs yet'); return; }
  const known = existsSync(KNOWN) ? readFileSync(KNOWN, 'utf8') : '';
  const knownSigs = known.split('\n')
    .filter((l) => l.startsWith('- ') && !l.startsWith('- [')) // markdown checkboxes are open items, not waivers
    .map((l) => findingSig(waiverTitle(l)));
  const groups = [];
  const summary = {};
  let unbacked = 0;
  let echoes = 0;
  for (const line of readFileSync(RUNS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    summary[j.class] = (summary[j.class] ?? 0) + 1;
    if (j.class !== 'FINDING') continue;
    echoes += (typeof j.templateEchoes === 'number' ? j.templateEchoes : 0);
    const unbackedList = (Array.isArray(j.unbackedFindings) ? j.unbackedFindings : [])
      .filter((f) => typeof f === 'string' && !isTemplateEcho(f));
    unbacked += unbackedList.length;
    for (const f of Array.isArray(j.findings) ? j.findings : []) {
      if (typeof f !== 'string' || isTemplateEcho(f)) continue;
      const rawTitle = f.split('|')[0];
      const sig = findingSig(rawTitle);
      let g = groups.find((x) => sameFinding(x.sig, sig));
      if (!g) { g = { sig, title: rawTitle.trim(), count: 0, waived: 0, examples: [] }; groups.push(g); }
      g.count += 1;
      // Per-member waiver check: a group is `known` only when EVERY merged
      // member matches a waiver — transitive merging at 0.6 must not let an
      // unwaived finding hide inside a waived group.
      const waived = knownSigs.some((k) => sameFinding(k, sig));
      if (waived) g.waived += 1;
      if (unbackedList.includes(f)) g.unbacked = true; // per-finding, not per-round
      g.models ??= new Set(); g.models.add(j.model);
      const ex = { f, scenario: j.scenario, seed: j.seed, runSeed: j.runSeed, tarball: j.tarball, model: j.model, waived };
      if (g.examples.length < 2) g.examples.push(ex);
      else if (!waived && g.examples.every((e) => e.waived)) g.examples[1] = ex; // surface the unwaived member that made this group NEW
    }
  }
  for (const g of groups) {
    const isKnown = g.waived === g.count;
    console.log(`${isKnown ? 'known' : 'NEW  '} [x${g.count}${g.models.size > 1 ? ` ·${g.models.size}models` : ''}]${g.unbacked ? ' ⚠unbacked' : ''} ${g.title}`);
    const shown = isKnown ? g.examples : [...g.examples].sort((a, b) => a.waived - b.waived);
    for (const e of shown) console.log(`      ${e.f}\n      repro: --seed ${e.seed} scenario=${e.scenario} tarball=${e.tarball}`);
  }
  console.log(`\ntotals: ${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(' ')}${unbacked ? ` | WARNING: ${unbacked} finding(s) cite no ran-CMD/SCREEN evidence — treat with doubt` : ''}${echoes ? ` | templateEchoes=${echoes}` : ''}`);
}

if (mode === 'triage') triage(); else if (mode === 'probe') await probeIsolation(); else await run().catch((e) => { console.error(e); process.exit(1); });
