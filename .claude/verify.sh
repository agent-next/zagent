#!/usr/bin/env bash
# Commit-time fast gate for the pre-commit-test-gate hook (~/.claude/hooks).
# Same file set and per-file sandbox as `node scripts/test-all.mjs` (the
# canonical serial gate, run locally), discovered via the same discoverTests
# module — but executed in parallel so the whole suite fits the hook's ~100s
# budget (serial: ~152s). CI covers the package smoke plus the unit list in
# .github/workflows/test-matrix.yml; the serial run remains the local gate.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
export AGENT_GATE_ROOT="$PWD"
exec node --input-type=module - <<'NODE'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { discoverTests } = await import(`${process.env.AGENT_GATE_ROOT}/scripts/discover-tests.mjs`);

const root = process.env.AGENT_GATE_ROOT;
// Mirrors test-all.mjs: live-runtime tests skip loudly offline, never pass silently.
const NEEDS_RUNTIME = new Set(['test.mjs', 'test-a2.mjs', 'test-permission-live.mjs', 'test-journeys-live.mjs']);
// pty journeys: real script(1) terminal drives, ~107s+25s wall even in parallel —
// they cannot fit the hook's ~100s budget, and no CI lane runs them either (the
// workflow deliberately excludes non-hermetic suites). The commit gate runs
// everything else; run `node scripts/test-all.mjs` locally for the full gate.
const PTY_JOURNEYS = new Set(['test-journeys.mjs', 'test-journeys-commands.mjs']);
const files = discoverTests(root);
if (files.length === 0) { console.error('FAIL: no test files discovered'); process.exit(1); }
const skipped = files.filter(f => NEEDS_RUNTIME.has(path.basename(f)) || PTY_JOURNEYS.has(path.basename(f)));
const run = files.filter(f => !NEEDS_RUNTIME.has(path.basename(f)) && !PTY_JOURNEYS.has(path.basename(f)));
const P = Math.max(2, Math.min(8, cpus().length - 2));
const failures = [];
let i = 0;
const workers = Array.from({ length: P }, async () => {
  while (i < run.length) {
    const file = run[i++];
    const rel = path.relative(root, file);
    const sandbox = mkdtempSync(path.join(tmpdir(), 'zagent-gate-'));
    let bad = true, out = '', bufs = [];
    try {
      const temp = path.join(sandbox, 'tmp');
      mkdirSync(temp);
      const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
      Object.assign(env, { HOME: sandbox, USERPROFILE: sandbox, TMPDIR: temp, TEMP: temp, TMP: temp,
        XDG_CONFIG_HOME: path.join(sandbox, '.config'), ZAGENT_TEST_SANDBOX: sandbox,
        ZCODE_RUNTIME: path.join(sandbox, 'no-runtime'),
        // --import takes a module specifier: file: URL, not a bare path (win32).
        NODE_OPTIONS: `--import=${pathToFileURL(path.join(root, 'scripts/offline-test-preload.mjs')).href}` });
      bad = await new Promise(resolve => {
        const p = spawn(process.execPath, [file], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 120000);
        p.stdout.on('data', d => { if (bufs.length < 400) bufs.push(d); });
        p.stderr.on('data', d => { if (bufs.length < 400) bufs.push(d); });
        p.on('close', rc => { clearTimeout(t); resolve(rc !== 0); });
        p.on('error', () => { clearTimeout(t); resolve(true); });
      });
      out = bufs.join('').trimEnd();
    } finally { rmSync(sandbox, { recursive: true, force: true }); }
    if (bad) { failures.push(rel); console.log(`FAIL ${rel}\n${out.split('\n').slice(-15).map(l => `     ${l}`).join('\n')}`); }
    else console.log(`ok   ${rel}`);
  }
});
await Promise.all(workers);
console.log(`\n${run.length - failures.length}/${run.length} test files passed (${skipped.length} skipped — live runtime + pty journeys; full gate: node scripts/test-all.mjs)`);
if (failures.length) { console.log(`FAILED: ${failures.join(', ')}`); process.exit(1); }
NODE
