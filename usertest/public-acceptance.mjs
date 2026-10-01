#!/usr/bin/env node
// Explicitly authorized live acceptance of the installed npm payload, not a human interview.
// Opt-in only (--live): it spends the operator's OWN Z.AI credentials from ~/.zcode/cli/config.json
// on real model calls inside an isolated profile. Never run by CI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyHelpers } from './public-helpers.mjs';
import { defaultCredentialSecret, decryptCredential } from '../packages/driver/credentials.mjs';
import { installationPaths } from '../scripts/verify-public-package.mjs';

if (!process.argv.includes('--live')) {
  console.error('Requires --live: uses existing Z.AI credentials for real model calls in an isolated profile.');
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const originalConfig = path.join(os.homedir(), '.zcode/cli/config.json');
const originalBytes = readFileSync(originalConfig);
let source;
try { source = JSON.parse(originalBytes); } catch { throw new Error('Existing account config is not valid JSON; no content logged.'); }
const provider = source.provider?.zai;
const model = {};
for (const key of ['main', 'lite']) {
  const id = source.model?.[key];
  if (key === 'lite' && id === undefined) continue;
  assert(['zai/glm-5.3', 'zai/glm-5.3-flash'].includes(id), 'Acceptance requires an explicitly supported Z.AI model');
  model[key] = id;
}
assert(provider?.options?.apiKey, 'Existing zai credentials required; never enter them in logs.');
if (!['https://api.z.ai/api/anthropic', 'https://api.z.ai/api/anthropic/'].includes(provider.options.baseURL))
  throw new Error('Acceptance requires the canonical official provider endpoint; no input logged.');
const runtime = process.env.ZCODE_RUNTIME || path.join(os.homedir(), '.local/opt/zcode-app-cli/node_modules/zcode-app-cli/bin/zcode.js');
assert(existsSync(runtime), 'Separately installed runtime required.');
const fixture = mkdtempSync(path.join(os.tmpdir(), 'zagent-live-acceptance-'));
const home = path.join(fixture, 'home');
const workspace = path.join(fixture, 'project');
mkdirSync(home); mkdirSync(workspace);
const config = path.join(home, '.zcode/cli/config.json');
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
  TMPDIR: fixture, TMP: fixture, TEMP: fixture, XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
  TERM: 'xterm-256color', LANG: 'C.UTF-8', ZCODE_RUNTIME: runtime,
  ZAGENT_ACCEPTANCE_RUN: path.basename(fixture),
  npm_config_cache: path.join(fixture, 'npm-cache'), npm_config_userconfig: path.join(fixture, 'no-npmrc'),
  npm_config_registry: 'https://registry.npmjs.org/' };
const results = [];
const protectedFiles = new Map([[originalConfig, originalBytes]]);
for (const suffix of ['.zcode/v2/credentials.json', '.zcode/cli/device.json']) {
  const file = path.join(os.homedir(), suffix);
  try { protectedFiles.set(file, readFileSync(file)); }
  catch { protectedFiles.set(file, null); }
}
const secrets = [provider.options.apiKey];
const active = new Set();
function taggedProcesses() {
  const tag = Buffer.from(`ZAGENT_ACCEPTANCE_RUN=${env.ZAGENT_ACCEPTANCE_RUN}\0`);
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number).filter(pid => {
    try { return readFileSync(`/proc/${pid}/environ`).includes(tag); } catch { return false; }
  });
}
const cleanup = () => {
  for (const pid of active) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  // script/TTY launchers can create new sessions outside the initial process group.
  for (const pid of taggedProcesses()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  rmSync(fixture, { recursive: true, force: true });
};
process.on('exit', cleanup);
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));
const redact = text => {
  let value = String(text);
  for (const secret of secrets.filter(Boolean)) value = value.split(secret).join('[REDACTED]');
  return value.split(fixture).join('[FIXTURE]').split(os.homedir()).join('[HOME]');
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function snapshot(dir = workspace, prefix = '') {
  const files = {};
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, item.name), absolute = path.join(dir, item.name);
    if (item.isDirectory()) Object.assign(files, snapshot(absolute, relative));
    else files[relative] = digest(readFileSync(absolute));
  }
  return files;
}
function run(command, args, { cwd = workspace, timeout = 180000, input, onData } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (child.pid) active.add(child.pid);
    let stdout = '', stderr = '', expired = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { expired = true; kill(); }, timeout);
    child.stdin.on('error', () => {});
    child.stdout.on('data', d => {
      stdout = (stdout + d).slice(-8 * 1024 * 1024);
      try { onData?.(stdout, child); } catch (e) { kill(); reject(e); }
    });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-1024 * 1024); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); kill(); active.delete(child.pid); resolve({ code, stdout, stderr, expired }); });
    if (input) child.stdin.end(input);
  });
}
let entry;
async function cli(args, expected = 0, options) {
  const r = await run(entry, args, options);
  assert(!r.expired, `timeout: ${args[0]}`);
  assert.equal(r.code, expected, redact(`${args[0]} rc=${r.code}: ${r.stderr.slice(-1200)} ${r.stdout.slice(-1200)}`));
  return r.stdout;
}
async function check(name, fn) {
  if (process.argv.includes('--pty-only') && /^(live |session )/.test(name)) {
    console.log(JSON.stringify({ event: 'skip', name, reason: 'targeted PTY diagnostic' })); return;
  }
  const start = Date.now();
  console.log(JSON.stringify({ event: 'start', name }));
  try { const detail = await fn(); results.push({ name, pass: true, elapsedMs: Date.now() - start, detail }); }
  catch (error) { results.push({ name, pass: false, elapsedMs: Date.now() - start, error: redact(error.message) }); }
  console.log(JSON.stringify(results.at(-1)));
}
async function prompt(text, extra = []) {
  const j = JSON.parse(await cli(['-p', text, '--json', ...extra]));
  assert(!j.error && !j.isError, 'Runtime error envelope');
  assert.equal(typeof j.response, 'string', 'JSON must contain assistant response');
  return j;
}
try {
  const packed = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', fixture], { cwd: root });
  assert.equal(packed.code, 0, 'npm pack failed');
  const [metadata] = JSON.parse(packed.stdout);
  const archive = path.join(fixture, metadata.filename);
  const install = await run('npm', ['install', '--global', '--prefix', path.join(fixture, 'install'), '--ignore-scripts', '--no-audit', '--no-fund', archive]);
  assert.equal(install.code, 0, 'Isolated package installation failed');
  const { bins } = installationPaths(path.join(fixture, 'install'), pkg);
  assert(bins.zagent && bins.za, 'Manifest must install zagent and za');
  entry = bins.zagent;
  console.log(JSON.stringify({ event: 'provenance', sha256: digest(readFileSync(archive)), version: metadata.version,
    runtimeVersion: JSON.parse(readFileSync(path.resolve(runtime, '../../package.json'))).version,
    model, liveModelCalls: true, simulatedUser: true, osSandbox: false }));
  await check('fresh install: aliases and missing credentials', async () => {
    assert.equal((await cli(['--version'])).trim().split('\n')[0], `zagent ${metadata.version}`);
    for (const aliasPath of Object.values(bins)) {
      const alias = await run(aliasPath, ['--version']);
      assert.equal(alias.code, 0);
      assert.equal(alias.stdout.trim().split('\n')[0], `zagent ${metadata.version}`);
    }
    assert.match(await cli(['--help']), /headless/);
    assert.match(await cli(['doctor'], 1), /NO CODING-PLAN CREDENTIAL/);
    assert(!existsSync(config));
  });
  if (!process.argv.includes('--pty-only')) {
    const helperHome = path.join(fixture, 'helper-home');
    const helperWorkspace = path.join(fixture, 'helper-project');
    mkdirSync(helperHome); mkdirSync(helperWorkspace);
    const saved = { ...env };
    Object.assign(env, { HOME: helperHome, USERPROFILE: helperHome,
      XDG_CONFIG_HOME: path.join(helperHome, '.config'), XDG_CACHE_HOME: path.join(helperHome, '.cache'),
      XDG_DATA_HOME: path.join(helperHome, '.local/share') });
    try {
      const helperRun = (command, args, options = {}) => run(command, args, { ...options, cwd: helperWorkspace });
      await verifyHelpers({ home: helperHome, workspace: helperWorkspace, entry, check, run: helperRun,
        cli: (args, expected = 0, options = {}) => cli(args, expected, { ...options, cwd: helperWorkspace }) });
    } finally { Object.assign(env, saved); }
  }
  env.ZAI_API_KEY = provider.options.apiKey;
  await check('doctor fix: creates private persistent configuration', async () => {
    assert.match(await cli(['doctor', '--fix']), /config created/);
    assert.equal(statSync(config).mode & 0o777, 0o600);
    const before = readFileSync(config);
    await cli(['doctor', '--fix']);
    assert.deepEqual(readFileSync(config), before);
  });
  delete env.ZAI_API_KEY;
  // Copy only the chosen provider/model; no plugins, hooks, paths, sessions or storage pointers.
  const safeProvider = { kind: 'anthropic', name: 'Z.AI Coding Plan',
    options: { apiKeyRequired: true, apiKey: provider.options.apiKey, baseURL: 'https://api.z.ai/api/anthropic' },
    models: { 'glm-5.3': { name: 'GLM-5.3' }, 'glm-5.3-flash': { name: 'GLM-5.3-Flash' } } };
  writeFileSync(config, JSON.stringify({ provider: { zai: safeProvider }, model,
    plugins: { enabled: false }, hooks: { enabled: false }, mcp: { servers: {} },
    skills: { enabled: false }, memory: { use: false, write: false } }), { mode: 0o600 });
  const seeded = readFileSync(config);
  await check('live JSON arithmetic: exact assistant answer', async () => {
    const j = await prompt('Compute 683 + 914. Reply with only the decimal integer, no tools.');
    assert.equal(j.response.trim(), '1597');
    return { response: j.response.trim() };
  });
  await check('live onboard: user-facing setup chain', async () => {
    assert.match(await cli(['onboard']), /smoke turn answered OK/);
  });
  const nonce = randomBytes(8).toString('hex');
  await check('session creation and fresh-process continuation', async () => {
    const stored = await prompt(`Remember this verification code for the next message: ${nonce}. Reply only STORED. Do not write any file.`);
    assert.equal(stored.response.trim(), 'STORED');
    const sessionId = stored.sessionId ?? stored.session?.sessionId;
    assert.equal(typeof sessionId, 'string', `Must identify the created session; envelope keys: ${Object.keys(stored).join(',')}`);
    const j = await prompt('What verification code did I ask you to remember? Reply only that code. Do not use tools.', ['--continue']);
    assert.equal(j.response.trim(), nonce);
    const resumed = await prompt('What verification code did I ask you to remember? Reply only that code. Do not use tools.', ['--resume', sessionId]);
    assert.equal(resumed.response.trim(), nonce);
    assert((await cli(['sessions'])).includes(sessionId.slice(5, 13)), 'Session panel must include this specific session');
    return { rememberedRandomCode: true, explicitResume: true };
  });
  writeFileSync(path.join(workspace, 'calc.py'), 'def add(a, b):\n    return a - b\n');
  const testSource = 'from calc import add\nassert add(2, 3) == 5\nassert add(-4, 7) == 3\nassert add(0, 0) == 0\nprint("CALC_TESTS_PASS")\n';
  writeFileSync(path.join(workspace, 'test_calc.py'), testSource);
  await check('live file reading: identifies actual bug without modifying file', async () => {
    const before = snapshot();
    const j = await prompt('Read calc.py. Explain the bug in one sentence. Do not modify any file.');
    assert.match(j.response, /subtract|a\s*-\s*b|minus/i);
    assert.deepEqual(snapshot(), before);
  });
  await check('live coding: fixes file and independently passes tests', async () => {
    const before = await run('python3', ['test_calc.py']);
    assert.notEqual(before.code, 0, 'Fixture must fail before coding');
    const filesBefore = snapshot();
    await prompt('Fix the bug in calc.py so add returns the sum. Only edit calc.py. Do not edit test_calc.py. Run python3 test_calc.py to verify.', ['--force']);
    const filesAfter = snapshot();
    delete filesBefore['calc.py']; delete filesAfter['calc.py'];
    // Python itself regenerates bytecode while the runtime runs the requested tests.
    for (const files of [filesBefore, filesAfter]) for (const name of Object.keys(files))
      if (name.startsWith('__pycache__/')) delete files[name];
    assert.deepEqual(filesAfter, filesBefore, 'Only calc.py and Python bytecode may change');
    const after = await run('python3', ['test_calc.py']);
    assert.equal(after.code, 0, 'Independent Python test must pass');
    assert.match(after.stdout, /CALC_TESTS_PASS/);
    assert.equal(readFileSync(path.join(workspace, 'test_calc.py'), 'utf8'), testSource);
  });
  await check('interactive PTY: rendered answer and Ctrl-C exit', async () => {
    let sent = false, answered = false, quit = false;
    const quotedEntry = "'" + entry.replaceAll("'", "'\\''") + "'";
    const r = await run('script', ['-qefc', `stty cols 120 rows 40; timeout --foreground -k 3 120 ${quotedEntry}`, '/dev/null'], {
      timeout: 130000,
      onData: (output, child) => {
        const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        if (!sent && /Ask a task/i.test(text)) { sent = true; child.stdin.write('Compute 721 plus 862. Reply only the decimal integer.\r'); }
        if (sent && /1583/.test(text) && !quit) {
          answered = true; quit = true; child.stdin.write('\x03');
          setTimeout(() => { if (!child.stdin.destroyed) child.stdin.write('\x03'); }, 1200);
        }
      },
    });
    const logFile = path.join(home, '.zcode/cli/tui-runtime.log');
    const diagnostics = existsSync(logFile) ? readFileSync(logFile, 'utf8').slice(-3000) : '';
    assert(sent, redact(`TUI prompt did not render; stderr: ${r.stderr.slice(-1000)}; tail: ${r.stdout.slice(-3000)}; diagnostics: ${diagnostics}`));
    assert(answered, redact(`TUI did not render computed answer; tail: ${r.stdout.slice(-1800)}`));
    assert(!r.expired && [0, 130].includes(r.code), `Ctrl-C must exit cleanly, got ${r.code}`);
    return { answer: '1583', exitCode: r.code };
  });
  await check('configuration persistence after real runtime sessions', async () => {
    const after = JSON.parse(readFileSync(config));
    assert.deepEqual(after, JSON.parse(seeded));
    assert.equal(statSync(config).mode & 0o777, 0o600);
  });
  if (!process.argv.includes('--pty-only')) {
    await check('quota credential isolation: selected encrypted credentials only', async () => {
      const storePath = path.join(os.homedir(), '.zcode/v2/credentials.json');
      const devicePath = path.join(os.homedir(), '.zcode/cli/device.json');
      assert(protectedFiles.get(storePath) && protectedFiles.get(devicePath), 'Existing quota credential files required');
      let store, device;
      try { store = JSON.parse(protectedFiles.get(storePath)); device = JSON.parse(protectedFiles.get(devicePath)); }
      catch { throw new Error('Quota credential files are not valid JSON; contents withheld'); }
      assert(typeof device.deviceMid === 'string' && device.deviceMid.length > 0, 'Device identity required');
      secrets.push(device.deviceMid);
      const selected = {};
      for (const field of ['zcodejwttoken', 'oauth:zai:access_token']) {
        assert(typeof store[field] === 'string' && store[field].length > 0, 'Required quota credential missing');
        selected[field] = store[field];
        secrets.push(store[field], decryptCredential(store[field]));
      }
      mkdirSync(path.join(home, '.zcode/v2'), { recursive: true });
      writeFileSync(path.join(home, '.zcode/v2/credentials.json'), JSON.stringify(selected), { mode: 0o600 });
      const credentialSecret = defaultCredentialSecret();
      secrets.push(credentialSecret);
      env.ZCODE_CREDENTIAL_SECRET = credentialSecret;
      env.ZCODE_DEVICE_MID = device.deviceMid;
    });
    for (const endpoint of ['balance', 'preview', 'reset']) {
      await check(`quota live ${endpoint}: successful HTTP and application envelope`, async () => {
        const j = JSON.parse(await cli(['quota', endpoint, '--json']));
        assert.equal(j.http, 200, 'Quota HTTP status');
        assert.equal(j.code, 0, 'Quota application success code');
        assert(j.data && typeof j.data === 'object', 'Quota data must be present');
        return { http: j.http, code: j.code, billingValuesWithheld: true };
      });
    }
    delete env.ZCODE_CREDENTIAL_SECRET; delete env.ZCODE_DEVICE_MID;
  }
  await check('corrupt configuration: doctor rejects it', async () => {
    const before = readFileSync(config);
    try { writeFileSync(config, '{corrupt'); await cli(['doctor'], 1); }
    finally { writeFileSync(config, before); }
  });
} finally {
  const unchanged = [...protectedFiles].every(([p, bytes]) => {
    if (bytes === null) return !existsSync(p);
    try { return readFileSync(p).equals(bytes); } catch { return false; }
  });
  const remainingProcesses = taggedProcesses().length;
  cleanup();
  console.log(JSON.stringify({ event: 'summary', passed: results.filter(r => r.pass).length,
    failed: results.filter(r => !r.pass).length, originalConfigUnchanged: unchanged,
    fixtureRemoved: !existsSync(fixture), remainingProcessesBeforeCleanup: remainingProcesses,
    humanInterview: false, results }));
  if (!unchanged || remainingProcesses || results.some(r => !r.pass)) process.exitCode = 1;
}
