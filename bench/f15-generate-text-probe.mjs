#!/usr/bin/env node
// F15 repoWiki — LIVE workspace/generateText probe (desktop 3.12.x).
// An earlier direction probe
// established the contract via -32602 oracles; this probe fires real generations
// (one discovery call per accepted selection, then one per remaining querySource
// plus a messages-variant) and dumps the result shapes. Spends real quota —
// run only when the 5h window is <90%.
//
//   node bench/f15-generate-text-probe.mjs [--workspace <dir>]
//
// Verdicts: CALLABLE+<shape> on success, or the kernel's -32xxx/-32602 error.
//
// Observed contract (runtime 3.12.1): `repo_wiki_` is a free-form querySource
// prefix — any `repo_wiki_*` source takes the streaming text path; the suffix
// is the caller's wiki kind slug, not an enumerated RPC name. The probe
// therefore also snapshots ~/.zcode/v2/repo-wiki before/after so a live run
// captures whatever wiki.json layout a repo_wiki_* generation writes (F15b).
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZCodeProtocolClient } from '../packages/driver/zcode-protocol.mjs';
import { repoWikiRoot, repoWikiHash } from '../packages/driver/repo-wiki.mjs';

const argv = process.argv.slice(2);
const wIdx = argv.indexOf('--workspace');
if (wIdx >= 0 && !argv[wIdx + 1]) {
  console.error('usage: node bench/f15-generate-text-probe.mjs [--workspace <dir>]');
  process.exit(2);
}
const ws = wIdx >= 0 ? path.resolve(argv[wIdx + 1]) : mkdtempSync(path.join(os.tmpdir(), 'f15-ws-'));
const own = wIdx < 0;

// Provider/model selection: same registry ids the GUI pushes
// (account:zai-individual-coding-plan) with a builtin config-key fallback.
// options.reasoningLevel is filled per-LEVELS below.
const SELECTIONS = [
  { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3' },
  { providerId: 'builtin:zai-coding-plan', modelId: 'GLM-5.3' },
  { providerId: 'zai', modelId: 'glm-5.3' },
];
const SOURCES = [
  { querySource: 'repo_wiki_catalog', prompt: 'Reply with exactly: pong' },
  { querySource: 'git_commit_message', prompt: 'Write a one-line commit message for: add empty file hello.txt' },
];

const snap = dir => {
  try { return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : []; }
  catch { return []; }
};
const before = snap(ws);
const wikiRoot = repoWikiRoot();
const wikiBefore = snap(wikiRoot);

let client, code = 0;
try {
  client = new ZCodeProtocolClient({ cwd: ws });
  await client.ready;
  const sync = await client.syncAccountConfig();
  console.log('account-config push:', JSON.stringify(sync));

  // Live-probed 2026-09-16: account-plan GLM-5.3 accepts low/high/max only —
  // 'medium'/'enabled'/'disabled' are stripped by normalizeModelSelection and
  // fail as reasoning-level-missing. maxOutputTokens is required.
  const LEVELS = ['high', 'low', 'max'];
  let selection = null;
  outer: for (const sel of SELECTIONS) {
    for (const lvl of LEVELS) {
      try {
        const key = path.normalize(ws);
        const r = await client.call('workspace/generateText', {
          workspace: { workspaceKey: key, workspacePath: key },
          selection: { ...sel, options: { reasoningLevel: lvl } },
          maxOutputTokens: 8192,
          querySource: SOURCES[0].querySource,
          prompt: SOURCES[0].prompt,
        }, 90000);
        selection = { ...sel, options: { reasoningLevel: lvl } };
        console.log(`\n=== selection ${sel.providerId}/${sel.modelId} reasoningLevel=${lvl} ACCEPTED ===`);
        console.log('result:', JSON.stringify(r, null, 2));
        break outer;
      } catch (e) {
        console.log(`selection ${sel.providerId}/${sel.modelId} lvl=${lvl}: code=${e?.code} ${e?.message}`);
        if (e?.data) console.log('  data:', JSON.stringify(e.data).slice(0, 400));
      }
    }
  }
  if (!selection) { console.log('\nVERDICT: no selection accepted — generateText unreachable'); code = 1; }
  else {
    for (const src of SOURCES.slice(1)) {
      const key = path.normalize(ws);
      try {
        const r = await client.call('workspace/generateText', {
          workspace: { workspaceKey: key, workspacePath: key },
          selection, maxOutputTokens: 8192, querySource: src.querySource, prompt: src.prompt,
        }, 90000);
        console.log(`\n=== querySource ${src.querySource} ===`);
        console.log('result:', JSON.stringify(r, null, 2));
      } catch (e) {
        console.log(`\nquerySource ${src.querySource}: code=${e?.code} ${e?.message}`);
        if (e?.data) console.log('  data:', JSON.stringify(e.data).slice(0, 400));
      }
    }
    // messages-variant shape check (prompt OR messages — the receipt says one required)
    try {
      const key = path.normalize(ws);
      const r = await client.call('workspace/generateText', {
        workspace: { workspaceKey: key, workspacePath: key },
        selection, maxOutputTokens: 8192, querySource: SOURCES[0].querySource,
        messages: [{ role: 'user', content: SOURCES[0].prompt }],
      }, 90000);
      console.log('\n=== messages-variant ===');
      console.log('result:', JSON.stringify(r, null, 2));
    } catch (e) {
      console.log(`\nmessages-variant: code=${e?.code} ${e?.message}`);
    }
    console.log('\nVERDICT: CALLABLE');
  }
} catch (e) {
  code = 1;
  console.log('VERDICT: probe failed —', e?.message ?? e);
} finally {
  // close() ends stdin + SIGTERMs the kernel child; wait for it (bounded) so the
  // write-snapshot sees a dead process and rmSync never pulls its cwd.
  try { client?.close(); } catch {}
  if (client) await Promise.race([client.exited, new Promise(r => setTimeout(r, 3000))]);
  const after = snap(ws);
  const created = after.filter(f => !before.includes(f));
  if (created.length) console.log('workspace writes:', JSON.stringify(created));
  const wikiCreated = snap(wikiRoot).filter(f => !wikiBefore.includes(f));
  if (wikiCreated.length) {
    console.log('repo-wiki writes:', wikiRoot, JSON.stringify(wikiCreated));
    console.log('repo-wiki expected hash dir:', repoWikiHash(path.normalize(ws)));
  }
  if (own) try { rmSync(ws, { recursive: true, force: true }); } catch {}
}
process.exitCode = code;
