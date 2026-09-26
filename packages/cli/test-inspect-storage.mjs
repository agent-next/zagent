#!/usr/bin/env node
// `zagent inspect --storage` mirrors the official 3.12.1 resource manager's
// category map over ~/.zcode (read-only; no clean). Seeded HOME fixture checks
// the classifier order: file patterns first, then longest directory prefix.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { displayPath } from '../driver/doctor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'packages/cli/zagent-inspect.mjs');

const home = mkdtempSync(path.join(os.tmpdir(), 'zagent-storage-'));
const seed = (rel, bytes) => {
  const p = path.join(home, '.zcode', rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, Buffer.alloc(bytes));
};
seed('cli/agents/run1/task2/transcript.jsonl', 100);   // file pattern -> subagentTranscripts
seed('cli/agents/run1/task2/output.bin', 50);          // dir prefix -> toolOutputs
seed('v2/main.sqlite', 200);                           // sessionStore
seed('v2/main.sqlite-wal', 20);                        // sessionStore
seed('cli/db/db.sqlite', 300);                         // sessionStore
seed('cli/db/db.sqlite.bak-1', 30);                    // backups (file pattern, not sessionStore dir)
seed('v2/checkpoints/ws1/pending/blob.bin', 40);       // toolOutputs (pending|tmp override)
seed('v2/checkpoints/ws1/tmp/blob2.bin', 41);          // toolOutputs (tmp variant)
seed('v2/checkpoints/ws1/done.bin', 60);               // sessionStore (v2/checkpoints dir)
seed('cli/config.json', 10);                           // config
seed('cli/config.json.bak-x', 5);                      // backups
seed('v2/setting.json', 8);                            // config (v2/*.json)
seed('agents/deploy.md', 7);                           // config (agents/*.md beats runtimes dir)
seed('agents/bundled.bin', 9);                         // runtimes (agents dir)
seed('cli/plugins/plg/x.js', 11);                      // runtimes
seed('cli/log/app.log', 12);                           // logs
seed('feedback/logs/f.log', 13);                       // logs (longer prefix beats exports/feedback)
seed('feedback/form.json', 14);                        // exports
seed('cli/rollout/r.bin', 15);                         // modelTrajectory
seed('v2/dev/trace', 16);                              // devTraces
seed('v2/coding-plan-cache.json', 17);                 // toolOutputs
seed('misc/random.bin', 18);                           // other
seed('agent/stray.bin', 19);                           // other (top-level agent/ excluded)
mkdirSync(path.join(home, '.zcode', 'v2', 'sessions'), { recursive: true });
symlinkSync(path.join(home, '.zcode', 'misc'), path.join(home, '.zcode', 'v2', 'sessions', 'loop'), 'junction');
symlinkSync(path.join(home, '.zcode', 'misc', 'random.bin'), path.join(home, '.zcode', 'v2', 'sessions', 'linked.bin'));
seed('v2/sessions/s1.bin', 21);                        // sessionStore; symlinked dir/file must not be walked/counted

const run = (args) => spawnSync(process.execPath, [script, ...args], {
  encoding: 'utf8', timeout: 20000,
  env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, LANG: 'C' },
});

const r = run(['--storage', '--json']);
assert.equal(r.error, undefined, r.error?.message);
assert.equal(r.status, 0, `expected exit 0, stderr: ${r.stderr}`);
const report = JSON.parse(r.stdout);
assert.equal(report.root, '~/.zcode', 'storage root renders home-relative');
const byId = Object.fromEntries(report.categories.map(c => [c.id, c]));
const expect = { sessionStore: 200 + 20 + 300 + 60 + 21, subagentTranscripts: 100,
  toolOutputs: 50 + 40 + 41 + 17, backups: 30 + 5, config: 10 + 8 + 7, runtimes: 9 + 11,
  logs: 12 + 13, exports: 14, modelTrajectory: 15, devTraces: 16, other: 18 + 19 };
for (const [id, bytes] of Object.entries(expect)) {
  assert.equal(byId[id]?.bytes, bytes, `category ${id}: got ${byId[id]?.bytes}, want ${bytes}`);
}
const sum = report.categories.reduce((a, c) => a + c.bytes, 0);
assert.equal(report.totalBytes, sum);
assert.equal(report.totalBytes, Object.values(expect).reduce((a, b) => a + b, 0));
assert.equal(report.totalFiles, report.categories.reduce((a, c) => a + c.files, 0));
assert.equal(byId.sessionStore.files, 5, 'sessionStore: sqlite x2, wal, db.sqlite, checkpoints done.bin, sessions s1.bin — linked.bin must be skipped');
assert.ok(report.categories.every(c => c.files > 0), 'empty categories must be filtered');

// Human output: same numbers, readable units, no JSON.
const r2 = run(['--storage']);
assert.equal(r2.status, 0, `expected exit 0, stderr: ${r2.stderr}`);
assert.ok(r2.stdout.includes('sessionStore'), 'human output must name categories');
assert.ok(!r2.stdout.trimStart().startsWith('{'), 'human output must not be JSON');

// A home with no .zcode still reports cleanly.
const empty = mkdtempSync(path.join(os.tmpdir(), 'zagent-storage-empty-'));
const r3 = spawnSync(process.execPath, [script, '--storage', '--json'], {
  encoding: 'utf8', timeout: 20000,
  env: { PATH: process.env.PATH, HOME: empty, USERPROFILE: empty, LANG: 'C' },
});
assert.equal(r3.status, 0, `expected exit 0, stderr: ${r3.stderr}`);
assert.equal(JSON.parse(r3.stdout).totalBytes, 0);

// ZCODE_DATA_BASE_DIR replaces HOME, then /.zcode is appended (kernel rule).
const r4 = spawnSync(process.execPath, [script, '--storage', '--json'], {
  encoding: 'utf8', timeout: 20000,
  env: { PATH: process.env.PATH, HOME: empty, USERPROFILE: empty, LANG: 'C',
    ZCODE_DATA_BASE_DIR: home },
});
assert.equal(r4.status, 0, `expected exit 0, stderr: ${r4.stderr}`);
const r4Report = JSON.parse(r4.stdout);
// the child prints root through displayPath: realpath-resolved (macOS /var
// -> /private/var) and forward-slashed (win32) since it is outside HOME
assert.equal(r4Report.root, displayPath(path.join(home, '.zcode'), empty));
assert.equal(r4Report.totalBytes, report.totalBytes);

console.log('ok - inspect --storage classifies ~/.zcode like the 3.12.1 resource manager');
process.exit(0);
