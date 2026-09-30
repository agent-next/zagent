// Head-to-head client performance: zagent vs zcode-app-cli.
// Same machine, same PTY size, same prompt. Measures what a user feels:
// time to first frame, idle memory, and CPU burned while a turn streams.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file, not from a hardcoded checkout: the original lived in a
// worktree that has since been deleted, which would have made the harness die on a
// path rather than measure anything.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.BENCH_REAL_HOME || homedir();
const OURS = ['node', path.join(ROOT, 'packages/cli/zagent.mjs')];
const THEIRS = ['node', path.join(HOME, '.local/opt/zcode-app-cli/node_modules/zcode-app-cli/bin/zcode.js')];
const CWD = process.argv[2] ?? process.cwd();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Sum RSS over a process and every descendant — both spawn a kernel child. */
function treeRssKb(rootPid) {
  const kids = new Map();
  const ps = spawn('ps', ['-eo', 'pid=,ppid=,rss='], { stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve) => {
    let buf = '';
    ps.stdout.on('data', d => { buf += d; });
    ps.on('close', () => {
      const rows = buf.trim().split('\n').map(l => l.trim().split(/\s+/).map(Number));
      for (const [pid, ppid, rss] of rows) {
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push({ pid, rss });
      }
      let total = 0;
      const walk = (pid) => {
        const self = rows.find(r => r[0] === pid);
        if (self) total += self[2];
        for (const c of kids.get(pid) ?? []) walk(c.pid);
      };
      walk(rootPid);
      resolve(total);
    });
  });
}

/** CPU seconds used by a process tree, from /proc — utime+stime of every member. */
function treeCpuSec(rootPid) {
  const ps = spawn('ps', ['-eo', 'pid=,ppid=,time='], { stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve) => {
    let buf = '';
    ps.stdout.on('data', d => { buf += d; });
    ps.on('close', () => {
      const rows = buf.trim().split('\n').map(l => {
        const [pid, ppid, t] = l.trim().split(/\s+/);
        const parts = t.split(':').map(Number);
        const sec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
        return { pid: Number(pid), ppid: Number(ppid), sec };
      });
      const byParent = new Map();
      for (const r of rows) {
        if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
        byParent.get(r.ppid).push(r);
      }
      let total = 0;
      const walk = (pid) => {
        const self = rows.find(r => r.pid === pid);
        if (self) total += self.sec;
        for (const c of byParent.get(pid) ?? []) walk(c.pid);
      };
      walk(rootPid);
      resolve(total);
    });
  });
}

async function measure(label, cmd, { prompt, settleMs = 6000, turnMs = 0 }) {
  const t0 = process.hrtime.bigint();
  const child = spawn('script', ['-qfec', cmd.join(' ') + ` --cwd ${CWD}`, '/dev/null'], {
    env: { ...process.env, COLUMNS: '100', LINES: '32', TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let bytes = 0;
  let firstFrameMs = null;
  const grab = (d) => {
    bytes += d.length;
    // First frame = the first time the client paints its own chrome, not the
    // kernel's boot noise. Both draw a bordered input box.
    if (firstFrameMs === null && /[╭┌]/u.test(d.toString())) {
      firstFrameMs = Number(process.hrtime.bigint() - t0) / 1e6;
    }
  };
  child.stdout.on('data', grab);
  child.stderr.on('data', grab);

  await sleep(settleMs);
  const idleRss = await treeRssKb(child.pid);
  const cpuBefore = await treeCpuSec(child.pid);

  let turnCpu = null;
  let turnBytes = null;
  if (prompt && turnMs) {
    const bytesBefore = bytes;
    child.stdin.write(prompt);
    await sleep(400);
    child.stdin.write('\r');
    await sleep(turnMs);
    turnCpu = (await treeCpuSec(child.pid)) - cpuBefore;
    turnBytes = bytes - bytesBefore;
  }

  child.stdin.write('\x03'); await sleep(250); child.stdin.write('\x03');
  await sleep(700);
  try { child.kill('SIGTERM'); } catch {}
  return { label, firstFrameMs, idleRss, bootBytes: bytes, turnCpu, turnBytes };
}

const mode = process.argv[3] ?? 'startup';
const opts = mode === 'turn'
  ? { prompt: 'List the files here with your tools, then say DONE.', settleMs: 6000, turnMs: 75000 }
  : { settleMs: 6000 };

const rows = [];
for (const [label, cmd] of [['zagent (ours)', OURS], ['zcode-app-cli', THEIRS]]) {
  if (!existsSync(cmd[1])) {
    console.error(`SKIP ${label}: not installed at ${cmd[1]}`);
    continue;
  }
  rows.push(await measure(label, cmd, opts));
  await sleep(2000);
}

console.log(`\n${'client'.padEnd(16)} ${'first frame'.padStart(12)} ${'idle RSS'.padStart(11)} ${'boot bytes'.padStart(11)}` +
  (mode === 'turn' ? ` ${'turn CPU'.padStart(9)} ${'turn bytes'.padStart(11)}` : ''));
for (const r of rows) {
  console.log(`${r.label.padEnd(16)} ${(r.firstFrameMs ? r.firstFrameMs.toFixed(0) + ' ms' : 'n/a').padStart(12)}` +
    ` ${(r.idleRss ? (r.idleRss / 1024).toFixed(0) + ' MB' : 'n/a').padStart(11)} ${String(r.bootBytes).padStart(11)}` +
    (mode === 'turn' ? ` ${(r.turnCpu != null ? r.turnCpu.toFixed(0) + ' s' : 'n/a').padStart(9)} ${String(r.turnBytes ?? 'n/a').padStart(11)}` : ''));
}
