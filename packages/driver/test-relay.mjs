// Relay state persistence — relay-state.json carries the device id and a
// credential-adjacent session id, so it must be written user-private.
import { mkdtempSync, statSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeRelayState } from './relay.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const tmp = mkdtempSync(path.join(os.tmpdir(), 'zrelay-'));
const file = path.join(tmp, 'cli', 'relay-state.json');
writeRelayState(file, { deviceMid: 'd1', deviceSid: 's1' });
ok(JSON.parse(readFileSync(file, 'utf8')).deviceSid === 's1', 'state written and readable back');

if (process.platform !== 'win32') {
  const mode = p => statSync(p).mode & 0o777;
  ok(mode(file) === 0o600, `state file is 0600 (got ${mode(file).toString(8)})`);
  ok(mode(path.dirname(file)) === 0o700, `state dir is 0700 (got ${mode(path.dirname(file)).toString(8)})`);

  // a pre-existing loose file is tightened, not just created private
  writeFileSync(file, '{}', { mode: 0o644 });
  chmodSync(file, 0o644);
  writeRelayState(file, { lastAck: 1 });
  ok(mode(file) === 0o600, 'pre-existing 0644 state file tightened to 0600');
}
rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `FAIL (${fails})` : 'PASS relay-state');
process.exit(fails ? 1 : 0);
