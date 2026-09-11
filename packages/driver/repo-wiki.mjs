// Read-only discovery of official ZCode repo-wiki artifacts.
// Path from https://zcode.z.ai/en/docs/repo-wiki (fetched 2026-09-10):
//   ~/.zcode/v2/repo-wiki/<sha256(workspaceKey)[:12]>/wiki.json
// Generation is GUI-only. This module never writes wiki files and never
// returns page bodies by default.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** Official GUI hash: sha256(workspaceKey).digest('hex').slice(0, 12). */
export function repoWikiHash(workspaceKey) {
  return createHash('sha256').update(String(workspaceKey ?? '')).digest('hex').slice(0, 12);
}

export function repoWikiRoot({ home = os.homedir() } = {}) {
  return path.join(home, '.zcode', 'v2', 'repo-wiki');
}

function isFile(file) {
  try { return statSync(file).isFile(); } catch { return false; }
}

function readWikiFile(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { path: file };
    return { path: file, body: value };
  } catch {
    return { path: file };
  }
}

function wikiTitle(body) {
  const ctx = body?.context;
  const name = ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx.name : null;
  if (typeof name === 'string' && name.trim()) return name.trim();
  if (typeof body?.title === 'string' && body.title.trim()) return body.title.trim();
  return undefined;
}

export function summarizeWiki(file, body) {
  const out = { path: file };
  const title = wikiTitle(body);
  if (title) out.title = title;
  return out;
}

const samePath = (a, b) => path.resolve(String(a)) === path.resolve(String(b));

/** Existing wiki.json files under ~/.zcode/v2/repo-wiki. Path + title only. */
export function listRepoWikis({ home = os.homedir() } = {}) {
  const root = repoWikiRoot({ home });
  let names;
  try { names = readdirSync(root); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const file = path.join(root, name, 'wiki.json');
    if (!isFile(file)) continue;
    const read = readWikiFile(file);
    out.push(summarizeWiki(read.path, read.body));
  }
  return out;
}

/**
 * Wiki for the current workspace, or null. Looks up the official hash path
 * first, then scans remaining wiki.json files for a workspaceKey/path match.
 */
export function inspectWiki({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const resolved = path.resolve(cwd);
  const hashed = path.join(repoWikiRoot({ home }), repoWikiHash(resolved), 'wiki.json');
  if (isFile(hashed)) {
    const read = readWikiFile(hashed);
    return summarizeWiki(read.path, read.body);
  }
  for (const row of listRepoWikis({ home })) {
    const read = readWikiFile(row.path);
    const key = read.body?.workspaceKey;
    const wsPath = read.body?.workspacePath;
    if ((typeof key === 'string' && samePath(key, resolved))
      || (typeof wsPath === 'string' && samePath(wsPath, resolved))) {
      return summarizeWiki(read.path, read.body);
    }
  }
  return null;
}
