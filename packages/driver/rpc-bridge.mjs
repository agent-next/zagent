// RPC frames -> bounded assembly -> local execution -> framed responses and acks.
// Budgets include executing requests, so a slow executor cannot bypass admission
// limits by immediately converting partial assemblies into pending promises.
import { buildFrames, frameValidationError, assembleFrames, frameAck, LIMITS } from './rpc-frame.mjs';

const MAX_TRACKED_SESSIONS = 64;
const MAX_COMPLETED = 512;

function validRequest(msg) {
  return msg !== null && typeof msg === 'object' && !Array.isArray(msg) &&
    (msg.jsonrpc === undefined || msg.jsonrpc === '2.0') &&
    typeof msg.method === 'string' && msg.method.length > 0 && msg.method.length <= 256 &&
    (msg.id === undefined || msg.id === null || (typeof msg.id === 'string' && msg.id.length <= 256) || Number.isFinite(msg.id)) &&
    (msg.params === undefined || (msg.params !== null && typeof msg.params === 'object'));
}

export function createRpcBridge({ send, call, onEvent = () => {}, now = () => Date.now(), assemblyTimeoutMs = LIMITS.assemblyTimeoutMs } = {}) {
  if (typeof send !== 'function' || typeof call !== 'function') throw new Error('rpc-bridge: send(payload) and call(method, params) required');
  if (!Number.isFinite(assemblyTimeoutMs) || assemblyTimeoutMs <= 0 || assemblyTimeoutMs > LIMITS.assemblyTimeoutMs) throw new Error('rpc-bridge: invalid assembly timeout');
  const sessions = new Map();
  let totalBytes = 0;
  const releaseBytes = (st, count) => { st.bytes -= count; totalBytes -= count; };
  function removeAssembly(st, key, { keepBytes = false } = {}) {
    const assembly = st.buffers.get(key);
    if (!assembly) return;
    clearTimeout(assembly.timer);
    st.buffers.delete(key);
    if (!keepBytes) releaseBytes(st, assembly.bytes);
  }
  function expire(st, key) {
    if (!st.buffers.has(key)) return;
    removeAssembly(st, key);
    onEvent('assembly-timeout', key);
  }
  function stateFor(sid) {
    let st = sessions.get(sid);
    if (!st) {
      if (sessions.size >= MAX_TRACKED_SESSIONS) {
        let oldest = null;
        for (const [k, v] of sessions) if (!v.active && (!oldest || v.lastSeen < oldest[1].lastSeen)) oldest = [k, v];
        if (!oldest) return null;
        for (const key of oldest[1].buffers.keys()) removeAssembly(oldest[1], key);
        sessions.delete(oldest[0]);
      }
      st = { buffers: new Map(), completed: new Set(), outSeq: 1, respSeq: 1, lastSeen: now(), bytes: 0, active: 0 };
      sessions.set(sid, st);
    }
    st.lastSeen = now();
    return st;
  }
  const reply = payload => send({ type: 'data', payload, client_ts: Date.now() });
  const refused = reason => { onEvent('invalid', reason); return { handled: 'invalid', reason }; };

  async function ingest(payload) {
    if (payload?.zcode_type === 'rpc-frame-ack') { onEvent('ack', payload.ackMessageSeq); return { handled: 'ack' }; }
    if (payload?.zcode_type !== 'rpc-frame') return { handled: 'ignored' };
    const err = frameValidationError(payload);
    if (err) return refused(err);
    // Timers expire silent sessions; this sweep also supports a supplied test clock.
    for (const state of sessions.values()) for (const [key, a] of state.buffers)
      if (now() - a.at >= assemblyTimeoutMs) expire(state, key);
    const st = stateFor(payload.bridgeSessionId);
    if (!st) return refused('session budget exceeded');
    const gen = payload.bridgeGeneration ?? 0, key = `${gen}|${payload.messageSeq}`;
    if (st.completed.has(key)) { onEvent('dup-message', key); return { handled: 'duplicate' }; }
    let assembly = st.buffers.get(key);
    if (assembly?.frames.some(f => f.fragmentIndex === payload.fragmentIndex)) return { handled: 'duplicate' };
    const count = Buffer.byteLength(payload.dataBase64, 'base64');
    if ((!assembly && st.buffers.size + st.active >= LIMITS.maxBufferedMessages) ||
        st.bytes + count > LIMITS.maxBufferedBytes || totalBytes + count > LIMITS.maxTotalBufferedBytes) {
      return refused('assembly budget exceeded');
    }
    if (!assembly) {
      assembly = { frames: [], bytes: 0, at: now(), timer: setTimeout(() => expire(st, key), assemblyTimeoutMs) };
      assembly.timer.unref?.();
      st.buffers.set(key, assembly);
    }
    const first = assembly.frames[0];
    if (first && (first.fragmentCount !== payload.fragmentCount || first.messageBytes !== payload.messageBytes || first.checksum.value !== payload.checksum.value)) {
      removeAssembly(st, key);
      return refused('inconsistent assembly metadata');
    }
    if (assembly.bytes + count > payload.messageBytes) {
      removeAssembly(st, key);
      return refused('fragments exceed messageBytes');
    }
    // Store only bounded, validated fields; arbitrary extra payload fields are not retained.
    const { bridgeSessionId, messageSeq, seq, fragmentIndex, fragmentCount, messageBytes, dataBase64 } = payload;
    assembly.frames.push({ zcode_type: 'rpc-frame', bridgeSessionId, bridgeGeneration: gen, messageSeq, seq,
      fragmentIndex, fragmentCount, messageBytes, checksum: { algorithm: 'crc32', value: payload.checksum.value }, dataBase64 });
    assembly.bytes += count; st.bytes += count; totalBytes += count;
    if (assembly.frames.length < fragmentCount) return { handled: 'partial', have: assembly.frames.length, need: fragmentCount };
    removeAssembly(st, key, { keepBytes: true });
    st.active++;
    try {
      let text;
      try { text = assembleFrames(assembly.frames).message; }
      catch (e) { onEvent('assemble-error', String(e.message)); return { handled: 'assemble-error' }; }
      st.completed.add(key);
      if (st.completed.size > MAX_COMPLETED) st.completed.delete(st.completed.values().next().value);
      reply(frameAck({ bridgeSessionId, bridgeGeneration: gen, ackMessageSeq: messageSeq }));
      let msg, result, error = null;
      try { msg = JSON.parse(text); }
      catch { error = { code: -32700, message: 'Parse error' }; }
      if (!error && !validRequest(msg)) error = { code: -32600, message: 'Invalid Request' };
      if (!error) {
        try { result = await call(msg.method, msg.params); }
        catch (e) { error = { code: e?.code ?? -32000, message: String(e?.message ?? e) }; }
      }
      const id = validRequest(msg) ? msg.id ?? null : null;
      const response = { jsonrpc: '2.0', id, ...(error ? { error } : { result: result ?? null }) };
      let frames;
      const frameResponse = response => buildFrames({ bridgeSessionId, bridgeGeneration: gen,
        message: JSON.stringify(response), messageSeq: st.respSeq });
      try { frames = frameResponse(response); }
      catch { frames = frameResponse({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Response cannot be encoded within the RPC limits' } }); }
      st.respSeq++;
      for (const frame of frames) { frame.seq = st.outSeq++; reply(frame); }
      return { handled: 'replied', messageSeq };
    } finally { st.active--; releaseBytes(st, assembly.bytes); }
  }

  return {
    ingest,
    sessions: () => sessions.size,
    buffered: sid => sid ? sessions.get(sid)?.buffers.size ?? 0 : [...sessions.values()].reduce((n, s) => n + s.buffers.size, 0),
    bufferedBytes: () => totalBytes,
    close() { for (const st of sessions.values()) for (const key of st.buffers.keys()) removeAssembly(st, key); sessions.clear(); },
  };
}
