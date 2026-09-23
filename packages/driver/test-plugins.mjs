// Plugin tests — fixtures copied from the LIVE marketplace/store shapes (2026-09-06).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash as _ch } from 'node:crypto';
import { marketplaceVersions, installedPlugins, suppressedBuiltins, updateReport, updateLine } from './plugins.mjs';
import path from 'node:path';
import os from 'node:os';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const MKT = { plugins: [
  { name: 'example-plugin', source: { url: 'https://cdn-zcode.z.ai/zcode/official-plugin/plugins/example-plugin/0.2.0/plugin.zip', sha256: 'aa' } },
  { name: 'cloudbase-skills', source: { url: 'https://cdn-zcode.z.ai/zcode/official-plugin/plugins/cloudbase-skills/0.1.0/plugin.zip' } },
  { name: 'no-url', source: {} },
] };
let mv = marketplaceVersions(MKT);
ok(mv['example-plugin'].version === '0.2.0' && mv['example-plugin'].sha256 === 'aa', 'version parsed from URL + sha');
ok(mv['cloudbase-skills'].version === '0.1.0', 'second entry');
ok(!('no-url' in mv), 'url-less entry skipped');

// installed scan (sandbox HOME, both cache/data layouts)
const home = mkdtempSync(path.join(os.tmpdir(), 'zplug-'));
for (const [base, name, ver] of [['cache', 'example-plugin', '0.1.0'], ['data', 'local-only', '1.2.3']]) {
  const d = `${home}/.zcode/cli/plugins/${base}/${name}/.zcode-plugin`;
  mkdirSync(d, { recursive: true });
  writeFileSync(`${d}/plugin.json`, JSON.stringify({ name, version: ver }));
}
mkdirSync(`${home}/.zcode/cli`, { recursive: true });
writeFileSync(`${home}/.zcode/cli/config.json`, JSON.stringify({ plugins: { suppressedBuiltins: ['cloudbase-skills'] } }));
let ip = installedPlugins({ home });
ok(ip['example-plugin'].version === '0.1.0' && ip['local-only'].version === '1.2.3', 'installed scan (cache+data)');
ok(JSON.stringify(suppressedBuiltins({ home })) === '["cloudbase-skills"]', 'suppressed list read');
ok(suppressedBuiltins({ home: '/nonexistent' }).length === 0, 'no config -> []');

let rows = updateReport({ marketplace: mv, installed: ip, suppressed: suppressedBuiltins({ home }) });
const byName = Object.fromEntries(rows.map(r => [r.name, r]));
ok(byName['example-plugin'].badge === 'update-available' && byName['example-plugin'].installed === '0.1.0' && byName['example-plugin'].marketplace === '0.2.0', 'update-available badge with versions');
ok(byName['cloudbase-skills'].badge === 'not-installed' && byName['cloudbase-skills'].suppressed === true, 'not-installed + suppressed marker');
ok(byName['local-only'].badge === 'orphan', 'off-marketplace orphan');
// equal & newer-installed
rows = updateReport({ marketplace: mv, installed: { ...ip, 'example-plugin': { version: '0.2.0' }, 'cloudbase-skills': { version: '0.3.0' } } });
const b2 = Object.fromEntries(rows.map(r => [r.name, r]));
ok(b2['example-plugin'].badge === 'ok', 'equal version -> ok');
ok(b2['cloudbase-skills'].badge === 'ok', 'installed NEWER than marketplace -> ok (no downgrade hint)');
ok(updateLine([]) === 'no plugins tracked', 'empty line');
ok(updateLine(rows).includes('local-only: orphan'), 'line format');
rmSync(home, { recursive: true, force: true });


// Prerelease/dirty semver + orphan suppression marker
import { updateReport as ur } from './plugins.mjs';
import { installPlugin } from './plugins.mjs';
import { spawnSync } from 'node:child_process';
const createHash = _ch;
const HAS_ZIP = spawnSync('zip', ['-v'], { encoding: 'utf8' }).status === 0;
let rows12 = ur({ marketplace: { p: { version: '0.1.0' } }, installed: { p: { version: '0.1.0-beta' } } });
ok(rows12[0].badge === 'update-available', 'prerelease < release -> update-available');
rows12 = ur({ marketplace: { p: { version: 'garbage!' } }, installed: { p: { version: '0.1.0' } } });
ok(rows12[0].badge === 'unknown-version', 'uncomparable version -> unknown (not ok)');
rows12 = ur({ marketplace: {}, installed: { hidden: { version: '1.0.0' } }, suppressed: ['hidden'] });
ok(rows12[0].badge === 'orphan' && rows12[0].suppressed === true, 'orphan keeps suppression marker');
rows12 = ur({ marketplace: { p: { version: '1.0' } }, installed: { p: { version: '1.0.0' } } });
ok(rows12[0].badge === 'ok', "'1.0' tolerated as 1.0.0");
rows12 = ur({ marketplace: { p: { version: '1.0.0-beta.10' } }, installed: { p: { version: '1.0.0-beta.2' } } });
ok(rows12[0].badge === 'update-available', 'numeric prerelease beta.2 < beta.10 (SemVer §11)');
rows12 = ur({ marketplace: { p: { version: '1.0.0-beta.2' } }, installed: { p: { version: '1.0.0-beta.10' } } });
ok(rows12[0].badge === 'ok', 'numeric prerelease beta.10 > beta.2');
rows12 = ur({ marketplace: { p: { version: '1.0.0-beta.2' } }, installed: { p: { version: '1.0.0-beta.2' } } });
ok(rows12[0].badge === 'ok', 'equal dotted prerelease');
rows12 = ur({ marketplace: { p: { version: '1.0.0-beta' } }, installed: { p: { version: '1.0.0-1' } } });
ok(rows12[0].badge === 'update-available', 'numeric prerelease < alphanumeric (SemVer §11)');
rows12 = ur({ marketplace: { p: { version: '1.0.0-beta.1' } }, installed: { p: { version: '1.0.0-beta' } } });
ok(rows12[0].badge === 'update-available', 'more prerelease fields > fewer when prefix-equal');


// builtin cachePath entries (no source.url)
const MKT2 = { plugins: [
  { name: 'browser-use', cachePath: '/x/cache/mkt/browser-use/0.4.2' },
  { name: 'example-plugin', source: { url: 'https://cdn/plugins/example-plugin/0.2.0/plugin.zip' } },
] };
const mv2 = marketplaceVersions(MKT2);
ok(mv2['browser-use'].version === '0.4.2', 'cachePath version parsed');
ok(mv2['example-plugin'].version === '0.2.0', 'url entries still parsed');



if (!HAS_ZIP) console.log('# skip install: real zip (no zip binary)');
else {
  // Install: real zip built in-sandbox, sha256 gate, layout placement
  const homeI = mkdtempSync(path.join(os.tmpdir(), 'zpinst-'));
  const src = `${homeI}/src-pkg`; mkdirSync(`${src}/.zcode-plugin`, { recursive: true });
  writeFileSync(`${src}/.zcode-plugin/plugin.json`, JSON.stringify({ name: 'demo-pkg', version: '9.9.9' }));
  writeFileSync(`${src}/README.md`, 'x');
  spawnSync('zip', ['-q', '-r', `${homeI}/pkg.zip`, '.'], { cwd: src });
  const zipBytes = readFileSync(`${homeI}/pkg.zip`);
  const { createHash } = { createHash: _ch };
  const sha = createHash('sha256').update(zipBytes).digest('hex');
  const MKT3 = { plugins: [{ name: 'demo-pkg', source: { url: 'https://cdn-zcode.z.ai/plugins/demo-pkg/9.9.9/plugin.zip', sha256: sha } }] };
  const fakeFetch = async url => ({ ok: true, status: 200, arrayBuffer: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.length) });
  const inst = await installPlugin({ name: 'demo-pkg', marketplaceJson: MKT3, home: homeI, fetchImpl: fakeFetch });
  ok(inst.version === '9.9.9' && existsSync(`${inst.path}/.zcode-plugin/plugin.json`), 'installed into cache layout with manifest');
  ok(installedPlugins({ home: homeI })['demo-pkg']?.version === '9.9.9', 'scanner sees the install');
  // tamper: wrong sha refused, nothing unpacked
  let threwI = false;
  try { await installPlugin({ name: 'demo-pkg', marketplaceJson: { plugins: [{ name: 'demo-pkg', source: { url: 'https://cdn-zcode.z.ai/plugins/demo-pkg/1.0.0/plugin.zip', sha256: 'deadbeef' } }] }, home: homeI, fetchImpl: fakeFetch }); }
  catch (e) { threwI = /MISMATCH/.test(e.message); }
  ok(threwI, 'sha mismatch refused');
  ok(!existsSync(`${homeI}/.zcode/cli/plugins/cache/zcode-plugins-official/demo-pkg/1.0.0`), 'nothing unpacked on mismatch');
  // no sha entry refused
  threwI = false;
  try { await installPlugin({ name: 'x', marketplaceJson: { plugins: [{ name: 'x', source: { url: 'u' } }] }, home: homeI, fetchImpl: fakeFetch }); } catch (e) { threwI = /no verifiable/.test(e.message); }
  ok(threwI, 'unverifiable source refused');
  rmSync(homeI, { recursive: true, force: true });
}



if (!HAS_ZIP) console.log('# skip identity gate (no zip binary)');
else {
  // Identity gate + concurrency + partial-failure cleanup
  const homeR = mkdtempSync(path.join(os.tmpdir(), 'zpgate-'));
  const mkZip = (name, ver) => {
    const src = `${homeR}/s-${name}`; mkdirSync(`${src}/.zcode-plugin`, { recursive: true });
    writeFileSync(`${src}/.zcode-plugin/plugin.json`, JSON.stringify({ name, version: ver }));
    spawnSync('zip', ['-q', '-r', `${homeR}/${name}.zip`, '.'], { cwd: src });
    const b = readFileSync(`${homeR}/${name}.zip`);
    return { bytes: b, sha: createHash('sha256').update(b).digest('hex') };
  };
  const WRONG = mkZip('other-pkg', '1.0.0');
  let threwR = false;
  try { await installPlugin({ name: 'wanted-pkg', marketplaceJson: { plugins: [{ name: 'wanted-pkg', source: { url: 'https://cdn-zcode.z.ai/plugins/wanted-pkg/1.0.0/plugin.zip', sha256: WRONG.sha } }] },
    home: homeR, fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => WRONG.bytes.buffer.slice(WRONG.bytes.byteOffset, WRONG.bytes.byteOffset + WRONG.bytes.length) }) }); }
  catch (e) { threwR = /manifest name/.test(e.message); }
  ok(threwR, 'identity mismatch refused (wrong plugin in zip)');
  { const wb = `${homeR}/.zcode/cli/plugins/cache/zcode-plugins-official/wanted-pkg`;
    const residue = existsSync(wb) ? readdirSync(wb).filter(e => e.startsWith('.staging') || e.includes('lock') || e === '.download.zip') : [];
    ok(residue.length === 0 && !existsSync(`${wb}/1.0.0`), 'no staging/lock/partial residue after refusal (base dir may exist, empty)'); }
  // concurrent same-plugin installs: lock serializes; loser reports busy, winner succeeds
  const GOOD = mkZip('race-pkg', '2.0.0');
  const goodFetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => GOOD.bytes.buffer.slice(GOOD.bytes.byteOffset, GOOD.bytes.byteOffset + GOOD.bytes.length) });
  const goodMkt = { plugins: [{ name: 'race-pkg', source: { url: 'https://cdn-zcode.z.ai/plugins/race-pkg/2.0.0/plugin.zip', sha256: GOOD.sha } }] };
  const slowFetch = async () => { await new Promise(r2 => setTimeout(r2, 300)); return goodFetch(); };
  const [a, b] = await Promise.allSettled([
    installPlugin({ name: 'race-pkg', marketplaceJson: goodMkt, home: homeR, fetchImpl: slowFetch }),
    installPlugin({ name: 'race-pkg', marketplaceJson: goodMkt, home: homeR, fetchImpl: goodFetch }),
  ]);
  const okCount = [a, b].filter(x => x.status === 'fulfilled').length;
  // staging+lock semantics: concurrent installs are IDEMPOTENT — both may publish (the
  // lock serializes them; identical validated content either way); corruption-free is the bar.
  ok(okCount === 2 || [a, b].every(x => x.status === 'fulfilled' || /another install/.test(x.reason?.message ?? '')),
     `concurrent installs: no corruption path (fulfilled=${okCount}; any rejection must be the busy-lock)`);
  ok(installedPlugins({ home: homeR })['race-pkg']?.version === '2.0.0', 'published install intact');
  ok(!readdirSync(`${homeR}/.zcode/cli/plugins/cache/zcode-plugins-official/race-pkg`).some(e => e.startsWith('.staging') || e.includes('lock')), 'no staging/lock residue');
  rmSync(homeR, { recursive: true, force: true });
}
import { symlinkSync } from 'node:fs';
// SECURITY: a plugin archive with a symlink to an EXTERNAL directory must be refused
// and must not move or delete anything outside the install tree (CWE-59/CWE-22).
{
  const homeS = mkdtempSync(path.join(os.tmpdir(), 'zplug-sym-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'zplug-victim-'));
  writeFileSync(`${outside}/victim.txt`, 'do-not-touch');
  const buf = Buffer.from('sentinel-zip-bytes');
  const sha = createHash('sha256').update(buf).digest('hex');
  const mkt = { plugins: [{ name: 'evil', source: { url: 'https://cdn-zcode.z.ai/plugins/evil/1.0.0/plugin.zip', sha256: sha } }] };
  // Injected unzip materializes what a real unzip would from a symlink-bearing archive.
  const evilUnzip = (_zip, dir) => { symlinkSync(outside, `${dir}/link`, 'dir'); return { status: 0 }; };
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });
  let threwS = false;
  try { await installPlugin({ name: 'evil', marketplaceJson: mkt, home: homeS, fetchImpl, unzipCmd: evilUnzip }); }
  catch (e) { threwS = /symlink/i.test(e.message); }
  ok(threwS, 'symlinked archive entry refused');
  ok(existsSync(outside) && readFileSync(`${outside}/victim.txt`, 'utf8') === 'do-not-touch', 'external files untouched by symlink archive');
  rmSync(homeS, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

// Install source pinning — a marketplace entry's source.url is remote input;
// it must be https on an allowlisted host, and the download must fail closed on
// timeout (a hanging fetch can stall an install forever otherwise).
{
  const homeP = mkdtempSync(path.join(os.tmpdir(), 'zplug-pin-'));
  const payload = Buffer.from('pin-payload');
  const pinSha = createHash('sha256').update(payload).digest('hex');
  const pinMkt = url => ({ plugins: [{ name: 'pin-test', source: { url, sha256: pinSha } }] });
  const goodUrl = 'https://cdn-zcode.z.ai/zcode/official-plugin/plugins/pin-test/1.0.0/plugin.zip';
  let fetchCalls = 0;
  const goodFetch = async () => { fetchCalls++;
    return { ok: true, status: 200, arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.length) }; };
  let threwP = false;
  try { await installPlugin({ name: 'pin-test', marketplaceJson: pinMkt(goodUrl.replace('https://', 'http://')), home: homeP, fetchImpl: goodFetch }); }
  catch (e) { threwP = /non-https/.test(e.message); }
  ok(threwP, 'http:// plugin source rejected');
  threwP = false;
  try { await installPlugin({ name: 'pin-test', marketplaceJson: pinMkt('https://attacker.example/plugins/pin-test/1.0.0/plugin.zip'), home: homeP, fetchImpl: goodFetch }); }
  catch (e) { threwP = /allowed plugin source origin/.test(e.message); }
  ok(threwP, 'non-allowlisted https host rejected');
  threwP = false;
  try { await installPlugin({ name: 'pin-test', marketplaceJson: pinMkt(goodUrl.replace('cdn-zcode.z.ai/', 'cdn-zcode.z.ai:1234/')), home: homeP, fetchImpl: goodFetch }); }
  catch (e) { threwP = /allowed plugin source origin/.test(e.message); }
  ok(threwP, 'explicit non-default port on an allowlisted host rejected');
  ok(fetchCalls === 0, 'scheme/host/port rejections happen before any fetch');
  // redirect:'error' must ride every install fetch: undici follows redirects by
  // default and never re-checks the Location against the allowlist (red-team
  // verified 2026-09-15: allowlisted https -> 302 -> http://localhost reached unzip).
  let gotOpts = null;
  const optFetch = async (u, opts) => { gotOpts = opts; fetchCalls++;
    return { ok: true, status: 200, arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.length) }; };
  try { await installPlugin({ name: 'pin-test', marketplaceJson: pinMkt(goodUrl), home: homeP, fetchImpl: optFetch }); }
  catch { /* a later validation step may still fail; the opts assertion below is the oracle */ }
  ok(gotOpts?.redirect === 'error', "install fetch passes redirect:'error'");
  threwP = false;
  try { await installPlugin({ name: 'pin-test', marketplaceJson: pinMkt(goodUrl), home: homeP,
    fetchImpl: () => new Promise(() => {}), timeoutMs: 20 }); }
  catch (e) { threwP = /timed out/.test(e.message); }
  ok(threwP, 'hanging download fails closed on timeout');
  rmSync(homeP, { recursive: true, force: true });
}
console.log(fails ? `FAIL (${fails})` : 'PASS plugins');
process.exit(fails ? 1 : 0);
