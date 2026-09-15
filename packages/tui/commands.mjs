// zagent-side slash commands + the merged command palette.
//
// The kernel injects its own 20 commands through host.slashCommands and those are
// still submitted verbatim (submitPrompt('/new'), ...) — they are the runtime's
// to run. But the daily surface Codex CLI / Claude Code users expect — /exit,
// /status, /diff, /undo, /cost — is CLIENT work: leaving the process, printing
// local state, reverting files the runtime changed. Sending "/exit" to the
// runtime produced "Unknown command", and the only way out was undocumented.
//
// mergeCommands() folds both sources into ONE palette list, ordered by group.
// A client command shadows a kernel command of the same name on purpose: /help
// must render the merged list, not the kernel's 20-entry one.
//
// Every run(ctx) stays inside the TUI process — no turn, no spinner. ctx is the
// narrow seam index.mjs builds; ctx.deps holds injectable seams (exec, quota,
// home/cwd) so the hermetic tests never touch the network or the real HOME.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionDiffArtifacts, renderDiff, undoPreview, undoApply } from '../driver/diffs.mjs';
import { loadGlobalMemory, loadProjectMemory } from '../driver/memory.mjs';
import { codingPlanStatus } from '../driver/quota.mjs';
import { listHooks, formatHooksText } from '../driver/hooks-cli.mjs';
import { findRuntime } from '../driver/runtime.mjs';
import { formatDuration, formatTokens } from './render.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ISSUES_URL = 'https://github.com/agent-next/zagent/issues/new';

/** zagent's own package version — never the kernel's host.version (0.16.5). */
export function zagentVersion() {
  try {
    const v = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
    return typeof v === 'string' && v !== '' ? v : 'unknown';
  } catch { return 'unknown'; }
}

function safeRuntime() {
  try { return findRuntime(); } catch { return null; }
}

/**
 * The banner/status runtime descriptor. rt.version is the installed PRODUCT
 * version findRuntime() resolved (desktop-bundle 3.11.2, zcode-app-cli
 * 3.10.2-19); host.version is the kernel's internal build string (0.16.5),
 * kept separately so it is only ever shown labelled — painting it as the
 * runtime version was the "runtime 0.16.5" banner bug.
 */
export function runtimeDescriptor(host) {
  const rt = safeRuntime();
  return {
    version: rt?.version ?? null,
    kernel: typeof host?.version === 'string' && host.version !== '' ? host.version : null,
    kind: rt?.kind ?? null,
    entry: rt?.entry ?? null,
  };
}

/**
 * Short form for the banner and /version: `<kind> <version>` when the driver
 * resolves a product version; `<kind> (kernel <build>)` when the install is
 * found but not versioned, and `kernel <build>` when nothing is discovered at
 * all — the kernel string is always labelled, never shown as the product.
 */
export function runtimeLabel(host) {
  const d = runtimeDescriptor(host);
  if (d.version) return [d.kind, d.version].filter(Boolean).join(' ');
  if (d.kind) return d.kernel ? `${d.kind} (kernel ${d.kernel})` : d.kind;
  // Nothing discovered: the host's string is the kernel build, never the product.
  return d.kernel ? `kernel ${d.kernel}` : '';
}

// --- the merged palette -------------------------------------------------------

export const GROUPS = Object.freeze(['Session', 'Model', 'Project', 'Tools', 'zagent']);

// The kernel's 20 commands, grouped. Unknown future kernel commands land in Tools
// rather than breaking the layout.
const KERNEL_GROUP = {
  new: 'Session', resume: 'Session', fork: 'Session', rewind: 'Session', compact: 'Session',
  login: 'Session', logout: 'Session', locale: 'Session',
  model: 'Model', effort: 'Model', mode: 'Model', expert: 'Model',
  init: 'Project', goal: 'Project', skill: 'Project',
  mcp: 'Tools', plugins: 'Tools', workflow: 'Tools', workflows: 'Tools',
};

/**
 * One palette list: client commands + kernel commands, group-ordered
 * (Session · Model · Project · Tools · zagent), stable within a group.
 * Client entries keep their `run`; kernel entries carry usage and source
 * so /help and completion can show where a command is executed.
 */
export function mergeCommands(hostSlashCommands, clientCommands = CLIENT_COMMANDS) {
  const client = (Array.isArray(clientCommands) ? clientCommands : [])
    .filter(c => c && typeof c.name === 'string' && c.name !== '');
  const claimed = new Set();
  for (const c of client) { claimed.add(c.name); for (const a of c.aliases ?? []) claimed.add(a); }
  const merged = client.map(c => ({ ...c, source: 'zagent' }));
  for (const k of Array.isArray(hostSlashCommands) ? hostSlashCommands : []) {
    if (!k || typeof k.name !== 'string' || k.name === '' || claimed.has(k.name)) continue;
    merged.push({
      name: k.name, aliases: [], group: KERNEL_GROUP[k.name] ?? 'Tools',
      summary: typeof k.summary === 'string' ? k.summary : '',
      usage: typeof k.usage === 'string' ? k.usage : `/${k.name}`,
      source: 'kernel',
    });
  }
  const rank = (g) => { const i = GROUPS.indexOf(g); return i === -1 ? GROUPS.length : i; };
  return merged
    .map((c, i) => [rank(c.group), i, c])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([, , c]) => c);
}

/** "/name arg…" -> the client command that owns it, or null (kernel handles it). */
export function matchClientCommand(text, commands = CLIENT_COMMANDS) {
  const m = /^\/([^\s/]+)\s*([\s\S]*)$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const command = commands.find(c => c.name === name || (c.aliases ?? []).includes(name));
  return command ? { command, args: m[2].trim() } : null;
}

// The keys a person can press, from the key handler in index.mjs — codex's `?`
// overlay and claude's /help modal both lead with theirs; zagent's were only
// ever visible in the one-line banner hint (G6).
export const SHORTCUTS = Object.freeze([
  ['enter', 'submit'],
  ['tab', 'cycle the /command, $skill, #conversation or @file popup'],
  ['esc', 'interrupt the turn · close a popup · clear a bare /'],
  ['ctrl+c', 'interrupt the turn · twice to exit'],
  ['ctrl+d', 'exit at an empty prompt'],
  ['ctrl+l', 'clear the screen'],
  ['ctrl+e', 'show or hide thinking'],
  ['shift+up/down', 'select an earlier turn, then h/l folds or expands it'],
  ['/ $ # @ ?', 'command · skill · conversation · file · help'],
]);

/** /help body: the merged list, grouped, one line each, then the keys. */
export function renderHelp(commands) {
  const lines = [];
  let last = null;
  for (const c of commands ?? []) {
    if (c.group !== last) {
      if (last !== null) lines.push('');
      lines.push(c.group ?? 'other');
      last = c.group;
    }
    const names = [c.name, ...(c.aliases ?? [])].map(n => `/${n}`).join(' ');
    lines.push(`  ${names} — ${c.summary ?? ''}${c.source === 'kernel' ? ' (runtime)' : ''}`);
  }
  lines.push('', 'Shortcuts');
  for (const [key, what] of SHORTCUTS) lines.push(`  ${key} — ${what}`);
  return lines.join('\n');
}

// --- helpers the commands share ------------------------------------------------

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** List-price table for the Coding Plan models (USD per 1M tokens). */
export const LIST_PRICE = Object.freeze({
  'glm-5.3': { input: 1.40, cached: 0.26, output: 4.40 },
  'glm-5.3-flash': { input: 0.15, cached: 0.03, output: 0.50 },
});

export function priceFor(model) {
  return /flash/i.test(String(model ?? '')) ? LIST_PRICE['glm-5.3-flash'] : LIST_PRICE['glm-5.3'];
}

/** USD at list price; labelled an estimate everywhere it is shown. */
export function estimateCost(model, totals) {
  const p = priceFor(model);
  const cached = num(totals?.cacheReadTokens) + num(totals?.cacheCreationTokens) + num(totals?.cacheWriteTokens);
  return (num(totals?.inputTokens) * p.input + cached * p.cached + num(totals?.outputTokens) * p.output) / 1e6;
}

function usageReport(ctx) {
  const t = ctx.state.totals ?? {};
  const lines = [
    `tokens this session: ${formatTokens(num(t.inputTokens))} in · ` +
    `${formatTokens(num(t.cacheReadTokens) + num(t.cacheCreationTokens) + num(t.cacheWriteTokens))} cached · ` +
    `${formatTokens(num(t.outputTokens))} out`,
  ];
  const model = ctx.ui.model || 'glm-5.3';
  lines.push(`≈ $${estimateCost(model, t).toFixed(4)} list-price estimate at ${priceFor(model) === LIST_PRICE['glm-5.3-flash'] ? 'GLM-5.3-Flash' : 'GLM-5.3'} rates — the Coding Plan is a subscription, not metered billing`);
  return lines.join('\n');
}

/** Coding Plan quota line block. Unknown amounts say "not reported", never 0. */
export function formatQuota(report) {
  const pools = Array.isArray(report?.pools) ? report.pools : [];
  const fiveHour = pools.find(p => p?.type === 'TOKENS_LIMIT');
  const monthly = pools.find(p => p?.type === 'TIME_LIMIT');
  const others = pools.filter(p => p !== fiveHour && p !== monthly);
  const hm = (iso) => {
    const d = new Date(iso);
    return Number.isFinite(d.getTime())
      ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : null;
  };
  const day = (iso) => {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
  };
  const lines = [];
  // TOKENS_LIMIT is the rolling window (number = its length in hours, 5 live).
  lines.push(fiveHour
    ? `${fiveHour.number ?? 5}-hour window: ${fiveHour.usedPercent == null ? 'not reported' : `${fiveHour.usedPercent}% used`}` +
      `${fiveHour.nextResetAt && hm(fiveHour.nextResetAt) ? ` · resets ${hm(fiveHour.nextResetAt)}` : ''}`
    : '5-hour window: not reported');
  // TIME_LIMIT is the monthly tool-call allowance: used/limit are call counts.
  lines.push(monthly
    ? `monthly tool calls: ${monthly.used ?? 'not reported'} / ${monthly.limit ?? 'not reported'}` +
      `${monthly.usedPercent == null ? '' : ` (${monthly.usedPercent}% used)`}` +
      `${monthly.nextResetAt && day(monthly.nextResetAt) ? ` · resets ${day(monthly.nextResetAt)}` : ''}`
    : 'monthly tool calls: not reported');
  // A pool we do not recognise still prints — raw type, like `zagent quota`.
  for (const p of others) {
    lines.push(`${p?.type ?? 'unknown pool'}: ${p?.usedPercent == null ? 'not reported' : `${p.usedPercent}% used`}` +
      `${p?.nextResetAt && day(p.nextResetAt) ? ` · resets ${day(p.nextResetAt)}` : ''}`);
  }
  if (typeof report?.level === 'string' && report.level) lines.push(`plan: ${report.level}`);
  return lines.join('\n');
}

/** In-process mirror of the checks `zagent doctor` runs (packages/cli/zmax.mjs). */
export function doctorLines({ env = process.env, home = os.homedir(), cwd = process.cwd(), exists = existsSync } = {}) {
  const lines = [];
  const rt = safeRuntime();
  lines.push(rt ? `runtime: ${rt.kind} (${rt.root})` : 'runtime: NOT FOUND — install zcode-app-cli or the ZCode desktop app');
  lines.push('interactive TUI: zagent (built in)');
  const cfg = path.join(home, '.zcode', 'cli', 'config.json');
  if (!exists(cfg)) {
    lines.push('config: missing — created on first run');
  } else {
    let state = 'present';
    try {
      const c = JSON.parse(readFileSync(cfg, 'utf8'));
      const providerId = typeof c?.model?.main === 'string' && /^[^/]+\/.+$/.test(c.model.main)
        ? c.model.main.split('/')[0] : null;
      const selected = providerId ? c?.provider?.[providerId] : null;
      if (!providerId || !selected || typeof selected !== 'object' || Array.isArray(selected)) {
        state = 'INVALID CONFIG — repair the JSON object manually; existing file preserved';
      }
      if (c?.model?.main && c.model.main === c.model?.lite) {
        lines.push(`warn: model.main == model.lite (${c.model.main}) — main should be the full model, lite the fast one`);
      }
    } catch { state = 'INVALID CONFIG — unreadable JSON; existing file preserved'; }
    lines.push(`config: ${state}`);
  }
  let haveKey = Boolean(env.ZAI_API_KEY) || exists(path.join(home, '.config', 'ccz', '.api_key'));
  if (!haveKey) { // the kernel OAuth store is a credential too (G1, mirrors zmax.mjs)
    try {
      const s = JSON.parse(readFileSync(path.join(home, '.zcode', 'v2', 'credentials.json'), 'utf8'));
      haveKey = typeof s['oauth:zai:access_token'] === 'string' && s['oauth:zai:access_token'] !== '';
    } catch {}
  }
  lines.push(`credential: ${haveKey ? 'present' : 'NO CODING-PLAN CREDENTIAL — export ZAI_API_KEY'}`);
  return lines;
}

/** Transcript -> Markdown for /export. */
export function exportMarkdown(state) {
  const lines = [`# zagent session ${state?.sessionId ?? ''}`.trimEnd(), ''];
  for (const e of state?.entries ?? []) {
    if (e.kind === 'user') lines.push(`> ${e.text}`, '');
    else if (e.kind === 'assistant') lines.push(e.text, '');
    else if (e.kind === 'thinking' && e.text.trim()) {
      lines.push('<details><summary>thinking</summary>', '', e.text, '', '</details>', '');
    } else if (e.kind === 'tool') {
      const first = String(e.resultText ?? '').split('\n').filter(Boolean).slice(0, 20);
      lines.push(`- **${e.name}** (${e.status})`);
      if (first.length) lines.push('  ```', ...first.map(l => `  ${l}`), '  ```');
      lines.push('');
    } else if (e.kind === 'notice') lines.push(`_${e.text}_`, '');
    else if (e.kind === 'command') lines.push('```', e.text, '```', '');
  }
  return lines.join('\n');
}

/** Tool-call ids belonging to the most recent turn — what /undo may revert. */
export function lastTurnToolCallIds(state) {
  const start = state?.turn?.entryStart;
  if (!Number.isInteger(start)) return new Set();
  const ids = new Set();
  for (const e of (state.entries ?? []).slice(start)) {
    if (e.kind === 'tool' && e.id) ids.add(e.id);
  }
  return ids;
}

function listGrants(home) {
  const file = path.join(home ?? os.homedir(), '.zcode', 'cli', 'grants.json');
  try {
    const obj = JSON.parse(readFileSync(file, 'utf8'));
    return Object.values(obj?.grants ?? {}).filter(g => g && typeof g === 'object');
  } catch { return []; }
}

function execCommand(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ code: 127, stdout: '', stderr: String(e?.message ?? e) }); return; }
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });
    child.on('error', e => resolve({ code: 127, stdout, stderr: String(e?.message ?? e) }));
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Numeric semver-ish compare: 0.0.203 > 0.0.202. Non-numeric tails never upgrade. */
export function isNewerVersion(latest, current) {
  const parse = (v) => String(v ?? '').trim().split('.').map(x => (/^\d+$/.test(x) ? Number(x) : -1));
  const a = parse(latest), b = parse(current);
  if (a.includes(-1) || b.includes(-1)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

const readCurrent = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

// --- the client command table ----------------------------------------------------

export const CLIENT_COMMANDS = [
  {
    name: 'exit', aliases: ['q', 'bye'], group: 'Session',
    summary: 'leave the session',
    run(ctx) { ctx.quit(); },
  },
  {
    name: 'quit', group: 'Session',
    summary: 'leave the session',
    run(ctx) { ctx.quit(); },
  },
  {
    name: 'stop', group: 'Session',
    summary: 'interrupt the running turn (same as esc)',
    run(ctx) {
      if (ctx.ui.busy) { ctx.interrupt(); ctx.notice('interrupted', 'muted'); }
      else ctx.notice('nothing is running', 'faint');
    },
  },
  {
    name: 'clear', group: 'Session',
    summary: 'new session (kernel /new) and clear the transcript view',
    run(ctx) { ctx.clearView(); ctx.send('/new'); },
  },
  {
    name: 'status', group: 'zagent',
    summary: 'version, runtime, model, session and token state',
    run(ctx) {
      const rt = runtimeDescriptor(ctx.host);
      const t = ctx.state.totals ?? {};
      const mcp = ctx.ui.mcp;
      const lines = [
        `zagent ${ctx.version}`,
        `runtime: ${[[rt.kind, rt.version].filter(Boolean).join(' ') || null,
          rt.kernel ? `kernel build ${rt.kernel}` : null, rt.entry].filter(Boolean).join(' · ') || 'not found'}`,
        `model: ${ctx.ui.model || '(runtime default)'} · effort ${ctx.ui.effort || '(default)'} · mode ${ctx.ui.mode}`,
        `session: ${ctx.state.sessionId ?? '(not started)'}`,
        `cwd: ${ctx.workspace}${ctx.host.workspaceGitBranch ? ` · branch ${ctx.host.workspaceGitBranch}` : ''}`,
        mcp && mcp.total > 0
          ? `mcp: ${mcp.connected}/${mcp.total} connected${mcp.failed ? ` · ${mcp.failed} failed` : ''}`
          : 'mcp: none',
        `tokens: ${formatTokens(num(t.inputTokens))} in · ${formatTokens(num(t.outputTokens))} out · ${formatTokens(num(t.cacheReadTokens) + num(t.cacheCreationTokens) + num(t.cacheWriteTokens))} cached`,
        `elapsed: ${formatDuration(Date.now() - ctx.state.startedAt)}`,
      ];
      ctx.print(lines.join('\n'));
    },
  },
  {
    name: 'version', aliases: ['v'], group: 'zagent',
    summary: 'print the zagent and runtime versions',
    run(ctx) {
      const label = runtimeLabel(ctx.host);
      ctx.print(`zagent ${ctx.version}${label ? ` · runtime ${label}` : ''}`);
    },
  },
  {
    name: 'usage', aliases: ['cost'], group: 'zagent',
    summary: 'session tokens and a list-price estimate',
    run(ctx) { ctx.print(usageReport(ctx)); },
  },
  {
    name: 'context', group: 'zagent',
    summary: 'context meter and input baseline breakdown',
    run(ctx) {
      const p = ctx.state.projection ?? {};
      const lines = [Number.isFinite(p.contextUsed) && Number.isFinite(p.contextWindow)
        ? `context: ${formatTokens(p.contextUsed)} / ${formatTokens(p.contextWindow)}`
        : 'context: not reported yet (the meter fills in after the first turn)'];
      const base = ctx.state.contextBreakdown;
      if (base && typeof base === 'object') {
        const rows = Object.entries(base).filter(([, v]) => typeof v === 'number' || typeof v === 'string');
        lines.push('baseline breakdown:');
        for (const [k, v] of rows) lines.push(`  ${k}: ${typeof v === 'number' ? formatTokens(v) : v}`);
        if (!rows.length) lines.push('  (none reported)');
      } else {
        lines.push('baseline breakdown: not reported');
      }
      ctx.print(lines.join('\n'));
    },
  },
  {
    name: 'diff', group: 'Session',
    summary: "this session's per-file changes (+A/-D and hunks)",
    run(ctx) {
      const sid = ctx.state.sessionId;
      if (!sid) return ctx.notice('no session yet — diffs appear after the first turn', 'faint');
      ctx.print(renderDiff(sessionDiffArtifacts(sid, { home: ctx.home })));
    },
  },
  {
    name: 'undo', group: 'Session',
    summary: "revert the last turn's file changes (asks y/N first)",
    async run(ctx) {
      const ids = lastTurnToolCallIds(ctx.state);
      const arts = sessionDiffArtifacts(ctx.state.sessionId ?? '', { home: ctx.home })
        .filter(a => ids.has(a.toolCallId));
      if (!arts.length) return ctx.notice('nothing to undo — the last turn changed no tracked files', 'faint');
      const plans = undoPreview(arts, readCurrent);
      for (const p of plans.filter(p => !p.canApply)) {
        ctx.notice(`skip ${p.path}: ${p.reason ?? p.state}`, 'warning');
      }
      const applicable = plans.filter(p => p.canApply);
      if (!applicable.length) return;
      const yes = await ctx.confirm(`revert ${applicable.length} file${applicable.length > 1 ? 's' : ''} to before the last turn?`);
      if (!yes) return ctx.notice('left unchanged', 'faint');
      const res = undoApply(plans, (p, c) => writeFileSync(p, c), { readCurrent, removeCurrent: (p) => unlinkSync(p) });
      const done = res.filter(r => r.reverted);
      for (const r of res.filter(r => !r.reverted)) {
        ctx.notice(`not reverted ${r.path}: ${r.error ?? r.state}`, 'warning');
      }
      ctx.print(done.length ? `reverted: ${done.map(r => r.path).join(', ')}` : 'nothing was reverted');
    },
  },
  {
    name: 'export', group: 'Session',
    summary: 'write the transcript as Markdown and print the path',
    run(ctx) {
      const id = String(ctx.state.sessionId ?? 'session').replace(/[^\w-]/g, '').slice(0, 8) || 'session';
      const file = path.join(ctx.cwd ?? ctx.workspace ?? process.cwd(), `zagent-${id}.md`);
      try {
        writeFileSync(file, exportMarkdown(ctx.state));
        ctx.print(`transcript written to ${file}`);
      } catch (e) {
        ctx.notice(`export failed: ${String(e?.message ?? e).slice(0, 160)}`, 'error');
      }
    },
  },
  {
    name: 'copy', group: 'Session',
    summary: 'copy the last assistant message to the clipboard',
    async run(ctx) {
      const last = [...ctx.state.entries].reverse().find(e => e.kind === 'assistant' && e.text.trim() !== '');
      if (!last) return ctx.notice('nothing to copy yet', 'faint');
      if (typeof ctx.host.writeClipboardText !== 'function') {
        return ctx.notice('clipboard is not available in this runtime', 'warning');
      }
      try {
        await ctx.host.writeClipboardText(last.text);
        ctx.notice('copied to the clipboard', 'muted');
      } catch {
        ctx.notice('clipboard is not available in this runtime', 'warning');
      }
    },
  },
  {
    name: 'doctor', group: 'zagent',
    summary: 'runtime/config/credential diagnosis (same checks as `zagent doctor`)',
    run(ctx) {
      ctx.print(doctorLines({ env: ctx.env, home: ctx.home, cwd: ctx.workspace }).join('\n'));
    },
  },
  {
    name: 'quota', group: 'zagent',
    summary: 'Coding Plan quota: 5-hour window and monthly tool-call pool',
    async run(ctx) {
      const fn = ctx.deps?.codingPlanStatus ?? codingPlanStatus;
      try { ctx.print(formatQuota(await fn())); }
      catch (e) { ctx.notice(`quota: ${String(e?.message ?? e).slice(0, 200)}`, 'warning'); }
    },
  },
  {
    name: 'update', group: 'zagent',
    summary: 'check npm for a newer zagent and offer to install it',
    async run(ctx) {
      const exec = ctx.deps?.exec ?? execCommand;
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const view = await exec(npm, ['view', 'zagent', 'version']);
      const latest = String(view.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
      if (view.code !== 0 || latest === '') {
        return ctx.notice('could not check npm for the latest zagent version (offline?)', 'warning');
      }
      if (!isNewerVersion(latest, ctx.version)) {
        return ctx.print(`zagent ${ctx.version} is current (npm latest: ${latest})`);
      }
      const yes = await ctx.confirm(`update zagent ${ctx.version} -> ${latest}? runs: npm i -g zagent@latest`);
      if (!yes) return ctx.notice('not updated', 'faint');
      const r = await exec(npm, ['i', '-g', 'zagent@latest']);
      if (r.code === 0) ctx.print(`updated zagent to ${latest} — restart zagent to use it`);
      else ctx.notice(`update failed: ${String(r.stderr || r.stdout || '').trim().slice(0, 300)}`, 'error');
    },
  },
  {
    name: 'theme', group: 'zagent',
    summary: 'switch the palette: /theme light | dark | auto',
    run(ctx, arg) {
      const v = String(arg ?? '').trim().toLowerCase();
      const apply = (s) => { ctx.setTheme(s); ctx.notice(`theme: ${s}`, 'muted'); };
      if (v === '') {
        return ctx.choose({
          title: 'Theme',
          items: [
            { value: 'light', label: 'light' },
            { value: 'dark', label: 'dark' },
            { value: 'auto', label: 'auto', note: 'follow the runtime setting' },
          ],
          pick: (item) => apply(item.value),
        });
      }
      if (!['light', 'dark', 'auto'].includes(v)) {
        return ctx.notice('usage: /theme light|dark|auto', 'warning');
      }
      apply(v);
    },
  },
  {
    name: 'hooks', group: 'Project',
    summary: 'list configured ZCode hook events (read-only)',
    run(ctx) { ctx.print(formatHooksText(listHooks({ home: ctx.home, cwd: ctx.workspace }))); },
  },
  {
    name: 'agents', group: 'Tools',
    summary: 'running subagents in this session',
    run(ctx) {
      const running = [...(ctx.state.subagents ?? [])];
      if (!running.length) return ctx.print('no running subagents');
      const lines = [`${running.length} running subagent${running.length > 1 ? 's' : ''}:`];
      for (const id of running) {
        const tool = ctx.state.entries.find(e => e.kind === 'tool' && e.id === id);
        const what = typeof tool?.input?.prompt === 'string' ? tool.input.prompt
          : typeof tool?.input?.description === 'string' ? tool.input.description : '';
        lines.push(`  ${id}${what ? ` — ${what.slice(0, 60)}` : ''}`);
      }
      ctx.print(lines.join('\n'));
    },
  },
  {
    name: 'permissions', group: 'Project',
    summary: 'persisted always-allow/deny grants',
    run(ctx) {
      const grants = listGrants(ctx.home);
      if (!grants.length) return ctx.print('no persisted permission grants');
      const lines = ['persisted grants (~/.zcode/cli/grants.json):'];
      for (const g of grants) lines.push(`  ${g.toolName ?? '?'} — ${g.optionId ?? '?'}`);
      ctx.print(lines.join('\n'));
    },
  },
  {
    name: 'memory', group: 'Project',
    summary: 'show project and global memory',
    run(ctx) {
      const head = (text) => String(text ?? '').split('\n').slice(0, 40);
      const lines = ['project memory:'];
      const project = loadProjectMemory(ctx.workspace ?? process.cwd());
      lines.push(...(project.trim() ? head(project) : ['  (none)']));
      lines.push('', 'global memory:');
      const global = loadGlobalMemory();
      lines.push(...(global.trim() ? head(global) : ['  (none)']));
      ctx.print(lines.join('\n'));
    },
  },
  {
    name: 'feedback', group: 'zagent',
    summary: 'where to report bugs and feedback',
    run(ctx) { ctx.print(`issues and feedback: ${ISSUES_URL}`); },
  },
  {
    name: 'bug', group: 'zagent',
    summary: 'report a bug',
    run(ctx) { ctx.print(`report a bug: ${ISSUES_URL}`); },
  },
  {
    name: 'approvals', group: 'Model',
    summary: 'choose the permission mode (the /mode picker)',
    async run(ctx) { if (!(await ctx.openPicker('mode'))) ctx.send('/mode'); },
  },
  {
    name: 'plan', group: 'Model',
    summary: 'switch to plan mode (/mode plan)',
    async run(ctx) { await ctx.setMode('plan'); },
  },
  {
    name: 'help', aliases: ['?'], group: 'zagent',
    summary: 'show this command list',
    run(ctx) { ctx.print(renderHelp(ctx.commands)); },
  },
];
