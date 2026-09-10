// Read-only listing of official ZCode hook config. Locations and the 7-event
// protocol are from https://zcode.z.ai/en/docs/hooks (fetched 2026-09-10):
//   user     ~/.zcode/cli/config.json   (hooks.enabled + hooks.events)
//   plugin   <plugin>/hooks/hooks.json  (auto-discovered; manifest.hooks also)
//   legacy   <cwd>/.agents/settings.json and <cwd>/.claude/settings.json
//            (read-only display, not executed)
//   project  <cwd>/.zcode/config.json and <cwd>/zcode.json
//            (ignored as a whole: config_project_hooks_ignored)
// Event names come from the files. This module never invents events and never
// executes hook scripts.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Official ZCode hook events, in documented execution order. Not a listing seed. */
export const OFFICIAL_HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
]);

const OFFICIAL_SET = new Set(OFFICIAL_HOOK_EVENTS);
const HOOK_META = new Set(['enabled', 'timeoutMs', 'maxOutputBytes', 'timeout', 'description']);

const readJson = (file) => {
  try { return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) }; }
  catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { missing: true };
    return { error: e instanceof SyntaxError ? 'invalid json' : (e?.message || 'read failed') };
  }
};

const isInside = (root, candidate) => {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const summarizeHook = (hook) => {
  if (!hook || typeof hook !== 'object' || Array.isArray(hook)) return null;
  if (hook.type == null && hook.command == null) return null;
  const out = {
    type: typeof hook.type === 'string' ? hook.type : null,
    command: typeof hook.command === 'string' ? hook.command : null,
    enabled: hook.enabled !== false,
  };
  if (Array.isArray(hook.args)) out.args = hook.args.map(String);
  if (hook.timeoutMs != null) out.timeoutMs = hook.timeoutMs;
  else if (hook.timeout != null) out.timeout = hook.timeout;
  if (hook.async === true) out.async = true;
  return out;
};

const groupsFrom = (value) => {
  if (!Array.isArray(value)) return [];
  const groups = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (Array.isArray(item.hooks)) {
      const hooks = item.hooks.map(summarizeHook).filter(Boolean);
      groups.push({ matcher: item.matcher ?? null, hooks });
      continue;
    }
    const hook = summarizeHook(item);
    if (hook) groups.push({ matcher: item.matcher ?? null, hooks: [hook] });
  }
  return groups;
};

/** Keys whose values are arrays are event declarations. Meta keys are not events. */
export function eventMapFromHooks(hooks) {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return {};
  if (hooks.events && typeof hooks.events === 'object' && !Array.isArray(hooks.events)) {
    return Object.fromEntries(Object.entries(hooks.events).filter(([, v]) => Array.isArray(v)));
  }
  const out = {};
  for (const [key, value] of Object.entries(hooks)) {
    if (HOOK_META.has(key) || !Array.isArray(value)) continue;
    out[key] = value;
  }
  return out;
}

const declaredEvents = (map) => Object.entries(map).map(([event, value]) => ({
  event,
  official: OFFICIAL_SET.has(event),
  groups: groupsFrom(value),
}));

const sourceEvents = (json, nested) => {
  const hooks = nested ? json?.hooks : json;
  return declaredEvents(eventMapFromHooks(hooks));
};

function walkPluginRoots(home) {
  const base = path.join(home, '.zcode', 'cli', 'plugins');
  const roots = [];
  const seen = new Set();
  const addIfPlugin = (dir) => {
    let st;
    try { st = statSync(dir); } catch { return false; }
    if (!st.isDirectory()) return false;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return true;
    if (existsSync(path.join(dir, '.zcode-plugin', 'plugin.json'))
      || existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))
      || existsSync(path.join(dir, 'hooks', 'hooks.json'))) {
      seen.add(resolved);
      roots.push(resolved);
      return true;
    }
    return false;
  };
  for (const layout of ['cache', 'data']) {
    let names;
    try { names = readdirSync(path.join(base, layout)); } catch { continue; }
    for (const name of names) {
      const pluginOrMarket = path.join(base, layout, name);
      if (addIfPlugin(pluginOrMarket)) continue;
      let nested;
      try { nested = readdirSync(pluginOrMarket); } catch { continue; }
      for (const plugin of nested) {
        const pluginDir = path.join(pluginOrMarket, plugin);
        if (addIfPlugin(pluginDir)) continue;
        let versions;
        try { versions = readdirSync(pluginDir); } catch { continue; }
        for (const version of versions) addIfPlugin(path.join(pluginDir, version));
      }
    }
  }
  return roots;
}

function readManifest(pluginRoot) {
  for (const rel of ['.zcode-plugin/plugin.json', '.claude-plugin/plugin.json']) {
    const file = path.join(pluginRoot, rel);
    const json = readJson(file);
    if (json.ok && json.value && typeof json.value === 'object') return { file, value: json.value };
  }
  return { file: null, value: null };
}

function eventsFromHookFile(json) {
  if (!json || typeof json !== 'object') return [];
  if (json.hooks != null) return sourceEvents(json, true);
  return sourceEvents(json, false);
}

function pluginHookPayloads(pluginRoot, manifest, manifestFile) {
  const payloads = [];
  const seen = new Set();
  const addFile = (file) => {
    const resolved = path.resolve(file);
    if (seen.has(resolved) || !isInside(pluginRoot, resolved) || !existsSync(resolved)) return;
    seen.add(resolved);
    payloads.push({ path: resolved });
  };
  addFile(path.join(pluginRoot, 'hooks', 'hooks.json'));
  const field = manifest?.hooks;
  const items = field == null ? [] : Array.isArray(field) ? field : [field];
  for (const item of items) {
    if (typeof item === 'string') {
      addFile(path.resolve(pluginRoot, item));
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      payloads.push({ path: manifestFile || path.join(pluginRoot, '.zcode-plugin/plugin.json'), inline: item });
    }
  }
  return payloads;
}

function pluginActive(name, config) {
  if ((config?.plugins?.suppressedBuiltins ?? []).includes(name)) return false;
  const map = config?.plugins?.enabledPlugins;
  if (!map || typeof map !== 'object') return true;
  if (Object.prototype.hasOwnProperty.call(map, name)) return map[name] === true;
  for (const [key, value] of Object.entries(map)) {
    if (key === `${name}` || key.startsWith(`${name}@`)) return value === true;
  }
  return true;
}

function collectUnique(sources) {
  const events = [];
  const seen = new Set();
  for (const source of sources) {
    for (const row of source.events ?? []) {
      if (!seen.has(row.event)) { seen.add(row.event); events.push(row.event); }
    }
  }
  return events;
}

function pushFileSource(sources, { kind, file, executed, reason, enabled, plugin, pluginVersion, nested = true }) {
  const json = readJson(file);
  if (json.missing) return;
  if (json.error) {
    sources.push({ kind, path: file, executed, reason, enabled, plugin, pluginVersion, error: json.error, events: [] });
    return;
  }
  if (nested && json.value?.hooks == null) return;
  sources.push({
    kind, path: file, executed, reason, enabled, plugin, pluginVersion,
    events: sourceEvents(json.value, nested),
  });
}

/**
 * List hook configuration the official runtime would consult.
 * `{ home, cwd }` are injectable so tests stay hermetic. Never spawns a hook.
 */
export function listHooks({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const sources = [];
  const userFile = path.join(home, '.zcode', 'cli', 'config.json');
  const userJson = readJson(userFile);
  let userConfig = null;
  if (userJson.ok) {
    userConfig = userJson.value;
    const hooks = userConfig?.hooks;
    if (hooks != null) {
      sources.push({
        kind: 'user',
        path: userFile,
        executed: hooks.enabled === true,
        enabled: hooks.enabled === true,
        reason: hooks.enabled === true ? undefined : 'hooks.enabled is not true',
        events: sourceEvents(userConfig, true),
      });
    }
  } else if (userJson.error) {
    sources.push({ kind: 'user', path: userFile, executed: false, error: userJson.error, events: [] });
  }

  for (const pluginRoot of walkPluginRoots(home)) {
    const manifest = readManifest(pluginRoot);
    const name = typeof manifest.value?.name === 'string' ? manifest.value.name : path.basename(pluginRoot);
    const version = typeof manifest.value?.version === 'string' ? manifest.value.version : undefined;
    const executed = pluginActive(name, userConfig);
    const reason = executed ? undefined : 'plugin disabled or suppressed';
    for (const payload of pluginHookPayloads(pluginRoot, manifest.value, manifest.file)) {
      if (payload.inline) {
        sources.push({
          kind: 'plugin', path: payload.path, plugin: name, pluginVersion: version,
          executed, reason, events: declaredEvents(eventMapFromHooks(payload.inline)),
        });
        continue;
      }
      const json = readJson(payload.path);
      if (json.missing) continue;
      if (json.error) {
        sources.push({
          kind: 'plugin', path: payload.path, plugin: name, pluginVersion: version,
          executed, reason, error: json.error, events: [],
        });
        continue;
      }
      sources.push({
        kind: 'plugin', path: payload.path, plugin: name, pluginVersion: version,
        executed, reason, events: eventsFromHookFile(json.value),
      });
    }
  }

  pushFileSource(sources, {
    kind: 'project', file: path.join(cwd, '.zcode', 'config.json'),
    executed: false, reason: 'config_project_hooks_ignored',
  });
  pushFileSource(sources, {
    kind: 'project', file: path.join(cwd, 'zcode.json'),
    executed: false, reason: 'config_project_hooks_ignored',
  });
  pushFileSource(sources, {
    kind: 'legacy', file: path.join(cwd, '.agents', 'settings.json'),
    executed: false, reason: 'read-only display, not executed',
  });
  pushFileSource(sources, {
    kind: 'legacy', file: path.join(cwd, '.claude', 'settings.json'),
    executed: false, reason: 'read-only display, not executed',
  });

  return { sources, events: collectUnique(sources) };
}

export function formatHooksText(report) {
  if (!report?.sources?.length) return 'no hooks configured';
  const lines = [];
  for (const source of report.sources) {
    const head = [source.kind];
    if (source.plugin) head.push(source.plugin + (source.pluginVersion ? `@${source.pluginVersion}` : ''));
    head.push(source.path);
    if (source.executed === false) head.push(`not executed (${source.reason ?? 'disabled'})`);
    lines.push(head.join('  '));
    if (source.error) {
      lines.push(`  error: ${source.error}`);
      continue;
    }
    if (!source.events.length) lines.push('  (no events declared)');
    else for (const row of source.events) lines.push(`  ${row.event}`);
  }
  lines.push(`events: ${report.events.length ? report.events.join(', ') : '(none)'}`);
  return lines.join('\n');
}
