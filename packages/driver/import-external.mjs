// Import Claude Code instructions/commands/skills into zagent locations.
// Preview is the default; --apply writes. Destinations are never overwritten
// without force. AGENTS.md is spliced at a cutoff marker so native text stays.

import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  renameSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CUTOFF_START = '<!-- zagent-import:claude -->';
export const CUTOFF_END = '<!-- /zagent-import:claude -->';

const SKIP_NAMES = new Set(['node_modules', '.git']);
const SECRET_RE = /sk-[A-Za-z0-9_-]{10,}/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._-]{8,}/gi;
const ASSIGNED_RE = /((?:api[_-]?key|token|secret|password|authorization|credential)\s*[:=]\s*)\S+/gi;

export function redactSecrets(text) {
  return String(text ?? '')
    .replace(SECRET_RE, 'sk-…')
    .replace(BEARER_RE, '$1…')
    .replace(ASSIGNED_RE, '$1[redacted]');
}

function exists(p) {
  try { return existsSync(p); } catch { return false; }
}

function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function wrapClaude(body) {
  return `${CUTOFF_START}\n${String(body ?? '').replace(/\s+$/u, '')}\n${CUTOFF_END}\n`;
}

export function spliceAgents(current, imported) {
  const block = wrapClaude(imported);
  const text = String(current ?? '');
  const start = text.indexOf(CUTOFF_START);
  const end = text.indexOf(CUTOFF_END);
  if (start >= 0 && end > start) {
    const after = text.slice(end + CUTOFF_END.length).replace(/^\n/u, '');
    const before = text.slice(0, start).replace(/\s+$/u, '');
    return `${before}${before ? '\n\n' : ''}${block}${after}`;
  }
  const trimmed = text.replace(/\s+$/u, '');
  return `${trimmed}${trimmed ? '\n\n' : ''}${block}`;
}

function agentsAction(dest, apply) {
  if (!exists(dest)) return apply ? 'created' : 'would-create';
  let current = '';
  try { current = readFileSync(dest, 'utf8'); } catch { return apply ? 'created' : 'would-create'; }
  if (current.includes(CUTOFF_START) && current.includes(CUTOFF_END))
    return apply ? 'updated' : 'would-update';
  return apply ? 'appended' : 'would-append';
}

function writeAtomic(dest, content) {
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, dest);
}

function listChildren(root) {
  let names;
  try { names = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of names) {
    if (!ent.name || ent.name.startsWith('.') || SKIP_NAMES.has(ent.name)) continue;
    const full = path.join(root, ent.name);
    if (!inside(root, full)) continue;
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) continue;
    out.push({ name: ent.name, path: full, dir: st.isDirectory() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function copyTree(src, dest, destRoot, force) {
  if (!inside(destRoot, dest)) throw new Error('refusing path outside import root');
  let st;
  try { st = lstatSync(src); } catch (e) { throw e; }
  if (st.isSymbolicLink()) return 'skipped';
  if (st.isFile()) {
    if (exists(dest) && !force) return 'skipped';
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return 'copied';
  }
  if (!st.isDirectory()) return 'skipped';
  if (exists(dest) && !force) return 'skipped';
  mkdirSync(dest, { recursive: true });
  for (const child of listChildren(src)) {
    copyTree(child.path, path.join(dest, child.name), destRoot, true);
  }
  return 'copied';
}

function displayPath(p, home) {
  const abs = path.resolve(p);
  const homeAbs = path.resolve(home);
  if (abs === homeAbs) return '~';
  if (abs.startsWith(homeAbs + path.sep))
    return `~${abs.slice(homeAbs.length).split(path.sep).join('/')}`;
  return abs.split(path.sep).join('/');
}

export function planImport({
  home = os.homedir(), cwd = process.cwd(), force = false,
} = {}) {
  const sources = [
    {
      id: 'claude-md', label: 'CLAUDE.md', kind: 'instructions',
      from: path.join(cwd, 'CLAUDE.md'), to: path.join(cwd, 'AGENTS.md'),
    },
    {
      id: 'user-commands', label: '~/.claude/commands', kind: 'command',
      from: path.join(home, '.claude', 'commands'), to: path.join(home, '.zcode', 'commands'),
    },
    {
      id: 'workspace-commands', label: '.claude/commands', kind: 'command',
      from: path.join(cwd, '.claude', 'commands'), to: path.join(home, '.zcode', 'commands'),
    },
    {
      id: 'user-skills', label: '~/.claude/skills', kind: 'skill',
      from: path.join(home, '.claude', 'skills'), to: path.join(home, '.zcode', 'skills'),
    },
  ];
  const items = [];
  for (const source of sources) {
    source.exists = exists(source.from);
    source.count = 0;
    if (!source.exists) continue;
    if (source.kind === 'instructions') {
      source.count = 1;
      items.push({
        kind: source.kind, source: source.id, name: 'CLAUDE.md',
        from: source.from, to: source.to, destRoot: path.dirname(source.to),
        action: agentsAction(source.to, false),
      });
      continue;
    }
    const children = listChildren(source.from);
    source.count = children.length;
    for (const child of children) {
      const dest = path.join(source.to, child.name);
      items.push({
        kind: source.kind, source: source.id, name: child.name,
        from: child.path, to: dest, destRoot: source.to,
        action: exists(dest) && !force ? 'would-skip' : 'would-copy',
      });
    }
  }
  const summary = { found: items.length, written: 0, skipped: 0, errors: 0 };
  for (const item of items) {
    if (item.action === 'would-skip') summary.skipped += 1;
  }
  return { mode: 'dry-run', force: Boolean(force), home, cwd, sources, items, summary };
}

export function applyImport(plan) {
  plan.mode = 'apply';
  for (const item of plan.items) {
    if (item.action === 'would-skip') { item.action = 'skipped'; continue; }
    try {
      if (item.kind === 'instructions') {
        const action = agentsAction(item.to, true);
        const imported = readFileSync(item.from, 'utf8');
        const current = exists(item.to) ? readFileSync(item.to, 'utf8') : '';
        writeAtomic(item.to, spliceAgents(current, imported));
        item.action = action;
        plan.summary.written += 1;
        continue;
      }
      const result = copyTree(item.from, item.to, item.destRoot, plan.force);
      item.action = result;
      if (result === 'skipped') plan.summary.skipped += 1;
      else plan.summary.written += 1;
    } catch (e) {
      item.action = 'error';
      item.error = e.message;
      plan.summary.errors += 1;
    }
  }
  return plan;
}

export function renderImport(plan, { json = false, home = plan.home } = {}) {
  if (json) {
    return redactSecrets(JSON.stringify({
      mode: plan.mode,
      force: plan.force,
      sources: plan.sources.map((s) => ({
        id: s.id, label: s.label, kind: s.kind, exists: s.exists, count: s.count,
        from: s.from, to: s.to,
      })),
      items: plan.items.map((i) => ({
        kind: i.kind, name: i.name, source: i.source, from: i.from, to: i.to,
        action: i.action, ...(i.error ? { error: i.error } : {}),
      })),
      summary: plan.summary,
    }, null, 2));
  }
  const lines = [];
  lines.push(plan.mode === 'apply' ? 'import apply' : 'import dry-run (no writes)');
  for (const s of plan.sources) {
    const loc = s.id === 'claude-md' ? 'CLAUDE.md' : s.label;
    const state = s.exists ? (s.kind === 'instructions' ? 'present' : `${s.count} item${s.count === 1 ? '' : 's'}`) : 'missing';
    lines.push(`  ${loc.padEnd(24)} ${state}`);
  }
  for (const i of plan.items) {
    const dest = displayPath(i.to, home);
    lines.push(`  ${i.kind.padEnd(13)} ${i.name}  →  ${dest}  ${i.action}${i.error ? ` (${i.error})` : ''}`);
  }
  lines.push(`${plan.summary.found} found · ${plan.summary.written} written · ${plan.summary.skipped} skipped · ${plan.summary.errors} errors`);
  return redactSecrets(lines.join('\n'));
}
