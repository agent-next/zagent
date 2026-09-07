#!/usr/bin/env node
// zagent help — our CLI-native palette: every subcommand with a one-liner.
// (The GUI's slash palette is TUI-internal; completion/complete is not protocol-registered
// (-32601) — no server-side command list exists to mirror. This is OUR palette, honestly so.)
import { COMMANDS, formatRow } from './commands.mjs';
for (const row of COMMANDS) console.log(formatRow(row));
console.log('\nSource-only experimental features (not shipped): bots, compact command, daemon, RPC bridge, plugin-validate.');
