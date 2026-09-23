// Live permission oracle against the official ZCode kernel (/opt/ZCode).
// Session is created WITHOUT auto-allow. A write/edit prompt must produce
// interaction/requestPermission; we allow once and assert the turn continues.
// Opt-in: `node scripts/test-all.mjs --live` or ZAGENT_LIVE=1 (same as test-a2.mjs).
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ZCodeProtocolClient, sessionSid, runTurn } from './zcode-protocol.mjs';
import { autoAllow } from './permissions.mjs';
import { setMode } from './session-control.mjs';
import { assert } from './test-util.mjs';

const OFFICIAL = '/opt/ZCode/resources/glm/zcode.cjs';
if (!existsSync(OFFICIAL)) {
  console.error(`FAIL: official ZCode runtime missing (${OFFICIAL})`);
  process.exit(1);
}

const ws = mkdtempSync(path.join(tmpdir(), 'zagent-perm-live-'));
writeFileSync(path.join(ws, 'note.txt'), 'BEFORE\n');

function redact(value) {
  const raw = JSON.stringify(value ?? null).split(ws).join('$WS');
  return raw.length > 2000 ? raw.slice(0, 2000) + '…' : raw;
}

const asked = [];
const c = new ZCodeProtocolClient({ runtime: OFFICIAL, cwd: ws });
const cleanup = () => { try { c.close(); } catch {} try { rmSync(ws, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

await c.ready;
const sid = sessionSid(await c.createSession(ws));
assert(!!sid?.startsWith('sess_'), `session created without auto-allow (${sid?.slice(0, 14)}…)`);
// build asks; yolo/auto would hide the kernel prompt this test exists to capture.
await setMode(c, sid, 'build');
c.requestHandlers['interaction/requestPermission'] = (p) => {
  asked.push(p);
  return autoAllow(p);
};

const prompt = 'Use the Edit or Write tool to replace the word BEFORE in note.txt with AFTER. Do not only print the change — actually modify the file. Then stop.';
const t0 = Date.now();
const { events, end } = await runTurn(c, sid, prompt, { timeoutMs: 120000 });
const kinds = events.map(e => e.kind);
console.log('   event kinds:', [...new Set(kinds)].slice(0, 16).join(', '));
console.log('   permission requests:', asked.length);
for (const p of asked) console.log('   requestPermission:', redact(p));
const after = existsSync(path.join(ws, 'note.txt')) ? readFileSync(path.join(ws, 'note.txt'), 'utf8') : '';
console.log('   note.txt after:', JSON.stringify(after).slice(0, 120));
console.log(`   elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s end=${end.ended}`);

assert(asked.length > 0, 'kernel sent interaction/requestPermission');
const mutating = asked.find(p => /edit|write|bash/i.test(String(p?.toolName ?? p?.tool ?? '')));
assert(!!(mutating ?? asked[0]), 'captured a permission request payload');
assert(end.ended === 'turn-completed', `turn continued after allow-once (end=${end.ended})`);
console.log('PASS permission-live');
process.exit(0);
