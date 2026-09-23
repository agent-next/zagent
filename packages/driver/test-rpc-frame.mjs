// D3 rpc-frame tests — schema rules extracted from the desktop zod validators (2026-09-06).
import { buildFrames, assembleFrames, frameAck, frameValidationError, crc32Hex, isCanonicalBase64, LIMITS } from './rpc-frame.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

// crc32 known vectors (zlib crc32 of 'hello world' etc — verified standard values)
ok(crc32Hex(Buffer.from('hello world')) === '0d4a1185', 'crc32 hello-world vector');
ok(crc32Hex(Buffer.from('')) === '00000000', 'crc32 empty');

// canonical base64
ok(isCanonicalBase64(Buffer.from('abc').toString('base64')) === true, 'canonical accepted');
ok(isCanonicalBase64('YWJj==') === false, 'non-canonical rejected');
ok(isCanonicalBase64('ab') === false, 'too short rejected');

// single-frame roundtrip
let frames = buildFrames({ bridgeSessionId: 'bridge-1.~', message: '{"method":"session/send"}' });
ok(frames.length === 1 && frames[0].fragmentCount === 1, 'small message single frame');
let asm = assembleFrames(frames);
ok(asm.message === '{"method":"session/send"}' && asm.messageSeq === 1, 'single-frame roundtrip');

// multi-fragment: force small frames
const big = 'x'.repeat(1000) + 'y'.repeat(500);
frames = buildFrames({ bridgeSessionId: 'b', message: big, maxBytesPerFrame: 400 });
ok(frames.length === 4, 'fragmented by maxBytesPerFrame');
ok(frames.every(f => frameValidationError(f) === null), 'all frames schema-valid');
ok(frames.every(f => f.bridgeGeneration === 0), 'bridgeGeneration always emitted (default 0)');
asm = assembleFrames(frames);
ok(asm.message === big, 'multi-fragment roundtrip');

// reorder tolerated; duplicates REJECTED (desktop strictness, r3 #3)
const shuffled = [frames[2], frames[0], frames[3], frames[1]];
ok(assembleFrames(shuffled).message === big, 'out-of-order frames reassemble');
let dupThrew = false; try { assembleFrames([frames[0], frames[0]]); } catch (e) { dupThrew = /duplicate fragment/.test(e.message); }
ok(dupThrew, 'duplicate fragment rejected (desktop parity)');

// validation failures (the zod rules, one per branch)
const base = () => buildFrames({ bridgeSessionId: 'b', message: 'payload-bytes' })[0];
ok(frameValidationError({ ...base(), fragmentIndex: 2, fragmentCount: 2 }) === 'fragmentIndex >= fragmentCount', 'superRefine: index >= count');
ok(frameValidationError({ ...base(), fragmentCount: 3, messageBytes: 2 }) === 'fragmentCount > messageBytes', 'superRefine: count > messageBytes');
ok(frameValidationError({ ...base(), bridgeSessionId: 'bad id!' }) === 'bridgeSessionId', 'id charset enforced');
ok(frameValidationError({ ...base(), seq: 0 }) === 'seq', 'seq must be > 0');
ok(frameValidationError({ ...base(), checksum: { algorithm: 'crc32', value: 'XYZ' } }) === 'checksum', 'checksum 8-hex lowercase');
ok(frameValidationError({ ...base(), dataBase64: 'not base64!!' }) === 'dataBase64', 'dataBase64 canonical');
ok(frameValidationError({ ...base(), fragmentCount: LIMITS.maxFragments + 1 }) === 'fragmentCount', 'maxFragments 64 cap');

// assembly integrity
let tampered = frames.map(f => ({ ...f }));
tampered[1] = { ...tampered[1], dataBase64: Buffer.from('zzzz').toString('base64') };
let threw = false; try { assembleFrames(tampered); } catch (e) { threw = /crc32 mismatch|assembled|exceed/.test(e.message); }
ok(threw, 'corrupted fragment detected (size or crc)');

threw = false; try { assembleFrames(frames.slice(0, 3)); } catch (e) { threw = /missing fragment/.test(e.message); }
ok(threw, 'missing fragment named');

const other = buildFrames({ bridgeSessionId: 'b', message: 'other', messageSeq: 2 });
threw = false; try { assembleFrames([...frames, ...other]); } catch (e) { threw = /mixed messageSeq/.test(e.message); }
ok(threw, 'mixed messageSeq refused');

// oversize message guard
threw = false; try { buildFrames({ bridgeSessionId: 'b', message: 'y'.repeat(64 * 24 * 1024 + 100), maxBytesPerFrame: 24 * 1024 }); } catch (e) { threw = /max 64/.test(e.message); }
ok(threw, 'oversize message rejected at build');

// ack
const ack = frameAck({ bridgeSessionId: 'b', ackMessageSeq: 7, bridgeGeneration: 2 });
ok(ack.zcode_type === 'rpc-frame-ack' && ack.ackMessageSeq === 7 && ack.bridgeGeneration === 2, 'ack shape');
ok(frameAck({ bridgeSessionId: 'b', ackMessageSeq: 1 }).bridgeGeneration === 0, 'ack defaults bridgeGeneration 0');
threw = false; try { frameAck({ bridgeSessionId: 'b', ackMessageSeq: 0 }); } catch { threw = true; }
ok(threw, 'ack guards bad seq');

console.log(fails ? `FAIL (${fails})` : 'PASS rpc-frame-d3');
process.exit(fails ? 1 : 0);
