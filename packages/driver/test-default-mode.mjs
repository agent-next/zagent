// Hermetic checks for the persisted default -p permission mode
// (default-mode.mjs — the F14c follow-up surface `zagent mode` drives).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, ok, summary } from './test-util.mjs';
import { DEFAULT_MODE_VALUES, readDefaultMode, readDefaultModeDetail, writeDefaultMode, withPersistedMode, hasModeFlag } from './default-mode.mjs';

eq(DEFAULT_MODE_VALUES.join('|'), 'build|edit|plan|yolo', 'the domain is exactly the kernel --mode enum (auto is reserved, not launchable)');

const home = mkdtempSync(path.join(tmpdir(), 'zagent-default-mode-'));
const cfgDir = path.join(home, '.zcode', 'cli');
const cfgFile = path.join(cfgDir, 'config.json');
try {
  // Absent file reads as unset and refuses writes honestly — the file is
  // never created just to hold this key.
  eq(readDefaultMode({ home }), null, 'missing config reads as unset');
  let threw = null;
  try { writeDefaultMode('plan', { home }); } catch (e) { threw = e; }
  ok(threw && /no ~\/.zcode\/cli\/config\.json yet/.test(threw.message), 'set on absent config refuses with a next step');
  ok(!existsSync(cfgFile), 'the refusal did not create the file');
  // ...but CLEARING an absent config is a no-op success, not an error —
  // 'no default set' is already true; idempotent `mode clear` must not exit 1.
  eq(writeDefaultMode(null, { home }), false, 'clear on absent config is a no-op, not a refusal');
  ok(!existsSync(cfgFile), 'the no-op clear did not create the file');
  eq(readDefaultModeDetail({ home }).state, 'absent', 'detail reports absent vs unset');

  // A non-object config reads as unset and refuses writes without a touch.
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(cfgFile, '"just a string"');
  eq(readDefaultMode({ home }), null, 'non-object config reads as unset');
  threw = null;
  try { writeDefaultMode('plan', { home }); } catch (e) { threw = e; }
  ok(threw && /not valid JSON|not a JSON object/.test(threw.message), 'non-object config refuses honestly');
  eq(readFileSync(cfgFile, 'utf8'), '"just a string"', 'refused write left the file untouched');

  // Malformed JSON says so; an UNREADABLE config is a different diagnosis —
  // not folded into 'not valid JSON'.
  writeFileSync(cfgFile, '{oops');
  threw = null;
  try { writeDefaultMode('plan', { home }); } catch (e) { threw = e; }
  ok(threw && /not valid JSON/.test(threw.message), 'malformed JSON names the parse failure');
  eq(readDefaultModeDetail({ home }).state, 'malformed', 'detail distinguishes malformed from unset');
  eq(readDefaultMode({ home }), null, 'the read path still fails open for -p');
  rmSync(cfgFile); mkdirSync(cfgFile); // a directory at the config path reads EISDIR
  threw = null;
  try { writeDefaultMode('plan', { home }); } catch (e) { threw = e; }
  ok(threw && /cannot read config/.test(threw.message) && !/not valid JSON/.test(threw.message),
    'an unreadable config is not misreported as bad JSON');
  eq(readDefaultModeDetail({ home }).state, 'unreadable', 'detail distinguishes unreadable from malformed');
  rmSync(cfgFile, { recursive: true });

  // Round-trip on a real config: existing keys survive, invalid values read
  // as unset, clear drops an emptied permissions object.
  writeFileSync(cfgFile, JSON.stringify({
    provider: { zai: { kind: 'anthropic' } },
    model: { main: 'zai/glm-5.3', lite: 'zai/glm-5.3-flash' },
  }));
  eq(readDefaultMode({ home }), null, 'config without the key reads as unset');
  ok(writeDefaultMode('plan', { home }) === true, 'set reports a change');
  eq(readDefaultMode({ home }), 'plan', 'set round-trips');
  const after = JSON.parse(readFileSync(cfgFile, 'utf8'));
  ok(after.provider?.zai?.kind === 'anthropic' && after.model?.main === 'zai/glm-5.3',
    'existing config keys survive a set');
  if (process.platform !== 'win32') // mode bits are not honored there
    eq(statSync(cfgFile).mode & 0o777, 0o600, 'config stays 0600 after a write');
  ok(writeDefaultMode('plan', { home }) === false, 'setting the same value is a no-op');

  // An invalid or out-of-domain stored value reads as unset, never throws.
  writeFileSync(cfgFile, JSON.stringify({ permissions: { defaultMode: 'bogus' } }));
  eq(readDefaultMode({ home }), null, 'out-of-domain stored value reads as unset');
  writeFileSync(cfgFile, JSON.stringify({ permissions: { defaultMode: 'auto' } }));
  eq(readDefaultMode({ home }), null, "'auto' is not a launchable default — reads as unset");
  writeFileSync(cfgFile, JSON.stringify({ permissions: { defaultMode: 7 } }));
  eq(readDefaultMode({ home }), null, 'non-string stored value reads as unset');
  {
    const d = readDefaultModeDetail({ home });
    ok(d.state === 'invalid' && d.value === 7, 'detail surfaces the ignored value');
  }
  writeFileSync(cfgFile, JSON.stringify({ permissions: { defaultMode: 'plan' } }));
  {
    const d = readDefaultModeDetail({ home });
    ok(d.state === 'ok' && d.mode === 'plan', 'detail reports the stored mode');
  }
  writeFileSync(cfgFile, JSON.stringify({ permissions: {} }));
  eq(readDefaultModeDetail({ home }).state, 'unset', 'detail distinguishes key-absent from file-absent');

  // Clear removes the key AND an emptied permissions object; clearing twice
  // is an honest no-op.
  ok(writeDefaultMode('edit', { home }) === true, 're-set after bogus values');
  ok(writeDefaultMode(null, { home }) === true, 'clear reports a removal');
  eq(readDefaultMode({ home }), null, 'cleared value reads as unset');
  ok(!('permissions' in JSON.parse(readFileSync(cfgFile, 'utf8'))), 'an emptied permissions object is dropped');
  ok(writeDefaultMode(null, { home }) === false, 'clearing an absent key is a no-op');
  // Other keys inside permissions survive a clear.
  writeFileSync(cfgFile, JSON.stringify({ permissions: { defaultMode: 'yolo', other: true } }));
  ok(writeDefaultMode(null, { home }) === true, 'clear removes the key');
  eq(JSON.parse(readFileSync(cfgFile, 'utf8')).permissions?.other, true, 'sibling permissions keys survive a clear');

  // A scalar `permissions` cannot be merged without clobbering — refuse.
  writeFileSync(cfgFile, JSON.stringify({ permissions: 'oops' }));
  threw = null;
  try { writeDefaultMode('plan', { home }); } catch (e) { threw = e; }
  ok(threw && /not an object/.test(threw.message), 'scalar permissions refuses rather than clobber');
  ok(readDefaultMode({ home }) === null, 'scalar permissions reads as unset');
  ok(writeDefaultMode(null, { home }) === false, 'scalar permissions clears nothing');
  threw = null;
  try { writeDefaultMode('bogus', { home }); } catch (e) { threw = e; }
  ok(threw && /must be one of/.test(threw.message), 'write validates its own domain');
} finally { rmSync(home, { recursive: true, force: true }); }

// --- argv plumbing (pure) ---
eq(JSON.stringify(withPersistedMode(['-p', 'hi'], 'plan')), '["-p","hi","--mode","plan"]',
  'no `--` — the flag appends');
eq(JSON.stringify(withPersistedMode(['-p', 'hi', '--', '--target', 'x'], 'plan')),
  '["-p","hi","--mode","plan","--","--target","x"]',
  'inserts BEFORE the `--` so post-separator positionals keep their place');
eq(JSON.stringify(withPersistedMode([], 'plan')), '["--mode","plan"]', 'empty argv appends');
const src = ['-p', 'hi'];
withPersistedMode(src, 'plan');
eq(src.length, 2, 'withPersistedMode never mutates its input');

ok(hasModeFlag(['-p', 'hi', '--mode', 'plan']), 'hasModeFlag: space form');
ok(hasModeFlag(['--mode=yolo', '-p', 'hi']), 'hasModeFlag: = form');
ok(!hasModeFlag(['-p', 'hi']), 'hasModeFlag: absent');
ok(!hasModeFlag(['-p', 'hi', '--mode-other', 'x']), 'hasModeFlag: a different flag prefix does not match');
// Callers pass the PRE-`--` slice; a post-separator --mode is a kernel
// positional and must not suppress injection.
ok(!hasModeFlag(['-p', 'hi', '--', '--mode'].slice(0, 2)),
  'hasModeFlag is a pre-`--` decision by contract');

summary('default-mode');
