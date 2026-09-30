// Real oracle: the failing behaviour first, then the fix, then the properties that
// keep it honest. Every assertion is a number the loop's correctness depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registry } from './client.mjs';
import { pulse } from './registry-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FP = 'd950776c54bd';            // a real fingerprint from a live fuzz run
const BODY = { invariants: [{ id: 'needed-sigkill' }], spec: { behaviour: 'hang' } };

async function withServer(fn) {
  const port = 8000 + Math.floor(Math.random() * 1500);
  const p = spawn(process.execPath, [path.join(here, 'server.mjs'), '--port', String(port)], { stdio: 'ignore' });
  try {
    const url = `http://127.0.0.1:${port}/`;
    for (let i = 0; i < 100; i++) {
      try { await fetch(new URL('/pulse', url)); break; } catch { await new Promise(r => setTimeout(r, 50)); }
    }
    await fn(url);
  } finally { p.kill('SIGKILL'); }
}

test('TODAY: N stateless agents each re-file the same defect', async () => {
  // Each agent gets its own empty findings dir — which is what an ephemeral
  // container has. This is the duplicate storm the registry exists to stop.
  const claims = await Promise.all(Array.from({ length: 10 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fuzz-dir-'));
    mkdirSync(dir, { recursive: true });
    return registry({ url: undefined, dir }).claim(FP, BODY);
  }));
  assert.equal(claims.filter(c => c.claimed).length, 10,
    'the local-directory design lets every agent think the finding is new');
});

test('WITH the registry: exactly one of 10 concurrent agents files it', async () => {
  await withServer(async (url) => {
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      registry({ url, agent: `agent-${i}` }).claim(FP, BODY)));
    const winners = claims.filter(c => c.claimed);
    assert.equal(winners.length, 1, `expected exactly 1 filer, got ${winners.length}`);
    assert.equal(new Set(claims.map(c => c.owner)).size, 1, 'all agents must agree on the owner');
    assert.equal(Math.max(...claims.map(c => c.hits)), 10, 'every rediscovery must still be counted');
  });
});

test('a restarted container does not re-file its own claim', async () => {
  await withServer(async (url) => {
    const a = registry({ url, agent: 'agent-restarted' });
    assert.equal((await a.claim(FP, BODY)).claimed, true);
    assert.equal((await a.claim(FP, BODY)).claimed, false, 'a retry must not produce a second issue');
  });
});

test('distinct defects are not collapsed', async () => {
  await withServer(async (url) => {
    const a = registry({ url, agent: 'agent-x' });
    assert.equal((await a.claim('aaaaaaaaaaaa', BODY)).claimed, true);
    assert.equal((await a.claim('bbbbbbbbbbbb', BODY)).claimed, true);
  });
});

test('the claimed body survives for the triage lane, and triage is once-only', async () => {
  await withServer(async (url) => {
    await registry({ url, agent: 'finder' }).claim(FP, BODY);
    const { findings } = await (await fetch(new URL('/untriaged?limit=5', url))).json();
    assert.equal(findings.length, 1);
    assert.equal(findings[0].body.invariants[0].id, 'needed-sigkill', 'the finding must arrive intact');
    const mark = () => fetch(new URL('/triaged', url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: FP }) }).then(r => r.json());
    assert.equal((await mark()).updated, 1);
    assert.equal((await mark()).updated, 0, 'a second triage pass must not re-file');
    const after = await (await fetch(new URL('/untriaged', url))).json();
    assert.equal(after.findings.length, 0);
  });
});

test('pulse calls a lane dead when it stops beating', () => {
  const now = Date.parse('2026-09-07T21:00:00Z');
  const beats = [
    { agent: 'a', at: '2026-09-07T20:59:00Z', round: 3 },   // 1 min ago
    { agent: 'b', at: '2026-09-07T20:30:00Z', round: 1 },   // 30 min ago
  ];
  const p = pulse(beats, { total: 2, untriaged: 1 }, now);
  assert.deepEqual(p.stale, ['b']);
  assert.equal(p.alive, 1);
  assert.equal(p.healthy, true);
  assert.equal(pulse([], { total: 0, untriaged: 0 }, now).healthy, false, 'no lanes at all is not healthy');
});
