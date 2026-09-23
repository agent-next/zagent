#!/usr/bin/env node
// UX audit oracle: run the real dispatcher end-to-end in a temp HOME and fail
// on a wrong exit code or on any engineering-internal term reaching human
// output. The banned list is the vocabulary a maintainer review flagged; a
// regression that reintroduces one fails here even if every command's own
// test passes.
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin/zagent');
const home = mkdtempSync(path.join(tmpdir(), 'zagent-ux-audit-'));
const tmp = path.join(home, 'tmp');
mkdirSync(tmp, { recursive: true });

// A fixture runtime so --version and models have something real to report. It
// sits outside every layout findRuntime versions (…/resources/glm/zcode.cjs,
// …/zcode-app-cli/bin/zcode.js) so the labeled kernel fallback is exercised.
const kernel = path.join(home, 'kernel', 'zcode.cjs');
mkdirSync(path.dirname(kernel), { recursive: true });
writeFileSync(kernel, `const a = process.argv.slice(2);
if (a.includes('--version')) console.log('9.9.9-fixture');
else console.log('fixture-kernel:' + a.join(' '));
`);
const catalogDir = path.join(home, 'model-providers'); // <kernel dir>/../model-providers
mkdirSync(catalogDir, { recursive: true });
writeFileSync(path.join(catalogDir, 'models_catalog_1.json'), JSON.stringify({
  schemaVersion: 'zcode.model-providers.v1',
  providers: [
    { id: 'fixture', models: [{ id: 'fixture-alpha' }] },
    { id: 'zai', models: [{ id: 'glm-5.3' }, { id: 'glm-5.3-flash' }] },
  ],
}));
mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
writeFileSync(path.join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({
  model: { main: 'zai/glm-5.3', lite: 'zai/glm-5.3-flash' },
  provider: { zai: { kind: 'anthropic', options: { baseURL: 'https://api.z.ai/api/anthropic/', apiKey: 'fixture' } } },
}));

const env = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  ZAGENT_TEST_SANDBOX: home,
  TMPDIR: tmp,
  TEMP: tmp,
  TMP: tmp,
  ZCODE_RUNTIME: kernel,
  ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
};

const run = (args, cwd = home) => spawnSync(process.execPath, [bin, ...args], {
  encoding: 'utf8', timeout: 15000, env, cwd,
});

// Internal vocabulary that must never reach a user. D1/D2 are milestone codes —
// matched capitalized and word-bounded so real words cannot trip the audit.
const BANNED = [
  /retry-on-envelope/i, /chain.?proof/i, /degraded.?posture/i, /raw service codes/i,
  /\bD1\b/, /\bD2\b/, /dossier/i, /receipt/i, /\bpanel\b/i, /envelope/i,
  /\bparity\b/i, /GUI task store/i, /both worlds/i, /product path/i,
];

let pass = 0;
const check = (label, args, { code = 0, codes, expect = [], reject = [] } = {}) => {
  const r = run(args);
  const allowed = codes ?? [code];
  assert.ok(allowed.includes(r.status), `${label}: exit ${r.status}, want ${allowed} — ${r.stderr}`);
  const all = `${r.stdout}${r.stderr}`;
  for (const re of expect) assert.match(all, re, `${label}: missing ${re}`);
  for (const re of reject) assert.doesNotMatch(all, re, `${label}: leaked ${re}`);
  for (const re of BANNED) assert.doesNotMatch(all, re, `${label}: banned term ${re} in human output`);
  pass++;
  return r;
};

const help = check('help', ['help'], { expect: [/^Run$/m, /^Set up$/m, /^Account$/m, /^Project$/m, /^Extend$/m, /^Debug$/m] });
check('--help', ['--help'], { expect: [/^Run$/m, /^Debug$/m] });
const order = ['Run', 'Set up', 'Account', 'Project', 'Extend', 'Debug'].map(g => help.stdout.indexOf(`\n${g}\n`));
assert.ok(order.every((i, n) => i > 0 && (n === 0 || order[n - 1] < i)), `groups out of order: ${order}`);

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const ver = check('--version', ['--version'], {
  expect: [new RegExp(`^zagent ${pkg.version.replace(/\./g, '\\.')}$`, 'm'), /runtime: explicit \(kernel 9\.9\.9-fixture\)/],
  reject: [/0\.16\.5/], // the kernel's internal string must never pass as the product version
});
assert.equal(ver.stdout.trim().split('\n').length, 2, '--version is two lines, nothing else');
check('doctor', ['doctor'], { expect: [/^runtime: explicit \(kernel 9\.9\.9-fixture\) \(/m], reject: [/0\.16\.5/] });

check('-v', ['-v'], { expect: [new RegExp(`^zagent ${pkg.version.replace(/\./g, '\\.')}$`, 'm')], reject: [/0\.16\.5|Usage: zcode/] });
check('--bogus', ['--bogus'], { code: 2, expect: [/zagent: unknown option '--bogus'/, /Run 'zagent help'/], reject: [/Usage: zcode|0\.16\.5/] });
check('--cwd', ['--cwd', home], { codes: [0, 1], expect: [/fixture-kernel:--cwd /], reject: [/Usage: zcode|unknown option/] });
check('--capabilities', ['--capabilities'], {
  code: 2,
  expect: [/zagent: unknown option '--capabilities'/, /zagent doctor --capabilities/],
  reject: [/Usage: zcode|0\.16\.5/],
});
const foo = check('foo', ['foo'], {
  code: 2,
  expect: [/zagent: unknown command 'foo'/, /Run 'zagent help' for the command list\./],
  reject: [/Usage: zcode/i],
});
assert.equal(foo.stdout, '', 'unknown command writes nothing to stdout');

const models = check('models', ['models'], { expect: [/Your Coding Plan: main zai\/glm-5\.3 · lite zai\/glm-5\.3-flash/, /zai\/glm-5\.3-flash/, /Other providers:/] });
assert.ok(models.stdout.indexOf('zai/glm-5.3') < models.stdout.indexOf('fixture\t'), 'GLM models list before other providers');
check('models glm', ['models', 'glm'], { expect: [/zai\/glm-5\.3/] });
check('models zai', ['models', 'zai'], { expect: [/zai\/glm-5\.3/] });

check('memory show', ['memory', 'show'], { expect: [/No memory for .+\. Add one with: zagent memory append/] });
const offpeak = check('offpeak', ['offpeak'], { codes: [0, 1], expect: [/Billing for this window is not verified by zagent\./], reject: [/routing now/i] });
assert.ok(offpeak.stdout.trim().split('\n').length <= 3, `offpeak prints at most three lines:\n${offpeak.stdout}`);
check('remote', ['remote'], { expect: [/Relay: (not )?registered · last heartbeat: .* · remote control from a second device is not available yet\./] });

rmSync(home, { recursive: true, force: true });
console.log(`PASS ux audit: ${pass} invocations clean`);
