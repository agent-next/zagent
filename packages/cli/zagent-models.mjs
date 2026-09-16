#!/usr/bin/env node
// zagent models [query] — B1: search the OFFICIAL provider catalog the desktop ships.
// No query: the configured Coding Plan models first (the plan is what people
// actually run), then the other providers.
// zagent models test <provider/model|model> — the GUI's connection check:
// provider/testModelConnectivity (desktop 3.12.x) asks the runtime to reach the
// provider, so the answer covers credentials and endpoint, not just the catalog.
//
// Verified against the extracted 3.12.1 kernel (2026-09-15): the params schema is
// strict — {workspace:{workspaceKey,workspacePath}, selection:{providerId,modelId}};
// a top-level workspacePath is rejected -32602. The app-server's provider registry
// is NOT read from config.json — the GUI pushes it via provider/updateAccountConfig,
// so a bare headless spawn answers "Provider Registry 中不存在 Provider" until a
// client syncs (same gap as the 3.12.1 TUI sign-in). Provider/model ids here are the
// configured keys of ~/.zcode/v2/config.json, which is what the GUI pushes.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog, providerList, findModel } from '../driver/providers.mjs';

if (process.argv[2] === 'test') {
  const rest = process.argv.slice(3);
  const asJson = rest.includes('--json');
  const positional = rest.filter(a => !a.startsWith('-'));
  const unknownFlags = rest.filter(a => a.startsWith('-') && a !== '--json');
  if (positional.length !== 1 || unknownFlags.length) {
    console.error('usage: zagent models test <provider/model|model> [--json]');
    process.exit(2);
  }
  // The registry mirror: provider id -> configured model ids (config.json keeps
  // models as a map keyed by id). Disabled/system-disabled providers are not
  // usable carriers — the push marks them unentitled — so they are tracked
  // separately for a clear diagnostic instead of a kernel provider_not_found.
  const { configured, disabled } = (() => {
    try {
      const cfgPath = path.join(process.env.ZCODE_DATA_BASE_DIR?.trim() || os.homedir(),
        '.zcode', 'v2', 'config.json');
      const providers = JSON.parse(readFileSync(cfgPath, 'utf8'))?.provider ?? {};
      const configured = {}, disabled = new Set();
      for (const [id, p] of Object.entries(providers)) {
        if (p?.enabled === false || p?.systemDisabledReason) disabled.add(id);
        else configured[id] = Object.keys(p?.models ?? {});
      }
      return { configured, disabled };
    } catch { return { configured: {}, disabled: new Set() }; }
  })();
  const fail = (msg, modelId) => {
    if (asJson) console.log(JSON.stringify({ ok: false, providerId: null, modelId, error: msg }, null, 2));
    else console.error(msg);
    process.exit(1);
  };
  const carriers = m => Object.entries(configured)
    .filter(([, models]) => models.some(x => x.toLowerCase() === m.toLowerCase()))
    .map(([id, models]) => [id, models.find(x => x.toLowerCase() === m.toLowerCase())]);
  // `builtin:<family>-coding-plan`/`-start-plan` config keys are CLI-side; the
  // registry holds the account rules they entitle (account:<family>-*). Map a
  // configured builtin key to its primary account provider id — a coding-plan
  // key covers both individual and team rules (same key, same endpoint), so
  // individual is the representative test target.
  const accountIdFor = pid => {
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
  const sel = positional[0];
  const slash = sel.indexOf('/');
  let providerId, modelId;
  if (slash > 0) {
    providerId = sel.slice(0, slash).trim();
    modelId = sel.slice(slash + 1).trim();
    if (!providerId || !modelId) {
      console.error('usage: zagent models test <provider/model|model> [--json]');
      process.exit(2);
    }
    if (configured[providerId]) {
      // Canonical model id: the kernel's getModel is exact-match, and
      // config.json keys carry the canonical casing (GLM-5.3, not glm-5.3).
      modelId = configured[providerId].find(m => m.toLowerCase() === modelId.toLowerCase()) ?? modelId;
      // The registry knows account:* ids, not builtin:* config keys.
      const accountId = accountIdFor(providerId);
      if (accountId) {
        if (!asJson) console.error(`note: '${providerId}' tests as registry provider '${accountId}'`);
        providerId = accountId;
      }
    } else if (disabled.has(providerId)) {
      fail(`provider '${providerId}' is disabled in the CLI config`, modelId);
    } else if (providerId.startsWith('account:')) {
      // Registry-native ids (the account-config push): the kernel resolves them
      // against its rebuilt registry — never remap through configured carriers.
    } else {
      // `zagent models` prints catalog/rule ids (account:…); the app-server
      // registry only knows configured keys. Remap through the model's carriers
      // when unambiguous instead of handing the kernel a guaranteed miss.
      const hits = carriers(modelId);
      if (hits.length === 1) {
        if (!asJson) console.error(`note: '${providerId}' is not a configured provider; testing ${hits[0][0]}/${hits[0][1]}`);
        [providerId, modelId] = hits[0];
      } else if (hits.length > 1) {
        if (asJson) fail(`'${modelId}' is configured on ${hits.length} providers`, modelId);
        console.error(`'${modelId}' is configured on ${hits.length} providers; name one:`);
        for (const [p, m] of hits) console.error(`  zagent models test ${p}/${m}`);
        process.exit(1);
      }
      // No carriers either — pass through; the kernel is the authority.
    }
  } else {
    const hits = carriers(sel);
    if (!hits.length) fail(`no configured provider carries '${sel}' — pass provider/model to test one anyway`, sel);
    if (hits.length > 1) {
      if (asJson) fail(`'${sel}' is configured on ${hits.length} providers`, sel);
      console.error(`'${sel}' is configured on ${hits.length} providers; name one:`);
      for (const [p, m] of hits) console.error(`  zagent models test ${p}/${m}`);
      process.exit(1);
    }
    [[providerId, modelId]] = hits;
  }
  const { ZCodeProtocolClient } = await import('../driver/zcode-protocol.mjs');
  let client, code = 0;
  try {
    client = new ZCodeProtocolClient({ cwd: process.cwd() });
    await client.ready;
    // The registry is GUI-pushed (provider/updateAccountConfig); a headless
    // spawn is empty until this best-effort sync lands (no-op pre-3.12.x). An
    // unexpected push failure is surfaced — silent would masquerade as the
    // empty-registry provider_not_found this push exists to prevent.
    const sync = await client.syncAccountConfig();
    if (sync?.pushed === false && sync.benign === false)
      console.error(`note: account-config push failed (${sync.reason}); continuing`);
    const key = path.normalize(process.cwd());
    // Success is an empty result — the kernel's handler only throws.
    await client.call('provider/testModelConnectivity', {
      workspace: { workspaceKey: key, workspacePath: key },
      selection: { providerId, modelId },
    }, 45000);
    if (asJson) console.log(JSON.stringify({ ok: true, providerId, modelId }, null, 2));
    else console.log(`${providerId}/${modelId}: reachable`);
  } catch (e) {
    code = 1;
    const requestId = e?.data?.providerRequestId ?? e?.data?.requestId ?? null;
    const msg = e?.code === -32601
      ? 'this ZCode runtime does not support connectivity tests (provider/testModelConnectivity arrived in desktop 3.12.x)'
      : `${providerId}/${modelId}: ${e?.message ?? e}`;
    if (asJson) {
      console.log(JSON.stringify({ ok: false, providerId, modelId, error: msg, requestId }, null, 2));
    } else {
      console.error(`models test failed: ${msg}`);
      if (requestId) console.error(`  provider request id: ${requestId}`);
    }
  } finally {
    try { client?.close(); } catch {}
  }
  process.exit(code);
}

const q = process.argv[2];
const catalog = loadCatalog();
if (!catalog) {
  console.error('no provider catalog found for the installed runtime');
  process.exit(1);
}

const planHeader = () => {
  let model = {};
  try {
    model = JSON.parse(readFileSync(`${os.homedir()}/.zcode/cli/config.json`, 'utf8'))?.model ?? {};
  } catch {}
  const parts = [
    typeof model.main === 'string' && model.main ? `main ${model.main}` : null,
    typeof model.lite === 'string' && model.lite ? `lite ${model.lite}` : null,
  ].filter(Boolean);
  console.log(`Your Coding Plan: ${parts.length ? parts.join(' · ') : 'not configured'}`);
};

if (!q) {
  planHeader();
  const providers = providerList(catalog);
  const plan = providers.find((p) => p.id === 'zai');
  if (plan) {
    console.log();
    for (const m of plan.models) console.log(`  zai/${m}`);
  }
  const rest = providers.filter((p) => p !== plan);
  if (rest.length) {
    console.log('\nOther providers:');
    for (const p of rest) console.log(`${p.id}\t${p.models.length} models\t${p.baseURL ?? ''}`);
  }
} else {
  const exact = findModel(q, catalog);
  if (exact.length) for (const h of exact)
    console.log(`${h.provider}/${h.model}\tctx ${h.contextWindow ?? '?'}\tout ${h.maxOutputTokens ?? '?'}\tkinds ${h.kinds.join(',')}\tinput ${h.input.join(',')}`);
  else { // substring search over provider/model, so `models zai` or `models glm` find the plan's models
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    let hits = 0;
    for (const p of providerList(catalog)) for (const m of p.models) if (re.test(`${p.id}/${m}`)) { console.log(`${p.id}/${m}`); hits++; }
    // A query that matches nothing used to print nothing and exit 0, so "no such
    // model" and "the command is broken" looked identical — and a mistyped flag
    // (models --bogus) was silently a success.
    if (!hits) {
      console.error(`no model matching '${q}'. \`zagent models\` lists every provider.`);
      process.exit(1);
    }
  }
}
