// The persisted DEFAULT permission mode for headless -p runs (F14c follow-up).
//
// The kernel already persists a PER-PROJECT mode itself — session/setMode writes
// local_setting permission/mode and session/create restores it — which is what
// the TUI's /mode picker owns. What nothing owned: a user-level default for the
// `-p` path, whose kernel default is yolo (every tool executes unconfirmed).
// This module stores that default as `permissions.defaultMode` inside the
// existing ~/.zcode/cli/config.json — the same file that already carries
// zagent-owned keys like hooks.* and plugins.suppressedBuiltins; the kernel
// reads the file leniently (JSON.parse + is-object) and ignores unknown keys.
//
// 'auto' exists in session/setMode's MODES but is NOT --mode-launchable (the
// runtime refuses it: "reserved but not implemented yet") — the launchable
// domain is exactly the kernel's --mode enum.
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MODE_VALUES = ['build', 'edit', 'plan', 'yolo'];

const configPath = ({ home } = {}) => path.join(home ?? os.homedir(), '.zcode', 'cli', 'config.json');
const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Like readDefaultMode but reports WHY there is no mode, so a user-facing
 * surface can distinguish 'unset' from 'could not read the config' — the -p
 * injection stays silently fail-open (a corrupt config must never brick -p),
 * but `zagent mode` should not call an unparseable file "not set".
 */
export function readDefaultModeDetail({ home } = {}) {
  const file = configPath({ home });
  if (!existsSync(file)) return { mode: null, state: 'absent' };
  let cfg;
  try { cfg = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { return { mode: null, state: e instanceof SyntaxError ? 'malformed' : 'unreadable' }; }
  if (!isObject(cfg)) return { mode: null, state: 'malformed' };
  const v = cfg.permissions?.defaultMode;
  if (v === undefined) return { mode: null, state: 'unset' };
  if (!DEFAULT_MODE_VALUES.includes(v)) return { mode: null, state: 'invalid', value: v };
  return { mode: v, state: 'ok' };
}

/** The stored default mode, or null — never throws (absent file, non-object config, invalid/absent value all read as unset). */
export function readDefaultMode({ home } = {}) {
  return readDefaultModeDetail({ home }).mode;
}

// Same tmp+rename convention as saveGrantFile (permissions.mjs): renameSync
// drops the tmp file's mode onto an existing dest, so chmod after the rename.
function saveConfig(file, cfg) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    // The rename already lands the tmp file's 0600 — a chmod failure after a
    // persisted write must not report failure for a write that succeeded.
    try { chmodSync(file, 0o600); } catch {}
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Merge-set (or delete, when mode is null) permissions.defaultMode in the
 * EXISTING config — the file is never created just to hold this key, and an
 * emptied `permissions` object is dropped with it. Returns whether the stored
 * value changed. Throws a plain, user-facing Error when there is nothing safe
 * to merge into.
 */
export function writeDefaultMode(mode, { home } = {}) {
  if (mode !== null && !DEFAULT_MODE_VALUES.includes(mode))
    throw new Error(`mode must be one of ${DEFAULT_MODE_VALUES.join('|')} (got '${mode}')`);
  const file = configPath({ home });
  // Clearing an absent config is a no-op success — 'no default set' is already
  // the true state, and idempotent `mode clear` in scripts must not exit 1.
  if (!existsSync(file)) {
    if (mode === null) return false;
    throw new Error('no ~/.zcode/cli/config.json yet — run `zagent` once first');
  }
  let cfg;
  try { cfg = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) {
    // Parse failures and read failures are different diagnoses — an unreadable
    // but valid file (EACCES, EISDIR) must not be reported as bad JSON.
    throw new Error(e instanceof SyntaxError
      ? 'config is not valid JSON — not touching it'
      : `cannot read config: ${e.code ?? e.message}`);
  }
  if (!isObject(cfg))
    throw new Error('config is not a JSON object — not touching it');
  const perms = cfg.permissions;
  let changed = false;
  if (mode === null) {
    if (isObject(perms) && Object.hasOwn(perms, 'defaultMode')) {
      delete perms.defaultMode;
      if (!Object.keys(perms).length) delete cfg.permissions;
      changed = true;
    } // a non-object `permissions` cannot hold a defaultMode — nothing to clear
  } else {
    if (perms !== undefined && !isObject(perms))
      throw new Error('config permissions is not an object — not touching it');
    const p = cfg.permissions ?? (cfg.permissions = {});
    if (p.defaultMode !== mode) { p.defaultMode = mode; changed = true; }
  }
  if (changed) saveConfig(file, cfg);
  return changed;
}

/**
 * A NEW argv with `--mode <mode>` inserted before the first `--` token
 * (appended when none) — post-`--` tokens are the kernel's positionals and
 * must keep their positions. Pure.
 */
export function withPersistedMode(args, mode) {
  const sep = args.indexOf('--');
  const out = [...args];
  out.splice(sep === -1 ? out.length : sep, 0, '--mode', mode);
  return out;
}

/** True when a PRE-`--` token is `--mode` or `--mode=…` — an explicit flag always beats the persisted default. */
export function hasModeFlag(preSepArgs) {
  return preSepArgs.some(a => a === '--mode' || a.startsWith('--mode='));
}
