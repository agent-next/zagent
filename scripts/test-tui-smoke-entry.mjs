#!/usr/bin/env node
// Gate for tui-smoke's entry check: the tool is opt-in (needs a live runtime
// and credential), so a main guard that silently fails to fire reads as a
// clean exit 0 that ran nothing, and nothing downstream notices. The raw
// `file://${argv[1]}` template missed exactly the awkward-but-legal ways the
// script gets invoked; the guard must resolve and real-path the argument the
// way the shipped entry points do.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'tui-smoke.mjs');

// ZCODE_RUNTIME pointing nowhere is authoritative for findRuntime: the tool
// takes its designed no-runtime exit ("SKIP: no ZCode runtime found", exit 0)
// instead of a live TUI run — proof that main() itself executed.
const env = { ...process.env, ZCODE_RUNTIME: path.join(root, 'no-runtime-for-this-gate') };
delete env.ZAGENT_LIVE;

const work = mkdtempSync(path.join(tmpdir(), 'tui-smoke-entry-'));
const cases = [
  ['relative path from the repo root', 'scripts/tui-smoke.mjs'],
  ['absolute path', script],
];
try {
  // Symlinks INTO the real script (not copies): the module's relative imports
  // must keep resolving from scripts/, while argv[1] carries the awkward path.
  // Creating symlinks needs privileges on some Windows hosts — skip those
  // cases loudly there rather than fail on a host policy, not a defect.
  const linked = path.join(work, 'tui-smoke-link.mjs');
  const spacedDir = path.join(work, 'dir with space');
  const spaced = path.join(spacedDir, 'tui-smoke.mjs');
  try {
    symlinkSync(script, linked);
    mkdirSync(spacedDir);
    symlinkSync(script, spaced);
    cases.push(['path containing a space', spaced], ['symlinked path', linked]);
  } catch (e) {
    if (!['EPERM', 'EACCES'].includes(e.code)) throw e;
    console.log(`skip: symlink creation not permitted on this host (${e.code}) — spaced/symlink argv[1] legs not run`);
  }

  for (const [how, file] of cases) {
    const r = spawnSync(process.execPath, [file], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, `${how}: exit ${r.status}${r.stderr ? `: ${r.stderr.split('\n')[0]}` : ''}`);
    assert.match(`${r.stdout}${r.stderr}`, /SKIP: no ZCode runtime found/,
      `${how}: main never ran (the entry guard silently no-oped)`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`PASS tui-smoke entry: main runs under ${cases.map(([how]) => how).join(', ')}`);
