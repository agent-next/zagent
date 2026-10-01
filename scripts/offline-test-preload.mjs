import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

if (!process.env.ZAGENT_TEST_SANDBOX || process.env.HOME !== process.env.ZAGENT_TEST_SANDBOX ||
    process.env.USERPROFILE !== process.env.ZAGENT_TEST_SANDBOX) throw new Error('test HOME isolation missing');
const mkdtemp = fs.mkdtempSync;
// Contain legacy hardcoded /tmp fixtures even after early process.exit or failure.
fs.mkdtempSync = (prefix, options) => mkdtemp(path.join(process.env.TMPDIR, path.basename(String(prefix))), options);
const blocked = () => { throw new Error('network disabled by offline test harness'); };
globalThis.fetch = async () => blocked();
net.Socket.prototype.connect = blocked;
http.request = http.get = https.request = https.get = blocked;
syncBuiltinESMExports();
