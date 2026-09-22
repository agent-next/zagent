// rewind — fork-from-checkpoint (live-verified 2026-09-05, runtime 2.1.0).
//
// Workspace checkpoints appear automatically after file-editing turns (the runtime
// snapshots edited files). `session/fork {sessionId}` — and ONLY {sessionId}: extra keys
// like checkpointId/messageId are rejected (-32602) — forks from the LATEST checkpoint
// into a NEW session, restoring the snapshotted files ("copied N messages and restored
// N file"). That is the GUI's rewind semantics: rewind = fork at an earlier state.
//
// Before any edit has landed, fork answers -32603 "No workspace checkpoint is available yet."
//
// 3.12.1 widened the schema: `target` is a strict discriminated
// union {kind:"message",messageId} | {kind:"checkpoint",checkpointId} |
// {kind:"latestCheckpoint"} defaulting to latestCheckpoint, plus an optional
// nonnegative-int `expectedRevision`. Checkpoints are kernel-owned session_entry
// rows (runtime/workspace_checkpoint in ~/.zcode/cli/db/db.sqlite) — enumerable
// locally via listSessionCheckpoints; see notes below for the fork precondition.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

const CHECKPOINT_ID = /^checkpoint_[A-Za-z0-9-]+$/;

// Map a CLI action to the union member. `latest` -> the default leg; anything
// else needs its id validated before it reaches the wire (-32602 otherwise).
export function rewindTarget(action, id) {
  if (action === 'latest') return { kind: 'latestCheckpoint' };
  if (action === 'checkpoint') {
    if (!CHECKPOINT_ID.test(String(id ?? ''))) throw new Error(`invalid checkpoint id '${id}'`);
    return { kind: 'checkpoint', checkpointId: id };
  }
  if (action === 'message') {
    if (typeof id !== 'string' || !id.trim()) throw new Error('message target needs a message id');
    return { kind: 'message', messageId: id.trim() };
  }
  throw new Error(`unknown rewind target '${action}'`);
}

export async function forkSession(client, sessionId, { action = 'latest', checkpointId, messageId, expectedRevision } = {}) {
  const params = { sessionId, target: rewindTarget(action, action === 'checkpoint' ? checkpointId : messageId) };
  if (expectedRevision !== undefined) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error(`invalid expectedRevision '${expectedRevision}' (nonnegative integer)`);
    }
    params.expectedRevision = expectedRevision;
  }
  const r = await client.call('session/fork', params, 60000);
  return {
    forkedSessionId: r?.forkedSessionId ?? null,
    parentSessionId: r?.parentSessionId ?? null,
    targetCheckpointId: r?.targetCheckpointId ?? null,
    targetMessageId: r?.targetMessageId ?? null,
    summary: r?.response ?? '',
    snapshot: r?.snapshot ?? null,
  };
}

// Back-compat: the 2.1.0 minimal shape. `{sessionId}` alone is still correct on
// 3.12.1 because `target` defaults to {kind:"latestCheckpoint"}.
export async function forkLatest(client, sessionId) {
  const r = await client.call('session/fork', { sessionId }, 60000);
  return {
    forkedSessionId: r?.forkedSessionId ?? null,
    parentSessionId: r?.parentSessionId ?? null,
    targetCheckpointId: r?.targetCheckpointId ?? null,
    targetMessageId: r?.targetMessageId ?? null,
    summary: r?.response ?? '',
  };
}

// session/fork only reaches ACTIVE sessions — a finished -p session is absent
// from a fresh app-server's session map ("Session is not active", -32004).
// session/resume loads the persisted record first; a -32004 there means the
// session is truly gone. Live-verified 2026-09-16 on 3.12.1.
export function resumeSession(client, sessionId) {
  return client.call('session/resume', { sessionId }, 60000);
}

// The kernel's checkpoint ledger — NOT the GUI's git refs. Every CheckpointCreated
// event persists as a session_entry row (type runtime/workspace_checkpoint, id
// workspace-checkpoint:<eventId>) in ~/.zcode/cli/db/db.sqlite, for interactive
// AND headless -p sessions alike. Live-verified 2026-09-16 on 3.12.1: a -p Write
// turn persisted checkpoint_<uuid> here and resume+fork restored the file.
// (Only file-mutation tools — Write/Edit — checkpoint; Bash writes do not.)
// Same root rule as the kernel and inspect --storage: ZCODE_DATA_BASE_DIR
// replaces HOME, then /.zcode (verified live: session_entry.time_created is
// epoch ms, session.directory/session.path carry the workspace path).
export function sessionDbPath({ home = os.homedir() } = {}) {
  return path.join(process.env.ZCODE_DATA_BASE_DIR?.trim() || home, '.zcode', 'cli', 'db', 'db.sqlite');
}

function openSessionDb({ home } = {}) {
  try { return new DatabaseSync(sessionDbPath({ home }), { readOnly: true }); }
  catch { return null; } // absent store -> empty answers below, never thrown
}

// sessionId pins one session; cwd scopes to sessions whose workspace directory
// is cwd. A missing store answers []; a store that exists but fails the query
// (schema drift, busy) THROWS — an honest error beats a silent empty list.
export function listSessionCheckpoints({ home, sessionId, cwd } = {}) {
  const db = openSessionDb({ home });
  if (!db) return [];
  try {
    const rows = db.prepare(
      `SELECT se.session_id AS sessionId, se.time_created AS createdAt, se.data AS data,
              s.directory AS directory, s.path AS workspacePath
         FROM session_entry se LEFT JOIN session s ON s.id = se.session_id
        WHERE se.type = 'runtime/workspace_checkpoint'
        ORDER BY se.time_created, se.id`).all();
    const key = typeof cwd === 'string' ? path.normalize(cwd) : null;
    const out = [];
    for (const r of rows) {
      if (sessionId && r.sessionId !== sessionId) continue;
      const stored = r.workspacePath ?? r.directory ?? null;
      const workspace = typeof stored === 'string' ? path.normalize(stored) : null;
      if (key && workspace !== key) continue;
      let payload;
      try { payload = JSON.parse(r.data)?.payload; } catch { continue; }
      if (!CHECKPOINT_ID.test(String(payload?.checkpointId ?? ''))) continue;
      out.push({
        checkpointId: payload.checkpointId,
        sessionId: r.sessionId,
        messageId: payload.messageId ?? null,
        fileCount: Number.isInteger(payload.fileCount) ? payload.fileCount : null,
        createdAt: Number.isFinite(r.createdAt) ? r.createdAt : null,
        workspace,
      });
    }
    return out;
  } finally { try { db.close(); } catch {} }
}

// `rewind` without --session: pick the session that owns THIS workspace's
// newest checkpoint (that is what "undo my last file-editing turn" means), or —
// for an explicit checkpoint id — that checkpoint's owner session, even outside
// cwd. Falls back to the cwd's most recent session, then the caller's own
// recency source. A missing/empty store yields null.
export function defaultSessionForRewind({ home, cwd, checkpointId } = {}) {
  const safe = f => { try { return f(); } catch { return null; } };
  const scoped = safe(() => listSessionCheckpoints({ home, cwd })) ?? [];
  if (checkpointId) {
    const hit = scoped.find(c => c.checkpointId === checkpointId)
      ?? safe(() => listSessionCheckpoints({ home }).find(c => c.checkpointId === checkpointId));
    if (hit) return { id: hit.sessionId };
  }
  if (scoped.length) return { id: scoped.at(-1).sessionId };
  return safe(() => latestSessionForCwd({ home, cwd }));
}

// Most recent session for a workspace in the kernel store — the fallback for
// `rewind` without --session: headless -p sessions never write tasks-index
// rows, so recentSession() cannot see them (verified live 2026-09-16).
export function latestSessionForCwd({ home, cwd } = {}) {
  const db = openSessionDb({ home });
  if (!db || typeof cwd !== 'string') return null;
  try {
    const key = path.normalize(cwd);
    const rows = db.prepare(
      `SELECT id, directory, path, time_updated AS updatedAt FROM session
        ORDER BY time_updated DESC LIMIT 200`).all();
    const hit = rows.find(r => path.normalize(String(r.path ?? r.directory ?? '')) === key);
    return hit ? { id: hit.id, startedAt: null } : null;
  } finally { try { db.close(); } catch {} }
}

// GUI-side checkpoints: git refs under refs/zcode/checkpoints/<workspaceHash>/
// <checkpointId> in the workspace repo (GitCheckpointStore lives in the desktop
// app.asar, not the kernel — headless sessions never write these). Kept for
// diagnostics; `rewind list` shows the kernel store above, whose ids are the
// ones session/fork actually resolves.
export function listCheckpoints(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'for-each-ref', 'refs/zcode/checkpoints', '--format=%(refname)'],
    { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) return [];
  return String(r.stdout ?? '').split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(ref => {
      const m = ref.match(/^refs\/zcode\/checkpoints\/([^/]+)\/(checkpoint_[A-Za-z0-9-]+)$/);
      return m ? { workspace: m[1], checkpointId: m[2], ref } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.checkpointId.localeCompare(b.checkpointId));
}

export function noCheckpointYet(err) {
  return err?.code === -32603 && /no workspace checkpoint/i.test(String(err?.message ?? ''));
}

// --- v4 conversation surface (F9 remainder — 3.12.1 kernel catalog) ---
// v4/conversation/fileChanges answers the GUI's per-turn change chip
// ({files,additions,deletions,state?,items:[{path,additions,deletions,
// writeCount,toolNames}]}); v4/conversation/fileRewindPreview answers the
// rewind dialog ({canApply, safeFiles[], unsafeFiles[], ignoredFiles[]} —
// file rows carry reasons checkpoint_missing|checkpoint_unreadable|
// external_modified|file_read_failed|unsupported_checkpoint|bash_ignored).
// Both take the SAME strict params (quoted from the 3.12.1 zod schema):
//   {sessionId, target:{rowId:int>=0, entityId:string},
//    baseRevision:int>=0, baseLogEpoch:string}
// `target` identifies a projection ROW — only kind:'turnHeader' rows are
// eligible (kernel resolveRowActionTarget); rows carry entityId, turnId,
// fileChanges (array, .state==='active' marks rewindable), turnCheckpoints
// ({turnIndex,baseFileCheckpointId,resultFileCheckpointId?}) and
// actions.canRewindFiles. base* pins the snapshot the row came from:
// proto.staleRevision / proto.staleLogEpoch / proto.staleTarget on a stale
// pair, guard.actionUnavailable on a non-rewindable row.
// The snapshot is NOT the subscribe result: v4/conversation/subscribe answers
// {ack:{subscriptionId,mode,logEpoch}} and the initial snapshot frame follows
// as a v4/conversation/frame notification (post-response outbox).

export function conversationTopic(sessionId) {
  return `conversation/${sessionId}`;
}

// Subscribe and capture the first frame for our topic. The notification can
// land before or after the response resolves, so the hook installs first and
// the wait is bounded — a frame that never arrives yields wire:null.
export async function subscribeConversation(client, sessionId, { clientMode = 'desktop-continuous', timeoutMs = 20000, frameTimeoutMs = 10000 } = {}) {
  const connectionId = randomUUID();
  const topic = conversationTopic(sessionId);
  const prevNotify = client.onNotify;
  let resolveFrame;
  const frameReady = new Promise(r => { resolveFrame = r; });
  client.onNotify = msg => {
    try { prevNotify?.(msg); } catch {}
    const p = msg?.params;
    if (msg?.method !== 'v4/conversation/frame' || !p) return;
    if (p.topic !== topic && p.frame?.topic !== topic) return;
    // Only the snapshot frame resolves the wait — a delta/control frame
    // landing first must not end it early.
    const kind = p.frame?.payload?.kind ?? p.frame?.kind ?? p.kind;
    if (kind === 'snapshot' || p.snapshot || p.frame?.snapshot) resolveFrame(p);
  };
  try {
    const r = await client.call('v4/conversation/subscribe', { topic, connectionId, clientMode }, timeoutMs);
    let timer;
    const wire = await Promise.race([
      frameReady,
      new Promise(res => { timer = setTimeout(() => res(null), frameTimeoutMs); }),
    ]);
    clearTimeout(timer);
    return { ack: r?.ack ?? null, connectionId, topic, wire };
  } finally {
    client.onNotify = prevNotify;
  }
}

// Wire shape (verified live on the 3.12.1 kernel): params
// {wireVersion,kind,deliveryKind,logicalFrameId,logicalFrameOrdinal,topic,
// subscriptionId,frame:{topic,subscriptionId,sentAt,fromSeq,toSeq,
// payload:{kind:'snapshot',snapshot}}}; tolerate the flattened variants,
// then the projection snapshot {logEpoch,revision,rows:{window:[...]}}.
export function conversationSnapshot(wire) {
  const f = wire?.frame ?? wire;
  const s = f?.payload?.snapshot ?? f?.snapshot ?? f;
  if (!s || typeof s !== 'object') return null;
  return {
    logEpoch: typeof s.logEpoch === 'string' && s.logEpoch ? s.logEpoch : null,
    revision: Number.isInteger(s.revision) ? s.revision : null,
    rows: Array.isArray(s?.rows?.window) ? s.rows.window : [],
  };
}

// Pick the turnHeader row to query. An explicit checkpointId matches the row
// whose turnCheckpoints (base/result file checkpoint ids) owns it (null on a
// miss — the caller reports it); otherwise the newest row that carries a
// change summary or is rewindable.
export function pickConversationRow(rows, { checkpointId } = {}) {
  const headers = (Array.isArray(rows) ? rows : []).filter(r =>
    r?.kind === 'turnHeader' && Number.isInteger(r.rowId) &&
    typeof r.entityId === 'string' && r.entityId);
  if (checkpointId) {
    return headers.find(r => rowOwnsCheckpoint(r, checkpointId)) ?? null;
  }
  const eligible = headers.filter(r => r?.actions?.canRewindFiles === true || r?.fileChanges != null);
  // Prefer rewindable rows (the kernel sets canRewindFiles only while
  // fileChanges.state === 'active'), then the newest by rowId — window order
  // is not a documented sort key.
  const pick = list => list.reduce((a, r) => (a === null || r.rowId > a.rowId ? r : a), null);
  return pick(eligible.filter(r => r?.actions?.canRewindFiles === true)) ?? pick(eligible);
}

function rowOwnsCheckpoint(row, checkpointId) {
  const cps = Array.isArray(row?.turnCheckpoints) ? row.turnCheckpoints : [];
  return cps.some(c => typeof c === 'string' ? c === checkpointId
    : c?.baseFileCheckpointId === checkpointId || c?.resultFileCheckpointId === checkpointId
      || c?.checkpointId === checkpointId || c?.id === checkpointId);
}

function rowQueryParams(sessionId, row, snapshot) {
  return {
    sessionId,
    target: { rowId: row.rowId, entityId: row.entityId },
    baseRevision: snapshot.revision,
    baseLogEpoch: snapshot.logEpoch,
  };
}

export function conversationFileChanges(client, sessionId, row, snapshot) {
  return client.call('v4/conversation/fileChanges', rowQueryParams(sessionId, row, snapshot), 30000);
}

export function conversationFileRewindPreview(client, sessionId, row, snapshot) {
  return client.call('v4/conversation/fileRewindPreview', rowQueryParams(sessionId, row, snapshot), 30000);
}

export function unsubscribeConversation(client, { topic, subscriptionId, connectionId }) {
  return client.call('v4/conversation/unsubscribe', { topic, subscriptionId, connectionId }, 10000);
}

// -32601 (older runtimes never registered the v4 surface) or the kernel's
// -32603 "v4 gateway is not initialized"; fault.*.unsupported marks a host
// that registered the method without the runtime capability.
// The kernel may surface these as the error message OR the code — match both.
const errText = err => `${err?.message ?? ''} ${err?.code ?? ''}`;

export function isV4SurfaceUnavailable(err) {
  return err?.code === -32601
    || (err?.code === -32603 && /v4 gateway/i.test(String(err?.message ?? '')))
    || /fault\.(fileChanges|fileRewindPreview)\.unsupported/.test(errText(err));
}

export function isStaleConversationBase(err) {
  return /proto\.stale(Revision|LogEpoch|Target)/.test(errText(err));
}

export function isRowActionUnavailable(err) {
  return /guard\.actionUnavailable/.test(errText(err));
}
