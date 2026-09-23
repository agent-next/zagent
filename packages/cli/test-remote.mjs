#!/usr/bin/env node
// Hermetic D1/D2 remote status. Temp HOME only; never opens a websocket.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { remoteStatus, connectDeniedReason } from './zagent-remote.mjs';
import { commandFor } from './commands.mjs';
import { relayStatus } from '../driver/relay.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, 'packages', 'cli', 'zagent-remote.mjs');
const bin = path.join(root, 'bin', 'zagent');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'zremote-'));

const makeHome = (tag) => {
  const home = mkdtempSync(path.join(tmp, tag));
  mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
  mkdirSync(path.join(home, '.zcode', 'v2'), { recursive: true });
  return home;
};

const write = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};

const run = (home, args, extraEnv = {}) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8',
  timeout: 5000,
  env: {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    ZAGENT_TEST_SANDBOX: home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    ...extraEnv,
  },
});

const empty = makeHome('empty-');
const none = remoteStatus({ home: empty, env: {} });
ok(none.registered === false && none.deviceSid === null && none.lastAck === null, 'empty home is not registered');
ok(none.secondDeviceControl === false && none.connected === false, 'status never claims a live hop');
ok(/second[- ]device/i.test(none.note), 'note says second-device control is not available');

const noneRun = run(empty, ['--json']);
ok(noneRun.error === undefined && noneRun.status === 0, 'empty status exits 0');
let noneJson;
try { noneJson = JSON.parse(noneRun.stdout); } catch (e) {
  ok(false, `empty --json parse: ${e.message} stdout=${JSON.stringify(noneRun.stdout)}`);
}
ok(noneJson && noneJson.registered === false && noneJson.secondDeviceControl === false,
  'empty --json is unregistered and honest');
ok(noneJson.lastAck === null && noneJson.deviceSid === null, 'empty --json last ack is null');

const noneText = run(empty, []);
ok(/Relay: not registered · last heartbeat: none · remote control from a second device is not available yet\./.test(noneText.stdout),
  'empty text reports not registered and no remote control');

const aliased = run(empty, ['status', '--json']);
ok(aliased.status === 0 && JSON.parse(aliased.stdout).registered === false,
  'remote status --json matches default remote');

const home = makeHome('cli-');
write(path.join(home, '.zcode', 'cli', 'device.json'), { deviceMid: 'fixture-mid' });
write(path.join(home, '.zcode', 'cli', 'relay-state.json'), {
  deviceMid: 'fixture-mid',
  deviceSid: 'd_fixtureSid0000000001',
  at: 1_700_000_000_000,
  lastAck: 1_700_000_123_000,
});
const helper = relayStatus({ home, env: {} });
ok(helper.registered === true && helper.deviceSid === 'd_fixtureSid0000000001',
  'driver helper reads matching cached sid');
ok(helper.lastAck === 1_700_000_123_000, 'driver helper reports lastAck');

const report = remoteStatus({ home, env: {} });
ok(report.registered === true && report.source === 'cli', 'CLI cache registers this host');
ok(report.lastAck === 1_700_000_123_000, 'CLI status reports lastAck');
ok(report.secondDeviceControl === false, 'registered status still denies second-device control');

const jsonRun = run(home, ['--json']);
ok(jsonRun.status === 0, 'registered status exits 0');
const json = JSON.parse(jsonRun.stdout);
ok(json.deviceSid === 'd_fixtureSid0000000001' && json.lastAck === 1_700_000_123_000,
  'registered --json includes device id and last ack');
ok(json.secondDeviceControl === false && json.connected === false,
  'registered --json does not claim a live hop');
ok(!JSON.stringify(json).includes('pass_hash') && !JSON.stringify(json).includes('passHash'),
  'status JSON does not leak pass_hash');

const textRun = run(home, ['status']);
ok(/Relay: registered · last heartbeat: 2023-11-14T22:15:23\.000Z · remote control from a second device is not available yet\./.test(textRun.stdout),
  'text reports registration and last heartbeat');
ok(!textRun.stdout.includes('d_fixtureSid0000000001') && !textRun.stdout.includes('fixture-mid'),
  'human output carries no device identifier');

const mismatch = makeHome('mismatch-');
write(path.join(mismatch, '.zcode', 'cli', 'device.json'), { deviceMid: 'this-host' });
write(path.join(mismatch, '.zcode', 'cli', 'relay-state.json'), {
  deviceMid: 'other-host', deviceSid: 'd_other', lastAck: 9,
});
const mis = remoteStatus({ home: mismatch, env: {} });
ok(mis.registered === false && mis.deviceSid === null, 'sid cached under another mid is ignored');

const gui = makeHome('gui-');
write(path.join(gui, '.zcode', 'v2', 'setting.json'), {
  webRemoteControlExternalRelayDevice: { deviceSid: 'd_guiSid00000000000001' },
});
const guiReport = remoteStatus({ home: gui, env: {} });
ok(guiReport.registered === true && guiReport.source === 'gui' && guiReport.deviceSid === 'd_guiSid00000000000001',
  'GUI setting.json device id counts as this-host registration');
ok(guiReport.lastAck === null, 'GUI-only registration has no CLI last ack');

const both = makeHome('both-');
write(path.join(both, '.zcode', 'cli', 'device.json'), { deviceMid: 'both-mid' });
write(path.join(both, '.zcode', 'cli', 'relay-state.json'), {
  deviceMid: 'both-mid', deviceSid: 'd_cliPreferred', lastAck: 42,
});
write(path.join(both, '.zcode', 'v2', 'setting.json'), {
  webRemoteControlExternalRelayDevice: { deviceSid: 'd_guiAlso' },
});
const bothReport = remoteStatus({ home: both, env: {} });
ok(bothReport.source === 'cli+gui' && bothReport.deviceSid === 'd_cliPreferred',
  'CLI sid wins when both caches exist');

const envMid = makeHome('envmid-');
write(path.join(envMid, '.zcode', 'cli', 'relay-state.json'), {
  deviceMid: 'env-mid', deviceSid: 'd_envSid', lastAck: 7,
});
const envRep = remoteStatus({ home: envMid, env: { ZCODE_DEVICE_MID: 'env-mid' } });
ok(envRep.registered === true && envRep.deviceMid === 'env-mid' && envRep.source === 'cli',
  'ZCODE_DEVICE_MID registers a matching cached sid without device.json');
ok(remoteStatus({ home: envMid, env: { ZCODE_DEVICE_MID: 'other-mid' } }).registered === false,
  'ZCODE_DEVICE_MID mismatch ignores the cached sid');

const garbage = makeHome('garbage-');
write(path.join(garbage, '.zcode', 'cli', 'relay-state.json'), '{not json');
ok(remoteStatus({ home: garbage, env: {} }).registered === false,
  'unparseable relay-state is ignored, not registered');

const arr = makeHome('arr-');
write(path.join(arr, '.zcode', 'cli', 'relay-state.json'), [1, 2]);
ok(remoteStatus({ home: arr, env: {} }).registered === false,
  'array-shaped relay-state is ignored');

const weakSid = makeHome('weaksid-');
write(path.join(weakSid, '.zcode', 'cli', 'relay-state.json'), { deviceSid: 42, lastAck: 'soon' });
const weak = remoteStatus({ home: weakSid, env: {} });
ok(weak.registered === false && weak.deviceSid === null, 'numeric deviceSid does not register');

const badAck = makeHome('badack-');
write(path.join(badAck, '.zcode', 'cli', 'relay-state.json'), { deviceSid: 'd_ok', lastAck: 'soon' });
const badAckRep = remoteStatus({ home: badAck, env: {} });
ok(badAckRep.registered === true && badAckRep.lastAck === null,
  'non-numeric lastAck is dropped while the sid still registers');

const noMid = makeHome('nomid-');
write(path.join(noMid, '.zcode', 'cli', 'device.json'), [1]);
write(path.join(noMid, '.zcode', 'cli', 'relay-state.json'), { deviceMid: 'any', deviceSid: 'd_loose' });
const loose = remoteStatus({ home: noMid, env: {} });
ok(loose.registered === true && loose.deviceMid === null && loose.deviceSid === 'd_loose',
  'non-object device.json leaves mid unknown; cached sid still counts');

const guiBad = makeHome('guibad-');
write(path.join(guiBad, '.zcode', 'v2', 'setting.json'), {
  webRemoteControlExternalRelayDevice: { deviceSid: 7 },
});
ok(remoteStatus({ home: guiBad, env: {} }).registered === false,
  'non-string GUI deviceSid does not register');

ok(connectDeniedReason({ ZAGENT_TEST_SANDBOX: home }, { live: true }) !== null,
  'connect is denied in the test harness even with --live');
ok(connectDeniedReason({ CI: 'true' }, { live: true }) !== null, 'connect is denied in CI even with --live');
ok(connectDeniedReason({}, { live: false }) !== null, 'connect without --live is opt-in denied');
ok(connectDeniedReason({}, { live: true }) === null, 'connect --live is allowed outside CI/test');
ok(connectDeniedReason({ GITHUB_ACTIONS: 'true' }, { live: true }) !== null,
  'connect is denied on GitHub Actions even with --live');
ok(connectDeniedReason({ ZAGENT_REMOTE_CONNECT: '1' }, { live: false }) === null,
  'ZAGENT_REMOTE_CONNECT=1 opts in without --live');
ok(connectDeniedReason({ ZAGENT_TEST_SANDBOX: 'x', ZAGENT_REMOTE_CONNECT: '1' }, {}) !== null,
  'CI/test block wins over the env opt-in');

const t0 = Date.now();
const denied = run(home, ['connect']);
ok(Date.now() - t0 < 4000, 'connect returns before a websocket hang');
ok(denied.status === 2, 'connect without --live exits 2');
ok(/blocked in CI\/test/.test(denied.stderr), 'connect under ZAGENT_TEST_SANDBOX names the CI/test block');

const optIn = spawnSync(process.execPath, [cli, 'connect'], {
  encoding: 'utf8',
  timeout: 5000,
  env: {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
  },
});
ok(optIn.status === 2 && /opt-in/.test(optIn.stderr) && /second[- ]device/.test(optIn.stderr),
  'connect without --live is opt-in denied and names no second-device control');

const deniedLive = run(home, ['connect', '--live']);
ok(deniedLive.status === 2 && /blocked in CI\/test/.test(deniedLive.stderr),
  'connect --live is still blocked under ZAGENT_TEST_SANDBOX');

const deniedJson = run(home, ['connect', '--json']);
ok(deniedJson.status === 2, 'connect --json exits 2');
const deniedBody = JSON.parse(deniedJson.stdout);
ok(deniedBody.blocked === true && deniedBody.connected === false && deniedBody.secondDeviceControl === false,
  'connect --json deny is honest');

const deniedLiveJson = run(home, ['connect', '--live', '--json']);
ok(deniedLiveJson.status === 2, 'connect --live --json exits 2');
const deniedLiveBody = JSON.parse(deniedLiveJson.stdout);
ok(deniedLiveBody.blocked === true && deniedLiveBody.connected === false
  && deniedLiveBody.secondDeviceControl === false && /CI\/test/.test(deniedLiveBody.reason),
  'connect --live --json deny parses and names the CI/test block');

const usage = run(home, ['pair']);
ok(usage.status === 2 && /usage: zagent remote/.test(usage.stderr), 'unknown subcommand is usage, exit 2');

const flag = run(home, ['status', '--ws']);
ok(flag.status === 2 && /usage: zagent remote/.test(flag.stderr), 'unknown flag is usage, exit 2');

const extra = run(home, ['status', 'extra']);
ok(extra.status === 2 && /usage: zagent remote/.test(extra.stderr),
  'extra positional on status is usage, exit 2');

const connectExtra = run(home, ['connect', 'bogus']);
ok(connectExtra.status === 2 && /usage: zagent remote/.test(connectExtra.stderr),
  'extra positional on connect is usage, exit 2');

const directHelp = run(home, ['--help']);
ok(directHelp.status === 2 && /usage: zagent remote/.test(directHelp.stderr),
  'bare --help is usage exit 2; the dispatcher answers it for users');

const runBin = (args) => spawnSync(process.execPath, [bin, ...args], {
  encoding: 'utf8',
  timeout: 5000,
  env: {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    ZAGENT_TEST_SANDBOX: home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
  },
});

const binRun = runBin(['remote', '--json']);
ok(binRun.status === 0 && JSON.parse(binRun.stdout).deviceSid === 'd_fixtureSid0000000001',
  'bin/zagent remote --json routes to the status command');

const remoteHelp = runBin(['remote', '--help']);
ok(remoteHelp.status === 0 && /remote control/.test(remoteHelp.stdout)
  && /not available yet/.test(remoteHelp.stdout),
  'zagent remote --help answers from the table and keeps the no-remote-control disclaimer');

const palette = runBin(['help']);
const remoteLine = (palette.stdout ?? '').split('\n').find((l) => /remote \[/.test(l));
ok(remoteLine && /not available yet/.test(remoteLine),
  'help palette remote row keeps the no-remote-control disclaimer');

const binSrc = readFileSync(bin, 'utf8');
ok(/remote:\s*\['packages\/cli\/zagent-remote\.mjs'\]/.test(binSrc), 'bin dispatcher routes remote');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
ok(pkg.files.includes('packages/cli/zagent-remote.mjs'), 'CLI ships in the package');
ok(!pkg.files.includes('packages/driver/relay.mjs'), 'relay driver stays unshipped');
ok(pkg.version.startsWith('0.0.'), 'this lane does not bump off 0.0.xx');

const commands = readFileSync(path.join(root, 'packages', 'cli', 'commands.mjs'), 'utf8');
ok(/not available yet/.test(commands), 'command table copy is honest');
const remoteRow = commandFor('remote');
ok(remoteRow && /remote control/.test(remoteRow[1]) && /not available yet/.test(remoteRow[1]),
  'the remote row itself carries the no-remote-control disclaimer');

rmSync(tmp, { recursive: true, force: true });
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
