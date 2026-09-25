// Relay device registration — mobile/remote sync foundation.
// Wire contract captured from desktop main bundle + verified live 2026-09-04:
// WSS wss://zcode.z.ai/ws?mid=<deviceMid>, header X-Device-ID, then
// {type:"device_register_init", device_mid, pass_hash, meta, client_ts} -> {type:"device_register_ack", device_sid}.
import WebSocket from 'ws';
import { readFileSync, writeFileSync as wd, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import os from 'node:os';
import { decryptCredential, loadCredentialStore, deviceMid } from './credentials.mjs';

export function relaySecrets() {
  const store = loadCredentialStore();
  return { passHash: decryptCredential(store['web-remote-control:external-relay:pass_hash']) };
}

export function registerDevice({ deviceMid: mid, meta = { app_version: '3.10.2', platform: process.platform }, timeoutMs = 15000,
                                 WebSocketImpl = WebSocket } = {}) {
  return new Promise((resolve, reject) => {
    const dm = mid ?? deviceMid();
  const ws = new WebSocketImpl(`wss://zcode.z.ai/ws?mid=${dm}`, { headers: { 'X-Device-ID': dm } });
    const done = (fn, arg) => { clearTimeout(timer); try { ws.close(); } catch {} fn(arg); };
    const timer = setTimeout(() => done(reject, new Error('relay register timeout')), timeoutMs);
    ws.on('open', () => {
      // relaySecrets() reads the credential store — missing/corrupt credentials
      // throw here, and a throw inside this EventEmitter callback escapes as an
      // uncaughtException while the promise stays pending. Reject instead.
      try {
        ws.send(JSON.stringify({ type: 'device_register_init', device_mid: dm, pass_hash: relaySecrets().passHash, meta, client_ts: Date.now() }));
      } catch (e) { done(reject, e); }
    });
    ws.on('message', d => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; } // one bad frame must not kill the register
      if (m.type === 'device_register_ack') done(resolve, m);
    });
    ws.on('error', e => done(reject, e));
    ws.on('close', () => done(reject, new Error('relay closed before ack')));
  });
}

// --- D2: persistent device connection (auth mode + heartbeat) ---
import { createHmac } from 'node:crypto';
import { routePayload } from './controller-router.mjs';
import { EventEmitter } from 'node:events';


const STATE = `${os.homedir()}/.zcode/cli/relay-state.json`;
function readStateFile(file) {
  try {
    const st = JSON.parse(readFileSync(file, 'utf8'));
    return st && typeof st === 'object' && !Array.isArray(st) ? st : null;
  } catch { return null; }
}
export function cachedDeviceSid(mid) { // cache is mid-keyed: a sid is only valid under its mid
  const st = readStateFile(STATE);
  return st && st.deviceMid === mid ? st.deviceSid : null;
}
/** Pure local read: this-host device id / last ack. Never opens a websocket. */
export function relayStatus({ home = os.homedir(), env = process.env } = {}) {
  const stateFile = `${home}/.zcode/cli/relay-state.json`;
  const st = readStateFile(stateFile);
  let deviceMidValue = env.ZCODE_DEVICE_MID || null;
  if (!deviceMidValue) {
    try {
      const d = JSON.parse(readFileSync(`${home}/.zcode/cli/device.json`, 'utf8'));
      if (typeof d?.deviceMid === 'string' && d.deviceMid) deviceMidValue = d.deviceMid;
    } catch {}
  }
  const cliSid = st && (!deviceMidValue || st.deviceMid === deviceMidValue) && typeof st.deviceSid === 'string' && st.deviceSid
    ? st.deviceSid : null;
  const lastAck = Number.isFinite(st?.lastAck) ? st.lastAck : null;
  return {
    registered: Boolean(cliSid),
    deviceSid: cliSid,
    deviceMid: deviceMidValue,
    lastAck,
    source: cliSid ? 'cli' : null,
  };
}
export async function ensureDeviceSid({ deviceMid: explicitMid } = {}) {
  const mid = explicitMid ?? deviceMid();
  const cached = cachedDeviceSid(mid);
  if (cached) return cached;
  const ack = await registerDevice({ deviceMid: mid });
  mkdirSync(dirname(STATE), { recursive: true });
  wd(STATE, JSON.stringify({ deviceMid: mid, deviceSid: ack.device_sid, at: Date.now() }, null, 1));
  return ack.device_sid;
}

export function connectDevice({ deviceSid, tasks = [], initialViewState = {}, onViewState, onError,
                                meta = { app_version: '3.10.2', platform: process.platform },
                                heartbeatMs = 10000, ackTimeoutMs = 30000 } = {}) {
  const mid = meta.deviceMid ?? deviceMid();
  const ctx = { deviceSid, tasks, initialViewState, mobileViewState: initialViewState?.mobile ?? {}, onViewState, onError };
  const bus = new EventEmitter();
  bus.on('error', () => {}); // default sink: emitting with no listeners must not throw
  const ws = new WebSocket(`wss://zcode.z.ai/ws?mid=${mid}`, { headers: { 'X-Device-ID': mid } });
  let hb, watchdog, lastAck = 0;
  const send = o => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
  ws.on('open', () => {
    send({ type: 'auth_init', role: 'device', device_sid: deviceSid, meta, client_ts: Date.now() });
    bus.emit('state', 'authenticating');
    hb = setInterval(() => {
      send({ type: 'pair_status_query', device_sid: deviceSid, client_ts: Date.now() });
      if (lastAck && Date.now() - lastAck > ackTimeoutMs) { bus.emit('state', 'heartbeat-stale'); ws.terminate(); }
    }, heartbeatMs);
    watchdog = setTimeout(() => ws.terminate(), ackTimeoutMs + heartbeatMs);
  });
  ws.on('message', d => {
    if (ws.readyState !== WebSocket.OPEN) return; // no frames into a torn-down bus
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    if (m.type === 'auth_challenge') {
      // proof = HMAC-SHA256(key=passHash, `${nonce}|device|${deviceSid}`) base64url (from desktop main bundle).
      let proof; try { proof = createHmac('sha256', relaySecrets().passHash) }
      catch (e) { bus.emit('error', e); ws.terminate(); return; }
      proof = proof
        .update(`${m.nonce}|device|${deviceSid}`).digest('base64url');
      send({ type: 'auth_response', device_sid: deviceSid, proof, client_ts: Date.now() });
      bus.emit('state', 'authenticating-proof-sent');
      return;
    }
    if (m.type === 'pair_status_ack' || /ack/.test(m.type ?? '')) { lastAck = Date.now(); clearTimeout(watchdog);
      watchdog = setTimeout(() => ws.terminate(), ackTimeoutMs + heartbeatMs);
      try {
        const st = readStateFile(STATE) ?? {};
        wd(STATE, JSON.stringify({ ...st, lastAck }, null, 1));
      } catch {}
    }
    // D3 phase 2: route data-envelope app payloads; replies go straight back over the relay
    if (m.type === 'data' && m.payload?.zcode_type) {
      const reply = routePayload(m.payload, ctx);
      if (reply) send({ type: 'data', payload: reply, client_ts: Date.now() });
      bus.emit('app', m.payload);
    }
    if (m.type === 'error') { bus.emit('state', `relay-error:${m.code ?? 'unknown'}`); return; } // KICKED/AUTH_FAILED: surface, caller re-registers
    bus.emit('frame', m);
  });
  ws.on('close', () => { clearInterval(hb); clearTimeout(watchdog); bus.emit('state', 'closed'); });
  ws.on('error', e => bus.emit('error', e));
  return Object.assign(bus, {
    close: () => new Promise(res => { if (ws.readyState === WebSocket.CLOSED) return res(); ws.once('close', res).close(); }),
    terminate: () => ws.terminate(),
  });
}
