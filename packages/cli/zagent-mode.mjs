#!/usr/bin/env node
// zagent mode — view or set the persisted DEFAULT permission mode for headless
// -p runs (F14c follow-up). Stored as permissions.defaultMode in
// ~/.zcode/cli/config.json; a -p run without an explicit --mode picks it up.
// Interactive/TUI sessions are untouched — the kernel already persists its own
// per-project mode (session/setMode ↔ session/create), which the /mode picker
// owns; this surface only owns the -p default.
import { readDefaultModeDetail, writeDefaultMode, DEFAULT_MODE_VALUES } from '../driver/default-mode.mjs';

const argv = process.argv.slice(2);
// `mode` bare means show — and a leading flag does too, so `zagent mode --json` parses.
const cmd = !argv.length || argv[0].startsWith('-') ? 'show' : argv[0];
const rest = cmd === argv[0] ? argv.slice(1) : argv;
const flags = new Set(rest.filter(x => x.startsWith('-')));
const pos = rest.filter(x => !x.startsWith('-'));
const usage = 'usage: zagent mode [show] [--json] | set <build|edit|plan|yolo> [--json] | clear [--json]';
if (!['show', 'set', 'clear'].includes(cmd) ||
    [...flags].some(f => f !== '--json') ||
    (cmd === 'set' ? pos.length !== 1 : pos.length > 0) ||
    pos.some(p => !p.trim())) {
  console.error(usage); process.exit(2);
}
const json = flags.has('--json');
const fail = (e) => { console.error(`zagent: ${e.message}`); process.exit(1); };
// Echoed argv tokens can carry control bytes — strip them like zagent.mjs's
// safe() so `mode set $'\x1b[2J'` cannot write raw escapes to the terminal.
const safe = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ');

if (cmd === 'show') {
  const d = readDefaultModeDetail();
  if (json) {
    // state distinguishes 'unset' from 'could not read the config' — a
    // bare defaultMode:null would call a malformed file "not set".
    console.log(JSON.stringify({ defaultMode: d.mode, state: d.state }));
  } else {
    // 'unset' and 'could not read the config' are different diagnoses — a
    // malformed file that may hold a default must not print a bare "not set".
    if (d.state === 'malformed' || d.state === 'unreadable')
      console.log(`default -p permission mode: not set — ~/.zcode/cli/config.json is ${d.state === 'malformed' ? 'not valid JSON' : 'unreadable'}, so it is ignored`);
    else if (d.state === 'invalid')
      console.log(`default -p permission mode: not set — stored value '${safe(d.value)}' is not a launchable mode, ignoring it`);
    else
      console.log(`default -p permission mode: ${d.mode ?? 'not set — -p runs yolo (every tool executes with no confirmation)'}`);
    // Honest scope + precedence: this default is headless-only, and a flag
    // still beats it; the TUI's /mode picker is a different (per-project) store.
    console.log('precedence: an explicit --mode flag wins over this default; without either, -p runs yolo');
    console.log('scope: headless -p runs only — interactive sessions keep the per-project mode set with /mode in the TUI');
  }
} else if (cmd === 'set') {
  const m = pos[0].toLowerCase(); // the kernel folds --mode case; the stored value is the lowercase enum
  if (m === 'auto') {
    console.error("zagent: 'auto' is reserved by the runtime (not implemented — it denies tools) and cannot be a -p default");
    console.error(`pick one of: ${DEFAULT_MODE_VALUES.join('|')}`);
    process.exit(2);
  }
  if (!DEFAULT_MODE_VALUES.includes(m)) {
    console.error(`zagent: mode must be one of ${DEFAULT_MODE_VALUES.join('|')} (got '${safe(pos[0])}')`);
    process.exit(2);
  }
  try { writeDefaultMode(m); } catch (e) { fail(e); }
  if (json) console.log(JSON.stringify({ defaultMode: m }));
  else console.log(`default -p permission mode set to '${m}' — -p runs without --mode use it now (TUI /mode still owns interactive sessions)`);
} else { // clear
  let cleared = false;
  try { cleared = writeDefaultMode(null); } catch (e) { fail(e); }
  if (json) console.log(JSON.stringify({ defaultMode: null, cleared }));
  else console.log(cleared
    ? 'default -p permission mode cleared — -p runs yolo again unless --mode is passed'
    : 'no default -p permission mode was set');
}
