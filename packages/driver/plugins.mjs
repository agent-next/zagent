// I7: plugin update semantics — marketplace version (from CDN URL path) vs installed
// manifest version, with the suppressed-builtin marker. Shapes from the LIVE store
// (2026-09-06): marketplace entries {name, source:{url: '…/plugins/<name>/<ver>/plugin.zip', sha256}};
// installed plugins carry .zcode-plugin/plugin.json {name, version}.
import { readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync, lstatSync, renameSync, rmdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const parseSemver = v => { // r12 #3: tolerate '1.0' as 1.0.0; NaN parts make the whole version invalid (null)
  const m = String(v ?? '').match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: m[3] !== undefined ? +m[3] : 0, pre: m[4] ?? null };
};
const cmpSemver = (a, b) => {
  const va = parseSemver(a), vb = parseSemver(b);
  if (!va || !vb) return null; // uncomparable — caller must NOT infer ordering
  for (const k of ['major', 'minor', 'patch']) if (va[k] !== vb[k]) return va[k] < vb[k] ? -1 : 1;
  if (!va.pre && !vb.pre) return 0;
  if (!va.pre) return 1;               // release > prerelease
  if (!vb.pre) return -1;
  return va.pre < vb.pre ? -1 : va.pre > vb.pre ? 1 : 0;
};

export function marketplaceVersions(marketplaceJson) {
  const out = {};
  for (const p of marketplaceJson?.plugins ?? []) {
    if (!p?.name) continue;
    // CDN entries carry source.url …/plugins/<name>/<ver>/plugin.zip; BUILTIN entries
    // carry cachePath …/<name>/<ver> instead (live-verified 2026-09-06: browser-use & co).
    const m = String(p.source?.url ?? '').match(/\/plugins\/[^/]+\/([^/]+)\/plugin\.zip$/)
      ?? String(p.cachePath ?? '').match(/\/([^/]+)\/?$/);
    if (m) out[p.name] = { version: m[1], sha256: p.source?.sha256 ?? null };
  }
  return out;
}

export function installedPlugins({ home = os.homedir() } = {}) {
  const dir = `${home}/.zcode/cli/plugins`;
  const out = {};
  const add = mf => { try { const j = JSON.parse(readFileSync(mf, 'utf8'));
    if (j?.name && j?.version) { const c = out[j.name] ? cmpSemver(out[j.name].version, j.version) : -1; if (c === null || c < 0) {} else if (c > 0) return; } if (j?.name && j?.version && (!out[j.name] || cmpSemver(out[j.name].version, j.version) === -1))
      out[j.name] = { version: j.version, path: path.dirname(mf) }; } catch {} };
  for (const base of ['cache', 'data']) { // flat layout
    let names; try { names = readdirSync(`${dir}/${base}`); } catch { continue; }
    for (const n of names) add(`${dir}/${base}/${n}/.zcode-plugin/plugin.json`);
  }
  // I8: THIRD layout — cache/<marketplace>/<name>/<version>/.zcode-plugin/plugin.json
  // (version-nested; report the HIGHEST version per name)
  let mkts; try { mkts = readdirSync(`${dir}/cache`); } catch { mkts = []; }
  for (const mk of mkts) {
    let names; try { names = readdirSync(`${dir}/cache/${mk}`); } catch { continue; }
    for (const n of names) {
      let vers; try { vers = readdirSync(`${dir}/cache/${mk}/${n}`); } catch { continue; }
      for (const v of vers) add(`${dir}/cache/${mk}/${n}/${v}/.zcode-plugin/plugin.json`);
    }
  }
  return out;
}

export function suppressedBuiltins({ home = os.homedir() } = {}) {
  try { return JSON.parse(readFileSync(`${home}/.zcode/cli/config.json`, 'utf8'))?.plugins?.suppressedBuiltins ?? []; }
  catch { return []; }
}

export function updateReport({ marketplace, installed, suppressed = [] }) {
  const rows = [];
  const sup = new Set(suppressed);
  for (const [name, mk] of Object.entries(marketplace ?? {})) {
    const inst = installed?.[name];
    let badge = 'not-installed';
    if (inst) {
      const c = cmpSemver(inst.version, mk.version);
      badge = c === null ? 'unknown-version' : c < 0 ? 'update-available' : 'ok'; // r12 #3: uncomparable is NOT ok
    }
    rows.push({ name, installed: inst?.version ?? null, marketplace: mk.version, badge,
      suppressed: sup.has(name) ? true : undefined });
  }
  for (const name of Object.keys(installed ?? {})) if (!(name in (marketplace ?? {})))
    rows.push({ name, installed: installed[name].version, marketplace: null, badge: 'orphan', suppressed: sup.has(name) ? true : undefined }); // r12 #4: orphans keep the suppression marker
  return rows;
}

export function updateLine(rows) {
  if (!rows?.length) return 'no plugins tracked';
  return rows.map(r => `${r.name}: ${r.badge}${r.installed ? ` (${r.installed}${r.marketplace ? ' → ' + r.marketplace : ''})` : ''}${r.suppressed ? ' [suppressed]' : ''}`).join('\n');
}

// J3: plugin install — download the marketplace zip, VERIFY sha256 (entries carry it),
// unpack into the runtime's cache layout cache/<marketplace>/<name>/<version>/.
// The runtime discovers that layout itself (I8 census). Refuse on hash mismatch — never
// unpack unverified bytes.
import { createHash, randomUUID } from 'node:crypto';
import { defaultUnzipCmd } from './extract.mjs';

/** The official marketplace, as the runtime itself records it. */
export const OFFICIAL_MARKETPLACE_URL = 'https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json';

/**
 * Refresh a marketplace catalog from its source of truth.
 *
 * installPlugin() has always verified and installed correctly, but the CLI only
 * ever read the LOCAL cache — and that cache is written by the desktop app, so on
 * this machine it was 5 weeks stale and listed 2 plugins while the CDN listed 18.
 * `zagent plugins install video2code` therefore failed with "no verifiable source"
 * for a plugin that exists and is published.
 *
 * The URL comes from the runtime's own known_marketplaces.json when present, and
 * is required to be https on the official CDN host — a local file is not a
 * sufficient reason to fetch from anywhere.
 */
export async function fetchMarketplace({ marketplaceId = 'zcode-plugins-official', home = os.homedir(),
  fetchImpl = fetch, timeoutMs = 8000, write = true } = {}) {
  let url = OFFICIAL_MARKETPLACE_URL;
  try {
    const known = JSON.parse(readFileSync(`${home}/.zcode/cli/plugins/known_marketplaces.json`, 'utf8'));
    const entry = (known?.marketplaces ?? []).find(m => m?.id === marketplaceId);
    if (typeof entry?.source?.url === 'string') url = entry.source.url;
  } catch { /* no record: the official default stands */ }

  const parsed = (() => { try { return new URL(url); } catch { return null; } })();
  if (!parsed || parsed.protocol !== 'https:' || parsed.hostname !== 'cdn-zcode.z.ai')
    throw new Error(`marketplace refresh: refusing a non-official source (${url})`);

  const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`marketplace refresh: http ${r.status}`);
  const json = await r.json();
  if (!Array.isArray(json?.plugins)) throw new Error('marketplace refresh: response has no plugins array');

  if (write) {
    // Cache beside the runtime's own copy, under our own filename, so a refresh
    // never overwrites what the desktop app maintains.
    const dir = `${home}/.zcode/cli/plugins/marketplaces/${marketplaceId}`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/zagent-marketplace.json`, JSON.stringify(json, null, 1));
    } catch { /* a read-only home must not fail the install */ }
  }
  return json;
}

export async function installPlugin({ name, marketplaceJson, marketplaceId = 'zcode-plugins-official', home = os.homedir(),
  fetchImpl = fetch, renameImpl = renameSync,
  unzipCmd = defaultUnzipCmd() } = {}) {
  const validSegment = value => typeof value === 'string' && value.length > 0 &&
    value !== '.' && value !== '..' && !/[\/\\\0:]/.test(value) && !path.isAbsolute(value);
  if (!validSegment(name) || !validSegment(marketplaceId)) throw new Error('install: invalid plugin or marketplace identifier');
  const entry = (marketplaceJson?.plugins ?? []).find(p => p?.name === name);
  if (!entry?.source?.url || !entry.source.sha256) throw new Error(`install: no verifiable source for '${name}' (need url+sha256)`);
  const version = String(entry.source.url).match(/\/plugins\/[^/]+\/([^/]+)\/plugin\.zip$/)?.[1];
  if (!validSegment(version)) throw new Error('install: invalid marketplace version');
  const r = await fetchImpl(entry.source.url);
  if (!r.ok) throw new Error(`install: download failed http ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== entry.source.sha256) throw new Error(`install: sha256 MISMATCH (got ${sha.slice(0, 8)}…, expected ${entry.source.sha256.slice(0, 8)}…) — refusing to unpack`);

  // r18: work in a UNIQUE staging dir; publish (lock + rename) only after full
  // validation — concurrent installs can never corrupt the live destination, and
  // any failure cleans its own staging without touching installed state.
  const base = `${home}/.zcode/cli/plugins/cache/${marketplaceId}/${name}`;
  const dir = `${base}/${version}`;
  const staging = `${base}/.staging-${randomUUID()}`;
  const backup = `${base}/.backup-${randomUUID()}`;
  const lock = `${base}/.install.lock`;
  let cleanupWarning;
  try {
    mkdirSync(staging, { recursive: true });
    const zipPath = `${staging}/.download.zip`;
    writeFileSync(zipPath, buf);
    const uz = unzipCmd(zipPath, staging);
    rmSync(zipPath, { force: true });
    if (uz.status !== 0) throw new Error(`install: unzip failed rc ${uz.status}`);
    // SECURITY (CWE-59/CWE-22): a crafted archive can contain a symlink that points
    // outside the install tree; the hoist and cleanup below would then follow it and
    // move or delete external files. Refuse any symlink anywhere in the payload.
    const assertNoSymlinks = (root) => {
      for (const de of readdirSync(root, { withFileTypes: true })) {
        if (de.isSymbolicLink()) throw new Error(`install: unpacked payload contains a symlink ('${de.name}') \u2014 refusing`);
        if (de.isDirectory()) assertNoSymlinks(`${root}/${de.name}`);
      }
    };
    assertNoSymlinks(staging);
    // Official zips nest one top-level dir; the runtime's cache is FLAT — hoist.
    if (!existsSync(`${staging}/.zcode-plugin`)) {
      const entries = readdirSync(staging).filter(e => !e.startsWith('.'));
      if (entries.length === 1 && lstatSync(`${staging}/${entries[0]}`).isDirectory()) {
        const inner = `${staging}/${entries[0]}`;
        for (const e of readdirSync(inner)) renameSync(`${inner}/${e}`, `${staging}/${e}`);
        rmdirSync(inner);
      }
    }
    const mfPath = `${staging}/.zcode-plugin/plugin.json`;
    if (!existsSync(mfPath)) throw new Error('install: unpacked layout has no .zcode-plugin/plugin.json');
    // r18: identity check — the manifest must BE the plugin we asked for
    let mf; try { mf = JSON.parse(readFileSync(mfPath, 'utf8')); } catch { throw new Error('install: manifest is not valid JSON'); }
    if (mf?.name !== name) throw new Error(`install: manifest name '${mf?.name}' ≠ requested '${name}' — refusing`);
    if (mf?.version !== version) throw new Error(`install: manifest version '${mf?.version}' ≠ marketplace '${version}'`);

    // Serialize publication; rollback-safe replacement (not a crash-atomic swap).
    let lockFh; try { lockFh = openSync(lock, 'wx'); } catch { throw new Error('install: another install in progress'); }
    try {
      const replacing = existsSync(dir);
      if (replacing) renameImpl(dir, backup);
      try { renameImpl(staging, dir); }
      catch (e) {
        if (replacing) {
          try { renameImpl(backup, dir); }
          catch (rollbackError) {
            throw Object.assign(new AggregateError([e, rollbackError],
              `install: publication failed (${e.message}); rollback failed (${rollbackError.message}); old plugin retained at ${backup}; restore to ${dir}`, { cause: e }),
            { code: 'E_PLUGIN_ROLLBACK_FAILED', backupPath: backup, destinationPath: dir });
          }
        }
        throw e;
      }
      if (replacing) {
        try { rmSync(backup, { recursive: true, force: true }); }
        catch { cleanupWarning = `installed successfully; could not remove backup ${backup}`; }
      }
    } finally { closeSync(lockFh); try { unlinkSync(lock); } catch {} }
    return { name, version, path: dir, ...(cleanupWarning ? { cleanupWarning } : {}) };
  } catch (e) {
    try { rmSync(staging, { recursive: true, force: true }); }
    catch (cleanupError) { e.cleanupError = cleanupError; }
    throw e;
  }
}
