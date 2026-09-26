#!/usr/bin/env node
// User-flow suite — the paths a new user takes, executed for real.
// 1) Config shape recognized by the TUI's own model picker (provider key "zai")
// 2) Interactive turn through the REAL TUI (pty via script): session created, no retries
// Run: node test-user-flow.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRuntime } from './packages/driver/runtime.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

// 1) The config zagent bootstraps must contain the provider key the TUI recognizes.
let cfg; try { cfg = JSON.parse(readFileSync(`${os.homedir()}/.zcode/cli/config.json`, 'utf8')); } catch { cfg = { provider: {}, model: {} }; }
ok('zai' in cfg.provider, 'config has launcher-native provider key "zai"');
ok(cfg.model?.main?.startsWith('zai/'), `model.main is zai/* (${cfg.model.main})`);
ok(cfg.model?.lite?.includes('flash'), `model.lite includes flash (${cfg.model.lite})`);

// 2) Interactive turn through the REAL TUI: a prompt goes in, a session comes out,
//    and the status bar shows the working model without retries. Runs against a
//    sandboxed HOME (fresh mkdtemp dirs + a COPY of the real config) so TUI
//    side-effects can never mutate the developer's ~/.zcode — and no symlink into
//    the real home, which let writes escape the sandbox. The runtime is pinned by
//    ZCODE_RUNTIME so discovery never looks at the real ~/.local.
const ws = mkdtempSync(path.join(os.tmpdir(), 'zuf-ws-'));
const zhome = mkdtempSync(path.join(os.tmpdir(), 'zuf-zhome-'));
mkdirSync(`${zhome}/.zcode/cli`, { recursive: true });
try { copyFileSync(`${os.homedir()}/.zcode/cli/config.json`, `${zhome}/.zcode/cli/config.json`); } catch {}
const env2 = { ...process.env, HOME: zhome };
const runtime = findRuntime()?.entry;
if (runtime) env2.ZCODE_RUNTIME = runtime; // explicit path; never resolved through the sandboxed HOME
const t = spawnSync('bash', ['-c',
  `(printf 'Reply with exactly: OK\\r'; sleep 70) | timeout 80 script -qec "timeout 75 ${root}/bin/zagent --cwd ${ws}" /dev/null`],
  { encoding: 'utf8', env: env2, timeout: 90000, maxBuffer: 32e6 });
const out = t.stdout ?? '';
ok(/sess_/.test(out), 'interactive TUI created a session');
ok(!/etrying model/.test(out), 'no model retries in the interactive turn');
ok(/zai\/glm-5\.3(?!-flash)/.test(out), 'status bar shows the MAIN model (not lite fallback)');

// 3) zagent doctor on a fresh HOME must not crash.
const home2 = mkdtempSync(path.join(os.tmpdir(), 'zuf-home-'));
mkdirSync(`${home2}/.zcode/cli`, { recursive: true });
const zt = spawnSync('node', [`${root}/packages/cli/zagent.mjs`, 'doctor'],
  { encoding: 'utf8', env: { ...process.env, HOME: home2, ZAI_API_KEY: 'test-key' } });
ok(typeof zt.status === 'number' && /runtime/.test(zt.stdout), 'zagent doctor on fresh HOME reports runtime without crashing');

rmSync(ws, { recursive: true, force: true }); rmSync(home2, { recursive: true, force: true }); rmSync(zhome, { recursive: true, force: true });
console.log(fails ? `FAIL (${fails})` : 'PASS user-flow');
process.exit(fails ? 1 : 0);
