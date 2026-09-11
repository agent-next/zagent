#!/usr/bin/env node
// `zagent inspect` — one dump of what the official GUI Settings pages show:
// runtime, config layers, skills, MCP-ish config, task store, AGENTS.md, repo-wiki.
// Credentials are redacted. This is the CLI equivalent of Grok's /inspect.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRuntime } from '../driver/runtime.mjs';
import { listSkills, listConversationsAsync } from '../driver/catalog.mjs';
import { inspectWiki } from '../driver/repo-wiki.mjs';

// Key match is boundary-anchored: normalize camelCase/kebab to snake first so
// accessToken, client-secret and CLIENT_SECRET all hit the same suffix list.
// Bare `key` is a suffix: privateKey/signingKey are secrets; "monkey" and
// "keyboard" still pass because their boundary is a letter, not a separator.
const SECRET_SUFFIX = /(^|_)(api_?key|token|secret|password|passwd|authorization|credential|jwt|key)$/;
const isSecretKey = (k) => SECRET_SUFFIX.test(
  String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase());
const redact = (v) => {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = isSecretKey(k) ? '[redacted]' : redact(val);
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
  wiki: inspectWiki({ home, cwd }),
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
line('wiki', report.wiki ? (report.wiki.title ? `${report.wiki.title} · ${report.wiki.path}` : report.wiki.path) : '(none)');
process.exit(rt ? 0 : 1);
