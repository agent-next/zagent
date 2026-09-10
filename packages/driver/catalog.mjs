// Official GUI input tokens the TUI was not offering:
//   $skill          ~/.zcode/skills + <cwd>/.zcode/skills (and .claude/skills)
//   #conversation   rows in the shared GUI task store
//
// Filesystem only. No kernel RPC. Skill names are directory / markdown stems;
// a broken symlink is skipped.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function skillNameFromEntry(root, name) {
  if (!name || name.startsWith('.')) return null;
  const full = join(root, name);
  try {
    const st = statSync(full);
    if (st.isDirectory()) {
      if (existsSync(join(full, 'SKILL.md')) || existsSync(join(full, 'skill.md'))) return name;
      return name; // official layout is a directory even without SKILL.md yet
    }
    if (st.isFile() && /\.md$/iu.test(name)) return name.replace(/\.md$/iu, '');
  } catch { return null; }
  return null;
}

/** Deduped skill names, user-global first then workspace. */
export function listSkills({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const roots = [
    join(home, '.zcode', 'skills'),
    join(cwd, '.zcode', 'skills'),
    join(cwd, '.claude', 'skills'),
  ];
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    if (!isDir(root)) continue;
    let names = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      const skill = skillNameFromEntry(root, name);
      if (!skill || seen.has(skill)) continue;
      seen.add(skill);
      out.push({ value: skill, hint: 'skill', source: root });
    }
  }
  return out;
}

/** Recent GUI tasks as #conversation candidates. Empty when sqlite is unavailable. */
export async function listConversationsAsync(opts = {}) {
  try {
    const mod = await import('./tasks-index.mjs');
    const db = mod.openTasksDb({ home: opts.home ?? os.homedir(), readOnly: true });
    try {
      const limit = opts.limit ?? 40;
      return mod.listTasks(db)
        .slice(0, limit)
        .map((row) => {
          const id = String(row.task_id ?? '');
          const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : id.slice(-8);
          return { value: id, hint: title, title };
        })
        .filter((c) => c.value);
    } finally { db.close(); }
  } catch { return []; }
}

export function mcpSummary(servers) {
  const entries = servers && typeof servers === 'object' && !Array.isArray(servers)
    ? Object.entries(servers) : [];
  let connected = 0, failed = 0, other = 0;
  for (const [, v] of entries) {
    const status = v && typeof v === 'object' ? String(v.status ?? '') : '';
    if (status === 'connected' || status === 'ready') connected += 1;
    else if (status === 'failed' || status === 'error' || status === 'disconnected') failed += 1;
    else other += 1;
  }
  return { connected, failed, other, total: entries.length };
}
