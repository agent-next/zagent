// Packaging oracle — the explicit production list must contain each relative
// import, and every bare external import must be a declared root dependency.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, ok, summary } from './test-util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const declared = new Set(Object.keys(pkg.dependencies ?? {}));

// directory entries in files[] (e.g. 'packages/') expand to the concrete .mjs files —
// enumerate from disk so directory-globs and explicit lists both work.
const shipped = new Set();
for (const entry of pkg.files) {
  if (entry === 'packages/') {
    for (const dir of ['packages/driver', 'packages/cli'])
      for (const f of readdirSync(path.join(root, dir)))
        if (f.endsWith('.mjs')) shipped.add(`${dir}/${f}`);
  } else if (entry === 'bin/') {
    for (const f of readdirSync(path.join(root, 'bin')))
      if (statSync(path.join(root, 'bin', f)).isFile()) shipped.add(`bin/${f}`);
  } else if (/^(?:packages\/.*\.mjs|bin\/)/.test(entry)) shipped.add(entry);
}

// Bare specifier = not relative ('./x'), not a node builtin ('node:fs').
const IMPORT_RE = /(?:^|\s)(?:import\s[^'"]*from|export\s[^'"]*from|import)\s*['"]([^'"]+)['"]/g;
const bare = new Map(); // specifier -> first file that imports it

for (const rel of shipped) {
  const file = path.join(root, rel);
  const src = readFileSync(file, 'utf8');
  for (const [, spec] of src.matchAll(IMPORT_RE)) {
    if (spec.startsWith('.')) {
      const target = path.relative(root, path.resolve(path.dirname(file), spec)).replaceAll(path.sep, '/');
      ok(existsSync(path.join(root, target)) && shipped.has(target), `${rel} relative import is shipped: ${target}`);
      continue;
    }
    if (spec.startsWith('/') || spec.startsWith('node:')) continue;
      // Scoped or plain package name (strip subpath): 'ws/lib/x' -> 'ws', '@a/b/c' -> '@a/b'
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!bare.has(name)) bare.set(name, path.relative(root, file));
  }
}

for (const [name, file] of bare) {
  ok(declared.has(name), `'${name}' (imported by ${file}) is declared in root dependencies`);
}

eq(typeof pkg.dependencies, 'object', 'root package.json declares a dependencies object');
eq(pkg.dependencies.ws, '8.21.3', "existing 'ws' dependency is pinned");
for (const removed of ['telegram.mjs', 'feishu.mjs', 'attachments.mjs', 'mentions.mjs', 'relay.mjs',
  'controller-router.mjs', 'rpc-frame.mjs', 'rpc-bridge.mjs', 'packages/cli/zagent-compact.mjs'])
  ok(![...shipped].some(file => file === removed || file.endsWith(`/${removed}`)), `${removed} is not shipped`);

summary('packaging');
