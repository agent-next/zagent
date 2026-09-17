#!/usr/bin/env node
// zagent task — B0 task-index write-side (schema-verified). UPDATE-only CRUD: archive/
// unarchive, pin/unpin, rename, soft-delete. Task id accepts unique suffixes.
import { openTasksDbIfPresent, listTasks, findTask, updateTask } from '../driver/tasks-index.mjs';
const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter(x => x.startsWith('--')));
const pos = rest.filter(x => !x.startsWith('--') && x.trim());
const [a, b] = pos;
const usage = 'usage: zagent task list [--all] [--json] | archive|unarchive|pin|unpin|delete <taskId> | rename <taskId> <title>';
const mutations = ['archive', 'unarchive', 'pin', 'unpin', 'delete'];
const knownFlags = new Set(['--all', '--json']);
const badFlag = [...flags].find(f => !knownFlags.has(f));
// Arity is per-verb: list takes no positionals, mutations one id, rename id+title.
// Flags only mean something on list — elsewhere they were silently ignored before.
const arity = cmd === 'list' ? 0 : cmd === 'rename' ? 2 : mutations.includes(cmd) ? 1 : -1;
if (badFlag || arity < 0 || pos.length !== arity || pos.some(p => !p.trim()) || (cmd !== 'list' && flags.size)) {
  console.error(usage); process.exit(2);
}
// null on a fresh machine: no store = zero tasks. list reads read-only like
// its sibling readers — a rw open would recreate a store deleted mid-check.
const db = openTasksDbIfPresent({ readOnly: cmd === 'list' });
const needId = () => {
  const hits = db ? findTask(db, a) : [];
  if (!hits.length) { console.error(a ? (db && findTaskAmbiguous(db, a) ? `ambiguous id '${a}'` : `no task '${a}'`) : usage); process.exit(1); }
  return hits[0];
};
function findTaskAmbiguous(d, id) { return d.prepare('SELECT COUNT(*) c FROM tasks WHERE task_id LIKE ? AND deleted = 0').get(`%${id}`).c > 1; }

if (cmd === 'list') {
  const rows = db ? listTasks(db, { includeArchived: flags.has('--all') }) : [];
  if (flags.has('--json')) {
    console.log(JSON.stringify({ count: rows.length, tasks: rows }, null, 2));
  } else {
    if (!rows.length) console.log('no tasks');
    for (const r of rows) console.log(`${r.pinned ? '📌' : ' '} ${r.archived ? '[archived] ' : ''}${r.task_id}  ${r.title}  (${r.task_status ?? '?'})`);
  }
} else if (mutations.includes(cmd)) {
  const t = needId();
  const col = { archive: 'archived', unarchive: 'archived', pin: 'pinned', unpin: 'pinned', delete: 'deleted' }[cmd];
  updateTask(db, t, { [col]: cmd.startsWith('un') ? false : true });
  console.log(`${cmd} ok: ${t.task_id}`);
} else if (cmd === 'rename') {
  const t = needId();
  updateTask(db, t, { title: b });
  console.log(`renamed ${t.task_id} → ${b}`);
} else { console.error(usage); process.exit(2); }
