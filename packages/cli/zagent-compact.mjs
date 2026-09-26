#!/usr/bin/env node
// zagent compact — E5: route to the daemon (live sessions are process-local; a fresh
// runtime process CANNOT compact another process's session — r8: never silently
// resume/mutate a foreign live session). No daemon → honest guidance.
import { connect } from 'node:net';
import { daemonPaths } from './zagentd-paths.mjs';
const SOCK = daemonPaths().sock;
const client = connect(SOCK);
client.on('error', () => {
  console.error('compact applies to LIVE sessions. Start the daemon first (zagentd start), send an ask, then: zagent compact\n(for the interactive TUI use its own /compact — sessions are process-local).');
  process.exit(1);
});
client.on('connect', () => client.write(JSON.stringify({ op: 'compact', cwd: process.cwd() }) + '\n'));
let buf = '';
client.on('data', d => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) {
  try { const r = JSON.parse(buf.slice(0, i));
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('invalid response');
    if (r.error) { console.error(r.error); process.exit(1); } // r8 #5: failures exit 1
    console.log(JSON.stringify(r)); process.exit(0);
  } catch { console.error('unparseable daemon response'); process.exit(1); }
} });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 130000);
