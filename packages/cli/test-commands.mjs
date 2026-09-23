#!/usr/bin/env node
// The README is the only documentation most users read, and it had drifted from
// the code it describes: it advertised "Node.js >= 22.5" while package.json
// required ^22.15.0 || >=23.5.0, and its command table omitted `offpeak` and
// `task`, both of which had shipped and worked for a while. Drift like that is
// only caught by a test, because nothing else reads both files.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, verbOf, commandFor } from './commands.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));

const tests = [];
const test = (n, f) => tests.push([n, f]);

// Verbs a user actually types; the first three rows document invocation forms.
const VERBS = COMMANDS.map(([sig]) => verbOf(sig)).filter(v => !v.startsWith('-') && v !== '(default)');

for (const readme of ['README.md', 'docs/README.zh-CN.md']) {
  test(`${readme} documents every shipped command`, () => {
    const text = read(readme);
    const missing = VERBS.filter(v => !new RegExp(`\`zagent ${v}[\\s\\\`\\[]`).test(text));
    assert.deepEqual(missing, [], `${readme} is missing: ${missing.join(', ')}`);
  });

  test(`${readme} states the Node requirement package.json actually enforces`, () => {
    const text = read(readme);
    const engines = pkg.engines.node;                        // "^22.15.0 || >=23.5.0"
    const floor = engines.match(/\^(\d+)\.(\d+)/);
    assert.ok(floor, `unexpected engines format: ${engines}`);
    const claim = text.match(/Node\.js\s*[>≥]=?\s*(\d+)\.(\d+)/);
    assert.ok(claim, `${readme} states no Node version`);
    assert.equal(`${claim[1]}.${claim[2]}`, `${floor[1]}.${floor[2]}`,
      `${readme} claims Node ${claim[1]}.${claim[2]} but package.json requires ${engines}`);
  });
}

test('every routed subcommand has a table entry to answer --help from', () => {
  const zagent = read('bin/zagent');
  const routes = [...zagent.matchAll(/^\s{2}['"]?([a-z-]+)['"]?:\s*\[/gm)].map(m => m[1]);
  assert.ok(routes.length >= 10, `expected the route table, found ${routes.length}`);
  const undocumented = routes.filter(r => r !== 'help' && !commandFor(r));
  assert.deepEqual(undocumented, [],
    `routed but absent from COMMANDS, so \`zagent <cmd> --help\` would fall through: ${undocumented}`);
});

test('the help palette is generated, not a second hand-maintained copy', () => {
  const help = read('packages/cli/zagent-help.mjs');
  assert.match(help, /from '\.\/commands\.mjs'/, 'help must read the shared table');
  assert.ok(!/\['onboard'|\['models'/.test(help), 'help must not re-declare commands');
});

test('bin/zagent answers --help from the shared table', () => {
  const zagent = read('bin/zagent');
  assert.match(zagent, /commandFor\(command\)/);
  assert.match(zagent, /HELP_FLAGS\.has\(a\)/);
});

test('sqlite subcommands do not leak node\'s experimental warning', () => {
  const zagent = read('bin/zagent');
  for (const [, line] of [...zagent.matchAll(/^\s{2}\w+: \[([^\]]*--experimental-sqlite[^\]]*)\]/gm)].entries()) {}
  const sqliteRoutes = [...zagent.matchAll(/^\s{2}(\w+): \[([^\]]*--experimental-sqlite[^\]]*)\]/gm)];
  assert.ok(sqliteRoutes.length >= 2, 'expected sqlite routes');
  for (const [, name, args] of sqliteRoutes) {
    assert.ok(args.includes('--no-warnings'),
      `${name} would print "SQLite is an experimental feature" on every run`);
  }
});

// Found by an independent review (NIM kimi-k3): the first version fired on
// --help ANYWHERE in the argument list, so a subcommand taking free text could
// never receive the literal string "--help" — the dispatcher would answer it as
// a help request and the command would never run.
test('a `--` separator lets free-text subcommands receive a literal --help', () => {
  const zagent = read('bin/zagent');
  assert.match(zagent, /const sep = .*rest\.indexOf\('--'\)/,
    'help detection must stop at a `--` separator');
  assert.match(zagent, /rest\.slice\(0, sep\)/);
  assert.ok(!/rest\.includes\('--help'\)/.test(zagent),
    'scanning the whole argument list swallows data arguments');
  // The dispatcher interpreted `--`, so it must consume it: leaving it in made
  // `zagent memory append -- --help` store the literal text "-- --help".
  assert.match(zagent, /rest\.slice\(0, sep\), \.\.\.rest\.slice\(sep \+ 1\)/,
    'the separator must not reach the subcommand as data');
});

test('verbOf yields a usable verb for every row, with no collisions', () => {
  const verbs = COMMANDS.map(([sig]) => verbOf(sig));
  assert.equal(new Set(verbs).size, verbs.length, `duplicate verbs: ${verbs}`);
  for (const v of verbs) {
    assert.ok(v.length, 'empty verb');
    assert.ok(!/[\s[\]]/.test(v), `verb "${v}" still carries signature syntax`);
  }
  // The three invocation-form rows are not typed as subcommands.
  assert.deepEqual(verbs.filter(v => v.startsWith('-') || v === '(default)').sort(),
    ['(default)', '--version', '-p']);
});

test('commandFor resolves each routed verb to its own row', () => {
  for (const v of ['models', 'diff', 'memory', 'plugins', 'cron', 'quota', 'sessions', 'task', 'offpeak', 'onboard']) {
    const row = commandFor(v);
    assert.ok(row, `no row for ${v}`);
    assert.equal(verbOf(row[0]), v);
  }
});

test('a source-only command is refused before --help can answer for it', () => {
  // Otherwise `zagent telegram --help` would print help for something this
  // distribution deliberately does not ship.
  const zagent = read('bin/zagent');
  const sourceOnlyAt = zagent.indexOf('SOURCE_ONLY.has(command)');
  const helpAt = zagent.indexOf('flagArgs.some(a => HELP_FLAGS');
  assert.ok(sourceOnlyAt > 0 && helpAt > 0);
  assert.ok(sourceOnlyAt < helpAt, 'the source-only refusal must come first');
});

// The prose line was fixed in 0.0.185 but the shields badge still read 22.5,
// because the test only looked at prose. A badge is the first thing a reader
// believes, so it is checked the same way.
for (const readme of ['README.md', 'docs/README.zh-CN.md']) {
  test(`${readme}'s Node badge matches the engines field`, () => {
    const text = read(readme);
    const floor = pkg.engines.node.match(/\^(\d+)\.(\d+)/);
    // shields encodes ">=" as %E2%89%A5 (≥) and spaces as %20
    // %E2%89%A5 is the encoded "≥" and %20 the space; matching plain \d+ ate the %20.
    const badge = text.match(/img\.shields\.io\/badge\/node-(?:%E2%89%A5|>=|-)?(?:%20)*(\d+)\.(\d+)/);
    assert.ok(badge, `${readme} has no Node badge`);
    assert.equal(`${badge[1]}.${badge[2]}`, `${floor[1]}.${floor[2]}`,
      `${readme} badge shows ${badge[1]}.${badge[2]}, engines requires ${pkg.engines.node}`);
  });
}

test('the README badges name the package that is actually published', () => {
  // scripts/export-public-source.mjs publishes as `zagent`, so the badge must
  // match the EXPORTED name, not this repo's package.json.
  const exporter = read('scripts/export-public-source.mjs');
  const published = exporter.match(/name\s*=\s*'([^']+)'/)?.[1];
  assert.equal(published, 'zagent', `exporter publishes as ${published}`);
  const text = read('README.md');
  assert.match(text, new RegExp(`img\\.shields\\.io/npm/v/${published}`), 'no npm version badge');
  assert.match(text, new RegExp(`img\\.shields\\.io/npm/dm/${published}`), 'no downloads badge');
});

let pass = 0, fail = 0;
for (const [n, f] of tests) {
  try { f(); pass++; } catch (e) { fail++; console.error(`FAIL ${n}\n  ${e.message}`); }
}
console.log(`${pass}/${tests.length} command-table tests passed`);
process.exit(fail ? 1 : 0);
