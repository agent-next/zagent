// D3 phase 3 — rpc-frame workspace bridge (mobile fully driving a session).
// Schema extracted from the desktop's own zod validators (app.asar main chunk, 2026-09-06):
//   rpc-frame = {zcode_type:'rpc-frame', bridgeSessionId(1..N, [A-Za-z0-9._~-]), bridgeGeneration?, recoveryId?,
//     seq(int>0), messageSeq(int>0), fragmentIndex(0..63), fragmentCount(1..64, <= messageBytes),
//     messageBytes(int>0), checksum:{algorithm:'crc32', value:8-lowercase-hex}, dataBase64(canonical, >=4 chars)}
//     — strict; fragmentIndex must be < fragmentCount.
//   rpc-frame-ack = {zcode_type:'rpc-frame-ack', bridgeSessionId, bridgeGeneration?, recoveryId?, ackMessageSeq(int>0)}
//   relay envelope: {type:'data', payload: frame|ack, client_ts?, server_ts?}
//   limits: maxFragments 64, assemblyTimeoutMs 30_000.
// Checksum scope note: whole-MESSAGE crc32 (verified by reassembly success); if live relay
// traffic ever disagrees, this is the line to re-check.

export const LIMITS = { maxFragments: 64, maxPhysicalFrameBytes: 64 * 1024, maxMessageBytes: 4 * 1024 * 1024,
  maxBufferedMessages: 64, maxBufferedBytes: 8 * 1024 * 1024, maxTotalBufferedBytes: 32 * 1024 * 1024,
  assemblyTimeoutMs: 30_000 };

const ID_RE = /^[A-Za-z0-9._~-]+$/;
const HEX8_RE = /^[0-9a-f]{8}$/;

const CRC_TABLE = (() => { const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0; }
  return t; })();

export function crc32Hex(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

// Canonical base64 check (the desktop rejects re-encoded/padded variants): strict roundtrip.
export function isCanonicalBase64(s) {
  if (typeof s !== 'string' || s.length < 4) return false;
  try {
    const b = Buffer.from(s, 'base64');
    return b.length > 0 && b.toString('base64') === s;
  } catch { return false; }
}

export function frameValidationError(f) { // -> reason string | null (schema + superRefine rules)
  if (f?.zcode_type !== 'rpc-frame') return 'zcode_type';
  if (typeof f.bridgeSessionId !== 'string' || f.bridgeSessionId.length > 256 || !ID_RE.test(f.bridgeSessionId)) return 'bridgeSessionId';
  for (const k of ['seq', 'messageSeq']) if (!Number.isSafeInteger(f[k]) || f[k] <= 0) return k;
  if (f.bridgeGeneration !== undefined && (!Number.isSafeInteger(f.bridgeGeneration) || f.bridgeGeneration < 0)) return 'bridgeGeneration';
  if (f.recoveryId !== undefined && (typeof f.recoveryId !== 'string' || f.recoveryId.length > 256 || !ID_RE.test(f.recoveryId))) return 'recoveryId';
  if (!Number.isInteger(f.fragmentIndex) || f.fragmentIndex < 0 || f.fragmentIndex >= LIMITS.maxFragments) return 'fragmentIndex';
  if (!Number.isInteger(f.fragmentCount) || f.fragmentCount < 1 || f.fragmentCount > LIMITS.maxFragments) return 'fragmentCount';
  if (f.fragmentIndex >= f.fragmentCount) return 'fragmentIndex >= fragmentCount';
  if (!Number.isSafeInteger(f.messageBytes) || f.messageBytes <= 0 || f.messageBytes > LIMITS.maxMessageBytes) return 'messageBytes';
  if (f.fragmentCount > f.messageBytes) return 'fragmentCount > messageBytes';
  if (!f.checksum || f.checksum.algorithm !== 'crc32' || !HEX8_RE.test(f.checksum?.value ?? '')) return 'checksum';
  // Reject oversized encoded data before decoding it for the canonical check.
  if (typeof f.dataBase64 !== 'string' || f.dataBase64.length > 4 * Math.ceil(LIMITS.maxPhysicalFrameBytes / 3)) return 'dataBase64';
  if (!isCanonicalBase64(f.dataBase64)) return 'dataBase64';
  const fragmentBytes = Buffer.byteLength(f.dataBase64, 'base64');
  if (fragmentBytes > LIMITS.maxPhysicalFrameBytes || fragmentBytes > f.messageBytes) return 'fragmentBytes';
  return null;
}

// Fragment a message into valid frames (whole-message crc, contiguous fragmentIndex).
export function buildFrames({ bridgeSessionId, message, seq = 1, messageSeq = 1, bridgeGeneration, maxBytesPerFrame = 24 * 1024 }) { // bridgeGeneration defaults to 0 on every frame
  if (typeof message !== 'string' || message.length === 0) throw new Error('buildFrames: message required');
  const bytes = Buffer.from(message, 'utf8');
  if (typeof bridgeSessionId !== 'string' || !ID_RE.test(bridgeSessionId)) throw new Error('buildFrames: invalid bridgeSessionId');
  if (!Number.isSafeInteger(maxBytesPerFrame) || maxBytesPerFrame <= 0) throw new Error('buildFrames: maxBytesPerFrame must be a positive integer');
  if (bytes.length > LIMITS.maxMessageBytes) throw new Error('buildFrames: message exceeds byte limit');
  const fragmentSize = Math.min(maxBytesPerFrame, LIMITS.maxPhysicalFrameBytes);
  const fragmentCount = Math.ceil(bytes.length / fragmentSize);
  if (fragmentCount > LIMITS.maxFragments) throw new Error(`buildFrames: needs ${fragmentCount} fragments (max ${LIMITS.maxFragments})`);
  const checksum = { algorithm: 'crc32', value: crc32Hex(bytes) };
  const frames = [];
  for (let i = 0; i < fragmentCount; i++) {
    // bridgeGeneration always present (review r3 #3: schema marks it optional but the
    // desktop's generation fencing rejects frames without it).
    const frame = { zcode_type: 'rpc-frame', bridgeSessionId, bridgeGeneration: bridgeGeneration ?? 0, seq, messageSeq,
      fragmentIndex: i, fragmentCount, messageBytes: bytes.length, checksum,
      dataBase64: bytes.subarray(i * fragmentSize, (i + 1) * fragmentSize).toString('base64') };
    const err = frameValidationError(frame);
    if (err) throw new Error(`buildFrames: produced invalid frame (${err}) — bug`);
    frames.push(frame);
  }
  return frames;
}

export function frameAck({ bridgeSessionId, ackMessageSeq, bridgeGeneration, recoveryId } = {}) {
  if (!ID_RE.test(String(bridgeSessionId ?? ''))) throw new Error('frameAck: invalid bridgeSessionId');
  if (!Number.isInteger(ackMessageSeq) || ackMessageSeq <= 0) throw new Error('frameAck: ackMessageSeq must be int > 0');
  const ack = { zcode_type: 'rpc-frame-ack', bridgeSessionId, bridgeGeneration: bridgeGeneration ?? 0, ackMessageSeq };
  if (recoveryId !== undefined) ack.recoveryId = recoveryId;
  return ack;
}

// Reassemble a set of frames for one messageSeq → {message, bridgeSessionId} or throws.
// Tolerant input: duplicates and out-of-order frames; intolerant of validation/coverage/integrity.
export function assembleFrames(frames) {
  const valid = [];
  for (const f of frames ?? []) {
    const err = frameValidationError(f);
    if (err) throw new Error(`assembleFrames: invalid frame (${err})`);
    valid.push(f);
  }
  if (!valid.length) throw new Error('assembleFrames: no frames');
  const { bridgeSessionId, messageSeq, fragmentCount, messageBytes, checksum } = valid[0];
  for (const f of valid) {
    if (f.bridgeSessionId !== bridgeSessionId) throw new Error('assembleFrames: mixed bridgeSessionId');
    if (f.messageSeq !== messageSeq) throw new Error('assembleFrames: mixed messageSeq');
    if (f.checksum.value !== checksum.value) throw new Error('assembleFrames: checksum disagreement');
    if (f.fragmentCount !== fragmentCount || f.messageBytes !== messageBytes ||
        (f.bridgeGeneration ?? 0) !== (valid[0].bridgeGeneration ?? 0)) throw new Error('assembleFrames: inconsistent metadata');
  }
  // Desktop strictness (review r3 #3): the authoritative bridge REJECTS repeated fragment
  // sequence numbers — duplicates are a protocol violation, not redelivery to tolerate.
  const byIndex = new Map();
  for (const f of valid) {
    if (byIndex.has(f.fragmentIndex)) throw new Error(`assembleFrames: duplicate fragment ${f.fragmentIndex}`);
    byIndex.set(f.fragmentIndex, f);
  }
  for (let i = 0; i < fragmentCount; i++)
    if (!byIndex.has(i)) throw new Error(`assembleFrames: missing fragment ${i}`);
  const parts = [];
  let size = 0;
  for (let i = 0; i < fragmentCount; i++) {
    const part = Buffer.from(byIndex.get(i).dataBase64, 'base64');
    size += part.length;
    if (size > messageBytes) throw new Error('assembleFrames: fragments exceed messageBytes');
    parts.push(part);
  }
  if (size !== messageBytes) throw new Error(`assembleFrames: assembled ${size} bytes, expected ${messageBytes}`);
  const buf = Buffer.concat(parts, size);
  if (crc32Hex(buf) !== checksum.value) throw new Error('assembleFrames: crc32 mismatch — corrupted message');
  return { message: buf.toString('utf8'), bridgeSessionId, messageSeq };
}
