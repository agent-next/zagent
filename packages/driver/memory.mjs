// E6 — memory parity (r10: runtime-exact algorithm, legacy migration, locked appends).
// GLOBAL audit 2026-09-06: UPSTREAM ZCode uses project-only memory (bundle + live tree
// show memories/projects/… only; headless runs skip extraction — a /tmp probe wrote
// nothing). zmax INTENTIONALLY retains the global load/save/append API below as a LOCAL
// feature — not a parity claim; do not remove it on parity grounds.
// Workspace-id scheme copied from the runtime's rules (cx-verified spec, 2026-09-06):
// resolve(path) → basename → lowercase → keep [a-z0-9._-] → trim edge hyphens →
// truncate 48 → fallback 'project'; hash = sha256(resolved)[0:16] (Windows lowercases
// the hash input). Proven against live dirs: downloads-c8eaf70bac09c0f2, e3undo-….
import { readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const GLOBAL = `${os.homedir()}/.claude/memory/MEMORY.md`;
const PROJECT_BASE = `${os.homedir()}/.zcode/cli/memories/projects`;
const LEGACY_BASE = `${os.homedir()}/.zcode/v2/cli/memories/projects`; // pre-0.0.114 CLI writes

export function loadGlobalMemory() {
  try { return readFileSync(GLOBAL, 'utf8'); } catch { return ''; }
}

export function saveGlobalMemory(content) {
  mkdirSync(path.dirname(GLOBAL), { recursive: true });
  writeFileSync(GLOBAL, content);
}

export function appendGlobalMemory(line) {
  const cur = loadGlobalMemory();
  saveGlobalMemory(cur.endsWith('\n') || !cur ? cur + line + '\n' : cur + '\n' + line + '\n');
}

export const workspaceId = workspacePath => {
  const resolved = path.resolve(String(workspacePath ?? ''));
  const hashInput = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const h = createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
  let name = path.basename(resolved).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (!name) name = 'project';
  return `${name}-${h}`;
};

// Legacy (pre-0.0.114) CLI id: basename_<sha12> — for migration reads only.
const legacyId = workspacePath => {
  const h = createHash('sha256').update(workspacePath).digest('hex').slice(0, 12);
  const readable = workspacePath.split('/').filter(Boolean).pop()?.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30) ?? 'root';
  return `${readable}_${h}`;
};

export function loadProjectMemory(workspacePath) {
  const id = workspaceId(workspacePath);
  // new layout first; fall back ONLY on ENOENT (r10: other errors must not resurrect stale data)
  try { return readFileSync(`${PROJECT_BASE}/${id}/memory/MEMORY.md`, 'utf8'); } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  try { return readFileSync(`${PROJECT_BASE}/${id}/MEMORY.md`, 'utf8'); } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  // legacy pre-0.0.114 CLI writes (different base AND id) — migration source
  try { return readFileSync(`${LEGACY_BASE}/${legacyId(workspacePath)}/memory/MEMORY.md`, 'utf8'); } catch {}
  return '';
}

// Serialized write (r10 #3): exclusive lockfile + tmp/rename atomic replace.
export function saveProjectMemory(workspacePath, content) {
  const dir = `${PROJECT_BASE}/${workspaceId(workspacePath)}/memory`;
  mkdirSync(dir, { recursive: true });
  const lock = `${dir}/.lock`;
  const fh = openSync(lock, 'wx'); // EEXIST → another writer holds it
  try {
    const tmp = `${dir}/MEMORY.md.tmp-${process.pid}`;
    writeFileSync(tmp, content);
    renameSync(tmp, `${dir}/MEMORY.md`);
  } finally { closeSync(fh); try { unlinkSync(lock); } catch {} } // unlink: no artifacts left in the GUI-owned store
}
