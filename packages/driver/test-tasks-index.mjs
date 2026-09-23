// B0 tests — sandbox db seeded with the LIVE schema DDL (verified 2026-09-06).
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listTasks, findTask, updateTask, openTasksDb, openTasksDbIfPresent, tasksDbPath } from './tasks-index.mjs';
import path from 'node:path';
import os from 'node:os';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const home = mkdtempSync(path.join(os.tmpdir(), 'ztask-'));
mkdirSync(`${home}/.zcode/v2`, { recursive: true });
const db = new DatabaseSync(tasksDbPath({ home }));
db.exec(`CREATE TABLE tasks (workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
  task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT, provider TEXT, mode TEXT NOT NULL DEFAULT 'build',
  model TEXT, migration_source TEXT, forked_from_task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  unread_at INTEGER, last_unread_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, title_overridden INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}', searchable_text TEXT NOT NULL DEFAULT '', cron_automation_id TEXT, off_peak_task_id TEXT,
  PRIMARY KEY (workspace_key, task_id))`);
const ins = db.prepare('INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)');
ins.run('/w1', '/w1', 'sess_aaa111', 'Task A', 'completed', 1, 1);
ins.run('/w1', '/w1', 'sess_bbb222', 'Task B', 'completed', 2, 2);
ins.run('/w2', '/w2', 'sess_aaa333', 'Task C', 'completed', 3, 3); // same PREFIX different ws

let t = listTasks(db);
ok(t.length === 3, 'lists all live tasks');
ok(listTasks(db, { includeArchived: true }).length === 3, 'flag plumbing');

let f = findTask(db, 'sess_aaa111');
ok(f.length === 1 && f[0].task_id === 'sess_aaa111', 'exact id found');
f = findTask(db, 'bbb222');
ok(f.length === 1 && f[0].task_id === 'sess_bbb222', 'suffix match unique');
f = findTask(db, 'aaa');
ok(f.length === 0, 'ambiguous suffix -> [] not a guess');
ok(findTask(db, 'nope')[0] === undefined && findTask(db, 'nope').length === 0, 'missing -> []');
ok(findTask(db, '').length === 0 && findTask(db, undefined).length === 0 && findTask(db, '  ').length === 0,
   'missing and empty IDs never resolve as wildcard suffixes');

let r = updateTask(db, { workspaceKey: '/w1', taskId: 'sess_aaa111' }, { archived: true });
t = listTasks(db);
ok(t.length === 2 && !t.some(x => x.task_id === 'sess_aaa111'), 'archive hides from default list');
ok(listTasks(db, { includeArchived: true }).length === 3, 'archived still there');
updateTask(db, { workspaceKey: '/w1', taskId: 'sess_aaa111' }, { archived: false });
ok(listTasks(db).length === 3, 'unarchive restores');

updateTask(db, { workspaceKey: '/w1', taskId: 'sess_bbb222' }, { pinned: true });
ok(db.prepare('SELECT pinned FROM tasks WHERE task_id=?').get('sess_bbb222').pinned === 1, 'pin persisted');

updateTask(db, { workspaceKey: '/w1', taskId: 'sess_bbb222' }, { title: 'Renamed' });
const row = db.prepare('SELECT title, title_overridden FROM tasks WHERE task_id=?').get('sess_bbb222');
ok(row.title === 'Renamed' && row.title_overridden === 1, 'rename sets override flag');

updateTask(db, { workspaceKey: '/w2', taskId: 'sess_aaa333' }, { deleted: true });
ok(listTasks(db, { includeArchived: true }).length === 2, 'soft delete hides everywhere');

let threw = false; try { updateTask(db, { workspaceKey: '/w1', taskId: 'x' }, {}); } catch { threw = true; }
ok(threw, 'empty update refused');
const upd = db.prepare('SELECT updated_at FROM tasks WHERE task_id=?').get('sess_bbb222');
ok(upd.updated_at > 2, 'updated_at bumped');

// The sole remaining task was the dangerous case: an omitted ID became LIKE '%'.
db.exec("UPDATE tasks SET deleted = 1 WHERE task_id != 'sess_bbb222'");
const sole = db.prepare('SELECT * FROM tasks WHERE deleted = 0').get();
const cli = fileURLToPath(new URL('../cli/zagent-task.mjs', import.meta.url));
for (const verb of ['delete', 'archive', 'unarchive', 'pin', 'unpin']) {
  for (const id of [undefined, '']) {
    const result = spawnSync(process.execPath, [cli, verb, ...(id === undefined ? [] : [id])], {
      env: { ...process.env, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home, TMPDIR: home, TEMP: home, TMP: home }, encoding: 'utf8', timeout: 10000,
    });
    ok(result.status === 2 && /usage:/.test(result.stderr), `${verb} with ${id === undefined ? 'missing' : 'empty'} ID fails with usage`);
    ok(JSON.stringify(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(sole.task_id)) === JSON.stringify(sole),
       `${verb} without a usable ID leaves the sole task unchanged`);
  }
}
const emptyHome = path.join(home, 'empty-home');
mkdirSync(path.join(emptyHome, '.zcode/v2'), { recursive: true });
const missingId = spawnSync(process.execPath, [cli, 'delete'], {
  env: { ...process.env, HOME: emptyHome, USERPROFILE: emptyHome, ZAGENT_TEST_SANDBOX: emptyHome, TMPDIR: emptyHome, TEMP: emptyHome, TMP: emptyHome },
  encoding: 'utf8', timeout: 10000,
});
ok(missingId.status === 2 && !existsSync(tasksDbPath({ home: emptyHome })), 'missing ID is rejected before an empty task database can be created');

// openTasksDbIfPresent — every fresh-machine store state resolves to null.
const h2 = mkdtempSync(path.join(os.tmpdir(), 'ztask-empty-'));
ok(openTasksDbIfPresent({ home: h2 }) === null, 'absent store file -> null');
ok(!existsSync(tasksDbPath({ home: h2 })), 'a read creates no file');
mkdirSync(`${h2}/.zcode/v2`, { recursive: true });
new DatabaseSync(tasksDbPath({ home: h2 })).close(); // well-formed db, no table
ok(openTasksDbIfPresent({ home: h2 }) === null, 'db without tasks table -> null');
writeFileSync(tasksDbPath({ home: h2 }), 'not sqlite');
ok(openTasksDbIfPresent({ home: h2 }) === null, 'corrupt store -> null');
const good = openTasksDbIfPresent({ home });
ok(good !== null && listTasks(good).length >= 1, 'valid store -> live handle');
try { good?.close(); } catch {}
rmSync(h2, { recursive: true, force: true });

try { db.close(); } catch {} // Windows: file handles must close before rm (EBUSY)
rmSync(home, { recursive: true, force: true });
console.log(fails ? `FAIL (${fails})` : 'PASS tasks-index-b0');
process.exit(fails ? 1 : 0);
