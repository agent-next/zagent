#!/usr/bin/env node
// zagent bots — read-only view of the desktop's shared bot store. The official
// "bots" channel is host-process-internal (Electron MessagePort, ):
// the headless app-server has no bots/* methods, so parity is a native read of
// ~/.zcode/v2/bot-config.v3.json + bot-state.v3.json. Never writes the store,
// never reads the credential store — credentialRef/webhookSecretRef are emitted
// as presence booleans only. webhookUrl stays verbatim — it is user config the
// desktop itself displays, not a credential-store key. Older pre-v3 store names
// (bot-config.json / bot-state.v2.json) are intentionally not read: the desktop
// migrates them on next launch.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
// `bots` bare means list — and a flag in first position means it too, so the
// documented `[list] [--json]` signature accepts `zagent bots --json`.
const cmd = !argv.length || argv[0].startsWith('-') ? 'list' : argv[0];
const rest = cmd === argv[0] ? argv.slice(1) : argv;
const flags = new Set(rest.filter(x => x.startsWith('--')));
const pos = rest.filter(x => !x.startsWith('--'));
const usage = 'usage: zagent bots [list] [--json] | show <botId> [--json] | status [--json]';
const verbs = new Set(['list', 'show', 'status']);
if (!verbs.has(cmd) || [...flags].some(f => f !== '--json') ||
    (cmd === 'show' ? pos.length !== 1 : pos.length > 0) || pos.some(p => !p.trim())) {
  console.error(usage); process.exit(2);
}
const json = flags.has('--json');

// Same root rule as the kernel/inspect: ZCODE_DATA_BASE_DIR replaces HOME.
const v2 = path.join(process.env.ZCODE_DATA_BASE_DIR?.trim() || os.homedir(), '.zcode', 'v2');
// Absent or corrupt store = zero bots, never a crash and never a created file.
const readStore = (file, botsKey) => {
  try {
    const p = path.join(v2, file);
    if (!existsSync(p)) return null;
    const d = JSON.parse(readFileSync(p, 'utf8'));
    return d && typeof d === 'object' ? (d[botsKey] ?? null) : null;
  } catch { return null; }
};
const config = readStore('bot-config.v3.json', 'bots') ?? [];
const stateMap = readStore('bot-state.v3.json', 'bots') ?? {};
const states = stateMap && typeof stateMap === 'object' && !Array.isArray(stateMap) ? stateMap : {};
const bots = (Array.isArray(config) ? config : []).filter(b => b && typeof b === 'object');
const stateOf = id => (Object.hasOwn(states, id) ? states[id] : null);

// Presence booleans for the credential-store keys — the refs are deterministic
// names and the store itself is never opened.
const scrub = b => ({ ...b, credentialRef: !!b.credentialRef, webhookSecretRef: !!b.webhookSecretRef });
const workspaces = b => (Array.isArray(b.allowedWorkspaces) ? b.allowedWorkspaces.join(', ') : '') || '-';

const findBot = id => {
  const exact = bots.filter(b => b.id === id);
  const hits = exact.length ? exact : bots.filter(b => String(b.id ?? '').includes(id));
  return { hits, ambiguous: hits.length > 1 };
};

if (cmd === 'list') {
  if (json) {
    console.log(JSON.stringify({ count: bots.length, bots: bots.map(scrub) }, null, 2));
  } else {
    if (!bots.length) console.log('no bots configured');
    for (const b of bots)
      console.log(`${b.enabled === true ? '[on] ' : '[off]'} ${b.id}  ${b.name || '(unnamed)'}  ${b.provider ?? '?'}` +
        (b.displayName ? `  (${b.displayName})` : ''));
  }
} else if (cmd === 'show') {
  const { hits, ambiguous } = findBot(pos[0]);
  if (!hits.length || ambiguous) {
    console.error(ambiguous ? `ambiguous id '${pos[0]}'` : `no bot '${pos[0]}'`);
    process.exit(1);
  }
  const b = hits[0];
  if (json) {
    console.log(JSON.stringify({ ...scrub(b), state: stateOf(b.id) }, null, 2));
  } else {
    console.log(`${b.id}  ${b.name || '(unnamed)'}  ${b.provider ?? '?'}`);
    console.log(`  enabled:            ${b.enabled === true}`);
    console.log(`  display name:       ${b.displayName ?? '-'}`);
    console.log(`  reply mode:         ${b.replyMode ?? '-'}`);
    console.log(`  allowed workspaces: ${workspaces(b)}`);
    console.log(`  credential:         ${b.credentialRef ? 'configured' : 'none'}`);
    console.log(`  webhook secret:     ${b.webhookSecretRef ? 'configured' : 'none'}`);
    const s = stateOf(b.id);
    if (s) console.log(`  state:              ${s.mode ?? '?'}${s.activeTaskId ? `  task ${s.activeTaskId}` : ''}  ${s.workspacePath ?? ''}`);
  }
} else { // status — the host getStatus counts plus per-bot state, incl. orphans
  const known = new Set(bots.map(b => b.id));
  const rows = bots.map(b => ({ id: b.id, provider: b.provider ?? null, enabled: b.enabled === true,
    mode: stateOf(b.id)?.mode ?? null, activeTaskId: stateOf(b.id)?.activeTaskId ?? null,
    workspacePath: stateOf(b.id)?.workspacePath ?? null }));
  const orphans = Object.entries(states).filter(([id]) => !known.has(id))
    .map(([id, s]) => ({ id, mode: s?.mode ?? null, activeTaskId: s?.activeTaskId ?? null,
      workspacePath: s?.workspacePath ?? null }));
  const enabled = rows.filter(r => r.enabled === true).length;
  if (json) {
    console.log(JSON.stringify({ botsCount: bots.length, enabledBotsCount: enabled,
      contextsCount: Object.keys(states).length, bots: rows,
      ...(orphans.length ? { orphanStates: orphans } : {}) }, null, 2));
  } else {
    console.log(`${bots.length} bot(s), ${enabled} enabled`);
    for (const r of [...rows, ...orphans.map(o => ({ ...o, provider: null, enabled: null, orphan: true }))])
      console.log(`${r.enabled === true ? '[on] ' : '[off]'} ${r.id}  ${r.provider ?? '?'}  ${r.mode ?? 'no state'}${r.activeTaskId ? `  task ${r.activeTaskId}` : ''}${r.orphan ? '  (orphan state)' : ''}`);
  }
}
