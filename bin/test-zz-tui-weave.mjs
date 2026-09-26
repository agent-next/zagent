// zz-tui-weave: plugin commands must land as catalog-visible *.md skill files
// (the catalog only recognizes names ending in .md), and an existing file at
// the destination must survive a re-run — it may be user-edited.
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const weave = fileURLToPath(new URL('./zz-tui-weave', import.meta.url));
const home = mkdtempSync(path.join(os.tmpdir(), 'zweave-'));
const env = { ...process.env, HOME: home, USERPROFILE: home };
// The child runs against its own HOME; the offline harness preload would fail
// it for the HOME/sandbox mismatch, and it needs no network anyway.
delete env.NODE_OPTIONS; delete env.ZAGENT_TEST_SANDBOX;
const run = () => spawnSync(process.execPath, [weave], { env, encoding: 'utf8' });

let r = run();
ok(r.status === 0, `weave exits 0 (${String(r.stderr ?? '').trim()})`);
const skills = `${home}/.zcode/skills`;
ok(existsSync(`${skills}/quota.md`) && existsSync(`${skills}/zquota.md`), 'commands installed with .md extension (catalog-visible)');
ok(!existsSync(`${skills}/quota`), 'no extensionless file installed');
writeFileSync(`${skills}/quota.md`, 'user edited');
r = run();
ok(r.status === 0 && readFileSync(`${skills}/quota.md`, 'utf8') === 'user edited', 'existing skill preserved on re-run');
ok(/kept existing/.test(r.stdout), 're-run reports the kept file');
rmSync(home, { recursive: true, force: true });
console.log(fails ? `FAIL (${fails})` : 'PASS zz-tui-weave');
process.exit(fails ? 1 : 0);
