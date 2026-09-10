#!/usr/bin/env node
// zagent import — copy Claude Code instructions/commands/skills into zagent paths.
// Default is a dry-run listing. --apply writes. Destinations are never overwritten
// without --force. Printed output is secret-redacted; file bodies are not printed.

import { applyImport, planImport, renderImport } from '../driver/import-external.mjs';

const FLAGS = new Set(['--json', '--apply', '--dry-run', '--force']);
const args = process.argv.slice(2);
const unknown = args.filter((a) => !FLAGS.has(a));
if (unknown.length) {
  console.error('usage: zagent import [--dry-run|--apply] [--force] [--json]');
  process.exit(2);
}

const json = args.includes('--json');
const force = args.includes('--force');
const apply = args.includes('--apply') && !args.includes('--dry-run');
const plan = planImport({ force });
if (apply) applyImport(plan);
process.stdout.write(`${renderImport(plan, { json })}\n`);
process.exit(plan.summary.errors ? 1 : 0);
