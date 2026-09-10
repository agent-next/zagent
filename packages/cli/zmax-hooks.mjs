#!/usr/bin/env node
// zagent hooks [list] [--json] — print event names declared in official ZCode
// hook config. Read-only: never runs hook scripts.
import { listHooks, formatHooksText } from '../driver/hooks-cli.mjs';

const raw = process.argv.slice(2);
const asJson = raw.includes('--json');
const args = raw.filter(a => a !== '--json');
const cmd = args[0] ?? 'list';
if (cmd !== 'list' || args.length > 1) {
  console.error('usage: zagent hooks [list] [--json]');
  process.exit(2);
}

const report = listHooks();
if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else process.stdout.write(`${formatHooksText(report)}\n`);
