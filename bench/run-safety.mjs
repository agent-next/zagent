import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each invocation owns a new fixture. A run ID names a receipt, never a deletion target.
export function prepareRun({ lane, task, runId, results, prefix = '' }) {
  const slug = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  for (const [name, value] of Object.entries({ lane, task, runId })) {
    if (typeof value !== 'string' || !slug.test(value)) throw new Error(`${name} must be a slug`);
  }
  const receipt = path.join(results, `${prefix}${lane}_${task}_${runId}.json`);
  if (existsSync(receipt)) throw new Error('receipt already exists; choose a new run ID');
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'zbench-run-'));
  const workspace = path.join(fixture, 'workspace'), grade = path.join(fixture, 'grade');
  try { mkdirSync(workspace); mkdirSync(grade); }
  catch (error) { rmSync(fixture, { recursive: true, force: true }); throw error; }
  return {
    workspace, grade,
    write(record) {
      mkdirSync(results, { recursive: true });
      writeFileSync(receipt, JSON.stringify(record, null, 1), { flag: 'wx' });
    },
    cleanup() { rmSync(fixture, { recursive: true, force: true }); },
  };
}
