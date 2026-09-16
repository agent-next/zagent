#!/usr/bin/env node
// zagent help — the command list, grouped and generated from the shared table in
// commands.mjs. (The GUI's slash palette is TUI-internal; completion/complete is
// not protocol-registered (-32601) — no server-side command list exists to
// mirror. This is OUR palette, honestly so.)
import { COMMANDS, GROUPS, formatRow } from './commands.mjs';

console.log('Usage: zagent [command]\n');
for (const group of GROUPS) {
  const rows = COMMANDS.filter((row) => row[2] === group);
  if (!rows.length) continue;
  console.log(group);
  for (const row of rows) console.log(formatRow(row));
  console.log();
}
console.log(`Run 'zagent <command> --help' for a command's usage.`);
