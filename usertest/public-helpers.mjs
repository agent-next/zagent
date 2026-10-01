import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Public helper acceptance only: no model requests, GUI claims, or real profile access.
// The caller owns the isolated HOME/workspace and removes them after acceptance.
export async function verifyHelpers({ cli, run, check, workspace, home, entry }) {
  assert(path.isAbsolute(home) && path.isAbsolute(workspace));
  const state = path.join(home, '.zcode');
  const failure = async (args, code, pattern) => {
    const r = await run(entry, args, { timeout: 15000 });
    assert(!r.expired, `${args.join(' ')} timed out`);
    assert.equal(r.code, code);
    assert.match(r.stderr, pattern);
  };

  await check('helper memory: fresh state, append, show and index', async () => {
    assert(!existsSync(path.join(state, 'cli/memories')), 'Requires a fresh fixture memory store');
    assert.match((await cli(['memory', 'show'])), /No memory for/, 'empty memory reports exit-0 guidance');
    assert.equal((await cli(['memory', 'index'])).trim(), 'no memories anywhere');
    await failure(['memory', 'append'], 2, /usage:/);
    await cli(['memory', 'append', 'synthetic helper memory first']);
    await cli(['memory', 'append', 'synthetic helper memory second']);
    const expected = '# Memory Index\n- synthetic helper memory first\n- synthetic helper memory second';
    assert.equal((await cli(['memory', 'show'])).trim(), expected);
    assert.equal((await cli(['memory'])).trim(), expected);
    const base = path.join(state, 'cli/memories/projects');
    const names = readdirSync(base);
    assert.equal(names.length, 1);
    assert.equal(readFileSync(path.join(base, names[0], 'memory/MEMORY.md'), 'utf8').trim(), expected);
    assert.equal((await cli(['memory', 'index'])).trim(), `${names[0]}  (2 entries)`);
    return { synthetic: true, persistedEntries: 2 };
  });

  await check('helper cron: add, reject duplicates, list, remove and empty tick', async () => {
    const jobsFile = path.join(state, 'cli/automations.json');
    assert(!existsSync(jobsFile), 'Requires a fresh fixture automation store');
    assert.equal((await cli(['cron', 'list'])).trim(), 'no automations');
    await failure(['cron', 'add', 'invalid', '61 * * * *', 'never execute'], 2, /usage:/);
    assert(!existsSync(jobsFile), 'Invalid schedule must not persist');
    await cli(['cron', 'add', 'synthetic-helper', '0 0 1 1 *', 'Never execute this synthetic job']);
    const jobs = JSON.parse(readFileSync(jobsFile, 'utf8')).jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].workspace, workspace);
    assert.equal(jobs[0].prompt, 'Never execute this synthetic job');
    assert.equal(jobs[0].status, 'idle');
    assert.equal(jobs[0].lastAttemptMs, null);
    const before = readFileSync(jobsFile);
    await failure(['cron', 'add', 'synthetic-helper', '* * * * *', 'duplicate'], 2, /exists/);
    assert.deepEqual(readFileSync(jobsFile), before);
    assert.match(await cli(['cron', 'list']), /synthetic-helper:.*never succeeded/);
    await cli(['cron', 'remove', 'synthetic-helper']);
    assert.equal((await cli(['cron', 'list'])).trim(), 'no automations');
    // This assertion is a safety gate: never tick a store containing any job.
    assert.deepEqual(JSON.parse(readFileSync(jobsFile, 'utf8')).jobs, []);
    assert.equal((await cli(['cron', 'tick'])).trim(), 'no due jobs');
    assert.match(readFileSync(path.join(state, 'cli/automation-heartbeat.log'), 'utf8'), /tick due=0/);
    return { synthetic: true, executedJobs: 0, emptyTickHeartbeat: true };
  });

  await check('helper task: synthetic SQLite fixture CRUD through public commands', async () => {
    const dbFile = path.join(state, 'v2/tasks-index.sqlite');
    assert(!existsSync(dbFile), 'Run synthetic task acceptance before live runtime creates its index');
    mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    try {
      // Same schema contract as driver/test-tasks-index.mjs; this is not a runtime-created task.
      db.exec(`CREATE TABLE tasks (workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
        task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT, provider TEXT, mode TEXT NOT NULL DEFAULT 'build',
        model TEXT, migration_source TEXT, forked_from_task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        unread_at INTEGER, last_unread_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, title_overridden INTEGER NOT NULL DEFAULT 0,
        meta_json TEXT NOT NULL DEFAULT '{}', searchable_text TEXT NOT NULL DEFAULT '', cron_automation_id TEXT, off_peak_task_id TEXT,
        PRIMARY KEY (workspace_key, task_id))`);
      const id = 'sess_synthetic_helper_acceptance';
      db.prepare('INSERT INTO tasks (workspace_key,workspace_path,task_id,title,task_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(workspace, workspace, id, 'SYNTHETIC helper acceptance', 'completed', 1, 1);
      const row = () => db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id);
      assert.match(await cli(['task', 'list']), /SYNTHETIC helper acceptance/);
      await cli(['task', 'rename', id, 'SYNTHETIC renamed helper']);
      assert.equal(row().title, 'SYNTHETIC renamed helper');
      assert.equal(row().title_overridden, 1);
      await cli(['task', 'pin', 'helper_acceptance']);
      assert.equal(row().pinned, 1);
      await cli(['task', 'unpin', id]);
      assert.equal(row().pinned, 0);
      await cli(['task', 'archive', id]);
      assert.equal(row().archived, 1);
      assert.equal((await cli(['task', 'list'])).trim(), 'no tasks');
      assert.match(await cli(['task', 'list', '--all']), /\[archived\].*SYNTHETIC renamed helper/);
      await cli(['task', 'unarchive', id]);
      assert.equal(row().archived, 0);
      assert.match(await cli(['task', 'list']), /SYNTHETIC renamed helper/);
      await cli(['task', 'delete', id]);
      assert.equal(row().deleted, 1);
      assert(row().updated_at > 1);
      assert.equal((await cli(['task', 'list', '--all'])).trim(), 'no tasks');
      await failure(['task', 'pin', id], 1, /no task/);
      return { synthetic: true, runtimeTaskCreationTested: false, softDeletePersisted: true };
    } finally { db.close(); }
  });

  await check('helper models: local official catalog and exact search', async () => {
    const res = '/opt/ZCode/resources';
    // 3.12.1+: config/provider/zcode-builtin.json replaced the model-providers catalog
    let providers = [];
    try {
      const b = JSON.parse(readFileSync(path.join(res, 'config/provider/zcode-builtin.json'), 'utf8'));
      if (b?.schemaVersion === 1 && b.config?.providerConfigRules) {
        const r = b.config.providerConfigRules;
        providers = [...(r.providerRules ?? []), ...(r.templateRules ?? [])].map(p => ({
          id: p.providerId ?? p.templateId, baseURL: p.config?.api?.baseUrl ?? '',
          modelIds: [...(p.config?.builtinModelIds ?? [])],
        }));
      }
    } catch {}
    if (!providers.length) {
      const dir = path.join(res, 'model-providers');
      const names = existsSync(dir) ? readdirSync(dir).filter(n => /^models_catalog_.*\.json$/.test(n)).sort().reverse() : [];
      let catalog;
      for (const name of names) {
        try {
          const candidate = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
          if (candidate.schemaVersion === 'zcode.model-providers.v1') { catalog = candidate; break; }
        } catch {}
      }
      providers = (catalog?.providers ?? []).map(p => ({
        id: p.id, baseURL: p.endpoints?.baseURL ?? '', modelIds: (p.models ?? []).map(m => m.id),
      }));
    }
    const expected = providers.map(p => `${p.id}\t${p.modelIds.length} models\t${p.baseURL}`).join('\n');
    assert.equal((await cli(['models'])).trim(), expected.trim());
    const modelId = providers.flatMap(p => p.modelIds)[0];
    if (modelId) {
      const hits = await cli(['models', modelId]);
      assert(hits.includes(`/${modelId}\tctx `));
    }
    assert.equal((await cli(['models', 'synthetic-no-such-model-[.*]'])).trim(), '');
    return { providerCount: providers.length, localCatalogAvailable: providers.length > 0, networkCalls: 0 };
  });

  await check('helper plugins and diff: empty and missing-cache failures', async () => {
    assert(!existsSync(path.join(state, 'cli/plugins')), 'Requires an empty fixture plugin store');
    assert.equal((await cli(['plugins'])).trim(), 'no plugins tracked');
    await failure(['plugins', 'synthetic-missing'], 1, /no plugin matching/);
    await failure(['plugins', 'install'], 2, /usage:/);
    // No marketplace cache exists, so this exits before any download/install path.
    await failure(['plugins', 'install', 'synthetic-missing'], 1, /official marketplace cache not found/);
    assert(!existsSync(path.join(state, 'cli/plugins')));
    assert.equal((await cli(['diff'])).trim(), 'no sessions with file changes');
    await failure(['diff', 'synthetic-missing-session'], 1, /no change artifacts/);
    await failure(['diff', 'one', 'two'], 2, /usage:/);
    return { downloads: 0, synthetic: true };
  });
}
