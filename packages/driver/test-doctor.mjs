import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { displayPath, displayText } from './doctor.mjs';

const home = mkdtempSync(path.join(os.tmpdir(), 'zagent-doctor-'));
try {
  const runtime = path.join(home, 'runtime.cjs');
  writeFileSync(runtime, 'throw new Error("doctor must not start runtime");');
  const config = path.join(home, '.zcode/cli/config.json');
  mkdirSync(path.dirname(config), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home, ZCODE_RUNTIME: runtime, ZAI_API_KEY: 'fixture-key' };
  for (const value of ['{corrupt', 'null', '[]', '"text"', '{}', '{"model":{"main":"missing/model"},"provider":{}}',
    '{"model":{"main":"zai"},"provider":{"zai":{}}}', '{"model":{"main":"zai/model"},"provider":{"zai":[]}}']) {
    writeFileSync(config, value);
    for (const args of [['doctor'], ['doctor', '--fix']]) {
      const r = spawnSync(process.execPath, [fileURLToPath(new URL('../cli/zagent.mjs', import.meta.url)), ...args], { env, encoding: 'utf8', cwd: home });
      assert.equal(r.status, 1, `doctor must reject invalid config ${value}`);
      assert.match(r.stdout + r.stderr, /invalid config/i);
      assert.equal(readFileSync(config, 'utf8'), value, 'doctor must preserve corrupt user config');
    }
  }
  writeFileSync(config, JSON.stringify({ model: { main: 'zai/model' }, provider: { zai: { options: { apiKey: 'fixture-key' } } } }));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../cli/zagent.mjs', import.meta.url)), 'doctor'], { env, encoding: 'utf8', cwd: home });
  assert.equal(r.status, 0, 'valid object remains accepted with an environment key');
  // doctor reports environment depth — node build, credential source, config
  // path, plugin/hook/MCP counts, disk and log dir — like other harness doctor
  // commands, not three bare lines.
  assert.match(r.stdout, /^node: v\d+\.\d+\.\d+ \S+$/m, 'doctor reports the node build');
  assert.match(r.stdout, /^credential: ZAI_API_KEY \(env\)$/m, 'doctor names the env credential source');
  // paths under the user home render as ~/... — absolute home
  // paths leak the machine's directory layout on shared terminals.
  assert.ok(r.stdout.includes('config: present (~/.zcode/cli/config.json)'), 'doctor renders the config path home-relative');
  assert.match(r.stdout, /^plugins: 0 installed$/m, 'doctor counts installed plugins');
  assert.match(r.stdout, /^hooks: 0 configured$/m, 'doctor counts configured hooks');
  assert.match(r.stdout, /^mcp: 0 configured$/m, 'doctor counts MCP servers');
  assert.match(r.stdout, /^disk: [\d.]+ GB free \(~\)$/m, 'doctor reports free disk home-relative');
  assert.ok(r.stdout.includes('logs: ~/.zcode/cli/log'), 'doctor renders the log dir home-relative');
  assert.equal(r.stdout.includes(`${home}/.zcode`), false, 'doctor never prints absolute paths inside the user home');
  // counts and the config credential source must be real, not placeholders
  mkdirSync(path.join(home, '.zcode/cli/plugins/data/seeded/.zcode-plugin'), { recursive: true });
  writeFileSync(path.join(home, '.zcode/cli/plugins/data/seeded/.zcode-plugin/plugin.json'),
    JSON.stringify({ name: 'seeded', version: '1.0.0' }));
  writeFileSync(config, JSON.stringify({
    model: { main: 'zai/model' }, provider: { zai: { options: { apiKey: 'fixture-key' } } },
    hooks: { enabled: true, events: { UserPromptSubmit: [{ type: 'command', command: 'echo hi' }] } },
    mcp: { servers: { fs: { command: 'mcp-fs' }, db: { command: 'mcp-db' } } },
  }));
  const envNoKey = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ZAGENT_TEST_SANDBOX: home, ZCODE_RUNTIME: runtime };
  const r2 = spawnSync(process.execPath, [fileURLToPath(new URL('../cli/zagent.mjs', import.meta.url)), 'doctor'], { env: envNoKey, encoding: 'utf8', cwd: home });
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /^credential: cli config provider "zai"$/m, 'doctor names the config credential source');
  assert.match(r2.stdout, /^plugins: 1 installed$/m);
  assert.match(r2.stdout, /^hooks: 1 configured · 1 event$/m);
  assert.match(r2.stdout, /^mcp: 2 configured$/m);
  // a keyless config + a fallback key file: that key is only a bootstrap
  // source (ensureConfig never reads it once config.json exists) so doctor must
  // NOT claim it — and a present-but-credential-less config keeps exit 0 with a
  // warn line (the exit contract is unchanged: config presence means set up ran).
  mkdirSync(path.join(home, '.config', 'ccz'), { recursive: true });
  writeFileSync(path.join(home, '.config', 'ccz', '.api_key'), 'fallback-key');
  writeFileSync(config, JSON.stringify({ model: { main: 'zai/model' }, provider: { zai: { options: {} } } }));
  const r3 = spawnSync(process.execPath, [fileURLToPath(new URL('../cli/zagent.mjs', import.meta.url)), 'doctor'], { env: envNoKey, encoding: 'utf8', cwd: home });
  assert.equal(r3.status, 0, r3.stderr);
  assert.match(r3.stdout, /^credential: NONE$/m, 'doctor reports no credential honestly');
  assert.match(r3.stdout, /^warn: no Coding Plan credential/m, 'a credential-less config is warned, not silent');
  // with no config file at all the fallback file IS the bootstrap source
  rmSync(config);
  const r4 = spawnSync(process.execPath, [fileURLToPath(new URL('../cli/zagent.mjs', import.meta.url)), 'doctor'], { env: envNoKey, encoding: 'utf8', cwd: home });
  assert.match(r4.stdout, /^credential: ccz fallback/m, 'fallback file is claimed only when no cli config exists');
  writeFileSync(config, JSON.stringify({ model: { main: 'zai/model' }, provider: { zai: { options: { apiKey: 'fixture-key' } } } }));
  // a staged desktop update is reported read-only and never blocks a healthy verdict
  const pendingDir = path.join(home, '.cache', '@zcodedesktop-updater', 'pending');
  mkdirSync(pendingDir, { recursive: true });
  writeFileSync(path.join(pendingDir, 'update-info.json'), JSON.stringify({ fileName: 'ZCode-3.12.1-linux-x64.deb' }));
  const p = spawnSync(process.execPath, [fileURLToPath(new URL('../cli/zagent.mjs', import.meta.url)), 'doctor'], { env, encoding: 'utf8', cwd: home });
  assert.equal(p.status, 0, 'a pending desktop update stays a warning, not a failure');
  assert.match(p.stdout + p.stderr, /desktop update pending: ZCode-3\.12\.1-linux-x64\.deb/);
  // displayPath edges: a prefix-sibling is NOT under home, home='/' degrades to
  // absolute, trailing slashes normalize, non-strings never throw.
  assert.equal(displayPath(path.join(home, 'x', 'y'), home), '~/x/y');
  assert.equal(displayPath(home, home), '~');
  assert.equal(displayPath(`${home}-sibling/f`, home), `${home}-sibling/f`, 'a prefix-sibling path is not under home');
  assert.equal(displayPath('/etc/hosts', '/'), '/etc/hosts', 'home=/ keeps absolute paths');
  assert.equal(displayPath(path.join(home, 'f'), `${home}/`), '~/f', 'trailing-slash home still matches');
  assert.equal(displayPath(undefined, home), '', 'non-string input never throws');
  // displayText edges: embedded home paths relativize at a boundary, a
  // prefix-sibling is NOT rewritten, and home='/' leaves text untouched.
  assert.equal(displayText(`open ${home}/.zcode/x failed`, home), 'open ~/.zcode/x failed');
  assert.equal(displayText(`see ${home}-sibling/f`, home), `see ${home}-sibling/f`, 'displayText spares prefix-siblings');
  assert.equal(displayText('a/b/c', '/'), 'a/b/c', 'home=/ leaves text untouched');
  assert.equal(displayText(`home is ${home}`, home), 'home is ~', 'a bare trailing home still relativizes');
  assert.equal(displayText(`"root":"${home}"`, home), '"root":"~"', 'a home value quoted in JSON still relativizes');
  console.log('PASS doctor rejects malformed config without rewriting it');
} finally { rmSync(home, { recursive: true, force: true }); }
