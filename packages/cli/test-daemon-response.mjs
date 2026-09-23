// Exercise the actual command entrypoints with an offline socket adapter. The
// adapter replaces only net.connect; all requests/responses still cross the CLI's
// serialization and exit-code paths in separate Node processes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zdaemon-response-'));
try {
  const temp = path.join(sandbox, 'tmp');
  mkdirSync(temp);
  const adapter = path.join(sandbox, 'socket.mjs');
  writeFileSync(adapter, `import net from 'node:net';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
net.connect = () => {
  const socket = new EventEmitter();
  socket.setEncoding = () => socket;
  socket.destroy = () => {};
  socket.write = line => {
    const request = JSON.parse(line);
    if (!request.cwd || (request.op !== 'compact' && request.prompt !== 'fixture prompt')) throw new Error('unexpected daemon request');
    queueMicrotask(() => { socket.emit('data', process.env.ZAGENT_DAEMON_TEST_RESPONSE + '\\n'); socket.emit('end'); });
  };
  queueMicrotask(() => socket.emit('connect'));
  return socket;
};
syncBuiltinESMExports();
`);
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { HOME: sandbox, USERPROFILE: sandbox, TMPDIR: temp, TMP: temp, TEMP: temp,
    ZAGENT_TEST_SANDBOX: sandbox, NODE_OPTIONS: `--import=${path.join(root, 'scripts/offline-test-preload.mjs')}`,
  });
  for (const [script, args] of [['zagentd.mjs', ['ask', 'fixture prompt']], ['zagentd-compact.mjs', []]]) {
    for (const [response, exit] of [['{"answer":"你好"}', 0], ['{"error":"workspace busy; retry after the active request completes"}', 1], ['null', 1], ['broken JSON', 1]]) {
      const child = spawnSync(process.execPath, ['--import', adapter, path.join(root, 'packages/cli', script), ...args], {
        cwd: root, env: { ...env, ZAGENT_DAEMON_TEST_RESPONSE: response }, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(child.status, exit, `${script}: ${response}\n${child.stderr}`);
      if (response.startsWith('{')) assert.deepEqual(JSON.parse(child.stdout), JSON.parse(response));
      else assert.match(child.stderr, /unparseable daemon response/);
    }
  }
  console.log('PASS daemon ask/compact response exit codes: success, structured error, null, malformed JSON');
} finally { rmSync(sandbox, { recursive: true, force: true }); }
