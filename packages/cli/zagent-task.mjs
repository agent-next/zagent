#!/usr/bin/env node
// zagent task — B0 task-index write-side (schema-verified). UPDATE-only CRUD: archive/
// unarchive, pin/unpin, rename, soft-delete. Task id accepts unique suffixes.
import { openTasksDb, listTasks, findTask, updateTask } from '../driver/tasks-index.mjs';
const [cmd, a, b] = process.argv.slice(2);
const usage = 'usage: zagent task list [--all] | archive|unarchive|pin|unpin|delete <taskId> | rename <taskId> <title>';
const mutations = ['archive', 'unarchive', 'pin', 'unpin', 'delete'];
if ((mutations.includes(cmd) || cmd === 'rename') && !a?.trim()) { console.error(usage); process.exit(2); }
const db = openTasksDb();
const needId = () => {
  const hits = findTask(db, a);
  if (!hits.length) { console.error(a ? (findTaskAmbiguous(db, a) ? `ambiguous id '${a}'` : `no task '${a}'`) : usage); process.exit(1); }
  return hits[0];
};
function findTaskAmbiguous(d, id) { return d.prepare('SELECT COUNT(*) c FROM tasks WHERE task_id LIKE ? AND deleted = 0').get(`%${id}`).c > 1; }

if (cmd === 'list') {
  const rows = listTasks(db, { includeArchived: a === '--all' });
  if (!rows.length) console.log('no tasks');
  for (const r of rows) console.log(`${r.pinned ? '📌' : ' '} ${r.archived ? '[archived] ' : ''}${r.task_id}  ${r.title}  (${r.task_status ?? '?'})`);
} else if (mutations.includes(cmd)) {
  const t = needId();
  const col = { archive: 'archived', unarchive: 'archived', pin: 'pinned', unpin: 'pinned', delete: 'deleted' }[cmd];
  updateTask(db, t, { [col]: cmd.startsWith('un') ? false : true });
  console.log(`${cmd} ok: ${t.task_id}`);
} else if (cmd === 'rename') {
  if (!b) { console.error(usage); process.exit(2); }
  const t = needId();
  updateTask(db, t, { title: b });
  console.log(`renamed ${t.task_id} → ${b}`);
} else { console.error(usage); process.exit(2); }
