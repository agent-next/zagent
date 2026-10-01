// Relay state persistence — relay-state.json carries the device id and a
// credential-adjacent session id, so it must be written user-private.
import { mkdtempSync, statSync, writeFileSync, readFileSync, rmSync, chmodSync, readdirSync } from 'node:fs';
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

  // A pre-existing loose file is REPLACED by rename, not written in place:
  // the new content is never observable at the old 0644 mode — not even for
  // an instant. A changed inode proves the old file was swapped out wholesale.
  writeFileSync(file, 'loose-old-content', { mode: 0o644 });
  chmodSync(file, 0o644);
  const oldIno = statSync(file).ino;
  writeRelayState(file, { lastAck: 1 });
  ok(statSync(file).ino !== oldIno, 'loose target replaced by rename, not written in place');
  ok(readFileSync(file, 'utf8').includes('lastAck'), 'old content gone');
  ok(mode(file) === 0o600, 'pre-existing 0644 state file tightened to 0600');
  ok(!readdirSync(path.dirname(file)).some(n => n.endsWith('.tmp')), 'no tmp file left behind');

  // Loud failure: when the dir path is squatted by a file, mkdir/chmod throw
  // instead of the write proceeding loosely.
  const blocked = path.join(tmp, 'blocked');
  writeFileSync(blocked, 'not a dir');
  let threw = false;
  try { writeRelayState(path.join(blocked, 'relay-state.json'), { lastAck: 2 }); } catch { threw = true; }
  ok(threw, 'a state dir that cannot be made private fails loudly');
}
rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `FAIL (${fails})` : 'PASS relay-state');
process.exit(fails ? 1 : 0);
