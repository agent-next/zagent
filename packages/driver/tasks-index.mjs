// B0 task-index write-side (schema-verified 2026-09-06 against ~/.zcode/v2/tasks-index.sqlite):
// tasks PK (workspace_key, task_id); columns archived/pinned/title_overridden/deleted are
// the GUI's CRUD surface. We only UPDATE existing rows — never INSERT synthetic tasks.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import os from 'node:os';

export function tasksDbPath({ home = os.homedir() } = {}) { return `${home}/.zcode/v2/tasks-index.sqlite`; }

export function openTasksDb({ home = os.homedir(), readOnly = false } = {}) {
  return new DatabaseSync(tasksDbPath({ home }), { readOnly });
}

export function listTasks(db, { includeArchived = false } = {}) {
  return db.prepare(`SELECT workspace_key, task_id, title, task_status, pinned, archived, deleted
    FROM tasks WHERE deleted = 0 ${includeArchived ? '' : 'AND archived = 0'}
    ORDER BY updated_at DESC LIMIT 200`).all();
}

export function findTask(db, taskId) { // exact id, or unique suffix match (sess_… uuid tails are what users type)
  if (typeof taskId !== 'string' || !taskId.trim()) return [];
  const exact = db.prepare('SELECT workspace_key, task_id FROM tasks WHERE task_id = ? AND deleted = 0').all(taskId);
  if (exact.length) return exact;
  const suff = db.prepare('SELECT workspace_key, task_id FROM tasks WHERE task_id LIKE ? AND deleted = 0').all(`%${taskId}`);
  return suff.length === 1 ? suff : []; // ambiguous/none -> [] (caller reports)
}

export function updateTask(db, coords, sets) { // coords: findTask row (snake) or camel literal; sets: {archived?, pinned?, title?, deleted?}
  const workspaceKey = coords?.workspaceKey ?? coords?.workspace_key;
  const taskId = coords?.taskId ?? coords?.task_id;
  if (typeof workspaceKey !== 'string' || typeof taskId !== 'string') throw new Error('updateTask: missing workspace/task coords');
  const allowed = ['archived', 'pinned', 'deleted', 'title_overridden'];
  const cols = [], vals = [];
  for (const k of allowed) if (k in (sets ?? {})) { cols.push(`${k} = ?`); vals.push(sets[k] ? 1 : 0); }
  if (typeof sets?.title === 'string' && sets.title.length) { cols.push('title = ?'); vals.push(sets.title); cols.push('title_overridden = 1'); }
  if (!cols.length) throw new Error('updateTask: nothing to set');
  cols.push('updated_at = ?'); vals.push(Date.now());
  vals.push(workspaceKey, taskId);
  return db.prepare(`UPDATE tasks SET ${cols.join(', ')} WHERE workspace_key = ? AND task_id = ?`).run(...vals);
}
