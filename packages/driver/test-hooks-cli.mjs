#!/usr/bin/env node
// Hermetic listing of official ZCode hook config. Temp dirs only; hook scripts
// are never executed.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listHooks, formatHooksText, eventMapFromHooks, OFFICIAL_HOOK_EVENTS } from './hooks-cli.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(root, 'packages', 'cli', 'zagent-hooks.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'zhooks-'));

const makeHome = (tag) => {
  const home = mkdtempSync(path.join(tmp, tag));
  const cwd = path.join(home, 'ws');
  mkdirSync(cwd);
  return { home, cwd };
};

const write = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

ok(OFFICIAL_HOOK_EVENTS.length === 7, 'docs list exactly 7 official events');
ok(OFFICIAL_HOOK_EVENTS.join(',') === 'SessionStart,UserPromptSubmit,PreToolUse,PermissionRequest,PostToolUse,PostToolUseFailure,Stop',
  'official names match zcode.z.ai/en/docs/hooks execution order');

const empty = makeHome('empty-');
const none = listHooks(empty);
ok(none.sources.length === 0 && none.events.length === 0, 'missing files invent no events');
ok(formatHooksText(none) === 'no hooks configured', 'empty listing is explicit');

const userHome = makeHome('user-');
write(path.join(userHome.home, '.zcode/cli/config.json'), {
  hooks: {
    enabled: true,
    timeoutMs: 60000,
    events: {
      PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'process', command: 'node', args: ['scripts/check-write.mjs'] }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
    },
  },
});
const user = listHooks(userHome);
ok(user.events.join(',') === 'PreToolUse,Stop', 'user listing is declared names only');
ok(!user.events.includes('SessionStart'), 'undeclared official events are not invented');
ok(user.sources[0].kind === 'user' && user.sources[0].executed === true, 'enabled user hooks are executed');
ok(user.sources[0].events.every(e => e.official === true), 'declared official names are annotated');

const disabledHome = makeHome('disabled-');
write(path.join(disabledHome.home, '.zcode/cli/config.json'), {
  hooks: { enabled: false, events: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'true' }] }] } },
});
const disabled = listHooks(disabledHome);
ok(disabled.events.join(',') === 'UserPromptSubmit', 'disabled config still declares its events');
ok(disabled.sources[0].executed === false, 'hooks.enabled false is not executed');

const pluginHome = makeHome('plugin-');
const pluginRoot = path.join(pluginHome.home, '.zcode/cli/plugins/cache/zcode-plugins-official/video2code/0.6.0');
write(path.join(pluginRoot, '.zcode-plugin/plugin.json'), { name: 'video2code', version: '0.6.0' });
const marker = path.join(pluginHome.home, 'hook-ran');
const hookScript = path.join(pluginRoot, 'hooks/run.sh');
write(hookScript, `#!/bin/sh\necho ran > "${marker}"\n`);
try { chmodSync(hookScript, 0o755); } catch { /* listing must not execute even if not executable */ }
write(path.join(pluginRoot, 'hooks/hooks.json'), {
  description: 'fixture',
  hooks: {
    SessionStart: [{ matcher: 'startup|clear|compact', hooks: [{ type: 'command', command: hookScript }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookScript }] }],
  },
});
write(path.join(pluginHome.home, '.zcode/cli/plugins/marketplaces/claude-plugins-official/plugins/hookify/hooks/hooks.json'), {
  hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: hookScript }] }] },
});
const plugin = listHooks(pluginHome);
ok(plugin.events.join(',') === 'SessionStart,UserPromptSubmit', 'plugin events come from hooks/hooks.json');
ok(!plugin.events.includes('PreToolUse'), 'marketplace catalog copies are not installed plugins');
ok(plugin.sources.some(s => s.kind === 'plugin' && s.plugin === 'video2code'), 'plugin source is named from the manifest');
ok(!existsSync(marker), 'listing does not execute plugin hook scripts');

const emptyPlugin = makeHome('empty-plugin-');
const emptyRoot = path.join(emptyPlugin.home, '.zcode/cli/plugins/data/android-emulator');
write(path.join(emptyRoot, '.zcode-plugin/plugin.json'), { name: 'android-emulator', version: '0.1.0' });
write(path.join(emptyRoot, 'hooks/hooks.json'), { hooks: {} });
const emptyPlug = listHooks(emptyPlugin);
ok(emptyPlug.events.length === 0, 'empty plugin hooks object invents no events');
ok(emptyPlug.sources.some(s => s.plugin === 'android-emulator'), 'empty plugin file is still a source');

const extraHome = makeHome('extra-');
const extraRoot = path.join(extraHome.home, '.zcode/cli/plugins/data/claude-security');
write(path.join(extraRoot, '.claude-plugin/plugin.json'), { name: 'claude-security', version: '0.0.1' });
write(path.join(extraRoot, 'hooks/hooks.json'), {
  hooks: { UserPromptExpansion: [{ matcher: '^x$', hooks: [{ type: 'command', command: 'true' }] }] },
});
const extra = listHooks(extraHome);
ok(extra.events.join(',') === 'UserPromptExpansion', 'file-declared non-official names are printed, not invented');
ok(extra.sources[0].events[0].official === false, 'non-official names are not labeled official');

const projectHome = makeHome('project-');
write(path.join(projectHome.cwd, '.zcode/config.json'), {
  hooks: { enabled: true, events: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } },
});
write(path.join(projectHome.cwd, 'zcode.json'), {
  hooks: { events: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] } },
});
write(path.join(projectHome.cwd, '.claude/settings.json'), {
  hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] },
});
write(path.join(projectHome.cwd, '.agents/settings.json'), {
  hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'true' }] }] },
});
const project = listHooks(projectHome);
ok(project.events.join(',') === 'Stop,PreToolUse',
  'project files contribute only their declared names');
ok(project.sources.filter(s => s.kind === 'project').every(s => s.executed === false && s.reason === 'config_project_hooks_ignored'),
  'project hooks are listed as ignored');
ok(!project.sources.some(s => s.kind === 'legacy'),
  'kernel-unknown .claude/.agents settings are not listed as official hooks');
ok(!project.events.includes('PostToolUse') && !project.events.includes('PermissionRequest'),
  'Claude/agents settings events are not mixed into the official list');

const badHome = makeHome('bad-');
write(path.join(badHome.home, '.zcode/cli/config.json'), '{not json');
const bad = listHooks(badHome);
ok(bad.events.length === 0, 'invalid json invents no events');
ok(bad.sources[0].error === 'invalid json', 'invalid json is reported');

const inlineHome = makeHome('inline-');
const inlineRoot = path.join(inlineHome.home, '.zcode/cli/plugins/data/inline-hooks');
write(path.join(inlineRoot, '.zcode-plugin/plugin.json'), {
  name: 'inline-hooks',
  version: '1.0.0',
  hooks: { Stop: [{ hooks: [{ type: 'process', command: 'true' }] }] },
});
const inline = listHooks(inlineHome);
ok(inline.events.join(',') === 'Stop', 'inline manifest.hooks object is declared');

const pathHome = makeHome('path-');
const pathRoot = path.join(pathHome.home, '.zcode/cli/plugins/data/path-hooks');
write(path.join(pathRoot, '.zcode-plugin/plugin.json'), {
  name: 'path-hooks', version: '1.0.0', hooks: 'custom/hooks.json',
});
write(path.join(pathRoot, 'custom/hooks.json'), {
  hooks: { PostToolUseFailure: [{ hooks: [{ type: 'command', command: 'true' }] }] },
});
write(path.join(pathRoot, 'hooks/hooks.json'), {
  hooks: { PostToolUseFailure: [{ hooks: [{ type: 'command', command: 'true' }] }] },
});
const pathed = listHooks(pathHome);
ok(pathed.sources.filter(s => s.plugin === 'path-hooks').length === 2, 'standard file and manifest path are both read');
ok(pathed.events.join(',') === 'PostToolUseFailure', 'duplicate event names collapse in the summary');

const escapeHome = makeHome('escape-');
const escapeRoot = path.join(escapeHome.home, '.zcode/cli/plugins/data/escape-hooks');
const outside = path.join(escapeHome.home, 'outside-hooks.json');
write(outside, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } });
write(path.join(escapeRoot, '.zcode-plugin/plugin.json'), {
  name: 'escape-hooks', version: '1.0.0', hooks: '../outside-hooks.json',
});
const escaped = listHooks(escapeHome);
ok(escaped.events.length === 0, 'manifest hooks path cannot escape the plugin root');

ok(eventMapFromHooks({ enabled: true, timeoutMs: 1, PreToolUse: [] }).PreToolUse
  && !('enabled' in eventMapFromHooks({ enabled: true, PreToolUse: [] })),
  'meta keys are not event names');

const suppressedHome = makeHome('suppressed-');
write(path.join(suppressedHome.home, '.zcode/cli/config.json'), {
  plugins: { suppressedBuiltins: ['quiet'] },
});
const quietRoot = path.join(suppressedHome.home, '.zcode/cli/plugins/data/quiet');
write(path.join(quietRoot, '.zcode-plugin/plugin.json'), { name: 'quiet', version: '0.1.0' });
write(path.join(quietRoot, 'hooks/hooks.json'), {
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] },
});
const suppressed = listHooks(suppressedHome);
ok(suppressed.events.join(',') === 'Stop', 'suppressed plugin still declares events');
ok(suppressed.sources.find(s => s.plugin === 'quiet')?.executed === false, 'suppressed plugin is not executed');

const runCli = (home, cwd, args) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', timeout: 15000, cwd,
  env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
});

const cliHome = makeHome('cli-');
write(path.join(cliHome.home, '.zcode/cli/config.json'), {
  hooks: { enabled: true, events: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] } },
});
const jsonRun = runCli(cliHome.home, cliHome.cwd, ['--json']);
ok(jsonRun.status === 0, `hooks --json exits 0 (got ${jsonRun.status})`);
ok(jsonRun.stderr === '', `hooks --json is silent on stderr (got ${JSON.stringify(jsonRun.stderr)})`);
let parsed = null;
try { parsed = JSON.parse(jsonRun.stdout); } catch (e) { parsed = { _error: e.message }; }
ok(parsed && Array.isArray(parsed.events) && Array.isArray(parsed.sources), 'hooks --json is parseable');
ok(parsed.events.join(',') === 'PreToolUse', 'CLI JSON events match the temp config');
ok(!existsSync(marker), 'CLI listing still does not execute hook scripts');

const listJson = runCli(cliHome.home, cliHome.cwd, ['list', '--json']);
ok(listJson.status === 0 && JSON.parse(listJson.stdout).events.join(',') === 'PreToolUse',
  'hooks list --json matches hooks --json');

const human = runCli(cliHome.home, cliHome.cwd, []);
ok(human.status === 0 && /PreToolUse/.test(human.stdout) && /events: PreToolUse/.test(human.stdout),
  'default listing prints declared event names');

const usage = runCli(cliHome.home, cliHome.cwd, ['run']);
ok(usage.status === 2 && /usage: zagent hooks/.test(usage.stderr), 'unknown subcommand is usage, exit 2');

const bin = readFileSync(path.join(root, 'bin/zagent'), 'utf8');
ok(/hooks:\s*\['packages\/cli\/zagent-hooks\.mjs'\]/.test(bin), 'bin dispatcher routes hooks');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
ok(pkg.files.includes('packages/cli/zagent-hooks.mjs'), 'CLI ships in the package');
ok(pkg.files.includes('packages/driver/hooks-cli.mjs'), 'driver ships in the package');

rmSync(tmp, { recursive: true, force: true });
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
