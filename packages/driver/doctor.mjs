// G8: codex/claude doctor print an environment block —
// node build, credential source, config path, extension counts, disk, logs —
// while `zagent doctor` showed three lines. These are the shared depth lines so
// `zagent doctor` and the TUI `/doctor` mirror cannot drift apart.
// Everything here is read-only and must never throw.
import { existsSync, readFileSync, realpathSync, statfsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installedPlugins } from './plugins.mjs';
import { listHooks } from './hooks-cli.mjs';

/** Node runtime line, e.g. `node: v22.22.0 linux-x64`. */
export function nodeLine() {
  return `node: ${process.version} ${process.platform}-${process.arch}`;
}

/**
 * Which credential zagent will actually use, in effective order:
 * env key -> the SELECTED cli config provider's key (same rule as quota's
 * resolveCodingPlanKey: model.main picks the provider) -> kernel OAuth store ->
 * ccz fallback. The ccz file is only a bootstrap source: ensureConfig consumes
 * it when no cli config exists, so it is not claimed while `hasConfig`.
 * Returns the source label or null when nothing is configured.
 */
export function doctorCredential({ env = process.env, home = os.homedir(), config = null, hasConfig = config != null, exists = existsSync } = {}) {
  if (typeof env.ZAI_API_KEY === 'string' && env.ZAI_API_KEY.trim()) return 'ZAI_API_KEY (env)';
  const providerId = typeof config?.model?.main === 'string' && /^[^/]+\/.+$/.test(config.model.main)
    ? config.model.main.split('/')[0] : null;
  const key = providerId ? config?.provider?.[providerId]?.options?.apiKey : null;
  if (typeof key === 'string' && key.trim() !== '')
    return `cli config provider "${providerId.replace(/[^\w:@.-]/g, '?')}"`;
  try {
    const s = JSON.parse(readFileSync(path.join(home, '.zcode', 'v2', 'credentials.json'), 'utf8'));
    if (typeof s['oauth:zai:access_token'] === 'string' && s['oauth:zai:access_token'] !== '')
      return 'kernel OAuth store (zagent login)';
  } catch { /* no OAuth store */ }
  if (!hasConfig && exists(path.join(home, '.config', 'ccz', '.api_key'))) return 'ccz fallback (~/.config/ccz/.api_key)';
  return null;
}

// Server maps are {name: def} objects; kernel schemas also carry mcpServers as
// arrays of server objects (plugin manifests may instead give a PATH string or
// array — those are not servers, so array items are counted only when objects).
const countValue = (v) => Array.isArray(v) ? v.filter(i => i && typeof i === 'object' && !Array.isArray(i)).length
  : v && typeof v === 'object' ? Object.keys(v).length : 0;

// The cli config's real MCP shape is mcp.servers (public-acceptance.mjs writes
// it); some kernel schemas and .mcp.json use mcpServers. Count both.
const mcpCount = (json) => countValue(json?.mcpServers) + countValue(json?.mcp?.servers);

/**
 * Installed-plugin / configured-hook / MCP-server counts. MCP servers are read
 * from the user cli config, the project files the kernel consults
 * (<cwd>/.zcode/config.json, <cwd>/zcode.json, <cwd>/.mcp.json) and installed
 * plugins (<root>/.mcp.json + manifest mcpServers) — counts are configured, not
 * connected (a live status needs a session, which doctor never spawns).
 */
export function extensionCounts({ home = os.homedir(), cwd = process.cwd(), config = null } = {}) {
  const out = { plugins: 0, hooks: 0, hookEvents: 0, hooksDisabled: 0, mcp: 0 };
  let plugins = {};
  try { plugins = installedPlugins({ home }); out.plugins = Object.keys(plugins).length; } catch { /* count stays 0 */ }
  try {
    const report = listHooks({ home, cwd });
    const events = new Set();
    for (const s of report.sources)
      for (const e of s.events ?? []) {
        if (s.executed !== false) events.add(e.event);
        for (const g of e.groups ?? []) {
          const n = (g.hooks ?? []).length;
          if (s.executed === false) out.hooksDisabled += n; else out.hooks += n;
        }
      }
    out.hookEvents = events.size;
  } catch { /* counts stay 0 */ }
  out.mcp = mcpCount(config);
  for (const file of [path.join(cwd, '.zcode', 'config.json'), path.join(cwd, 'zcode.json'), path.join(cwd, '.mcp.json')]) {
    try { out.mcp += mcpCount(JSON.parse(readFileSync(file, 'utf8'))); } catch { /* absent is 0 */ }
  }
  // Installed plugins contribute servers via <root>/.mcp.json and the manifest's
  // mcpServers field (kernel KF merges both). "Configured" counts on-disk
  // sources; enablement is a session decision doctor does not second-guess.
  for (const p of Object.values(plugins)) {
    try { out.mcp += mcpCount(JSON.parse(readFileSync(path.join(p.path, '.mcp.json'), 'utf8'))); } catch { /* none */ }
    for (const rel of ['.zcode-plugin/plugin.json', '.claude-plugin/plugin.json']) {
      try { out.mcp += mcpCount(JSON.parse(readFileSync(path.join(p.path, rel), 'utf8'))); } catch { /* none */ }
    }
  }
  return out;
}

/**
 * `~/...` display form for paths under the user's home. Doctor output is read
 * on shared or screenshotted terminals, so absolute home paths never print.
 * Symlinked or case-divergent homes (macOS /var→/private/var, FreeBSD
 * /home→/usr/home) are retried on real paths before falling back to absolute.
 */
export function displayPath(p, home = os.homedir()) {
  if (typeof p !== 'string' || !p) return String(p ?? '');
  let abs = path.resolve(p);
  let homeAbs = path.resolve(typeof home === 'string' && home ? home : os.homedir());
  if (abs !== homeAbs && !abs.startsWith(homeAbs + path.sep)) {
    try {
      const ra = realpathSync(abs), rh = realpathSync(homeAbs);
      abs = ra; homeAbs = rh; // swap both only when both resolve
    } catch { /* lexical stands */ }
  }
  if (abs === homeAbs) return '~';
  if (abs.startsWith(homeAbs + path.sep))
    return `~${abs.slice(homeAbs.length).split(path.sep).join('/')}`;
  return abs.split(path.sep).join('/');
}

const REGEXP_META = /[.*+?^${}()|[\]\\]/g;

/** displayPath for paths embedded inside longer text (error messages). */
export function displayText(text, home = os.homedir()) {
  const homeAbs = path.resolve(typeof home === 'string' && home ? home : os.homedir());
  if (homeAbs === path.parse(homeAbs).root) return String(text ?? ''); // '/' home: nothing to relativize
  const re = new RegExp(`${homeAbs.replace(REGEXP_META, '\\$&')}(?=$|[\\\\/\\s'"\\])\`}])`, 'g');
  return String(text ?? '').replace(re, '~');
}

/** `hooks: N configured · M events[ · K disabled]` from extensionCounts. */
export function hooksLine(ext) {
  return `hooks: ${ext.hooks} configured${ext.hookEvents ? ` · ${ext.hookEvents} event${ext.hookEvents === 1 ? '' : 's'}` : ''}${ext.hooksDisabled ? ` · ${ext.hooksDisabled} disabled` : ''}`;
}

/** `disk: N.N GB free (<dir>)`, or null when statfs is unavailable. */
export function diskLine(dir = os.homedir(), home = os.homedir()) {
  try {
    const s = statfsSync(dir);
    return `disk: ${((s.bavail * s.bsize) / 1e9).toFixed(1)} GB free (${displayPath(dir, home)})`;
  } catch { return null; }
}

/** The zagent log dir line; honest when nothing has written logs yet. */
export function logDirLine(home = os.homedir(), exists = existsSync) {
  const dir = path.join(home, '.zcode', 'cli', 'log');
  return `logs: ${displayPath(dir, home)}${exists(dir) ? '' : ' (not created yet)'}`;
}
