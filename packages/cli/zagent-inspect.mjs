#!/usr/bin/env node
// `zagent inspect` — one dump of what the official GUI Settings pages show:
// runtime, config layers, skills, MCP-ish config, task store, AGENTS.md, repo-wiki.
// Credentials are redacted. This is the CLI equivalent of Grok's /inspect.

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRuntime } from '../driver/runtime.mjs';
import { listSkills, listConversationsAsync } from '../driver/catalog.mjs';
import { inspectWiki } from '../driver/repo-wiki.mjs';
import { installedPlugins } from '../driver/plugins.mjs';
import { displayPath, displayText } from '../driver/doctor.mjs';

// --storage mirrors the 3.12.1 resource manager's classifier (app.asar storage
// scan): file patterns win first, then the longest directory prefix, else
// "other". Read-only — the GUI's clean actions are deliberately not ported.
const STORAGE_FILE_RULES = [
  ['subagentTranscripts', /^cli\/agents\/[^/]+\/[^/]+\/transcript\.jsonl$/],
  ['sessionStore', /^v2\/[^/]+\.sqlite(?:-wal|-shm)?$/],
  ['sessionStore', /^cli\/db\/db\.sqlite(?:-wal|-shm)?$/],
  ['toolOutputs', /^v2\/checkpoints\/(?:.+\/)?(?:pending|tmp)\//],
  ['backups', /^cli\/db\/db\.sqlite\.[^/]+$/],
  ['backups', /^cli\/config\.json\.bak[^/]*$/],
  ['backups', /^v2\/[^/]+\.bak$/],
  ['backups', /^v2\/[^/]+\.backup\.json$/],
  ['backups', /^v2\/setting\.json\.(?:corrupt-|[^/]*backup)[^/]*$/],
  ['backups', /^v2\/config\.json\.pre-[^/]+$/],
  ['toolOutputs', /^v2\/coding-plan-cache\.json$/],
  ['toolOutputs', /^v2\/bots-model-cache[^/]*\.json$/],
  ['logs', /^computer-use\/run\/[^/]+\.log$/],
  ['config', /^v2\/[^/]+\.json$/],
  ['config', /^cli\/config\.json$/],
  ['config', /^agents\/[^/]+\.md$/],
  ['config', /^AGENTS\.md$/],
];
const STORAGE_DIR_RULES = Object.entries({
  sessionStore: ['v2/sessions', 'v2/session-bindings', 'v2/checkpoints'],
  subagentTranscripts: [],
  toolOutputs: ['cli/artifacts', 'cli/agents', 'cli/sessions', 'cli/exec', 'cli/image-cache',
    'cli/pdf-cache', 'clipboard', 'git-checkpoint-index', 'editor-icon', 'tmp', 'cache'],
  modelTrajectory: ['cli/debug', 'cli/rollout'],
  devTraces: ['v2/dev', 'v2/acp-traffic-proxy', 'v2/acp-stream-diagnostics'],
  logs: ['v2/logs', 'cli/log', 'logs', 'v2/crash', 'v2/perf', 'feedback/logs'],
  backups: ['backup', 'v2/backup', 'v2/migrations', 'cli/db/backup', 'cli/db/backups'],
  exports: ['export-log', 'export-log-stage', 'feedback'],
  runtimes: ['agents', 'bundled-agents', 'lite', 'computer-use', 'cli/plugins'],
  config: ['v2/repo-wiki', 'v2/agent-config', 'v2/bots-runtime-locks', 'v2/bot-attachments',
    'v2/certs', 'v2/acp-auth', 'v2/acp-config', 'v2/provider', 'cli/models', 'cli/memories',
    'cli/workflows', 'security', 'commands', 'skills', 'workflows', 'workspace', 'mailbox',
    'server', 'controller', 'launcher', 'dev-signing', 'cua-helper-dev-identity',
    'perf-task-manifests', 'plugin-workspace', 'projects'],
}).flatMap(([id, prefixes]) => prefixes.map(p => ({ prefix: p, id })))
  .sort((a, b) => b.prefix.length - a.prefix.length);
const STORAGE_ORDER = ['sessionStore', 'subagentTranscripts', 'toolOutputs', 'modelTrajectory',
  'devTraces', 'logs', 'backups', 'exports', 'runtimes', 'config', 'other'];

const underPrefix = (rel, prefix) => rel === prefix || rel.startsWith(`${prefix}/`);
const classifyStoragePath = (rel) => {
  if (underPrefix(rel, 'agent')) return 'other'; // official: legacy top-level agent/ is out of scope
  for (const [id, re] of STORAGE_FILE_RULES) if (re.test(rel)) return id;
  for (const { prefix, id } of STORAGE_DIR_RULES) if (underPrefix(rel, prefix)) return id;
  return 'other';
};

function scanStorage(root) {
  const totals = Object.fromEntries(STORAGE_ORDER.map(id => [id, { bytes: 0, files: 0 }]));
  let totalBytes = 0, totalFiles = 0;
  const walk = (dir, rel) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      let st;
      try { st = lstatSync(child); } catch { continue; }
      if (st.isSymbolicLink()) continue; // never follow: a link cycle would double-count forever
      if (st.isDirectory()) { walk(child, childRel); continue; }
      if (!st.isFile()) continue; // sockets/FIFOs/devices are not storage a user can clean
      const bucket = totals[classifyStoragePath(childRel)];
      bucket.bytes += st.size; bucket.files += 1; totalBytes += st.size; totalFiles += 1;
    }
  };
  walk(root, '');
  return { root, totalBytes, totalFiles,
    categories: STORAGE_ORDER.map(id => ({ id, ...totals[id] })).filter(c => c.files > 0) };
}

const humanBytes = (n) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
};

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

const json = process.argv.includes('--json');
const home = os.homedir();

// Paths under the user home display as ~/... — inspect output is a diagnostic
// dump meant to be pasted, so absolute home paths never print.
function fileNote(p) {
  return existsSync(p) ? displayPath(p, home) : null;
}
// Only --json/--storage are valid — 'inspect bogus' used to be silently ignored.
if (process.argv.slice(2).some(a => a !== '--json' && a !== '--storage')) {
  console.error('usage: zagent inspect [--storage] [--json]');
  process.exit(2);
}

if (process.argv.includes('--storage')) {
  // Same root rule as the kernel: ZCODE_DATA_BASE_DIR replaces HOME, then /.zcode.
  const report = scanStorage(path.join(process.env.ZCODE_DATA_BASE_DIR?.trim() || home, '.zcode'));
  const shownRoot = displayPath(report.root, home);
  if (json) {
    process.stdout.write(`${JSON.stringify({ root: shownRoot, totalBytes: report.totalBytes,
      totalFiles: report.totalFiles, categories: report.categories }, null, 2)}\n`);
  } else {
    process.stdout.write(`zcode storage (${shownRoot}): ${humanBytes(report.totalBytes)} in ${report.totalFiles} files\n`);
    for (const c of report.categories)
      process.stdout.write(`  ${c.id.padEnd(20)} ${humanBytes(c.bytes).padStart(9)}  ${c.files} files\n`);
  }
  process.exit(0); // a disk report does not need a runtime
}

const cwd = process.cwd();
const rt = findRuntime();
const cliConfigPath = path.join(home, '.zcode', 'cli', 'config.json');
const v2ConfigPath = path.join(home, '.zcode', 'v2', 'config.json');
const skills = listSkills({ home, cwd });
const conversations = await listConversationsAsync({ home, limit: 8 });

const wiki = inspectWiki({ home, cwd });
const report = {
  runtime: rt ? { entry: displayPath(rt.entry, home), kind: rt.kind ?? null, version: rt.version ?? null } : null,
  config: {
    cli: fileNote(cliConfigPath),
    v2: fileNote(v2ConfigPath),
    cliShape: JSON.parse(displayText(JSON.stringify(redact(readJson(cliConfigPath))), home)),
  },
  instructions: {
    user: fileNote(path.join(home, '.zcode', 'AGENTS.md')),
    workspace: fileNote(path.join(cwd, 'AGENTS.md')),
  },
  skills: skills.map(s => s.value),
  conversations: conversations.map(c => ({ id: c.value, title: c.hint })),
  plugins: Object.entries(installedPlugins({ home })).map(([n, p]) => `${n}@${p.version}`).sort(),
  wiki: wiki ? { ...wiki, path: wiki.path ? displayPath(wiki.path, home) : wiki.path } : wiki,
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(rt ? 0 : 1);
}

const line = (k, v) => process.stdout.write(`${k.padEnd(14)} ${v}\n`);
line('runtime', report.runtime ? `${report.runtime.entry}${report.runtime.version ? ` · ${report.runtime.version}` : ''}` : '(not found)');
line('cli config', report.config.cli ?? '(missing)');
line('v2 config', report.config.v2 ?? '(missing)');
line('AGENTS.md', [report.instructions.user, report.instructions.workspace].filter(Boolean).join(' · ') || '(none)');
line('skills', report.skills.length ? `${report.skills.length}: ${report.skills.slice(0, 12).join(', ')}${report.skills.length > 12 ? '…' : ''}` : '(none)');
line('tasks', report.conversations.length ? `${report.conversations.length} recent` : '(none / no sqlite)');
line('plugins', report.plugins.length ? report.plugins.join(', ') : '(none)');
line('wiki', report.wiki ? (report.wiki.title ? `${report.wiki.title} · ${report.wiki.path}` : report.wiki.path) : '(none)');
process.exit(rt ? 0 : 1);
