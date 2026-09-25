#!/usr/bin/env node
// zagentd compact — ask the daemon to compact its warm session for this cwd.
import { connect } from 'node:net';
import os from 'node:os';
const SOCK = `${os.tmpdir()}/zagentd-${process.getuid()}.sock`;
const client = connect(SOCK);
client.on('error', () => { console.error('daemon not running (zagentd start)'); process.exit(1); });
client.on('connect', () => client.write(JSON.stringify({ op: 'compact', cwd: process.cwd() }) + '\n'));
let buf = '', received = false;
client.setEncoding('utf8');
client.on('end', () => { if (!received) { console.error('daemon closed before a response'); process.exit(1); } });
client.on('data', d => {
  if (received) return;
  buf += d; const i = buf.indexOf('\n'); if (i < 0) return;
  received = true;
  try {
    const resp = JSON.parse(buf.slice(0, i));
    if (!resp || typeof resp !== 'object' || Array.isArray(resp)) throw new Error('invalid response');
    client.destroy();
    process.stdout.write(JSON.stringify(resp) + '\n', () => process.exit(resp.error != null ? 1 : 0));
  } catch { console.error('unparseable daemon response'); client.destroy(); process.exit(1); }
});
setTimeout(() => { console.error('timeout'); process.exit(1); }, 130000);
