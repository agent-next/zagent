#!/usr/bin/env node
// zagent — TUI entry. Finds a ZCode runtime on THIS machine (never vendors one),
// bootstraps ~/.zcode/cli/config.json if absent, and hands off to the interactive TUI or
// headless -p.
//
// The interactive path supplies OUR OWN TUI (packages/tui) through a Node ESM resolve
// hook. The official kernel imports '@zcode/tui' and z.ai ships no implementation, so a
// desktop-only install used to die with "Cannot find package '@zcode/tui'" and interactive
// use required the third-party zcode-app-cli. Set ZAGENT_TUI=runtime to hand off to
// whatever TUI the runtime itself vendors, or =auto to prefer the runtime's when present.
import { spawn, spawnSync } from 'node:child_process';
const NODE = process.execPath; // eslint-disable-line
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { findRuntime, kernelEnv } from '../driver/runtime.mjs';
import { runtimeCapabilities, capabilityLine } from '../driver/runtime-info.mjs';
import { buildLaunchArgs, tuiPreference, tuiNodeSupported, TUI_NODE_FLOOR, nodeSqliteSupported, NODE_SQLITE_FLOOR } from '../driver/tui-launch.mjs';
import { provisionStandaloneAccounts } from '../driver/account-provider.mjs';
import { explainProviderError, formatProviderError } from '../driver/provider-errors.mjs';
import { nodeLine, doctorCredential, extensionCounts, hooksLine, diskLine, logDirLine } from '../driver/doctor.mjs';
import { checkLatest, compareVersions, installedVersion, passiveCheckAllowed } from '../driver/update-check.mjs';

// G1 (ux-inventory §1/§9): every top CLI keeps a new user inside the product with
// 2-3 sign-in paths; zagent printed one line and exited 1. The card is also what
// a headless `-p` run prints, so both surfaces name the same three paths.
const SIGNIN_CARD = [
  'zagent: no GLM Coding Plan credential — choose a sign-in path:',
  '  1. zagent login                 sign in with the browser (OAuth)',
  '  2. export ZAI_API_KEY=<key>     Coding Plan API key (saved to ~/.zcode/cli/config.json, mode 0600)',
  '  3. quit',
];
const printSignInCard = () => { for (const l of SIGNIN_CARD) console.error(l); };

// `zagent login` (kernel OAuth) writes ~/.zcode/v2/credentials.json; the
// desktop/kernel provisions the plan key itself into v2/provider_config.json.
// An OAuth'd user is a credential — reusing the kernel's own provisioned key
// keeps the cli config consistent with what the runtime already trusts.
function oauthSignedIn(home = os.homedir()) {
  try {
    const s = JSON.parse(readFileSync(`${home}/.zcode/v2/credentials.json`, 'utf8'));
    return typeof s['oauth:zai:access_token'] === 'string' && s['oauth:zai:access_token'] !== '';
  } catch { return false; }
}
function provisionedPlanKey(home = os.homedir()) {
  try {
    const pc = JSON.parse(readFileSync(`${home}/.zcode/v2/provider_config.json`, 'utf8'));
    const k = pc?.config?.providerConfigRules?.providerRules
      ?.find(r => r?.providerId === 'zai')?.config?.access?.apiKey;
    return typeof k === 'string' && k !== '' ? k : null;
  } catch { return null; }
}

// The card as an actual choice, on a real terminal only: 1 runs the kernel's
// OAuth flow (`zagent login`), 2 takes a pasted key, anything else leaves.
// The card and prompts write to stderr, so the gate is stdin+stderr — piping
// stdout (`zagent | tee log`) must not dead-end into the non-interactive card.
async function chooseSignIn() {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
  printSignInCard();
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // rl.question resolves undefined when the interface closes early — stdin
    // EOF (ctrl+D), a hung-up pty — and a bare .trim() turned that into an
    // uncaught TypeError stack on the user's screen.
    const pick = ((await rl.question('sign in [1/2/3]: ')) ?? '').trim();
    if (pick === '2') {
      const k = ((await rl.question('paste ZAI_API_KEY: ')) ?? '').trim();
      return k ? { key: k } : null;
    }
    if (pick === '1') {
      const bin = fileURLToPath(new URL('../../bin/zagent', import.meta.url));
      const r = spawnSync(NODE, [bin, 'login'], { stdio: 'inherit' });
      if ((r.status ?? 1) === 0 && oauthSignedIn()) return { oauth: true };
      return null;
    }
    return null;
  } finally { rl.close(); }
}

function ensureConfig(forcedKey) { // same shape kingsword09's launcher creates; ours adds nothing secret
  const dir = `${os.homedir()}/.zcode/cli`;
  const file = `${dir}/config.json`;
  if (existsSync(file)) { // migrate legacy provider key the TUI does not recognize
    try {
      const cur = JSON.parse(readFileSync(file, 'utf8'));
      if (cur.provider?.['builtin:zai-coding-plan'] && !cur.provider?.zai) {
        const legacy = cur.provider['builtin:zai-coding-plan'];
        cur.provider.zai = { kind: 'anthropic', name: 'Z.AI Coding Plan',
          options: { apiKeyRequired: true, apiKey: legacy.options?.apiKey, baseURL: legacy.options?.baseURL },
          models: { 'glm-5.3': { name: 'GLM-5.3' },
            'glm-5.3-flash': { name: 'GLM-5.3-Flash', limit: { context: 1000000, output: 128000 },
              modalities: { input: ['text','image','video'], output: ['text'] } } } };
        cur.model = { main: 'zai/glm-5.3', lite: 'zai/glm-5.3-flash' };
        delete cur.provider['builtin:zai-coding-plan'];
        writeFileSync(file, JSON.stringify(cur, null, 2));
        chmodSync(file, 0o600); // writeFileSync mode is ignored on existing files
      }
      // An OAuth-only config written before the plan key was provisioned holds
      // apiKey:'' — backfill it once the kernel's provider_config has the key,
      // or /quota's config reader rejects the provider forever.
      const zai = cur.provider?.zai?.options;
      if (zai && !zai.apiKey) {
        const k = provisionedPlanKey();
        if (k) {
          zai.apiKey = k;
          writeFileSync(file, JSON.stringify(cur, null, 2));
          chmodSync(file, 0o600);
        }
      }
    } catch {}
    return file;
  }
  mkdirSync(dir, { recursive: true });
  let key = forcedKey ?? process.env.ZAI_API_KEY;
  if (!key) { try { key = readFileSync(`${os.homedir()}/.config/ccz/.api_key`, 'utf8').trim(); } catch {} }
  // OAuth-signed-in (zagent login / the desktop) counts: the kernel
  // authenticates from its own v2 store; the plan key it provisioned is reused
  // here when present so /quota's config reader keeps working too.
  if (!key && oauthSignedIn()) key = provisionedPlanKey() ?? '';
  if (!key && !oauthSignedIn()) { printSignInCard(); process.exit(2); } // exit 2 = "fixable usage error", like clap
  key = key ?? '';
  // Launcher-native shape (provider key "zai" — what the TUI's /login and model picker
  // expect). The builtin:zai-coding-plan key is NOT recognized by the TUI (owner-verified
  // failure 2026-09-04: "Model access is not configured" banner + /login overwrite).
  writeFileSync(file, JSON.stringify({
    provider: { zai: { kind: 'anthropic', name: 'Z.AI Coding Plan',
      options: { apiKeyRequired: true, apiKey: key, baseURL: 'https://api.z.ai/api/anthropic' },
      models: {
        'glm-5.3': { name: 'GLM-5.3' },
        'glm-5.3-flash': { name: 'GLM-5.3-Flash', limit: { context: 1000000, output: 128000 },
          modalities: { input: ['text', 'image', 'video'], output: ['text'] } },
      } } },
    model: { main: 'zai/glm-5.3', lite: 'zai/glm-5.3-flash' },
  }, null, 2), { mode: 0o600 });
  return file;
}

/** Best-effort kernel version (`node <entry> --version`); '' when unknown. */
const kernelVersion = (entry) => {
  try {
    const r = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8', timeout: 5000 });
    const m = String(r.stdout ?? '').match(/(\d+\.\d+[\w.-]*)/);
    return r.status === 0 && m ? m[1] : '';
  } catch { return ''; }
};

const args = process.argv.slice(2);
const rt = findRuntime();
// --model/--effort only make sense on a headless -p run; answer the usage
// error before any credential/runtime gates so `zagent --model x` never shows
// the sign-in card for what is really a flag mistake.
const { hasSelection, isPrintInvocation, splitSelection, runPrintOnce, printEnvelope } =
  await import(new URL('./zagent-print.mjs', import.meta.url).href);
if (hasSelection(args) && !isPrintInvocation(args)) {
  console.error('zagent: --model/--effort apply to headless -p runs; inside the TUI use /model and /effort');
  process.exit(2);
}
// 'doctor bogus' used to run the full diagnosis and exit 0 — a mistyped arg
// must not be swallowed. (The !rt fallback below stays permissive: bin/zagent
// already validated the command name upstream.)
if (args[0] === 'doctor' && args.slice(1).some(a => a !== 'fix' && a !== '--fix' && a !== '--capabilities')) {
  console.error('usage: zagent doctor [fix|--fix|--capabilities]');
  process.exit(2);
}
if (args[0] === 'doctor' || !rt) {
  const cfg = `${os.homedir()}/.zcode/cli/config.json`;
  const haveKey = !!(process.env.ZAI_API_KEY || existsSync(`${os.homedir()}/.config/ccz/.api_key`))
    || oauthSignedIn(); // the kernel OAuth store is a credential too (G1)
  const fixes = [];
  const warnings = [];
  let invalidConfig = false; // the config FILE is broken — drives the config: line
  let unhealthy = false;     // setup is broken some other way — drives only the exit code
  let cfgJson = null;
  if (rt && (args[1] === 'fix' || args.includes('--fix')) && !existsSync(cfg) && haveKey) {
    ensureConfig(); fixes.push('config created');
  }
  if (existsSync(cfg)) { // Validate local structure and warn when main has collapsed onto lite.
    try {
      const c = JSON.parse(readFileSync(cfg, 'utf8'));
      if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('config must be an object');
      const providerId = typeof c.model?.main === 'string' && /^[^/]+\/.+$/.test(c.model.main) ? c.model.main.split('/')[0] : null;
      const selected = c.provider?.[providerId];
      if (!providerId || !Object.hasOwn(c.provider ?? {}, providerId) || !selected || typeof selected !== 'object' || Array.isArray(selected))
        throw new Error('config must select a configured provider/model');
      if (c.model?.main && c.model?.main === c.model?.lite) warnings.push(`model.main == model.lite (${c.model.main}) — main should be the full model, lite the fast one`);
      cfgJson = c;
    } catch { invalidConfig = true; }
  }
  // rt.version is the installed product version; the kernel's own --version is
  // its internal string, so it is only a fallback and stays labeled.
  let rtVersion = rt?.version;
  if (rt && !rtVersion) { const k = kernelVersion(rt.entry); rtVersion = k ? `(kernel ${k})` : null; }
  console.log(rt ? `runtime: ${rt.kind}${rtVersion ? ` ${rtVersion}` : ''} (${rt.root})` : 'runtime: NOT FOUND — install zcode-app-cli or the ZCode desktop app');
  console.log(nodeLine());
  // The desktop's own updater stages the next build under its cache dir; a
  // pending update-info.json means the GUI swaps versions on next launch —
  // surface it read-only so doctor explains a sudden runtime change.
  try {
    const pending = JSON.parse(readFileSync(`${os.homedir()}/.cache/@zcodedesktop-updater/pending/update-info.json`, 'utf8'));
    if (typeof pending?.fileName === 'string' && pending.fileName)
      warnings.push(`desktop update pending: ${pending.fileName} (applies on next desktop launch)`);
  } catch { /* no staged update */ }
  // Self-update hint: the same registry answer `zagent update` uses, TTL-cached
  // so a doctor run pays at most one npm round-trip per window. Skipped in the
  // test sandbox/CI (a spawned npm would escape the offline gate) and silent on
  // offline machines — an unreachable registry is not a defect.
  if (args[0] === 'doctor' && passiveCheckAllowed()) {
    try {
      const self = checkLatest({ timeoutMs: 3000 });
      if (self.latest && compareVersions(self.latest, installedVersion()) === 1)
        warnings.push(`zagent ${installedVersion()} is outdated — npm has ${self.latest}; run 'zagent update'`);
    } catch { /* best-effort hint */ }
  }
  // Before zagent shipped its own TUI, doctor exited 0 on a desktop-only install while
  // the headline command (`zagent`) died with "Cannot find package '@zcode/tui'". A gate
  // that reports healthy for a configuration whose primary path crashes is a defect.
  if (rt) {
    // Ask the launcher rather than re-deriving its rule: a hand-copied verdict
    // would keep reporting healthy after the launcher's rule changed.
    const launch = buildLaunchArgs({ entry: rt.entry, args: [], preference: tuiPreference() });
    // An old Node (below the engines floor, e.g. a stale /usr/local/bin/node on
    // macOS) cannot load the built-in TUI — the child dies on registerHooks.
    const unsupported = launch.tui === 'zagent' && !tuiNodeSupported();
    const source = launch.tui === 'zagent' ? 'built in'
      : launch.ships ? 'runtime-provided' : 'NONE';
    console.log(`TUI: ${source}${source === 'NONE'
      ? ' — ZAGENT_TUI=runtime is set but this runtime ships no @zcode/tui; unset it'
      : unsupported ? ` — needs Node ${TUI_NODE_FLOOR} (have ${process.version}); headless -p still works${
          launch.ships ? '; or ZAGENT_TUI=runtime' : ''}` : ''}`);
    if (source === 'NONE' || unsupported) unhealthy = true; // interactive use is broken; do not exit 0
  }
  if (rt && args.includes('--capabilities')) {
    const { ZCodeProtocolClient } = await import(new URL('../driver/zcode-protocol.mjs', import.meta.url).href);
    let c;
    try {
      c = new ZCodeProtocolClient({ cwd: process.cwd() });
      await c.ready;
      const caps = await runtimeCapabilities(c);
      console.log(`capabilities: ${capabilityLine(caps)}`);
      for (const m of caps.present) console.log(`  + ${m}`);
      for (const m of caps.absent) console.log(`  - ${m}`);
    } catch (e) { console.error(`capabilities: probe failed (${String(e?.message ?? e).slice(0, 80)})`); }
    finally { try { c?.close(); } catch {} } // r1: spawned runtime always terminated
  }
  console.log(`config: ${invalidConfig ? 'INVALID CONFIG — repair the JSON object manually; existing file preserved' : existsSync(cfg) ? 'present' : !rt ? 'blocked: no runtime found (fix runtime first)' : haveKey ? 'will be created on first run (doctor --fix to do it now)' : 'NO CODING-PLAN CREDENTIAL — export ZAI_API_KEY'} (${cfg})`);
  // G8 depth lines: which credential will actually be used, what extensions are
  // configured, and whether the machine itself is healthy — all read-only.
  const cred = doctorCredential({ config: cfgJson, hasConfig: existsSync(cfg) });
  console.log(`credential: ${cred ?? 'NONE'}`);
  if (!cred && existsSync(cfg)) warnings.push('no Coding Plan credential in any source — turns will stop at the sign-in card');
  const ext = extensionCounts({ config: cfgJson });
  console.log(`plugins: ${ext.plugins} installed`);
  console.log(hooksLine(ext));
  console.log(`mcp: ${ext.mcp} configured`);
  const disk = diskLine();
  if (disk) console.log(disk);
  console.log(logDirLine());
  for (const w of warnings) console.log(`warn: ${w}`);
  if (fixes.length) console.log(`fixed: ${fixes.join(', ')}`);
  process.exit(rt && !invalidConfig && !unhealthy && (existsSync(cfg) || haveKey) ? 0 : 1); // doctor must fail when the diagnosis is unhealthy
}
// login/logout are kernel passthroughs (see bin/zagent): they manage the OAuth
// credential a user picks INSTEAD of the API key, so they must not die on the
// "no GLM Coding Plan credential" check ensureConfig performs first.
if (args[0] !== 'login' && args[0] !== 'logout') {
  const cfgFile = `${os.homedir()}/.zcode/cli/config.json`;
  const haveCredential = !!process.env.ZAI_API_KEY
    || existsSync(`${os.homedir()}/.config/ccz/.api_key`) || oauthSignedIn();
  // On a real terminal the card is a choice, not a dead end — `zagent login`
  // (option 1) and a pasted key (option 2) both land here with the credential
  // already in place, so ensureConfig just writes the provider entry.
  const needChoice = !existsSync(cfgFile) && !haveCredential;
  const picked = needChoice ? await chooseSignIn() : null;
  // The chooser already printed the card; a declined choice exits quietly.
  if (needChoice && picked == null && process.stdin.isTTY && process.stderr.isTTY) process.exit(2);
  ensureConfig(picked?.key); // oauth runs proceed with the kernel's own store
}
// --model/--effort have no kernel -p flag (its parseArgs table rejects both);
// selection is protocol-side (session/create takes model+thoughtLevel). Those
// invocations divert to the app-server runner in zagent-print.mjs; every other
// -p keeps the kernel path below (including its empty-envelope retry wrapper —
// this path reports real errors instead, so it needs none).
if (hasSelection(args)) { // !isPrintInvocation already exited above
  let sel;
  try { sel = splitSelection(args); }
  catch (e) { console.error(`zagent: ${e.message}`); process.exit(2); }
  const asJson = args.includes('--json') || sel.format === 'json';
  const write = (s, code) => process.stdout.write(s, () => process.exit(code)); // write-true ≠ flushed — callback form only (r6 #1)
  try {
    const r = await runPrintOnce(sel);
    if (asJson) write(JSON.stringify(printEnvelope(r)) + '\n', r.ok ? 0 : 1);
    else write((r.answer || `(turn ${r.ended})`) + '\n', r.ok ? 0 : 1);
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 300);
    if (asJson) write(JSON.stringify(printEnvelope({ ok: false, error: msg, sessionId: null, durationMs: 0 })) + '\n', 1);
    else {
      console.error(`zagent: ${msg}`);
      const explained = explainProviderError(msg);
      if (explained) console.error(formatProviderError(explained));
      process.exit(1);
    }
  }
}
// Headless JSON runs retry on empty/error-envelope output (product-level parity with
// harnesses that retry internally; 2 of 3 gate-verdict failures were 429 envelopes).
const headlessJson = args.includes('-p') && args.includes('--json');
if (headlessJson) {
  const { runHeadlessWithRetry } = await import(new URL('../driver/headless-retry.mjs', import.meta.url).href);
  const entry = rt.entry;
  const r = runHeadlessWithRetry(process.execPath, [entry, ...args], { cwd: process.cwd(), env: kernelEnv(entry),
    onAttempt: (a, v) => { if (v.retry) console.error(`zagent: attempt ${a} ${v.reason} — ${a < 2 ? 'retrying once' : 'giving up (exit 1)'}`); } });
  if (r.stderr) process.stderr.write(String(r.stderr).slice(-2000)); // r5 #6: runtime diagnostics surfaced
  if ((r.exitCode ?? 1) !== 0) {
    const explained = explainProviderError(String(r.stderr ?? ''));
    if (explained) process.stderr.write(`\n${formatProviderError(explained)}\n`);
  }
  const done = () => process.exit(r.exitCode ?? 1);
  // r5-followup: the write callback is ASYNC — without the return below, control fell
  // through to the interactive spawn and the runtime ran TWICE (two concatenated JSON
  // envelopes — the m5 4/4 regression root cause).
  process.stdout.write(r.stdout, done); // r6 #1: write-true ≠ flushed; callback form is the only safe exit
} else { // interactive/other paths — the headless branch schedules its own exit above
  const launch = buildLaunchArgs({ entry: rt.entry, args, preference: tuiPreference() });
  if (launch.tui === 'runtime' && !launch.ships) {
    console.error("zagent: ZAGENT_TUI=runtime, but this runtime ships no '@zcode/tui'. Unset it to use zagent's own TUI.");
    process.exit(1);
  }
  if (!nodeSqliteSupported()) {
    console.error(`zagent: the kernel needs node:sqlite (Node ${NODE_SQLITE_FLOOR}); this is ${process.version} — nothing works, headless included.`);
    console.error('  Upgrade Node (macOS: brew install node, or nvm install --lts).');
    process.exit(1);
  }
  if (launch.tui === 'zagent' && !tuiNodeSupported()) {
    console.error(`zagent: the built-in TUI needs Node ${TUI_NODE_FLOOR}; this is ${process.version}.`);
    console.error(`  Upgrade Node (macOS: brew install node, or nvm install --lts). Headless still works: zagent -p "…"${
      launch.ships ? " Or use the runtime's own TUI: ZAGENT_TUI=runtime zagent" : ''}`);
    process.exit(1);
  }
  // A headless run's stderr is teed so a provider business error can be explained
  // after it. Hitting the plan's 5-hour window printed 63 lines of stack trace with
  // the only actionable fact — when it resets — buried in the first one. The TUI
  // keeps plain inherited stdio; nothing about its rendering changes.
  const headless = args.includes('-p');
  // The kernel TUI resolves providers in standalone mode: it reads only the
  // `account-provider:*` credential records, which a pre-3.12.1 store lacks —
  // the "No model access configured" wall. Provision them from configured plan
  // keys before spawn (best-effort; never blocks the launch).
  if (!headless) { try { provisionStandaloneAccounts({ env: kernelEnv(rt.entry) }); } catch {} }
  const child = spawn(NODE, ['--experimental-sqlite', '--no-warnings', ...launch.argv], {
    cwd: process.cwd(),
    env: kernelEnv(rt.entry),
    stdio: headless ? ['inherit', 'inherit', 'pipe'] : 'inherit',
  });
  let errTail = '';
  if (headless && child.stderr) {
    child.stderr.on('data', (d) => {
      process.stderr.write(d);                       // nothing is swallowed
      errTail = (errTail + d).slice(-65536);         // bounded: this can stream
    });
  }
  child.on('error', e => { console.error('zagent:', e.message); process.exit(1); });
  child.on('exit', (c, sig) => {
    const code = c ?? (sig ? 1 : 0);
    if (headless && code !== 0) {
      const explained = explainProviderError(errTail);
      if (explained) process.stderr.write(`\n${formatProviderError(explained)}\n`);
    }
    process.exit(code); // signal death is failure, not success
  });
}
