#!/usr/bin/env node
// `zagent inspect` — one dump of what the official GUI Settings pages show:
// runtime, config layers, skills, MCP-ish config, task store, AGENTS.md.
// Credentials are redacted. This is the CLI equivalent of Grok's /inspect.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRuntime } from '../driver/runtime.mjs';
import { listSkills, listConversationsAsync } from '../driver/catalog.mjs';

const SECRET = /(^|[^a-z])(api[_-]?key|token|secret|password|authorization|credential|jwt)$/iu;
const redact = (v) => {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = SECRET.test(k) ? '[redacted]' : redact(val);
    return out;
  }
  return v;
};

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function fileNote(p) {
  return existsSync(p) ? p : null;
}

const json = process.argv.includes('--json');
const home = os.homedir();
const cwd = process.cwd();
const rt = findRuntime();
const cliConfigPath = path.join(home, '.zcode', 'cli', 'config.json');
const v2ConfigPath = path.join(home, '.zcode', 'v2', 'config.json');
const skills = listSkills({ home, cwd });
const conversations = await listConversationsAsync({ home, limit: 8 });

const report = {
  runtime: rt ? { entry: rt.entry, kind: rt.kind ?? null, version: rt.version ?? null } : null,
  config: {
    cli: fileNote(cliConfigPath),
    v2: fileNote(v2ConfigPath),
    cliShape: redact(readJson(cliConfigPath)),
  },
  instructions: {
    user: fileNote(path.join(home, '.zcode', 'AGENTS.md')),
    workspace: fileNote(path.join(cwd, 'AGENTS.md')),
  },
  skills: skills.map(s => s.value),
  conversations: conversations.map(c => ({ id: c.value, title: c.hint })),
  plugins: (() => {
    const dir = path.join(home, '.zcode', 'plugins');
    if (!existsSync(dir)) return [];
    try { return readdirSync(dir).filter(n => !n.startsWith('.')); } catch { return []; }
  })(),
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(rt ? 0 : 1);
}

const line = (k, v) => process.stdout.write(`${k.padEnd(14)} ${v}\n`);
line('runtime', report.runtime?.entry ?? '(not found)');
line('cli config', report.config.cli ?? '(missing)');
line('v2 config', report.config.v2 ?? '(missing)');
line('AGENTS.md', [report.instructions.user, report.instructions.workspace].filter(Boolean).join(' · ') || '(none)');
line('skills', report.skills.length ? `${report.skills.length}: ${report.skills.slice(0, 12).join(', ')}${report.skills.length > 12 ? '…' : ''}` : '(none)');
line('tasks', report.conversations.length ? `${report.conversations.length} recent` : '(none / no sqlite)');
line('plugins', report.plugins.length ? report.plugins.join(', ') : '(none)');
process.exit(rt ? 0 : 1);
