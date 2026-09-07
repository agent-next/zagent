// E4 rewind — fork-from-checkpoint (live-verified 2026-09-05, runtime 2.1.0).
//
// Workspace checkpoints appear automatically after file-editing turns (the runtime
// snapshots edited files). `session/fork {sessionId}` — and ONLY {sessionId}: extra keys
// like checkpointId/messageId are rejected (-32602) — forks from the LATEST checkpoint
// into a NEW session, restoring the snapshotted files ("copied N messages and restored
// N file"). That is the GUI's rewind semantics: rewind = fork at an earlier state.
//
// Before any edit has landed, fork answers -32603 "No workspace checkpoint is available yet."

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

export function noCheckpointYet(err) {
  return err?.code === -32603 && /no workspace checkpoint/i.test(String(err?.message ?? ''));
}
