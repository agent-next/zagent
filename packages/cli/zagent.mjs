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
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, fstatSync, statSync, accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { findRuntime, kernelEnv, kernelResolves } from '../driver/runtime.mjs';
import { runtimeCapabilities, capabilityLine } from '../driver/runtime-info.mjs';
import { buildLaunchArgs, tuiPreference, tuiNodeSupported, TUI_NODE_FLOOR, nodeSqliteSupported, NODE_SQLITE_FLOOR } from '../driver/tui-launch.mjs';
import { provisionStandaloneAccounts } from '../driver/account-provider.mjs';
import { explainProviderError, formatProviderError } from '../driver/provider-errors.mjs';
import { nodeLine, doctorCredential, extensionCounts, hooksLine, diskLine, logDirLine, displayPath, displayText } from '../driver/doctor.mjs';
import { snapshotStatus, snapshotLine } from '../driver/snapshot-guard.mjs';
import { checkLatest, compareVersions, installedVersion, passiveCheckAllowed } from '../driver/update-check.mjs';
import { KERNEL_VALUE_FLAGS, KERNEL_LIST_FLAGS, KERNEL_ENUM_FLAGS, KERNEL_BOOL_FLAGS } from './commands.mjs';
import { readDefaultMode, withPersistedMode, hasModeFlag } from '../driver/default-mode.mjs';

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
const CREDENTIAL_MSG = 'no GLM Coding Plan credential — run `zagent login` or export ZAI_API_KEY';

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
// `logout` asks the weaker question "is there anything to sign out of" — the
// kernel clears a fixed clear-set from the v2 credentials store (verified in
// zcode.cjs logoutZCodeCli): every oauth:* key, zcodejwttoken, and the
// account-provider:* identity records. Anything else in the file is not
// sign-in material. Same root rule as the kernel/inspect: ZCODE_DATA_BASE_DIR
// replaces HOME. A read failure other than ENOENT (EACCES, corrupt JSON)
// still counts — logout is also the recovery path for a wedged store and the
// kernel answers its own honest error for it.
function oauthSessionPresent(home = process.env.ZCODE_DATA_BASE_DIR?.trim() || os.homedir()) {
  try {
    const s = JSON.parse(readFileSync(`${home}/.zcode/v2/credentials.json`, 'utf8'));
    return s != null && typeof s === 'object'
      && Object.keys(s).some(k =>
        k.startsWith('oauth:') || k.startsWith('account-provider:') || k === 'zcodejwttoken');
  } catch (e) { return e?.code !== 'ENOENT'; }
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
  const rl = createInterface({ input: process.stdin, output: process.stderr, historySize: 0 });
  try {
    // Esc is the chooser's cancel affordance (FLOCK wave-4 T8): rl.close()
    // resolves the pending ask() undefined → pick '' → null → the caller's
    // quiet exit 2, identical to EOF/pick-3. Node's escape parser merges an
    // ESC+key struck inside its escape window into ONE meta+key keypress —
    // the 'escape' never fires and the key never lands in the line (triage:
    // Esc then 'world' answered 'orld'), so ANY meta-modified keypress is the
    // same cancel — including the named non-insert keys the merge produces
    // (Esc+Enter → {name:'return',meta:true}, which readline would swallow
    // with no visible effect — a dead screen, the same bug class); a 1/2/3
    // chooser keeps no meaningful alt-chords. Arrows/function keys parse as
    // NAMED keys without meta — unaffected. (v22.22.0 probe: ESC →
    // {name:'escape'}, ESC+w → {name:'w',meta:true}, ESC+Enter →
    // {name:'return',meta:true}, ↑ → {name:'up',meta:false}.)
    const onEscKey = (ch, key) => {
      if (key?.name === 'escape' || key?.meta === true) rl.close();
    };
    rl.input.on('keypress', onEscKey);
    rl.once('close', () => rl.input.off('keypress', onEscKey));
    // node:readline's callbackless rl.question() resolves undefined INSTANTLY
    // (nodejs/node#57035 — the working promise form lives only on
    // node:readline/promises). Wrap the callback form ourselves; undefined on
    // close still means stdin EOF (ctrl+D) or a hung-up pty. The key paste is
    // a secret: readline echoes every key through _writeToOutput, so writes
    // stay muted unless a non-secret question is pending (typeahead between
    // questions can never echo a credential); the prompt itself writes before
    // the flag flips. Private API — degrade to plain echo if it ever vanishes.
    const writeOut = typeof rl._writeToOutput === 'function' ? rl._writeToOutput.bind(rl) : null;
    let echoOpen = true; // closed only around/inside the masked question
    if (writeOut) rl._writeToOutput = (s) => { if (echoOpen) writeOut(s); };
    const ask = (q, secret = false) => new Promise((resolve) => {
      // A typeahead/Esc burst closes rl synchronously between the previous
      // pick resolving and this ask() — question() on a closed interface
      // throws ERR_USE_AFTER_CLOSE; resolve the same quiet-undefined instead.
      if (rl.closed) { resolve(undefined); return; }
      const done = (a) => {
        rl.off('close', onClose);
        if (secret && writeOut) writeOut('\r\n'); // Enter's echo was muted
        echoOpen = false; // stays muted until the next ask() opens it — a
        // typeahead burst in the inter-question gap must never echo a secret
        resolve(a);
      };
      const onClose = () => done(undefined);
      rl.once('close', onClose);
      echoOpen = true;                 // the question() prompt must render
      rl.question(q, done);
      echoOpen = !(secret && writeOut); // then only non-secret answers echo
    });
    const pick = ((await ask('sign in [1/2/3]: ')) ?? '').trim();
    if (pick === '2') {
      const k = ((await ask('paste ZAI_API_KEY: ', true)) ?? '').trim();
      return k ? { key: k } : null;
    }
    if (pick === '1') {
      const bin = fileURLToPath(new URL('../../bin/zagent', import.meta.url));
      // rl still holds the tty in raw mode (no ISIG/echo) until close — the
      // OAuth child would be uninterruptible and blind without this.
      rl.close();
      const r = spawnSync(NODE, [bin, 'login'], { stdio: 'inherit' });
      if ((r.status ?? 1) === 0 && oauthSignedIn()) return { oauth: true };
      return null;
    }
    return null;
  } finally { rl.close(); }
}

async function ensureConfig(forcedKey) { // same shape kingsword09's launcher creates; ours adds nothing secret
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
  if (!key && !oauthSignedIn()) {
    printSignInCard();
    // A `-p --json` caller parses stdout — it still gets a machine-readable
    // error envelope; the card stays on stderr for the human behind the pipe.
    await writeJsonCredentialError();
    process.exit(2); // exit 2 = "fixable usage error", like clap
  }
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

let args = process.argv.slice(2);
const rt = findRuntime();
// --model/--effort only make sense on a headless -p run; answer the usage
// error before any credential/runtime gates so `zagent --model x` never shows
// the sign-in card for what is really a flag mistake.
const { hasSelection, isPrintInvocation, splitSelection, runPrintOnce, printEnvelope, kernelPositional0, SELECTION_VALUE_FLAGS } =
  await import(new URL('./zagent-print.mjs', import.meta.url).href);
// The credential gate answers a JSON-asking headless run with a parseable
// envelope on stdout — "--json" or "--output-format json|stream-json" on a
// -p/--prompt invocation. Only pre-`--` tokens are flags; everything else
// keeps the human-only card.
const preSep = args.slice(0, args.indexOf('--') === -1 ? args.length : args.indexOf('--'));
const jsonPrint = isPrintInvocation(preSep) && (preSep.includes('--json')
  || preSep.some(a => /^--output-format=(?:json|stream-json)$/.test(a))
  || preSep.some((a, i) => a === '--output-format' && ['json', 'stream-json'].includes(preSep[i + 1])));
// num_turns is 0 here — the gate fires before any turn exists.
const writeJsonCredentialError = () => !jsonPrint ? Promise.resolve()
  : new Promise((res) => process.stdout.write(JSON.stringify(printEnvelope({
    ok: false, sessionId: null, durationMs: 0, numTurns: 0,
    error: CREDENTIAL_MSG, answer: CREDENTIAL_MSG })) + '\n', res));
if (hasSelection(args) && !isPrintInvocation(args)) {
  console.error('zagent: --model/--effort apply to headless -p runs; inside the TUI use /model and /effort');
  process.exit(2);
}
// A -p/--prompt with no value reaches the kernel parser, which answers our
// product's mistake with ITS usage ("Usage: zcode", "zcode 0.16.5"). A
// flag-shaped next token would be swallowed as the prompt text, so a bare or
// flag-followed -p is a usage error here (same rule splitSelection applies).
{
  // Only flag-leading invocations parse -p as the prompt flag; the words that
  // route through this file (doctor/login/logout/app-server) own their args.
  if (!args.length || args[0].startsWith('-')) {
    const missing = (v) => v === undefined || (v !== '-' && v.startsWith('-')); // trailing or flag-shaped (lone '-' is a value — kernel accepts `-p -`)
    // Echo user argv back safely: strip control bytes (hostile-arg flock
    // cards) before the file's displayText/displayPath home-hiding.
    const safe = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ');

    // --attach values collect inside the left-to-right sweep below — its
    // arity is parse-level like every kernel value flag and must lose to an
    // EARLIER bad flag (extracted 3.12.1: `-p hi --mode --attach` →
    // "Option '--mode' argument is ambiguous", not --attach's). The file
    // STAT waits below the --cwd gate — the kernel stats attachments at
    // prompt submit, after every flag gate.
    const attachFiles = [];

    // Kernel-arity sweep: every other kernel value-flag trailing or
    // flag-followed is the same masked-usage class the selection flags were —
    // the kernel's parseArgs answers 'argument missing'/'argument is
    // ambiguous' BEFORE any credential question, so the usage error must beat
    // the sign-in card here too (flock wave-3: `-p hi --mode` → the card).
    // `=` forms carry their own value and post-`--` tokens are positionals;
    // --attach keeps its dedicated arity check inside the sweep too.
    const selPath = hasSelection(preSep); // selection parser owns --mode (allows 'auto')
    const enumSeen = new Map(); // kernel parseArgs is last-wins — only the final value is checked
    for (let i = 0; i < preSep.length; i++) {
      const a = preSep[i];
      // -p/--prompt's own missing-value check lives INSIDE the sweep — the
      // kernel's parseArgs reports left-to-right, so an earlier token's parse
      // error must win (extracted 3.12.1: `--json=x -p` → "Option '--json'
      // does not take an argument", `--mode -p` → "Option '--mode' argument
      // is ambiguous", `--attach -p` → "Option '--attach' argument is
      // ambiguous" — each names the earlier flag, never -p).
      if (a === '-p' || a === '--prompt') {
        if (missing(preSep[i + 1])) {
          console.error("zagent: -p/--prompt requires a prompt text (use --prompt=... if the prompt starts with '-')");
          process.exit(2);
        }
        continue;
      }
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      const v = eq === -1 ? preSep[i + 1] : a.slice(eq + 1);
      // A glued value on a kernel BOOLEAN flag is its own parse-level
      // refusal ('Option '--json' does not take an argument' on extracted
      // 3.12.1) — the credential gate must not mask it either.
      if (eq !== -1 && KERNEL_BOOL_FLAGS.has(name)) {
        console.error(`zagent: ${name} does not take an argument`);
        process.exit(2);
      }
      // Short glued `-c=x`/`-f=x` is a different kernel error: parseArgs
      // expands single-dash clusters, so '=' itself is the bad option
      // ('Unknown option '-='' on extracted 3.12.1). -v/-h/-x glued forms
      // are already refused as unknown options by bin/zagent.
      if (eq === 2 && (name === '-c' || name === '-f')) {
        console.error("zagent: unknown option '-='");
        process.exit(2);
      }
      // --attach arity in argv order: the = form unambiguously supplies the
      // value; only the space form can swallow a following flag as its
      // "path". Lone '-' is a value here like everywhere else; `--attach=`
      // and a space-form '' carry no file.
      if (name === '--attach') {
        if (v === undefined || v === '' || (eq === -1 && v !== '-' && v.startsWith('-'))) {
          console.error('zagent: --attach requires a file path');
          process.exit(2);
        }
        attachFiles.push(v);
        continue;
      }
      // Kernel-enum sweep: the same parseArgs also refuses an out-of-domain
      // VALUE before any credential question (`--mode=bogus` → 'Unsupported
      // --mode value' on extracted 3.12.1), so a bogus value must beat the
      // sign-in card just like a missing one (flock wave-3 residual). The
      // check covers the selection path too — a bogus --locale/--surface/
      // --browser-use is wrong there anyway and splitSelection never validates
      // the value it merely parses.
      // A space form's flag-shaped next token is the arity error handled
      // below — never enum-checked. A GLUED `--mode=-x` is an unambiguous
      // value and IS enum-checked (kernel: 'Unsupported --mode value: -x').
      const domain = KERNEL_ENUM_FLAGS.get(name);
      const flagShapedValue = typeof v === 'string' && v !== '-' && v.startsWith('-');
      if (domain && !(name === '--mode' && selPath)
          && typeof v === 'string' && (eq !== -1 || !flagShapedValue))
        enumSeen.set(name, v);
      if (eq !== -1) continue;
      // A lone '-' is a legitimate value (kernel accepts `--cwd -`); the list
      // flags' own pre-parse still stops at ANY '-' token, so '-' is no tool.
      if (KERNEL_LIST_FLAGS.has(a) && (v === undefined || v.startsWith('-'))) {
        console.error(`zagent: ${a} requires at least one tool`);
        process.exit(2);
      }
      if (KERNEL_VALUE_FLAGS.has(a) && (v === undefined || (v !== '-' && v.startsWith('-')))) {
        console.error(`zagent: ${a} requires a value`);
        process.exit(2);
      }
    }
    for (const [name, v] of enumSeen) {
      const domain = KERNEL_ENUM_FLAGS.get(name);
      if (!domain.values.includes(domain.fold ? v.toLowerCase() : v)) {
        console.error(`zagent: ${name} must be one of ${domain.values.join('|')} (got '${displayText(safe(v))}')`);
        process.exit(2);
      }
    }

    // Kernel semantic gates — the same masked-usage family, one layer deeper.
    // Extracted 3.12.1 evaluates these AFTER the parse-level refusals above
    // (`--mode bogus` beats `--target`+`-p`), in exactly this order:
    // --browser-executable's --browser-use=headless requirement → --resume vs
    // --continue → --target non-empty → --target-replace requires --target →
    // --target vs --prompt → --surface invocation shape → the --cwd stat →
    // the --browser-executable stat — each still BEFORE any credential
    // question (flock wave-3 residuals: `-p hi --target x`,
    // `--browser-executable /x` without --browser-use, `-p hi --cwd
    // /nonexistent` all showed the sign-in card). Value flags here are
    // KERNEL_VALUE_FLAGS members whose arity was already checked, so a space
    // form's next token is a real value; kernel parseArgs is last-wins, so
    // only the final occurrence counts.
    const lastVal = (flag) => {
      let v;
      for (let i = 0; i < preSep.length; i++) {
        const a = preSep[i];
        if (a === flag && i + 1 < preSep.length) v = preSep[i + 1];
        else if (a.startsWith(flag + '=')) v = a.slice(flag.length + 1);
      }
      return v;
    };
    const hasFlag = (flag) => preSep.some(a => a === flag || a.startsWith(flag + '='));
    const browserUse = lastVal('--browser-use'); // enum-checked already: present ⇒ 'headless'
    const browserExec = lastVal('--browser-executable');
    if (browserExec !== undefined && browserUse !== 'headless') {
      console.error('zagent: --browser-executable requires --browser-use=headless');
      process.exit(2);
    }
    // --resume=<empty> is treated as unset kernel-side (`--resume=` reaches
    // the TUI launch); only a real resume value conflicts with -c/--continue.
    if (lastVal('--resume') && preSep.some(a => a === '-c' || a === '--continue')) {
      console.error('zagent: --resume and --continue cannot be used together');
      process.exit(2);
    }
    if (hasFlag('--target') && !String(lastVal('--target') ?? '').trim()) {
      console.error('zagent: --target requires non-empty text');
      process.exit(2);
    }
    if (hasFlag('--target-replace') && !hasFlag('--target')) {
      console.error('zagent: --target-replace requires --target');
      process.exit(2);
    }
    if (isPrintInvocation(preSep) && hasFlag('--target')) {
      console.error('zagent: --target cannot be used with --prompt — use either --target <objective> or --prompt "/goal <objective>"');
      process.exit(2);
    }
    // --surface is refused on a bare TUI launch too (kernel: '--surface can
    // only be used with --prompt, --target, app-server, or agent-server').
    if (hasFlag('--surface') && !isPrintInvocation(preSep) && !hasFlag('--target')) {
      const positional0 = kernelPositional0(args);
      if (positional0 !== 'app-server' && positional0 !== 'agent-server') {
        console.error('zagent: --surface can only be used with --prompt, --target, app-server, or agent-server');
        process.exit(2);
      }
    }
    const cwdArg = lastVal('--cwd');
    if (cwdArg !== undefined) {
      // An exact-empty value is its own kernel refusal BEFORE the stat
      // ('--cwd requires a non-empty path.' — extracted 3.12.1; `--cwd ""`,
      // `--cwd=`, last-wins empty all answer it). No trim: ' ' resolves to a
      // nonexistent path and stays 'not accessible' kernel-side.
      if (cwdArg === '') {
        console.error('zagent: --cwd requires a non-empty path');
        process.exit(2);
      }
      const abs = path.resolve(cwdArg); // the kernel names the resolved path
      const shown = displayPath(safe(abs)); // home-path privacy (F7/F12) + control-byte strip
      let st = null;
      try { st = statSync(abs); } catch {}
      if (!st) {
        console.error(`zagent: --cwd path is not accessible: ${shown}`);
        process.exit(2);
      }
      if (!st.isDirectory()) {
        console.error(`zagent: --cwd must point to a directory: ${shown}`);
        process.exit(2);
      }
    }
    if (browserExec !== undefined) { // --browser-use=headless by the first gate
      if (!path.isAbsolute(browserExec)) {
        console.error(`zagent: --browser-executable path must be absolute: ${displayText(safe(browserExec))}`);
        process.exit(2);
      }
      // A directory carries the search bit but the kernel refuses it too —
      // only a regular file with an exec bit counts.
      let execOk = false;
      try { execOk = statSync(browserExec).isFile() && (accessSync(browserExec, fsConstants.X_OK), true); }
      catch {}
      if (!execOk) {
        console.error(`zagent: --browser-executable is missing or not executable: ${displayPath(safe(browserExec))}`);
        process.exit(2);
      }
    }

    // Empty/whitespace prompt is its own kernel refusal ('--prompt requires
    // non-empty text.' on extracted 3.12.1 — `--prompt=`, `-p ''`, `-p ' '`),
    // but it is checked at prompt submit — EVERY flag gate above beats it
    // (verified on extracted 3.12.1: `-p ' ' --resume x -c` → '--resume and
    // --continue cannot be used together', `-p ' ' --browser-executable /x` →
    // 'requires --browser-use=headless', `-p ' ' --target x` → 'cannot be
    // used with --prompt', `-p ' ' --cwd /nope` → 'not accessible', `-p ' '
    // --target-replace` → 'requires --target') while it still beats the
    // --attach stat (`-p ' ' --attach /missing` → 'requires non-empty text').
    // `-p=` is NOT refused: parseArgs gives the short form '=' as its value.
    const blank = (v) => typeof v === 'string' && !v.trim();
    if (preSep.some((a, i) => (a === '-p' || a === '--prompt') && blank(preSep[i + 1]))
        || preSep.some(a => a.startsWith('--prompt=') && blank(a.slice('--prompt='.length)))) {
      console.error('zagent: -p/--prompt requires non-empty text');
      process.exit(2);
    }

    // --attach is forwarded verbatim; a missing file is only discovered inside
    // the runtime — after a provider call is already spent. Stat it here so a
    // typo fails as OUR usage error, not as inference that bills first. Runs
    // after the --cwd gate so `base` is a directory that exists, and only for
    // print invocations — the kernel stats attachments at prompt submit and
    // ignores the flag on a TUI launch entirely. The selection path skips
    // the stat: --attach is REFUSED with --model/--effort there, and that
    // actionable refusal must beat a file-not-found on a missing path.
    const base = cwdArg !== undefined ? cwdArg : process.cwd();
    if (isPrintInvocation(preSep) && !hasSelection(preSep)) for (const file of attachFiles) {
      let st = null;
      try { st = statSync(path.resolve(base, file)); } catch {}
      if (!st) {
        console.error(`zagent: --attach file not found: ${displayText(safe(file))}`);
        process.exit(2);
      }
      // A directory exists but is no attachment — same pre-spend refusal.
      if (!st.isFile()) {
        console.error(`zagent: --attach is not a file: ${displayText(safe(file))}`);
        process.exit(2);
      }
    }
  }
}
// 'doctor bogus' used to run the full diagnosis and exit 0 — a mistyped arg
// must not be swallowed. (The !rt fallback below stays permissive: bin/zagent
// already validated the command name upstream.)
if (args[0] === 'doctor' && args.slice(1).some(a => a !== 'fix' && a !== '--fix' && a !== '--capabilities')) {
  console.error('usage: zagent doctor [fix|--fix|--capabilities]');
  process.exit(2);
}
// F14c follow-up: `zagent mode` persists a default -p permission mode
// (permissions.defaultMode in ~/.zcode/cli/config.json). The kernel -p default
// is yolo — every tool executes unconfirmed — so a user who wants plan every
// time had to re-pass --mode on every run; injecting the stored default here
// makes that opt-out persistent. An explicit --mode always wins (hasModeFlag),
// and interactive/TUI launches are deliberately untouched — the kernel already
// persists a per-project mode for them (session/setMode ↔ session/create).
// Runs after the flag-validation sweep (the injected value is already in the
// --mode domain) and before splitSelection, so the selection path picks it up
// as sel.mode for free; the kernel paths forward it verbatim. A leading kernel
// positional means a passthrough verb owns its argv (`login -p hi` forwards a
// -p that is NOT the prompt flag) — no injection there.
if (isPrintInvocation(preSep) && !hasModeFlag(preSep) && kernelPositional0(preSep, SELECTION_VALUE_FLAGS) === undefined) {
  const persisted = readDefaultMode();
  if (persisted) args = withPersistedMode(args, persisted);
}
// --model/--effort parse HERE, ahead of the runtime report and the credential
// gate: the kernel's parseArgs answers a malformed argv first ('Unknown
// option'/'argument missing'), so a value-less or mismatched selection flag
// must surface its usage error instead of being masked by a sign-in card
// (flock: `-p hi --model` showed the credential card, not the flag error).
const selection = hasSelection(args); // the runner/kernel paths below gate on it
let sel = null;
if (selection) { // !isPrintInvocation already exited above
  try { sel = splitSelection(args); }
  catch (e) { console.error(`zagent: ${e.message}`); process.exit(2); }
}
if (args[0] === 'doctor' || !rt) {
  // A `-p --json` run on a runtime-less machine keeps stdout machine-readable
  // too: the diagnosis moves to stderr and the error envelope answers.
  if (!rt && args[0] !== 'doctor' && jsonPrint) {
    const msg = 'no ZCode runtime found — install zcode-app-cli or the ZCode desktop app';
    console.error(`zagent: ${msg}`);
    await new Promise((res) => process.stdout.write(JSON.stringify(printEnvelope({
      ok: false, sessionId: null, durationMs: 0, numTurns: 0,
      error: msg, answer: msg })) + '\n', res));
    process.exit(1);
  }
  const cfg = `${os.homedir()}/.zcode/cli/config.json`;
  const haveKey = !!(process.env.ZAI_API_KEY || existsSync(`${os.homedir()}/.config/ccz/.api_key`))
    || oauthSignedIn(); // the kernel OAuth store is a credential too (G1)
  const fixes = [];
  const warnings = [];
  let invalidConfig = false; // the config FILE is broken — drives the config: line
  let unhealthy = false;     // setup is broken some other way — drives only the exit code
  let cfgJson = null;
  if (rt && (args[1] === 'fix' || args.includes('--fix')) && !existsSync(cfg) && haveKey) {
    await ensureConfig(); fixes.push('config created');
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
  console.log(rt ? `runtime: ${rt.kind}${rtVersion ? ` ${rtVersion}` : ''} (${displayPath(rt.root)})` : 'runtime: NOT FOUND — install zcode-app-cli or the ZCode desktop app');
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
    } catch (e) { console.error(`capabilities: probe failed (${displayText(String(e?.message ?? e).slice(0, 80))})`); }
    finally { try { c?.close(); } catch {} } // r1: spawned runtime always terminated
  }
  console.log(`config: ${invalidConfig ? 'INVALID CONFIG — repair the JSON object manually; existing file preserved' : existsSync(cfg) ? 'present' : !rt ? 'blocked: no runtime found (fix runtime first)' : haveKey ? 'will be created on first run (doctor --fix to do it now)' : 'NO CODING-PLAN CREDENTIAL — export ZAI_API_KEY'} (${displayPath(cfg)})`);
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
  // The desktop host stages encrypted whole-workspace uploads under
  // v2/checkpoints when it is logged in — surface staged payloads, never
  // throws. ('pending' is reachable only when the user opted out of the
  // auto-guard — the dispatcher already wiped+locked before doctor ran.)
  try {
    const snap = snapshotStatus();
    console.log(snapshotLine(snap));
    if (snap.state === 'pending') warnings.push('workspace snapshot(s) staged for upload — run \'zagent snapshot lock\'');
  } catch { /* the guard probe must never break doctor */ }
  for (const w of warnings) console.log(`warn: ${w}`);
  if (fixes.length) console.log(`fixed: ${fixes.join(', ')}`);
  process.exit(rt && !invalidConfig && !unhealthy && (existsSync(cfg) || haveKey) ? 0 : 1); // doctor must fail when the diagnosis is unhealthy
}
// login/logout are kernel passthroughs (see bin/zagent): they manage the OAuth
// credential a user picks INSTEAD of the API key, so they must not die on the
// "no GLM Coding Plan credential" check ensureConfig performs first. The verb
// is the kernel's positionals[0], not args[0] — a flag-led `--json logout`
// reaches the kernel's logout dispatch identically, so it must skip this
// credential gate identically (else a cred-less machine answers the sign-in
// card where the honest logout refusal belongs).
const kernelVerb0 = kernelPositional0(args);
if (kernelVerb0 !== 'login' && kernelVerb0 !== 'logout') {
  const cfgFile = `${os.homedir()}/.zcode/cli/config.json`;
  const haveCredential = !!process.env.ZAI_API_KEY
    || existsSync(`${os.homedir()}/.config/ccz/.api_key`) || oauthSignedIn();
  // On a real terminal the card is a choice, not a dead end — `zagent login`
  // (option 1) and a pasted key (option 2) both land here with the credential
  // already in place, so ensureConfig just writes the provider entry.
  const needChoice = !existsSync(cfgFile) && !haveCredential;
  const picked = needChoice ? await chooseSignIn() : null;
  // The chooser already printed the card; a declined choice exits quietly —
  // a `-p --json` decline still emits the error envelope (same contract).
  if (needChoice && picked == null && process.stdin.isTTY && process.stderr.isTTY) {
    await writeJsonCredentialError();
    process.exit(2);
  }
  await ensureConfig(picked?.key); // oauth runs proceed with the kernel's own store
}
// FLOCK-F17: `login --no-browser` makes the kernel's OAuth flow wait for a
// sign-in code pasted on stdin; when stdin can never deliver one (fd closed,
// /dev/null) that wait never ends — kernel parity wart turned honest refusal.
// A pipe still forwards: `… | zagent login --no-browser` can carry the code.
// Known limit: an OPEN fd already at EOF (empty pipe/file) forwards too —
// fstat cannot tell EOF-now from a writer that has not written yet.
if (kernelVerb0 === 'login' && preSep.some(a => a === '--no-browser' || a.startsWith('--no-browser=')) && !process.stdin.isTTY) {
  let deadStdin = true; // fd closed outright, or a non-TTY character device (/dev/null)
  try { deadStdin = fstatSync(0).isCharacterDevice(); } catch { /* EBADF = closed */ }
  if (deadStdin) {
    console.error('zagent: login --no-browser reads the sign-in code from stdin, which cannot supply it — run it in a terminal (or pipe the code in), or export ZAI_API_KEY for a headless credential');
    process.exit(2);
  }
}
// FLOCK wave-4: kernel `logout` prints "Logged out from Coding Plan accounts"
// and exits 0 even when no session ever existed — it names a credentials file
// that may not be on disk. Refuse honestly when the store has provably nothing
// to clear; --json keeps the kernel's envelope keys (status/provider) so a
// script reader sees the same shape either way. The gate keys on the kernel's
// positionals[0], not args[0] — a flag-led `--json logout` still reaches the
// kernel's logout dispatch. (A runtime-less machine exits inside doctor long
// before this gate — nothing exists to forward to.)
if (kernelVerb0 === 'logout' && !oauthSessionPresent()) {
  const msg = 'not signed in — no Coding Plan OAuth session to log out of';
  console.error(`zagent: ${msg}`);
  if (preSep.some(a => a === '--json' || a.startsWith('--json=')))
    // write-true ≠ flushed — await the drain, THEN exit (a callback-scheduled
    // exit falls through and spawns the kernel anyway — the r6 #1 class).
    await new Promise(r => process.stdout.write(
      JSON.stringify({ status: 'not_signed_in', provider: 'zai', error: msg }) + '\n', r));
  process.exit(1);
}
// --model/--effort have no kernel -p flag (its parseArgs table rejects both);
// selection is protocol-side (session/create takes model+thoughtLevel). Those
// invocations divert to the app-server runner in zagent-print.mjs; every other
// -p keeps the kernel path below (including its empty-envelope retry wrapper —
// this path reports real errors instead, so it needs none).
if (selection) { // sel parsed above, before the runtime/credential gates
  const asJson = preSep.includes('--json') || sel.format === 'json';
  const write = (s, code) => process.stdout.write(s, () => process.exit(code)); // write-true ≠ flushed — callback form only (r6 #1)
  try {
    const r = await runPrintOnce(sel);
    if (asJson) write(JSON.stringify(printEnvelope(r)) + '\n', r.ok ? 0 : 1);
    else write((r.answer || `(turn ${r.ended})`) + '\n', r.ok ? 0 : 1);
  } catch (e) {
    const msg = displayText(String(e?.message ?? e).slice(0, 300));
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
// The selection block above only SCHEDULES its exit (async write callback) —
// without gating both kernel paths here, `-p --model/--effort --json` fell through and
// spawned the kernel a second time with flags its parseArgs rejects (the "empty
// output" retries + kernel usage dump seen on the installed build).
const headlessJson = !selection && isPrintInvocation(preSep) && preSep.includes('--json');
// --browser-use preflight: the kernel's browser backend imports
// playwright-core resolved from the kernel file's own directory; a runtime
// with no node_modules on that walk-up (the desktop bundle ships none) makes
// every browser command fail INSIDE an otherwise-green turn. Warn before the
// turn is spent; the flag still forwards verbatim — the hint is honest about
// an upstream limitation, never a gate. Only pre-`--` tokens are options.
if (!selection && rt
    && preSep.some(a => a === '--browser-use' || a.startsWith('--browser-use='))
    && !kernelResolves(rt.entry, 'playwright-core')) {
  console.error(`zagent: warning: --browser-use needs the kernel's pinned Playwright runtime, which '${displayPath(rt.entry)}' cannot resolve (no node_modules on its path).`);
  console.error('  Browser commands will fail inside the turn. Point ZCODE_RUNTIME at a full install that carries playwright-core (npm i -g zcode-app-cli).');
}
if (headlessJson) {
  const { runHeadlessWithRetry } = await import(new URL('../driver/headless-retry.mjs', import.meta.url).href);
  const entry = rt.entry;
  const r = runHeadlessWithRetry(process.execPath, [entry, ...args], { cwd: process.cwd(), env: kernelEnv(entry),
    onAttempt: (a, v) => { if (v.retry) console.error(`zagent: attempt ${a} ${v.reason} — ${a < 2 ? 'retrying once' : 'giving up (exit 1)'}`); } });
  if (r.stderr) process.stderr.write(displayText(String(r.stderr).slice(-2000))); // r5 #6: runtime diagnostics surfaced
  if ((r.exitCode ?? 1) !== 0) {
    const explained = explainProviderError(String(r.stderr ?? ''));
    if (explained) process.stderr.write(`\n${formatProviderError(explained)}\n`);
  }
  const done = () => process.exit(r.exitCode ?? 1);
  // r5-followup: the write callback is ASYNC — without the return below, control fell
  // through to the interactive spawn and the runtime ran TWICE (two concatenated JSON
  // envelopes — the m5 4/4 regression root cause).
  process.stdout.write(r.stdout, done); // r6 #1: write-true ≠ flushed; callback form is the only safe exit
} else if (!selection) { // selection owns its args — the interactive spawn must not see them either
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
  const headless = isPrintInvocation(args);
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
