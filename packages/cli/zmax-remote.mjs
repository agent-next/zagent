#!/usr/bin/env node
// zagent remote [status|connect] — D1/D2 this-host relay status.
// Default is a local file read (device id / last ack). It never opens a
// websocket and does not claim second-device control (D3 is not done).
// `connect` is opt-in and default-denied in CI/test so the gate cannot hang.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const NOTE = 'D1/D2 this-host device registration and last heartbeat ack only. Second-device remote control is not available.';
const USAGE = 'usage: zagent remote [status|connect] [--json] [--live]';

function readJson(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function currentDeviceMid(home, env) {
  if (env.ZCODE_DEVICE_MID) return env.ZCODE_DEVICE_MID;
  const d = readJson(path.join(home, '.zcode', 'cli', 'device.json'));
  return typeof d?.deviceMid === 'string' && d.deviceMid ? d.deviceMid : null;
}

function guiDeviceSid(home) {
  const setting = readJson(path.join(home, '.zcode', 'v2', 'setting.json'));
  const id = setting?.webRemoteControlExternalRelayDevice?.deviceSid;
  return typeof id === 'string' && id ? id : null;
}

/** Local status only. Never contacts the relay. */
export function remoteStatus({ home = os.homedir(), env = process.env } = {}) {
  const deviceMid = currentDeviceMid(home, env);
  const st = readJson(path.join(home, '.zcode', 'cli', 'relay-state.json'));
  const cliSid = st && (!deviceMid || st.deviceMid === deviceMid) && typeof st.deviceSid === 'string' && st.deviceSid
    ? st.deviceSid : null;
  const guiSid = guiDeviceSid(home);
  const deviceSid = cliSid || guiSid || null;
  const lastAck = Number.isFinite(st?.lastAck) ? st.lastAck : null;
  const source = cliSid && guiSid ? 'cli+gui' : cliSid ? 'cli' : guiSid ? 'gui' : null;
  return {
    registered: Boolean(deviceSid),
    deviceSid,
    deviceMid,
    lastAck,
    source,
    connected: false,
    secondDeviceControl: false,
    note: NOTE,
  };
}

export function connectDeniedReason(env = process.env, { live = false } = {}) {
  if (env.ZMAX_TEST_SANDBOX || env.CI || env.GITHUB_ACTIONS) {
    return 'live websocket connect is blocked in CI/test (would hang the gate)';
  }
  if (!live && env.ZAGENT_REMOTE_CONNECT !== '1') {
    return 'live websocket connect is opt-in: pass --live (D3 second-device control is not available)';
  }
  return null;
}

function printStatus(report, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const line = (k, v) => process.stdout.write(`${k.padEnd(14)} ${v}\n`);
  line('remote', report.registered ? `registered${report.source ? ` (${report.source})` : ''}` : 'not registered');
  line('device', report.deviceSid ?? '(none)');
  line('last ack', report.lastAck ? new Date(report.lastAck).toISOString() : '(none)');
  line('control', 'this-host D1/D2 status only; second-device hop is not available');
}

async function runConnect({ asJson, live, env }) {
  const reason = connectDeniedReason(env, { live });
  const blocked = {
    ok: false,
    connected: false,
    blocked: true,
    reason,
    secondDeviceControl: false,
    note: NOTE,
  };
  if (reason) {
    if (asJson) process.stdout.write(`${JSON.stringify(blocked, null, 2)}\n`);
    else process.stderr.write(`zagent remote connect: ${reason}\n`);
    process.exit(2);
  }
  let relay;
  try {
    relay = await import(new URL('../driver/relay.mjs', import.meta.url));
  } catch {
    const missing = 'relay driver is not in this package; live connect is source-only. Second-device control is not available.';
    if (asJson) process.stdout.write(`${JSON.stringify({ ...blocked, reason: missing }, null, 2)}\n`);
    else process.stderr.write(`zagent remote connect: ${missing}\n`);
    process.exit(2);
  }
  const deviceSid = await relay.ensureDeviceSid();
  process.stderr.write('zagent remote connect: opening this-host device websocket (no second-device control)\n');
  const bus = relay.connectDevice({ deviceSid });
  bus.on('state', (s) => process.stderr.write(`remote: ${s}\n`));
  bus.on('error', (e) => process.stderr.write(`remote: ${e?.message ?? e}\n`));
  const stop = () => { try { bus.close(); } catch {} process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const raw = process.argv.slice(2);
  const known = new Set(['--json', '--live']);
  if (raw.some((a) => a.startsWith('-') && !known.has(a))) {
    console.error(USAGE);
    process.exit(2);
  }
  const asJson = raw.includes('--json');
  const live = raw.includes('--live');
  const args = raw.filter((a) => !known.has(a));
  const cmd = args[0] ?? 'status';
  if (args.length > 1 || (cmd !== 'status' && cmd !== 'connect')) {
    console.error(USAGE);
    process.exit(2);
  }
  if (cmd === 'connect') await runConnect({ asJson, live, env: process.env });
  else printStatus(remoteStatus({ home: os.homedir(), env: process.env }), asJson);
}
