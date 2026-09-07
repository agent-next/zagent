#!/usr/bin/env node
// zagent — zcode-cli TUI entry. Finds a ZCode runtime on THIS machine (never vendors one),
// bootstraps ~/.zcode/cli/config.json if absent, and hands off to the interactive TUI or
// headless -p. Runtime preference: zcode-app-cli install (its launcher+TUI) > official
// desktop bundle (headless only, no TUI package shipped).
import { spawn } from 'node:child_process';
const NODE = process.execPath; // eslint-disable-line
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import os from 'node:os';

import { findRuntime } from '../driver/runtime.mjs';
import { runtimeCapabilities, capabilityLine } from '../driver/runtime-info.mjs';

function ensureConfig() { // same shape kingsword09's launcher creates; ours adds nothing secret
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
    } catch {}
    return file;
  }
  mkdirSync(dir, { recursive: true });
  let key = process.env.ZAI_API_KEY;
  if (!key) { try { key = readFileSync(`${os.homedir()}/.config/ccz/.api_key`, 'utf8').trim(); } catch {} }
  if (!key) { console.error('zagent: no API key — set ZAI_API_KEY (see doctor)'); process.exit(1); }
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

const args = process.argv.slice(2);
const rt = findRuntime();
if (args[0] === 'doctor' || !rt) {
  const cfg = `${os.homedir()}/.zcode/cli/config.json`;
  const haveKey = !!(process.env.ZAI_API_KEY || existsSync(`${os.homedir()}/.config/ccz/.api_key`));
  const fixes = [];
  const warnings = [];
  let invalidConfig = false;
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
    } catch { invalidConfig = true; }
  }
  console.log(rt ? `runtime: ${rt.kind} (${rt.root})` : 'runtime: NOT FOUND — install zcode-app-cli or the ZCode desktop app');
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
  console.log(`config: ${invalidConfig ? 'INVALID CONFIG — repair the JSON object manually; existing file preserved' : existsSync(cfg) ? 'present' : !rt ? 'blocked: no runtime found (fix runtime first)' : haveKey ? 'will be created on first run (doctor --fix to do it now)' : 'NO API KEY — export ZAI_API_KEY'}`);
  for (const w of warnings) console.log(`warn: ${w}`);
  if (fixes.length) console.log(`fixed: ${fixes.join(', ')}`);
  process.exit(rt && !invalidConfig && (existsSync(cfg) || haveKey) ? 0 : 1); // doctor must fail when the diagnosis is unhealthy
}
ensureConfig();
// Headless JSON runs retry on empty/error-envelope output (product-level parity with
// harnesses that retry internally; 2 of 3 gate-verdict failures were 429 envelopes).
const headlessJson = args.includes('-p') && args.includes('--json');
if (headlessJson) {
  const { runHeadlessWithRetry } = await import(new URL('../driver/headless-retry.mjs', import.meta.url).href);
  const entry = rt.entry;
  const r = runHeadlessWithRetry(process.execPath, [entry, ...args], { cwd: process.cwd(), env: process.env,
    onAttempt: (a, v) => { if (v.retry) console.error(`zagent: attempt ${a} ${v.reason} — ${a < 2 ? 'retrying once' : 'giving up (exit 1)'}`); } });
  if (r.stderr) process.stderr.write(String(r.stderr).slice(-2000)); // r5 #6: runtime diagnostics surfaced
  const done = () => process.exit(r.exitCode ?? 1);
  // r5-followup: the write callback is ASYNC — without the return below, control fell
  // through to the interactive spawn and the runtime ran TWICE (two concatenated JSON
  // envelopes — the m5 4/4 regression root cause).
  process.stdout.write(r.stdout, done); // r6 #1: write-true ≠ flushed; callback form is the only safe exit
} else { // interactive/other paths — the headless branch schedules its own exit above
  const child = spawn(NODE, [rt.entry, ...args], { cwd: process.cwd(), stdio: 'inherit' });
  child.on('error', e => { console.error('zagent:', e.message); process.exit(1); });
  child.on('exit', (c, sig) => process.exit(c ?? (sig ? 1 : 0))); // signal death is failure, not success
}
