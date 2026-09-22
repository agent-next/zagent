// 3.12.1 app-server account config push — provider/updateAccountConfig.
//
// The app-server's provider registry starts EMPTY: the Electron host pushes the
// account snapshot over this RPC (kernel handler xLn). A headless spawn answers
// -32603 provider_not_found for every provider-backed call until a client syncs
// (measured live on the extracted 3.12.1 app-server).
// This mirrors the GUI push for what a headless client can know locally:
//   params (FVt, strict):
//     revision                     non-empty string; kernel form
//                                  `account:${JSON.stringify([builtinRev, providers, states])}`
//     basedOnZCodeBuiltinRevision  `zcode-builtin:<rev>:<sha256(resolve(path))>`
//                                  — must equal the kernel snapshot's
//                                  zcodeBuiltinRevision (see kernelActiveBuiltinPath)
//                                  or the registry rebuild is skipped silently
//     providers  record(id -> kio {builtinModelIds, access?:{type,entitled}|null})
//     states     record(id -> {availability, entitled, unavailableReason?,
//                              current?, connectionKey?, effectiveAt?}) — strict
//   L2n additionally requires states[id].current (bool) for every pushed
//   zhipu-account provider whose access.entitled is true (i0e: account:zai-* /
//   account:bigmodel-* plan ids).
//
// What a headless client can assert: a configured `builtin:<family>-coding-plan`
// or `-start-plan` provider with an API key entitles its account:* rule
// (configuredKeyFor, same mapping the credential provisioner uses). Everything
// else is pushed fail-closed (access.entitled=false, no state) — the kernel's
// own O_e fail-closed snapshot has the same shape.
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { configuredKeyFor, configuredAccountKeys } from './account-provider.mjs';

// The runtime-anchored builtin path, same derivation as kernelEnv().
export function builtinConfigPath(entry) {
  const cfg = path.resolve(path.dirname(entry), '..', 'config', 'provider', 'zcode-builtin.json');
  return existsSync(cfg) ? cfg : null;
}

// The kernel's registry snapshot is keyed by `zcodeBuiltinRevision` =
// `zcode-builtin:<rev>:<sha256(resolve(effectiveBuiltinPath))>` (zcode.cjs
// qio/Ey.#r), where effectiveBuiltinPath is what the spawned app-server's
// ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ends up as AFTER the kernel's own env
// preparation: when the spawned env carries BOTH
// ZCODE_BUILTIN_PROVIDER_CONFIG_FILE + ZCODE_PERSONAL_PROVIDER_CONFIG_FILE the
// kernel passes them through; otherwise it rewrites the builtin path to the
// managed "active" file
//   <dataBaseDir>/.zcode/v2/runtime/provider/<platform>/<appVersion>/
//     endpoint-<sha256(origin).slice(0,32)>/zcode-builtin.json
// (G_e/H_e/Gio//Psr in zcode.cjs). A bare revision number never matches and
// the registry rebuild is skipped silently -> provider_not_found.
const sha256 = s => createHash('sha256').update(s).digest('hex');
const zcodeOrigin = env => {
  const test = env.ZCODE_ENV?.trim().toLowerCase() === 'test';
  const base = (env.ZCODE_BASE_URL ?? env.ZCODE_ENDPOINT_ORIGIN
    ?? (test ? env.ZCODE_TEST_BASE_URL : env.ZCODE_PRODUCTION_BASE_URL))?.trim();
  try { return base ? new URL(base).origin : test ? 'https://zcode.chatglm.site' : 'https://zcode.z.ai'; }
  catch { return test ? 'https://zcode.chatglm.site' : 'https://zcode.z.ai'; }
};
// `bundledPath` is the file kernelEnv() injects when the caller did not set
// ZCODE_BUILTIN_PROVIDER_CONFIG_FILE (runtime.mjs — the spawned env therefore
// carries preset || bundledPath). Pass it so the passthrough check models the
// child's env, not the parent's: PERSONAL-only callers get the injected
// bundled builtin paired with their personal path.
export function kernelActiveBuiltinPath({ env = process.env, home = os.homedir(), bundledPath } = {}) {
  const childBuiltin = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim() || bundledPath;
  if (childBuiltin && env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()) return childBuiltin;
  const dataBaseDir = env.ZCODE_DATA_BASE_DIR?.trim() || home;
  const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${
    process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}`;
  // Headless zcode.cjs spawns have __ZCODE_VERSION__ undefined -> "0.0.0-dev"
  // (kernel Gx). A future bundle that inlines the version would need the same
  // `typeof __ZCODE_VERSION__` rule here — the managed path would mismatch.
  const appVersion = '0.0.0-dev';
  const endpoint = `endpoint-${sha256(zcodeOrigin(env)).slice(0, 32)}`;
  return path.join(dataBaseDir, '.zcode', 'v2', 'runtime', 'provider',
    platform, appVersion, endpoint, 'zcode-builtin.json');
}

/**
 * Build provider/updateAccountConfig params, or null when there is nothing to
 * base a snapshot on (no readable builtin provider config).
 * @returns {{revision:string, basedOnZCodeBuiltinRevision:string,
 *            providers:Object, states:Object}|null}
 */
export function buildAccountConfigParams({
  env = process.env, home = os.homedir(), builtinPath,
  read = p => readFileSync(p, 'utf8'),
} = {}) {
  const p = builtinPath ?? env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim();
  const effectivePath = kernelActiveBuiltinPath({ env, home, bundledPath: builtinPath });
  // The kernel rebuilds its registry from ITS effective builtin file, so read
  // rules+revision from it when it is a different file and readable; else fall
  // back to `p` (the managed file is provisioned from the bundled one on the
  // kernel's first read, and env-passthrough makes them the same file).
  let builtin;
  const candidates = p && path.resolve(effectivePath) === path.resolve(p)
    ? [p] : [effectivePath, p];
  for (const f of candidates) {
    if (!f) continue;
    try { builtin = JSON.parse(read(f)); break; } catch { /* try the next candidate */ }
  }
  if (!builtin) return null;
  const rules = builtin?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules) || !rules.length) return null;
  // The registry rebuilds only when our push's basedOnZCodeBuiltinRevision
  // equals the kernel snapshot's `zcode-builtin:<rev>:<sha256(resolve(path))>`
  // — `path` is hashed verbatim, `rev` comes from the effective file itself.
  const builtinRevision = builtin?.revision ?? 'unknown';
  const basedOn = `zcode-builtin:${builtinRevision}:${sha256(path.resolve(effectivePath))}`;

  let configured = {};
  try {
    const dataBaseDir = env.ZCODE_DATA_BASE_DIR?.trim() || home;
    configured = configuredAccountKeys(
      JSON.parse(read(path.join(dataBaseDir, '.zcode', 'v2', 'config.json')))?.provider);
  } catch { /* nothing configured -> every rule pushed fail-closed */ }

  const providers = {}, states = {};
  for (const rule of rules) {
    const pid = rule?.providerId, access = rule?.config?.access ?? {};
    if (typeof pid !== 'string' || access.type !== 'zhipu-account') continue;
    const entitled = !!configuredKeyFor(configured, access.accountType, access.mode);
    providers[pid] = {
      builtinModelIds: rule.config?.builtinModelIds ?? [],
      access: { type: 'zhipu-account', entitled },
    };
    if (entitled) states[pid] = { availability: 'available', entitled: true, current: true };
  }
  return {
    revision: `account:${JSON.stringify([builtinRevision, providers, states])}`,
    basedOnZCodeBuiltinRevision: basedOn,
    providers,
    states,
  };
}

/**
 * Best-effort push. Never throws. Expected refusals — a pre-3.12.x runtime
 * (-32601), a kernel without the account-config surface (-32018), or a
 * standalone-mode registry ("Standalone Account 由本进程管理，不接收 Host
 * 覆盖", a generic Error over RPC) — return benign:true; anything else
 * (schema -32602, timeout, transport) returns benign:false so callers can
 * surface a real push failure instead of mistaking it for "no push needed".
 * @returns {Promise<{pushed:boolean, benign?:boolean, reason?:string, result?:Object}>}
 */
export async function pushAccountConfig(client, { timeoutMs = 15000, ...opts } = {}) {
  let params;
  try {
    params = buildAccountConfigParams({ builtinPath: client?.runtime ? builtinConfigPath(client.runtime) : undefined, ...opts });
  } catch { params = null; }
  if (!params) return { pushed: false, benign: true, reason: 'no builtin provider config' };
  try {
    const result = await client.call('provider/updateAccountConfig', params, timeoutMs);
    return { pushed: true, result };
  } catch (e) {
    const detail = `${e?.message ?? ''} ${JSON.stringify(e?.data ?? '')}`;
    const benign = e?.code === -32601 || e?.code === -32018 || /Standalone Account/.test(detail);
    return { pushed: false, benign, reason: `${e?.code ?? ''} ${e?.message ?? e}`.trim() };
  }
}
