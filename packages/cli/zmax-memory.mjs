#!/usr/bin/env node
// zagent memory — E6 surface over the runtime-compatible store (paths proven vs live).
// Usage: zagent memory [show]        → this workspace's MEMORY.md
//        zagent memory index         → list workspaces that HAVE memories
//        zagent memory append <txt>  → append one line to this workspace's MEMORY.md
import { appendGlobalMemory, loadProjectMemory, saveProjectMemory } from '../driver/memory.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
const [cmd, ...rest] = process.argv.slice(2);
const cwd = process.cwd();

if (cmd === 'index') {
  const base = `${os.homedir()}/.zcode/cli/memories/projects`;
  let names; try { names = readdirSync(base, { withFileTypes: true }); } catch { console.log('no memories anywhere'); process.exit(0); }
  const rows = names.filter(e => e.isDirectory()).map(e => {
    let n = 0; try { n = readFileSync(`${base}/${e.name}/memory/MEMORY.md`, 'utf8').split('\n').filter(l => l.startsWith('- ')).length; } catch {}
    return `${e.name}  (${n} entries)`;
  });
  console.log(rows.length ? rows.join('\n') : 'no memories anywhere');
} else if (cmd === 'append') {
  if (!rest.length) { console.error('usage: zagent memory append <text>'); process.exit(2); }
  const line = rest.join(' ');
  // r10: retry under the exclusive lock (another append in flight), bounded
  let ok = false;
  for (let i = 0; i < 20 && !ok; i++) {
    try {
      const cur = loadProjectMemory(cwd);
      saveProjectMemory(cwd, (cur ? cur.replace(/\n*$/, '\n') : '# Memory Index\n') + `- ${line}\n`);
      ok = true;
    } catch (e) { if (e?.code !== 'EEXIST') { console.error(`append failed: ${e.message}`); process.exit(1); }
      const until = Date.now() + 100; while (Date.now() < until); }
  }
  if (!ok) { console.error('append: lock busy after retries'); process.exit(1); }
  console.log(`appended to ${cwd} memory`);
} else { // show (default)
  let m; try { m = loadProjectMemory(cwd); }
  catch (e) { console.error(`memory read failed: ${e.message}`); process.exit(2); } // r10 #4: IO errors ≠ 'no memory'
  if (!m) { console.error(`no memory for ${cwd}`); process.exit(1); }
  console.log(m);
}
