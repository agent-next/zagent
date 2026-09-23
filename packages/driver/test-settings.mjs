// B3 setting.json read/write tests — sandboxed HOME, real file roundtrip.
import { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { readSettings, writeSettings, addRecentProject } from './controller-router.mjs';
import path from 'node:path';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const realHome = process.env.HOME ?? os.homedir();
const realUserProfile = process.env.USERPROFILE;
// r2: full restore incl. previously-UNSET USERPROFILE; sandbox cleanup on any exit path
const restoreEnv = () => { process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile; };
const tmp = mkdtempSync(path.join(os.tmpdir(), 'zsettings-'));
process.env.HOME = tmp; process.env.USERPROFILE = tmp; // os.homedir(): $HOME on linux, USERPROFILE on win32 — sandbox both
// force re-read of homedir: os.homedir caches? No — it re-evaluates $HOME each call on POSIX.

// empty/missing file -> {}
ok(Object.keys(readSettings()).length === 0, 'missing setting.json -> {}');

// write + read back
const w = writeSettings({ foo: 'bar', nested: { a: 1 } });
ok(w.foo === 'bar', 'writeSettings returns merged object');
const r = readSettings();
ok(r.foo === 'bar' && r.nested.a === 1, 'roundtrip persists nested values');

// update preserves other keys
writeSettings({ baz: 2 });
ok(readSettings().foo === 'bar' && readSettings().baz === 2, 'update preserves existing keys');

// recentProjects: dedupe + move-to-front + cap 10
addRecentProject('/a'); addRecentProject('/b'); addRecentProject('/a');
let rp = readSettings().recentProjects;
ok(rp[0] === '/a' && rp.length === 2, 're-add moves to front, dedupes');
for (let i = 0; i < 12; i++) addRecentProject(`/p${i}`);
rp = readSettings().recentProjects;
ok(rp.length === 10 && rp[0] === '/p11', 'capped at 10, most-recent-first');

rmSync(tmp, { recursive: true, force: true });
process.env.HOME = realHome; if (realUserProfile !== undefined) process.env.USERPROFILE = realUserProfile;
console.log('interim:', fails ? `FAIL (${fails})` : 'ok');

// review r4: malformed settings file is backed up, never silently clobbered
import { writeFileSync as wfs } from 'node:fs';
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), 'zsettings2-'));
process.env.USERPROFILE = process.env.HOME;
mkdirSync(`${process.env.HOME}/.zcode/v2`, { recursive: true });
wfs(`${process.env.HOME}/.zcode/v2/setting.json`, '{corrupt!!!');
const before = readFileSync(`${process.env.HOME}/.zcode/v2/setting.json`, 'utf8');
writeSettings({ foo: 1 });
const after = readFileSync(`${process.env.HOME}/.zcode/v2/setting.json`, 'utf8');
const bak = readdirSync(`${process.env.HOME}/.zcode/v2`).find(f => f.startsWith('setting.json.corrupt-'));
ok(before === '{corrupt!!!', 'corrupt content read as-is');
ok(JSON.parse(after).foo === 1, 'fresh config written after corruption');
ok(bak !== undefined && readFileSync(`${process.env.HOME}/.zcode/v2/${bak}`, 'utf8') === '{corrupt!!!', 'corrupt file preserved as .corrupt-* backup');
rmSync(process.env.HOME, { recursive: true, force: true });
restoreEnv();
console.log(fails ? `FAIL (${fails})` : 'PASS settings-b3');
process.exit(fails ? 1 : 0);
