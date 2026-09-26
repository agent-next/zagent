// Public-source hygiene gate.
//
// This repository is public. Three times now a comment shipped citing material
// a public reader cannot reach — an internal dossier, a verification receipt,
// an inventory doc section. Each removal fixed one line; this gate fixes the
// class: no checked-in file may reference internal artifacts (receipt files,
// dossiers, task-run output, dated internal filenames, the private source
// repo) at all, so the next one fails CI instead of a review round.
//
// Distinction that matters: citing an internal ARTIFACT is banned; the bare
// words are not. "receipt" as a message timestamp or "22 receipts" as a
// feature are fine — "receipt d3-rpc-frame-2026-09-06" is not.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const self = fileURLToPath(import.meta.url);

// The private source repo's name, assembled so this gate file never carries it.
const privateRepo = ['zcode', 'cli'].join('[-_]?');

const RULES = [
  [/\bdossiers?\b/i, 'internal survey dossier'],
  [/\bux-inventory\b/i, 'internal inventory document'],
  [/\bgui-max\b/i, 'internal codename'],
  [/task-runs?\//i, 'internal task-run output path'],
  [/\breceipts?:?\s+[`'"]?[\w][\w.-]*-\d{4}-?\d{2}-?\d{2}/i, 'internal verification receipt'],
  [/[\w-]+-20\d{6}\.[a-z]{2,5}\b/i, 'dated internal filename absent from this checkout'],
  [/[\w-]+-\d{4}-\d{2}-\d{2}\.(md|txt)\b/i, 'dated internal filename absent from this checkout'],
  [new RegExp(`\\b${privateRepo}\\b`, 'i'), 'private source repository name'],
  [/out\/(host|renderer|main)\//, 'decompiled runtime source path'],
];

const SKIP_DIRS = new Set(['.git', 'node_modules', '.worktrees', 'artifacts', 'usertest', '.cache']);
const TEXT_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.md', '.json', '.yml', '.yaml', '.toml', '.txt', '.sh', '']);

// Files whose JOB is to name the banned vocabulary, plus NOTICE: MIT requires
// crediting the public upstream (kingsword09/zcode-cli), which collides with
// the private repo name — an attribution cannot also be a leak.
const EXEMPT = new Set([
  self,
  path.join(root, 'NOTICE'),
  path.join(root, 'scripts', 'test-ux-audit.mjs'),
  path.join(root, 'packages', 'cli', 'test-cli-ux.mjs'),
  path.join(root, 'packages', 'driver', 'test-public-export.mjs'),
]);

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    const stats = e.isSymbolicLink() ? statSync(full, { throwIfNoEntry: false }) : e;
    if (!stats) continue;
    if (stats.isDirectory()) { if (!e.isSymbolicLink() && !SKIP_DIRS.has(e.name)) walk(full, out); }
    else if (stats.isFile() && TEXT_EXT.has(path.extname(e.name)) && !EXEMPT.has(full)) out.push(full);
  }
  return out;
};

let fails = 0;
let scanned = 0;
for (const file of walk(root)) {
  scanned++;
  const rel = path.relative(root, file).split(path.sep).join('/');
  let body;
  try { body = readFileSync(file, 'utf8'); } catch { continue; }
  for (const [rule, what] of RULES) {
    const m = rule.exec(body);
    if (m) { fails++; console.error(`FAIL ${rel}: cites ${what} — ${JSON.stringify(m[0])}`); }
  }
}
console.log(`scanned ${scanned} text files`);
console.log(fails ? `FAIL (${fails})` : 'PASS public-hygiene');
process.exit(fails ? 1 : 0);
