#!/usr/bin/env node
// Linux installed-package comparison. Default invocation plans only; --live opts in.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS, buildMatrix, extractResponse, classifyRun, summarize } from './paired-core.mjs';
import { killChild } from './proc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = file => JSON.parse(readFileSync(file, 'utf8'));

export function isolatedEnv(home, temp) {
  return { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: home, USERPROFILE: home,
    TMPDIR: temp, TMP: temp, TEMP: temp, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CLAUDE_CODE_SAFE_MODE: '1',
    npm_config_cache: path.join(temp, 'npm-cache'),
    npm_config_userconfig: path.join(temp, 'absent-npmrc'),
    npm_config_registry: 'https://registry.npmjs.org/' };
}

export async function runProcess(command, args, { cwd, env, timeoutMs = 300000, maxBytes = 8e6 } = {}) {
  const start = performance.now();
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', timedOut = false, overflow = false, failed = false;
    const kill = () => killChild(child);
    const timer = setTimeout(() => {
      timedOut = true; kill();
      if (env?.ZCODE_PAIRED_RUN) killTagged(env.ZCODE_PAIRED_RUN);
    }, timeoutMs);
    const collect = (stream, data) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(data) > maxBytes) {
        overflow = true; kill(); return;
      }
      if (stream === 'stdout') stdout += data; else stderr += data;
    };
    child.stdout.on('data', d => collect('stdout', d));
    child.stderr.on('data', d => collect('stderr', d));
    child.on('error', () => { failed = true; });
    child.on('close', (status, signal) => {
      clearTimeout(timer); kill();
      resolve({ status: failed || overflow ? 1 : status, signal, timedOut, stdout, stderr,
        wallMs: Math.round(performance.now() - start) });
    });
  });
}

function taskFiles(task) {
  const dir = path.join(ROOT, 'bench/tasks', task);
  return readdirSync(dir).sort().filter(name => name === 'task.md' || name === 'agent_graded' || name.endsWith('.py'))
    .map(name => {
      const file = path.join(dir, name);
      assert(lstatSync(file).isFile(), 'task inputs must be regular files');
      return { name, bytes: readFileSync(file) };
    });
}

export function plan(repeats = 3, model = 'glm-5.3') {
  assert(['glm-5.3', 'glm-5.3-flash'].includes(model), 'unsupported benchmark model');
  const pkg = readJSON(path.join(ROOT, 'package.json'));
  const matrix = buildMatrix(repeats);
  const inputs = Object.fromEntries(TASKS.map(task => [task,
    Object.fromEntries(taskFiles(task).map(f => [f.name, hash(f.bytes)]))]));
  return { package: pkg.name, version: pkg.version, model, expectedCells: matrix.length,
    modelCalls: false, timing: 'full client process wall time including internal retries',
    osSandbox: false, tokenComparability: 'unknown; native numeric usage only, no cost equivalence',
    billing: { route: 'same canonical Z.AI Anthropic API endpoint and selected credential for both clients',
      accountPlan: 'same GLM Coding Plan account for both clients',
      freeTokenEntitlement: 'unverified', actualCharge: null, accountQuotaDelta: null,
      warning: 'Official ZCode product promotions are not assumed to apply to this API route.' },
    inputs, matrix };
}

export function nativeUsage(stdout) {
  let j; try { j = JSON.parse(stdout); } catch { return null; }
  const usage = j?.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const allowed = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  const result = Object.fromEntries(allowed.filter(k => Number.isFinite(usage[k]) && usage[k] >= 0).map(k => [k, usage[k]]));
  return Object.keys(result).length ? result : null;
}

export function finalizeSummary(records, expectedCells, {
  stopReason = null,
  protectedUnchanged = false,
  fixtureRemoved = false,
  unexpectedChildren = 0,
} = {}) {
  const core = summarize(records, expectedCells);
  const summary = { ...core, stopReason, protectedUnchanged, fixtureRemoved, unexpectedChildren };
  const correctnessOnly = records.every(record => !record?.failureCategory || record.failureCategory === 'incorrect');
  summary.measurementValid = core.complete && correctnessOnly && protectedUnchanged === true && fixtureRemoved === true && unexpectedChildren === 0;
  summary.acceptancePassed = summary.measurementValid && core.allPassed;
  return summary;
}

export function writeReport(manifest, records, summary) {
  const show = value => value === null || value === undefined ? 'unknown' : String(value);
  const rows = records.map(r => `| ${r.index} | ${r.task} | ${r.repeat} | ${r.lane} | ${r.pass ? 'PASS' : r.failureCategory} | ${r.wallMs} | ${r.usage ? JSON.stringify(r.usage) : 'unknown'} |`);
  return [
    '# Installed ZCode CLI versus Claude Code benchmark', '',
    `Model: ${manifest.model}. Source: ${manifest.sourceCommit}. Package: ${manifest.package}@${manifest.version}.`,
    `Tarball SHA-256: ${manifest.tarballSha256}.`,
    `Observed: ${records.length}/${manifest.expectedCells}. Measurement valid: ${summary.measurementValid}. Acceptance passed: ${summary.acceptancePassed}.`,
    `Stop reason: ${show(summary.stopReason)}. Original account files unchanged: ${summary.protectedUnchanged}.`, '',
    'This compares two clients on the same GLM Coding Plan credential and canonical API route.',
    'Wall time includes client boot and internal retries, excludes installation and grading. Cells run serially with alternating lane order.',
    'Both clients have fresh local profiles per cell; provider-side cache warmth is not controlled. Client prompts and internal retry policies differ.',
    'Task oracles are withheld from the task directory, not isolated by an OS security sandbox.', '',
    '## Per-cell detail', '',
    '| Index | Task | Repeat | Client | Result | Full wall ms | Native token fields |',
    '| --- | --- | --- | --- | --- | --- | --- |', ...rows, '',
    '## Aggregation and coverage', '', '```json', JSON.stringify(summary, null, 2), '```', '',
    '## Credits, free quota, and billing', '',
    'Native usage fields are not assumed to have identical input/cache semantics. Missing usage is unknown, never zero.',
    'No model or tool-call count is inferred from a successful answer. Main/lite model routing is configured explicitly; observed-model identity may be unavailable.',
    'Actual account quota delta, charges and free-token entitlement are unverified in this runner. Do not equate token count with credits or USD.',
    'The documented Flash campaign distinguishes official ZCode from other supported agents; matching account credentials does not prove matching campaign eligibility.',
    'See docs/benchmarks/PAIRED-RELEASE.md for the dated official credit formula, campaign conditions and remaining evidence requirements.', '',
  ].join('\n');
}

export async function gradeTask({ files, workspace, grade, response, env }) {
  mkdirSync(grade);
  const oracle = files.find(f => f.name === 'test.py');
  assert(oracle, 'missing test oracle');
  for (const file of files.filter(f => f.name.endsWith('.py') && f.name !== 'test.py')) {
    let bytes = file.bytes;
    if (files.some(f => f.name === 'agent_graded')) {
      const candidate = path.join(workspace, file.name);
      if (!existsSync(candidate) || !lstatSync(candidate).isFile()) return false;
      bytes = readFileSync(candidate);
    }
    writeFileSync(path.join(grade, file.name), bytes);
  }
  if (!files.some(f => f.name === 'agent_graded')) writeFileSync(path.join(grade, 'solution.py'), response);
  writeFileSync(path.join(grade, 'test.py'), oracle.bytes);
  const result = await runProcess('python3', ['-B', 'test.py'], { cwd: grade, env, timeoutMs: 30000 });
  return result.status === 0 && !result.timedOut;
}

function taggedPids(tag) {
  const needle = Buffer.from(`ZCODE_PAIRED_RUN=${tag}\0`);
  return readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(Number).filter(pid => {
    try { return readFileSync(`/proc/${pid}/environ`).includes(needle); } catch { return false; }
  });
}
function killTagged(tag) {
  const pids = taggedPids(tag);
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  return pids.length;
}

async function live(options) {
  assert(options.acknowledgeHostAccess, 'live requires --acknowledge-host-access; profiles are not an OS sandbox');
  assert(process.platform === 'linux', 'live paired runner currently supports Linux only');
  assert(options.output && path.isAbsolute(options.output), '--output must be an absolute NEW directory');
  assert(!existsSync(options.output), 'output already exists; never overwrite or reuse receipts');
  const protocol = plan(options.repeats, options.model);
  const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const state = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  assert(sourceCommit.status === 0 && state.status === 0 && !state.stdout.trim(), 'live requires a clean committed checkout');
  const configPath = path.join(os.homedir(), '.zcode/cli/config.json');
  const config = readJSON(configPath);
  const provider = config.provider?.zai;
  assert(['https://api.z.ai/api/anthropic', 'https://api.z.ai/api/anthropic/'].includes(provider?.options?.baseURL), 'canonical provider required');
  const key = provider.options.apiKey;
  assert(typeof key === 'string' && key.length > 0 && !key.startsWith('enc:'), 'plaintext selected provider credential required; value withheld');
  assert(options.runtime && path.isAbsolute(options.runtime) && existsSync(options.runtime), '--runtime must identify an installed entry file');
  assert(options.claudeCode && path.isAbsolute(options.claudeCode) && existsSync(options.claudeCode), '--claude-code must identify the reviewed Claude Code executable or wrapper');
  // Optional pin: a wrapper decides the route and flags of the reference lane, so a reviewed one can be hash-locked.
  if (options.claudeCodeSha256) assert(hash(readFileSync(options.claudeCode)) === options.claudeCodeSha256, 'Claude Code wrapper changed; review its route and flags before updating the pin');
  const protectedFiles = [configPath, path.join(os.homedir(), '.zcode/cli/device.json'),
    path.join(os.homedir(), '.zcode/v2/credentials.json')].map(file => [file, existsSync(file) ? hash(readFileSync(file)) : null]);
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'zcode-paired-'));
  const tag = path.basename(fixture);
  const cleanup = () => { killTagged(tag); rmSync(fixture, { recursive: true, force: true }); };
  const interrupted = () => { cleanup(); process.exit(130); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  const records = [];
  let outputCreated = false, manifest, stopReason = null, protectedUnchanged = true, unexpectedChildren = 0;
  try {
    const home = path.join(fixture, 'setup-home'); mkdirSync(home);
    const setupEnv = isolatedEnv(home, fixture);
    const pack = await runProcess('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', fixture], { cwd: ROOT, env: setupEnv, timeoutMs: 120000 });
    assert(pack.status === 0, 'npm pack failed; diagnostics withheld');
    const [packed] = JSON.parse(pack.stdout);
    const archive = path.join(fixture, packed.filename);
    const prefix = path.join(fixture, 'install');
    const install = await runProcess('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', archive], { cwd: fixture, env: setupEnv, timeoutMs: 120000 });
    assert(install.status === 0, 'tarball installation failed; diagnostics withheld');
    // Read the command name from the package's own bin map. It was hardcoded to
    // a fixed name, which a rename of the command would have broken — the harness would
    // have failed on a missing binary rather than on anything it measures.
    const [command] = Object.keys(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).bin ?? {});
    assert(command, 'package.json declares no bin command to install');
    const entry = path.join(prefix, 'bin', command);
    const version = await runProcess(entry, ['--version'], { cwd: fixture, env: setupEnv, timeoutMs: 10000 });
    assert(version.status === 0 && version.stdout.trim().split('\n')[0] === `zagent ${protocol.version}`, 'installed CLI version mismatch');
    const claudeCodeVersion = await runProcess(options.claudeCode, ['--version'], { cwd: fixture,
      env: { ...setupEnv, ZAI_AUTH_TOKEN: key }, timeoutMs: 10000 });
    assert(claudeCodeVersion.status === 0, 'Claude Code offline version preflight failed');
    manifest = { ...protocol, modelCalls: true, startedAt: new Date().toISOString(), sourceCommit: sourceCommit.stdout.trim(),
      tarballSha256: hash(readFileSync(archive)), claudeCodeSha256: hash(readFileSync(options.claudeCode)),
      runtimeEntrySha256: hash(readFileSync(options.runtime)),
      claudeCodeVersion: claudeCodeVersion.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null,
      cooldownMs: options.cooldownMs, timeoutMs: 300000 };
    mkdirSync(options.output); outputCreated = true;
    writeFileSync(path.join(options.output, 'manifest.json'), JSON.stringify(manifest, null, 2));
    for (const cell of protocol.matrix) {
      const cellRoot = path.join(fixture, `cell-${cell.index}`); mkdirSync(cellRoot);
      const cellHome = path.join(cellRoot, 'home'), workspace = path.join(cellRoot, 'workspace');
      mkdirSync(cellHome); mkdirSync(workspace);
      const files = taskFiles(cell.task);
      for (const file of files.filter(f => f.name.endsWith('.py') && f.name !== 'test.py'))
        writeFileSync(path.join(workspace, file.name), file.bytes);
      const env = { ...isolatedEnv(cellHome, cellRoot), ZCODE_PAIRED_RUN: tag };
      const prompt = files.find(f => f.name === 'task.md').bytes.toString();
      let command, args;
      if (cell.lane === 'zcode') {
        const dir = path.join(cellHome, '.zcode/cli'); mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
          provider: { zai: { kind: 'anthropic', name: 'Z.AI Coding Plan',
            options: { apiKeyRequired: true, apiKey: key, baseURL: 'https://api.z.ai/api/anthropic' },
            models: { [options.model]: { name: options.model } } } },
          model: { main: `zai/${options.model}`, lite: `zai/${options.model}` }, plugins: { enabled: false },
          hooks: { enabled: false }, mcp: { servers: {} }, skills: { enabled: false }, memory: { use: false, write: false },
        }), { mode: 0o600 });
        env.ZCODE_RUNTIME = options.runtime;
        command = entry; args = ['-p', prompt, '--json', '--force'];
      } else {
        Object.assign(env, { ZAI_AUTH_TOKEN: key, ANTHROPIC_MODEL: options.model,
          ANTHROPIC_SMALL_FAST_MODEL: options.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: options.model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: options.model, ANTHROPIC_DEFAULT_OPUS_MODEL: options.model });
        command = options.claudeCode;
        args = ['-p', prompt, '--model', options.model, '--output-format', 'json', '--safe-mode',
          '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config',
          '--mcp-config', '{"mcpServers":{}}', '--disallowedTools', 'Agent', 'Task'];
      }
      console.log(JSON.stringify({ event: 'start', ...cell }));
      const result = await runProcess(command, args, { cwd: workspace, env });
      const leaked = killTagged(tag); unexpectedChildren += leaked;
      let category = classifyRun(result);
      if (leaked) category = 'runtime_error';
      let pass = false;
      if (category === 'ok') {
        try { pass = await gradeTask({ files, workspace, grade: path.join(cellRoot, 'grade'),
          response: extractResponse(result.stdout), env: isolatedEnv(cellHome, cellRoot) }); }
        catch { category = 'runtime_error'; }
      }
      if (JSON.stringify(plan(options.repeats, options.model).inputs) !== JSON.stringify(protocol.inputs)) {
        category = 'runtime_error'; pass = false; stopReason = 'task_inputs_changed';
      }
      const record = { ...cell, pass, failureCategory: category === 'ok' ? (pass ? null : 'incorrect') : category,
        model: options.model, completedAt: new Date().toISOString(),
        wallMs: result.wallMs, usage: nativeUsage(result.stdout),
        tokenSource: 'client stdout JSON usage object; allowlisted native fields only',
        observedModel: null, toolCallCount: null, internalRetryCount: null };
      records.push(record);
      writeFileSync(path.join(options.output, `cell-${String(cell.index).padStart(3, '0')}.json`), JSON.stringify(record, null, 2), { flag: 'wx' });
      console.log(JSON.stringify(record));
      rmSync(cellRoot, { recursive: true, force: true });
      if (stopReason || category !== 'ok') { stopReason ??= category; break; }
      if (cell.index + 1 < protocol.matrix.length) await new Promise(resolve => setTimeout(resolve, options.cooldownMs));
    }
  } finally {
    protectedUnchanged = protectedFiles.every(([file, expected]) => {
      try { return (existsSync(file) ? hash(readFileSync(file)) : null) === expected; }
      catch { return false; }
    });
    cleanup();
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
    if (outputCreated) {
      const summary = finalizeSummary(records, protocol.expectedCells, { stopReason,
        protectedUnchanged, fixtureRemoved: !existsSync(fixture), unexpectedChildren });
      writeFileSync(path.join(options.output, 'summary.json'), JSON.stringify(summary, null, 2));
      writeFileSync(path.join(options.output, 'REPORT.md'), writeReport(manifest, records, summary));
      console.log(JSON.stringify({ event: 'summary', ...summary }));
      if (!summary.acceptancePassed) process.exitCode = 1;
    }
  }
}

export function parseOptions(args) {
  const options = { live: false, repeats: 3, cooldownMs: 10000, model: 'glm-5.3' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--live') options.live = true;
    else if (arg === '--acknowledge-host-access') options.acknowledgeHostAccess = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (['--output', '--runtime', '--claude-code', '--claude-code-sha256', '--repeats', '--cooldown-ms', '--model'].includes(arg)) {
      const value = args[++i]; assert(value && !value.startsWith('--'), 'option requires a value');
      const key = { '--output': 'output', '--runtime': 'runtime', '--claude-code': 'claudeCode', '--claude-code-sha256': 'claudeCodeSha256', '--repeats': 'repeats', '--cooldown-ms': 'cooldownMs', '--model': 'model' }[arg];
      options[key] = ['repeats', 'cooldownMs'].includes(key) ? Number(value) : value;
    } else throw new Error('unknown option');
  }
  buildMatrix(options.repeats);
  assert(['glm-5.3', 'glm-5.3-flash'].includes(options.model), 'unsupported benchmark model');
  assert(!(options.live && options.dryRun), '--live and --dry-run cannot be combined');
  assert(Number.isInteger(options.cooldownMs) && options.cooldownMs >= 10000 && options.cooldownMs <= 60000, 'cooldown must be 10000..60000 ms');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.live) await live(options);
    else console.log(JSON.stringify(plan(options.repeats, options.model), null, 2));
  } catch { console.error('paired benchmark failed closed; no raw diagnostics emitted'); process.exitCode = 1; }
}
