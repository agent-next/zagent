#!/usr/bin/env node
// zagent help — E2's CLI-native palette: every subcommand with a one-liner.
// (The GUI's slash palette is TUI-internal; completion/complete is not protocol-registered
// (-32601) — no server-side command list exists to mirror. This is OUR palette, honestly so.)
const CMDS = [
  ['--version', 'print the installed zagent package version (offline)'],
  ['(default)', 'interactive TUI'],
  ['-p "…" [--json]', 'headless one-shot (retry-on-envelope product path)'],
  ['onboard', 'first-run chain proof: doctor + live smoke + guidance'],
  ['doctor [--fix]', 'runtime/config/key diagnosis (+degraded-posture warnings)'],
  ['models [query]', 'search the official provider catalog (10 providers/130 models)'],
  ['quota [balance|preview|reset]', 'coding-plan oracles (dual-token auth)'],
  ['sessions', 'GUI task store panel (both worlds, one view)'],
  ['diff [sessionId]', 'per-turn +A -D aggregate + per-file hunks'],
  ['task list|archive|pin|rename|delete', 'inspect or modify existing runtime task records (no create)'],
  ['memory show|index|append', 'runtime-compatible memory store'],
  ['offpeak [--refresh|--json]', 'is GLM-5.3-Flash free right now (exit 0 = yes)'],
  ['cron add|list|tick', 'scheduled prompts (heartbeat receipts, no daemon)'],
  ['plugins', 'inspect and manage local plugins'],
];
for (const [c, d] of CMDS) console.log(`  zagent ${c.padEnd(34)} ${d}`);
console.log('\nSource-only experimental features (not shipped): bots, compact command, daemon, RPC bridge, plugin-validate.');
