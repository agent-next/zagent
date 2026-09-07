// CP-3: runtime capability probe. The runtime auto-updates silently (6 kernels in 6
// releases, CP-8); version strings lag and schema-zod errors tell the truth. Probe by
// method-existence (-32601 = absent) vs param-rejection (-32602 = present) — the
// discrimination technique that discovered goal/fork/subscribe in the first place.
// Cheap: every probe is a tiny call on ONE booted client; absent methods answer fast.
export const PROBE_METHODS = [
  'session/goal', 'session/fork', 'session/subscribe', 'session/compact',
  'session/setMode', 'session/setModel', 'session/setThoughtLevel',
  'session/subagents', 'session/usage', 'session/events',
  'session/resume', 'session/stop',
  'interaction/requestPermission', // registered as a server→client request; callability differs — see note
  'artifacts/exec', 'automation/list', 'completion/complete', 'conversation/subscribe', // known-absent sentinels
];

export async function probeMethod(client, method, timeoutMs = 8000) {
  try { await client.call(method, {}, timeoutMs); return { present: true, kind: 'ok' }; }
  catch (e) {
    if (e?.code === -32601) return { present: false, kind: 'absent' };
    if (e?.code === -32602) return { present: true, kind: 'param-rejected' }; // exists, wrong params — exactly what we want to know
    return { present: null, kind: 'error', code: e?.code ?? null }; // timeouts/transport: no verdict
  }
}

export async function runtimeCapabilities(client, { methods = PROBE_METHODS, timeoutMs = 8000, onEvent } = {}) {
  const out = {};
  for (const m of methods) {
    const r = await probeMethod(client, m, timeoutMs);
    out[m] = r;
    onEvent?.(m, r);
  }
  const present = Object.entries(out).filter(([, v]) => v.present).map(([k]) => k);
  const absent = Object.entries(out).filter(([, v]) => v.present === false).map(([k]) => k);
  const inconclusive = Object.entries(out).filter(([, v]) => v.present === null).map(([k]) => k);
  return { probed: methods.length, present, absent, inconclusive, detail: out };
}

export function capabilityLine(caps) {
  const have = caps.present.filter(m => !m.startsWith('interaction/'));
  const miss = caps.absent.filter(m => !['artifacts/exec', 'automation/list', 'completion/complete', 'conversation/subscribe'].includes(m));
  const knownAbsent = caps.absent.length - miss.length;
  return `${have.length}/${caps.probed} methods present (${miss.length} missing${knownAbsent ? `, ${knownAbsent} known-absent-sentinels` : ''})` +
    (caps.inconclusive.length ? ` · ${caps.inconclusive.length} inconclusive` : '');
}
