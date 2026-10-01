#!/usr/bin/env node
// The real binary's first-run and error surface — the headless half of the UX
// journey suite. A person who just installed zagent and has nothing configured
// is the cheapest user to lose; every competitor spends its onboarding effort
// here.
//
// These run against bin/zagent itself — not the fake host — in an empty HOME, so
// they stay hermetic and fit the fast gate. The pty and live halves of the same
// journeys run under the interactive journey harness. The oracles pin today's
// floor; upcoming UX features (the sign-in card, flag docs, the unknown-command
// list) tighten them when they land, per "every parity feature lands WITH its
// journey".
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, verbOf } from '../cli/commands.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(root, 'bin', 'zagent');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.error('FAIL ' + name + '\n   ' + String(detail).slice(0, 300).replace(/\n/g, ' | ')); }
};

const homes = [];
const freshHome = () => { const d = mkdtempSync(path.join(tmpdir(), 'zj1-home-')); homes.push(d); return d; };

/** Run the real dispatcher in a throwaway HOME; runtime absent unless given. */
const run = (args, { home, runtime, cwd } = {}) => {
  const h = home ?? freshHome();
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8', timeout: 30000, cwd: cwd ?? root,
    env: { PATH: process.env.PATH, LANG: 'C', HOME: h, USERPROFILE: h,
           ZCODE_RUNTIME: runtime ?? path.join(h, 'no-runtime'), NO_COLOR: '1' },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

// -- fresh install, first run -------------------------------------------------
// Landed: no runtime -> install hint; a runtime but no credential -> the
// sign-in card's three paths (zagent login / paste ZAI_API_KEY / quit) and
// exit 2 — the clap convention for a fixable usage error, and what the other
// top CLIs' first-run screens reduce to on a headless box.
{
  const r = run([]);
  check('J1 first run without a runtime fails with an install hint, not a hang or a stack',
    r.code !== 0 && /install zcode-app-cli|ZCode desktop/i.test(r.out) && !/^\s*at .*\.mjs:\d+/m.test(r.out),
    `code=${r.code} out=${r.out.slice(0, 160)}`);
}
{
  const h = freshHome();
  const rt = path.join(h, 'rt'); mkdirSync(rt, { recursive: true });
  const kernel = path.join(rt, 'zcode.js'); writeFileSync(kernel, '');
  const r = run([], { home: h, runtime: kernel });
  check('J1 first run without a credential shows the three-path sign-in card, exit 2',
    r.code === 2 && /zagent login/.test(r.out) && /ZAI_API_KEY/.test(r.out) && /quit/.test(r.out)
      && !/^\s*at .*\.mjs:\d+/m.test(r.out),
    `code=${r.code} out=${r.out.slice(0, 200)}`);
}
{ // -p prints the same card (the headless half)
  const h = freshHome();
  const rt = path.join(h, 'rt'); mkdirSync(rt, { recursive: true });
  const kernel = path.join(rt, 'zcode.js'); writeFileSync(kernel, '');
  const r = run(['-p', 'hi', '--json'], { home: h, runtime: kernel });
  check('J1 headless -p without a credential prints the same card, exit 2',
    r.code === 2 && /zagent login/.test(r.out) && /ZAI_API_KEY/.test(r.out),
    `code=${r.code} out=${r.out.slice(0, 200)}`);
}
{ // a provided key bootstraps the provider config at mode 0600 (the write path)
  const h = freshHome();
  const rt = path.join(h, 'rt'); mkdirSync(rt, { recursive: true });
  const kernel = path.join(rt, 'zcode.js'); writeFileSync(kernel, '');
  spawnSync(process.execPath, [BIN, '-p', 'hi', '--json'], {
    encoding: 'utf8', timeout: 30000, cwd: root,
    env: { PATH: process.env.PATH, LANG: 'C', HOME: h, USERPROFILE: h,
           ZCODE_RUNTIME: kernel, NO_COLOR: '1', ZAI_API_KEY: 'sk-test-key' },
  });
  const cfg = path.join(h, '.zcode', 'cli', 'config.json');
  let mode = 0, hasKey = false;
  try {
    mode = statSync(cfg).mode & 0o777;
    hasKey = JSON.parse(readFileSync(cfg, 'utf8'))?.provider?.zai?.options?.apiKey === 'sk-test-key';
  } catch {}
  // win32 reports synthetic modes (0666) — the 0600 bit is a POSIX contract
  check('J1 a provided key bootstraps config.json at mode 0600',
    existsSync(cfg) && (process.platform === 'win32' || mode === 0o600) && hasKey,
    `exists=${existsSync(cfg)} mode=${mode.toString(8)} hasKey=${hasKey}`);
}

// -- help discoverability -------------------------------------------------------
// --help must name every dispatched verb — a help page that omits a command is
// how `zagent models --help` shipped printing nothing in 0.0.185.
{
  const r = run(['--help']);
  const verbs = COMMANDS.map(([sig]) => verbOf(sig))
    .filter(v => !v.startsWith('-') && v !== '(default)');
  const missing = verbs.filter(v => !r.out.includes(v));
  check('J2 --help lists every dispatched command', r.code === 0 && missing.length === 0,
    `code=${r.code} missing=${missing.join(',') || '(none)'}`);
}
{
  const r = run(['help']);
  check('J2 bare `help` prints the same page', r.code === 0 && /Usage: zagent/.test(r.out),
    `code=${r.code} out=${r.out.slice(0, 120)}`);
}

// -- error paths ----------------------------------------------------------------
{
  const r = run(['definitely-not-a-command']);
  check('J6 an unknown command exits 2 and points at help',
    r.code === 2 && /unknown command/.test(r.out) && /help/i.test(r.out),
    `code=${r.code} out=${r.out.slice(0, 160)}`);
}
{
  const r = run(['--bogus-flag']);
  check('J6 an unknown option exits 2 and points at help',
    r.code === 2 && /unknown option/.test(r.out) && /help/i.test(r.out),
    `code=${r.code} out=${r.out.slice(0, 160)}`);
}
{
  const r = run(['doctor']);
  check('J6 doctor explains the missing runtime instead of a stack',
    r.code !== 0 && /runtime: NOT FOUND/.test(r.out) && /install/i.test(r.out),
    `code=${r.code} out=${r.out.slice(0, 160)}`);
}

console.log('\n' + pass + '/' + (pass + fail) + ' first-run journeys passed');
for (const h of homes) { try { rmSync(h, { recursive: true, force: true }); } catch {} }
process.exit(fail ? 1 : 0);
