#!/usr/bin/env node
// Hermetic repo-wiki discovery. Temp HOME only; never writes into the real
// ~/.zcode tree and never dumps wiki page bodies.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectWiki, listRepoWikis, repoWikiHash, repoWikiRoot, summarizeWiki } from './repo-wiki.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const tmp = mkdtempSync(path.join(os.tmpdir(), 'zwiki-'));
const inspectCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'zagent-inspect.mjs');
const SECRET = 'test-dummy-secret';

const makeHome = (tag) => {
  const home = mkdtempSync(path.join(tmp, tag));
  const cwd = path.join(home, 'ws');
  mkdirSync(cwd);
  return { home, cwd };
};

const writeWiki = (home, cwd, body) => {
  const hash = repoWikiHash(path.resolve(cwd));
  const file = path.join(home, '.zcode', 'v2', 'repo-wiki', hash, 'wiki.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
};

const runInspect = ({ home, cwd, json = true }) => spawnSync(
  process.execPath,
  ['--experimental-sqlite', '--no-warnings', inspectCli, ...(json ? ['--json'] : [])],
  {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: tmp,
      TEMP: tmp,
      TMP: tmp,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    },
  },
);

try {
  ok(repoWikiHash('/tmp/demo') === createHash('sha256').update('/tmp/demo').digest('hex').slice(0, 12),
    'hash is sha256(workspaceKey) hex[:12]');
  ok(repoWikiRoot({ home: '/tmp/h' }) === path.join('/tmp/h', '.zcode', 'v2', 'repo-wiki'),
    'root is ~/.zcode/v2/repo-wiki');

  const empty = makeHome('empty-');
  ok(listRepoWikis(empty).length === 0, 'missing repo-wiki dir lists nothing');
  ok(inspectWiki(empty) === null, 'missing wiki inspects as none');

  const noneText = runInspect({ ...empty, json: false });
  ok(noneText.error === undefined, 'inspect text spawn has no spawn error');
  ok(/wiki\s+\(none\)/.test(noneText.stdout),
    noneText.stdout.includes('wiki') ? 'inspect text reports wiki (none)'
      : `inspect text reports wiki (none) (stdout=${JSON.stringify(noneText.stdout)} stderr=${JSON.stringify(noneText.stderr)})`);
  const noneJson = runInspect(empty);
  ok(noneJson.error === undefined, 'inspect json spawn has no spawn error');
  let noneReport = null;
  try { noneReport = JSON.parse(noneJson.stdout); } catch (e) {
    ok(false, `inspect --json parse failed: ${e.message} stdout=${JSON.stringify(noneJson.stdout)} stderr=${JSON.stringify(noneJson.stderr)}`);
  }
  ok(noneReport && noneReport.wiki === null, 'inspect --json wiki is null when absent');

  const named = makeHome('named-');
  const namedFile = writeWiki(named.home, named.cwd, {
    wikiId: 'w1',
    workspaceKey: path.resolve(named.cwd),
    workspacePath: path.resolve(named.cwd),
    context: { name: 'demo-repo' },
    catalogTree: [{ id: 'n1', title: 'Overview', pageId: 'p1' }],
    pages: [{
      id: 'p1',
      title: 'Overview',
      markdown: `# secret page\napiKey: ${SECRET}\nBearer ${SECRET}\n`,
    }],
  });
  const found = inspectWiki(named);
  ok(found && found.path === namedFile, 'hashed wiki.json is discovered');
  ok(found.title === 'demo-repo', 'title comes from context.name');
  ok(!('pages' in found) && !('catalogTree' in found), 'summary omits page bodies');
  ok(JSON.stringify(found).includes(SECRET) === false, 'summary JSON omits planted secret');
  ok(listRepoWikis(named).length === 1, 'list finds the one wiki.json');

  const namedRun = runInspect(named);
  let namedReport = null;
  try { namedReport = JSON.parse(namedRun.stdout); } catch (e) {
    ok(false, `named inspect --json parse failed: ${e.message} stdout=${JSON.stringify(namedRun.stdout)} stderr=${JSON.stringify(namedRun.stderr)}`);
  }
  // Paths under the spawned home render as ~/..., never absolute. displayPath
  // forward-slashes separators, so the ~-suffix expectation does too.
  const shownWiki = `~${namedFile.slice(named.home.length).split(path.sep).join('/')}`;
  ok(namedReport.wiki && namedReport.wiki.path === shownWiki, 'inspect --json includes home-relative wiki.path');
  ok(namedReport.wiki.title === 'demo-repo', 'inspect --json includes wiki.title');
  ok(Object.keys(namedReport.wiki).sort().join(',') === 'path,title', 'inspect wiki keys are path,title only');
  const blob = JSON.stringify(namedReport);
  ok(blob.includes(SECRET) === false, 'inspect --json does not dump wiki bodies or secrets');
  ok(/"apiKey"/.test(blob) === false, 'inspect --json does not leak wiki apiKey fields');

  const namedText = runInspect({ ...named, json: false });
  ok(namedText.stdout.includes('demo-repo') && namedText.stdout.includes(shownWiki),
    'inspect text shows title and home-relative path');
  ok(namedText.stdout.includes(SECRET) === false, 'inspect text does not dump wiki bodies');

  const other = makeHome('other-');
  writeWiki(other.home, path.join(other.home, 'other-ws'), {
    context: { name: 'other-repo' },
    workspacePath: path.join(other.home, 'other-ws'),
    pages: [{ markdown: SECRET }],
  });
  mkdirSync(path.join(other.home, 'other-ws'));
  ok(inspectWiki(other) === null, 'another workspace wiki is not selected for cwd');
  ok(listRepoWikis(other).length === 1, 'list still discovers the other wiki.json');

  const scanned = makeHome('scan-');
  const scanWs = path.resolve(scanned.cwd);
  const oddHash = path.join(scanned.home, '.zcode', 'v2', 'repo-wiki', 'not-the-hash', 'wiki.json');
  mkdirSync(path.dirname(oddHash), { recursive: true });
  writeFileSync(oddHash, JSON.stringify({
    workspacePath: scanWs,
    context: { name: 'scanned-repo' },
    pages: [{ markdown: SECRET }],
  }));
  const scannedFound = inspectWiki(scanned);
  ok(scannedFound && scannedFound.path === oddHash && scannedFound.title === 'scanned-repo',
    'scan matches wiki.json workspacePath when hash dir differs');

  const bad = makeHome('bad-');
  const badFile = writeWiki(bad.home, bad.cwd, '{not json');
  const badFound = inspectWiki(bad);
  ok(badFound && badFound.path === badFile && badFound.title === undefined,
    'invalid wiki.json still reports path without title');

  const draft = makeHome('draft-');
  const draftDir = path.join(draft.home, '.zcode', 'v2', 'repo-wiki', repoWikiHash(path.resolve(draft.cwd)));
  mkdirSync(draftDir, { recursive: true });
  writeFileSync(path.join(draftDir, 'draft.json'), JSON.stringify({ pages: [{ markdown: SECRET }] }));
  ok(inspectWiki(draft) === null, 'draft-only dir is not a wiki');
  ok(listRepoWikis(draft).length === 0, 'draft-only dir is not listed');

  const untitled = makeHome('untitled-');
  writeWiki(untitled.home, untitled.cwd, { pages: [{ title: 'Page', markdown: 'body' }] });
  const untitledFound = inspectWiki(untitled);
  ok(untitledFound && untitledFound.path && untitledFound.title === undefined,
    'wiki without context.name omits title');
  ok(!('pages' in (untitledFound || {})), 'untitled summary still omits pages');

  const summary = summarizeWiki('/x/wiki.json', {
    context: { name: 'n' },
    pages: [{ markdown: SECRET }],
    catalogTree: [{ title: 't' }],
  });
  ok(summary.path === '/x/wiki.json' && summary.title === 'n', 'summarize keeps path and title');
  ok(!('pages' in summary) && !('catalogTree' in summary), 'summarize drops bodies');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (fails) {
  console.error(`FAIL repo-wiki (${fails})`);
  process.exit(1);
}
console.log('PASS repo-wiki');
