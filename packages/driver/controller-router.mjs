// D3 — device-side controller router (mobile/remote sync).
// Answers the web controller's app-payloads over the relay data channel, per the
// 18-type zcode_type catalog captured from the desktop main bundle (gui-max dossier,
// 2026-09-04). Frame shapes: {zcode_type:'bootstrap-request',requestId} ->
// {zcode_type:'bootstrap-response',requestId,success,result} etc.
// rpc-frame/rpc-frame-ack (the raw workspace bridge) are NOT implemented here — D3 phase 2.

import { readFileSync, statSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import os from 'node:os';

const APP_TYPES = [ // full catalog; handlers registered below answer 5, pass the rest
  'bootstrap-request', 'bootstrap-response', 'workspace-list-request', 'workspace-list-response',
  'workspace-list-updated', 'workspace-bridge-open', 'workspace-bridge-ready', 'workspace-bridge-error',
  'workspace-reconnect-request', 'workspace-reconnect-response', 'mobile-view-state-update',
  'platform-request', 'platform-response', 'rpc-frame', 'rpc-frame-ack', 'bridge-degraded',
  'app-error', 'mobile-diagnostic',
];

let wsCache = { mtime: 0, data: [] };
export function workspaces() { // same registry the GUI reads; mtime-keyed (per-frame cheap)
  try {
    const f = `${os.homedir()}/.zcode/v2/setting.json`;
    const m = statSync(f).mtimeMs;
    if (m === wsCache.mtime) return wsCache.data;
    const s = JSON.parse(readFileSync(f, 'utf8'));
    wsCache = { mtime: m, data: (s.recentProjects ?? []).filter(p => typeof p === 'string').map(p => ({ workspaceKey: p, workspacePath: p, label: p.split('/').pop() })) };
    return wsCache.data;
  } catch { return []; }
}

// Router: (payload, ctx) -> reply payload | null (null = no reply; pushes handled by caller)
export function routePayload(p, ctx = {}) {
  switch (p?.zcode_type) {
    case 'bootstrap-request':
      return { zcode_type: 'bootstrap-response', requestId: p.requestId, success: true,
        result: { windowControlSessionId: ctx.deviceSid ?? '', workspaces: workspaces(),
                  tasks: ctx.tasks ?? [], initialViewState: ctx.initialViewState ?? {},
                  mobileViewState: ctx.mobileViewState ?? {} } }; // catalog field (review r3 #2)
    case 'workspace-list-request':
      return { zcode_type: 'workspace-list-response', requestId: p.requestId, success: true,
        result: { workspaces: workspaces(), tasks: ctx.tasks ?? [] } };
    case 'mobile-view-state-update':
      ctx.onViewState?.(p.viewState, p.deviceInfo);
      return null;
    case 'platform-request':
      return { zcode_type: 'platform-response', requestId: p.requestId, success: false,
        error: 'not implemented in zagent (D3 phase 2)' };
    case 'app-error':
      ctx.onError?.(p);
      return null;
    default:
      return null; // pushes (workspace-list-updated etc.) and bridge frames: caller policy
  }
}

export { APP_TYPES };

// --- B3: setting.json read/write parity (GUI interop) ---
export function settingsPath() { return `${os.homedir()}/.zcode/v2/setting.json`; }

export function readSettings() {
  try { return JSON.parse(readFileSync(settingsPath(), 'utf8')); }
  catch { return {}; }
}

export function writeSettings(updates, { now = Date.now() } = {}) {
  const p = settingsPath();
  let cur = {}, raw = null;
  try { raw = readFileSync(p, 'utf8'); } catch {} // file present (even unparseable) = raw !== null
  if (raw !== null) { try { cur = JSON.parse(raw); } catch {
    // Review r4: never silently clobber an unreadable-but-present file — preserve it for
    // recovery, then write fresh. A corrupt GUI config is data, not garbage.
    try { copyFileSync(p, `${p}.corrupt-${now}`); } catch {}
  } }
  const next = { ...cur, ...updates };
  mkdirSync(`${os.homedir()}/.zcode/v2`, { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2));
  return next;
}

export function addRecentProject(workspacePath) {
  const s = readSettings();
  const cur = s.recentProjects ?? [];
  const deduped = [workspacePath, ...cur.filter(p => p !== workspacePath)].slice(0, 10); // cap 10, most-recent-first
  return writeSettings({ recentProjects: deduped });
}
