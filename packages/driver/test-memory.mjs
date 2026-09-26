import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zmemory-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = process.env.USERPROFILE = sandbox;
try {
const { loadGlobalMemory, appendGlobalMemory, saveGlobalMemory, loadProjectMemory, saveProjectMemory, appendProjectMemory, workspaceId } = await import('./memory.mjs');
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
ok(typeof loadGlobalMemory() === 'string', 'global memory loads (string)');
ok(loadGlobalMemory().length >= 0, 'global memory non-crash on missing file');
const before = loadGlobalMemory().length;
ok(before >= 0, `global memory size ${before}`);
const pm = loadProjectMemory(path.join(os.tmpdir(), 'test-ws-memtest'));
ok(typeof pm === 'string', 'project memory loads (empty ok)');
assert.equal(loadGlobalMemory(), '');
saveGlobalMemory('first');
appendGlobalMemory('second');
assert.equal(loadGlobalMemory(), 'first\nsecond\n');

// Runtime-exact id edges + locked-write concurrency + ENOENT-only fallback
ok(workspaceId('/tmp/foo.bar').startsWith('foo.bar-'), 'dots preserved in id');
ok(workspaceId('/tmp/a/').startsWith('a-'), 'trailing slash normalized');
// win32 truth: path.resolve('/') === '\\' — hashed input differs by platform; compute
// the expected digest with the SAME resolve the driver uses.
// Driver lowercases the hash input on win32 (drive letters); mirror the exact rule.
const rootInput = process.platform === 'win32' ? path.resolve('/').toLowerCase() : path.resolve('/');
ok(workspaceId('/') === `project-${createHash('sha256').update(rootInput).digest('hex').slice(0,16)}`, 'root -> project-<hash> (platform-native, case rule mirrored)');
ok(workspaceId('/tmp/under_score').startsWith('under_score-'), 'underscore preserved');
ok(workspaceId('/tmp/' + 'x'.repeat(60)).startsWith('x'.repeat(48) + '-'), 'truncate at 48');
ok(workspaceId('/tmp/--edge--').startsWith('edge-'), 'edge hyphens trimmed');
// The synchronous API rejects lock contention; it does not promise a retry queue.
saveProjectMemory(path.join(os.tmpdir(), 'zagent-memtest'), 'roundtrip');
assert.equal(loadProjectMemory(path.join(os.tmpdir(), 'zagent-memtest')), 'roundtrip');
const wsMem = path.join(os.tmpdir(), 'zagent-memtest');
const dir = `${sandbox}/.zcode/cli/memories/projects/${workspaceId(wsMem)}/memory`;
writeFileSync(`${dir}/.lock`, 'fixture');
assert.throws(() => saveProjectMemory(path.join(os.tmpdir(), 'zagent-memtest'), 'blocked'), { code: 'EEXIST' });
assert.equal(loadProjectMemory(path.join(os.tmpdir(), 'zagent-memtest')), 'roundtrip');
rmSync(`${dir}/.lock`);
for (let i = 0; i < 5; i++) saveProjectMemory(wsMem, `w${i}`);
assert.equal(loadProjectMemory(path.join(os.tmpdir(), 'zagent-memtest')), 'w4');
assert.deepEqual(readdirSync(dir), ['MEMORY.md']);
rmSync(`${dir}/MEMORY.md`);
writeFileSync(path.join(dir, '..', 'MEMORY.md'), 'fallback');
assert.equal(loadProjectMemory(path.join(os.tmpdir(), 'zagent-memtest')), 'fallback');
mkdirSync(`${dir}/MEMORY.md`);
assert.throws(() => loadProjectMemory(path.join(os.tmpdir(), 'zagent-memtest')), { code: 'EISDIR' });

const appendWorkspace = path.join(sandbox, 'append-workspace');
mkdirSync(appendWorkspace);
appendProjectMemory(appendWorkspace, 'initial');
assert.equal(loadProjectMemory(appendWorkspace), '# Memory Index\n- initial\n');
// Delay each successful memory read to expose stale snapshots across real CLI
// processes. With the read inside the lock, every successful append is retained.
const preload = path.join(sandbox, 'slow-memory-read.mjs');
writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
fs.readFileSync = (...args) => {
  const value = read(...args);
  if (String(args[0]).endsWith('/MEMORY.md')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  return value;
};
syncBuiltinESMExports();
`);
const cli = fileURLToPath(new URL('../cli/zagent-memory.mjs', import.meta.url));
const appends = await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'append', `parallel-${i}`], {
    cwd: appendWorkspace,
    timeout: 10000,
    env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox, ZAGENT_TEST_SANDBOX: sandbox, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject); child.on('close', status => resolve({ i, status, stderr }));
})));
assert.ok(appends.every(a => a.status === 0), JSON.stringify(appends));
const lines = loadProjectMemory(appendWorkspace).trim().split('\n').slice(1);
assert.equal(lines.length, 13);
for (const { i } of appends) assert.ok(lines.includes(`- parallel-${i}`));
ok(true, '12 concurrent successful CLI appends retain every line');
assert.deepEqual(readdirSync(`${sandbox}/.zcode/cli/memories/projects/${workspaceId(appendWorkspace)}/memory`), ['MEMORY.md']);
console.log(fails ? `FAIL (${fails})` : 'PASS memory');
process.exitCode = fails ? 1 : 0;
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
}
