#!/usr/bin/env node
// zagent memory — surface over the runtime-compatible store (paths proven vs live).
// Usage: zagent memory [show]        → this workspace's MEMORY.md
//        zagent memory index         → list workspaces that HAVE memories
//        zagent memory append <txt>  → append one line to this workspace's MEMORY.md
import { appendProjectMemory, loadProjectMemory } from '../driver/memory.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
const [cmd, ...rest] = process.argv.slice(2);
const cwd = process.cwd();
const usage = () => { console.error('usage: zagent memory [show|index|append <text>]'); process.exit(2); };
// Unknown verbs must not silently fall through to `show` — 'memory bogus'
// used to print this workspace's memory and exit 0.
if (cmd !== undefined && cmd !== 'show' && cmd !== 'index' && cmd !== 'append') usage();
if (cmd !== 'append' && rest.length) usage();

if (cmd === 'index') {
  const base = `${os.homedir()}/.zcode/cli/memories/projects`;
  let names; try { names = readdirSync(base, { withFileTypes: true }); } catch { console.log('no memories anywhere'); process.exit(0); }
  const rows = names.filter(e => e.isDirectory()).map(e => {
    let n = 0; try { n = readFileSync(`${base}/${e.name}/memory/MEMORY.md`, 'utf8').split('\n').filter(l => l.startsWith('- ')).length; } catch {}
    return `${e.name}  (${n} entries)`;
  });
  console.log(rows.length ? rows.join('\n') : 'no memories anywhere');
} else if (cmd === 'append') {
  if (!rest.join(' ').trim()) { console.error('usage: zagent memory append <text>'); process.exit(2); }
  const line = rest.join(' ');
  // : retry under the exclusive lock (another append in flight), bounded
  let ok = false;
  for (let i = 0; i < 20 && !ok; i++) {
    try {
      appendProjectMemory(cwd, line);
      ok = true;
    } catch (e) { if (e?.code !== 'EEXIST') { console.error(`append failed: ${e.message}`); process.exit(1); }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  }
  if (!ok) { console.error('append: lock busy after retries'); process.exit(1); }
  console.log(`appended to ${cwd} memory`);
} else { // show (default) — cmd is 'show' or undefined here
  let m; try { m = loadProjectMemory(cwd); }
  catch (e) { console.error(`memory read failed: ${e.message}`); process.exit(2); } // #4: IO errors ≠ 'no memory'
  if (!m) { console.log(`No memory for ${cwd}. Add one with: zagent memory append "…"`); process.exit(0); }
  console.log(m);
}
