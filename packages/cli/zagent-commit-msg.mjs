#!/usr/bin/env node
// zagent commit-msg — the GUI's commit-message generator, surfaced for the CLI.
// Rides workspace/generateText with querySource 'git_commit_message' (desktop
// 3.12.x), live-verified 2026-09-16 via bench/f15-generate-text-probe.mjs:
// strict params {workspace:{workspaceKey,workspacePath}, selection:
// {providerId,modelId,options:{reasoningLevel}}, maxOutputTokens, querySource,
// prompt}; GLM-5.3 accepts reasoningLevel low|high|max; the kernel binds its
// own commit-model variant, so the caller's maxOutputTokens is skipped for
// this querySource. The generated text may arrive fenced ("```\nmsg\n```") —
// the fences are stripped before printing.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog } from '../driver/providers.mjs';

const rest = process.argv.slice(2);
const asJson = rest.includes('--json');
const usage = 'usage: zagent commit-msg [--model provider/model|model] [--effort <level>] [--json]';
let modelRef, effort;
{
  const bad = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') continue;
    if (a === '--model' || a === '--effort') {
      const v = rest[i + 1];
      if (!v || v.startsWith('-')) { bad.push(a); continue; }
      if (a === '--model') modelRef = v; else effort = v;
      i++;
      continue;
    }
    const eq = /^(--model|--effort)=(.+)$/.exec(a);
    if (eq) {
      if (eq[1] === '--model') modelRef = eq[2]; else effort = eq[2];
      continue;
    }
    bad.push(a);
  }
  if (bad.length) {
    console.error(usage);
    process.exit(2);
  }
}

const fail = (msg, extra = {}) => {
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg, ...extra }, null, 2));
  else console.error(msg);
  process.exit(1);
};

const git = (args) => spawnSync('git', args, { encoding: 'utf8', cwd: process.cwd() });
const probe = git(['rev-parse', '--is-inside-work-tree']);
if (probe.error) fail(`git is not runnable here: ${probe.error.message}`);
if (probe.stdout?.trim() !== 'true') {
  const why = String(probe.stderr ?? '').trim();
  fail(`not a git repository — run inside the checkout you want a message for${why ? ` (git: ${why.split('\n')[0]})` : ''}`);
}
// Staged changes first (what a human commits); fall back to unstaged so the
// command still answers before anything is added to the index.
let scope = 'staged';
let diff = git(['diff', '--cached']).stdout ?? '';
if (!diff.trim()) { scope = 'unstaged'; diff = git(['diff']).stdout ?? ''; }
if (!diff.trim()) fail('no changes to describe — stage or edit files first');
const stat = (git(scope === 'staged' ? ['diff', '--cached', '--stat'] : ['diff', '--stat']).stdout ?? '').trim();
const DIFF_CAP = 12000;
const body = diff.length > DIFF_CAP ? `${diff.slice(0, DIFF_CAP)}\n… (diff truncated)` : diff;

// Selection: --model 'provider/model' or bare 'model' (provider defaults to the
// plan's 'zai', same convention as -p --model); otherwise the CLI config's
// model.main. Model ids are canonicalized against the configured store — the
// kernel's getModel is exact-match and config.json carries canonical casing.
const dataHome = process.env.ZCODE_DATA_BASE_DIR?.trim() || os.homedir();
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const providers = readJson(path.join(dataHome, '.zcode', 'v2', 'config.json'))?.provider ?? {};
const configured = {};
for (const [id, p] of Object.entries(providers)) {
  if (p?.enabled === false || p?.systemDisabledReason) continue;
  configured[id] = Object.keys(p?.models ?? {});
}
// Prefer the named provider's own keys (a same-lowercased id on another
// provider must not steal canonicalization), then the global store.
const canonicalModel = (m, pid) => {
  const pools = [...(configured[pid] ? [configured[pid]] : []), ...Object.values(configured)];
  for (const ids of pools) {
    const hit = ids.find(x => x.toLowerCase() === m.toLowerCase());
    if (hit) return hit;
  }
  return m;
};
// builtin:<family>-coding-plan/-start-plan keys are CLI-side; the registry the
// kernel checks holds the account rules they entitle (same map as models test).
const accountIdFor = (pid) => {
  const m = /^builtin:([a-z0-9][a-z0-9-]*)-(coding-plan|start-plan)$/.exec(pid);
  if (!m) return null;
  const rules = loadCatalog()?.config?.providerConfigRules?.providerRules ?? [];
  const modes = m[2] === 'coding-plan' ? ['individual-coding-plan', 'team-coding-plan'] : ['start-plan'];
  for (const mode of modes) {
    const hit = rules.find(r => r?.config?.access?.type === 'zhipu-account'
      && r.config.access.accountType === m[1] && r.config.access.mode === mode);
    if (hit?.providerId) return hit.providerId;
  }
  return null;
};

let ref = modelRef;
if (!ref) {
  const main = readJson(path.join(dataHome, '.zcode', 'cli', 'config.json'))?.model?.main;
  if (typeof main === 'string' && main.trim()) ref = main.trim();
}
if (!ref) fail('no model selected — set model.main in ~/.zcode/cli/config.json or pass --model provider/model');
const slash = ref.indexOf('/');
let providerId = slash > 0 ? ref.slice(0, slash).trim() : 'zai';
let modelId = (slash > 0 ? ref.slice(slash + 1) : ref).trim();
if (!providerId || !modelId) {
  console.error(usage);
  process.exit(2);
}
// `model.main` and -p use bare family names ('zai/glm-5.3'), but the registry
// knows neither 'zai' nor the builtin:* config keys — only the account rules
// they entitle. Alias a bare family to its configured builtin key first (same
// candidate order as `models test`; a disabled builtin key is skipped here —
// the kernel's -32603 reply is the diagnostic), then map builtin→account below.
if (!Object.hasOwn(configured, providerId) && !providerId.includes(':')) {
  const typed = providerId.toLowerCase();
  const alias = [`builtin:${typed}-coding-plan`, `builtin:${typed}`, `builtin:${typed}-start-plan`]
    .find(c => Object.hasOwn(configured, c));
  if (alias) providerId = alias;
}
modelId = canonicalModel(modelId, providerId);
const accountId = accountIdFor(providerId);
if (accountId) providerId = accountId;

const { ZCodeProtocolClient } = await import('../driver/zcode-protocol.mjs');
let client, code = 0;
try {
  client = new ZCodeProtocolClient({ cwd: process.cwd() });
  await client.ready;
  // The registry is GUI-pushed (provider/updateAccountConfig); a headless spawn
  // is empty until this sync lands. A failure is surfaced, not swallowed.
  const sync = await client.syncAccountConfig();
  if (sync?.pushed === false && sync.benign === false)
    console.error(`note: account-config push failed (${sync.reason}); continuing`);
  const key = path.normalize(process.cwd());
  const params = {
    workspace: { workspaceKey: key, workspacePath: key },
    selection: { providerId, modelId, options: { reasoningLevel: effort ?? 'low' } },
    maxOutputTokens: 8192,
    querySource: 'git_commit_message',
    prompt: `Write a one-line commit message for these ${scope} changes:\n\n${stat ? `${stat}\n\n` : ''}${body}`,
  };
  const r = await client.call('workspace/generateText', params, 90000);
  // The kernel wraps the message in a markdown fence — strip it so the output
  // can be piped straight into `git commit -m "$(zagent commit-msg)"`.
  let message = String(r?.text ?? '').trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(message)
    ?? /```[^\n]*\n([\s\S]*?)\n?```/.exec(message);
  if (fence) message = fence[1].trim();
  if (!message) throw new Error('the runtime returned an empty commit message');
  if (asJson) {
    console.log(JSON.stringify({ ok: true, message, scope,
      selection: { providerId, modelId, options: { reasoningLevel: effort ?? 'low' } },
      finishReason: r?.finishReason ?? null, usage: r?.usage ?? null }, null, 2));
  } else {
    console.log(message);
  }
} catch (e) {
  code = 1;
  const requestId = e?.data?.providerRequestId ?? e?.data?.requestId ?? null;
  const msg = e?.code === -32601
    ? 'this ZCode runtime does not support workspace/generateText (it arrived in desktop 3.12.x)'
    : e?.code === -32603 && /not.?found|provider/i.test(String(e?.message ?? ''))
      ? `provider '${providerId}' not found in the runtime registry — check --model or 'zagent models test'`
      : `${e?.message ?? e}`;
  if (asJson) {
    console.log(JSON.stringify({ ok: false, error: msg, requestId }, null, 2));
  } else {
    console.error(`commit-msg failed: ${msg}`);
    if (requestId) console.error(`  provider request id: ${requestId}`);
  }
} finally {
  try { client?.close(); } catch {}
}
process.exit(code);
