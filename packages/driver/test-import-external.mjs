#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyImport, CUTOFF_END, CUTOFF_START, planImport, redactSecrets, renderImport, spliceAgents } from './import-external.mjs';
import { ok, eq, summary } from './test-util.mjs';

const home = mkdtempSync(join(tmpdir(), 'zagent-import-home-'));
const cwd = mkdtempSync(join(tmpdir(), 'zagent-import-cwd-'));
const secret = 'sk-testfixture00';
try {
  mkdirSync(join(home, '.claude', 'commands'), { recursive: true });
  mkdirSync(join(home, '.claude', 'skills', 'demo', 'references'), { recursive: true });
  mkdirSync(join(cwd, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(cwd, 'CLAUDE.md'), `# Imported rules\nkey: ${secret}\n`);
  writeFileSync(join(home, '.claude', 'commands', 'review.md'), '# /review\n');
  writeFileSync(join(cwd, '.claude', 'commands', 'ship.md'), '# /ship\n');
  writeFileSync(join(home, '.claude', 'skills', 'demo', 'SKILL.md'), '# Demo skill\n');
  writeFileSync(join(home, '.claude', 'skills', 'demo', 'references', 'a.md'), '# ref\n');

  const dry = planImport({ home, cwd });
  eq(dry.mode, 'dry-run', 'default plan is dry-run');
  eq(dry.sources.map((s) => s.id).join(','),
    'claude-md,user-commands,workspace-commands,user-skills',
    'the four official GUI import sources are listed');
  ok(dry.sources.every((s) => s.exists), 'fixture sources exist');
  ok(dry.items.some((i) => i.kind === 'instructions' && i.name === 'CLAUDE.md'), 'CLAUDE.md is listed');
  ok(dry.items.some((i) => i.kind === 'command' && i.name === 'review.md'), '~/.claude/commands is listed');
  ok(dry.items.some((i) => i.kind === 'command' && i.name === 'ship.md'), '.claude/commands is listed');
  ok(dry.items.some((i) => i.kind === 'skill' && i.name === 'demo'), '~/.claude/skills is listed');
  ok(!existsSync(join(cwd, 'AGENTS.md')), 'dry-run does not write AGENTS.md');
  ok(!existsSync(join(home, '.zcode')), 'dry-run does not write ~/.zcode');
  const dryText = renderImport(dry, { json: false, home });
  const dryJson = renderImport(dry, { json: true, home });
  ok(!dryText.includes(secret) && !dryJson.includes(secret), 'dry-run output redacts secrets');
  ok(JSON.parse(dryJson).items.length === dry.items.length, '--json is parseable');
  // home paths render as ~/... in both output modes — an absolute
  // home path in shared/screenshotted output is a privacy leak.
  ok(!dryText.includes(home) && !dryJson.includes(home), 'dry-run output never prints the absolute home path');

  const emptyHome = mkdtempSync(join(tmpdir(), 'zagent-import-empty-'));
  const emptyCwd = mkdtempSync(join(tmpdir(), 'zagent-import-empty-cwd-'));
  const missing = planImport({ home: emptyHome, cwd: emptyCwd });
  eq(missing.items.length, 0, 'missing sources yield no items');
  eq(missing.sources.length, 4, 'missing sources are still listed');
  ok(missing.sources.every((s) => s.exists === false), 'missing sources report exists=false');
  rmSync(emptyHome, { recursive: true, force: true });
  rmSync(emptyCwd, { recursive: true, force: true });

  const applied = applyImport(planImport({ home, cwd }));
  eq(applied.summary.errors, 0, 'apply has no errors');
  ok(existsSync(join(cwd, 'AGENTS.md')), 'apply writes workspace AGENTS.md');
  const agents = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
  ok(agents.includes(CUTOFF_START) && agents.includes(CUTOFF_END), 'AGENTS.md has a cutoff marker');
  ok(agents.includes('# Imported rules'), 'AGENTS.md received CLAUDE.md body');
  ok(existsSync(join(home, '.zcode', 'commands', 'review.md')), 'user command is copied');
  ok(existsSync(join(cwd, '.zcode', 'commands', 'ship.md')), 'workspace command stays in the project');
  ok(!existsSync(join(home, '.zcode', 'commands', 'ship.md')), 'workspace command is not copied into ~/.zcode');
  ok(existsSync(join(home, '.zcode', 'skills', 'demo', 'SKILL.md')), 'skill SKILL.md is copied');
  ok(existsSync(join(home, '.zcode', 'skills', 'demo', 'references', 'a.md')), 'skill supporting files are copied');

  writeFileSync(join(cwd, 'AGENTS.md'), `# Native\nkeep me\n\n${agents}`);
  writeFileSync(join(home, '.zcode', 'commands', 'review.md'), 'ORIGINAL\n');
  writeFileSync(join(cwd, 'CLAUDE.md'), '# Imported rules v2\n');
  const skipped = applyImport(planImport({ home, cwd, force: false }));
  const reviewAfter = readFileSync(join(home, '.zcode', 'commands', 'review.md'), 'utf8');
  eq(reviewAfter, 'ORIGINAL\n', 'existing command is not overwritten without --force');
  ok(skipped.items.find((i) => i.name === 'review.md').action === 'skipped', 'existing dest is skipped');
  const agents2 = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
  ok(agents2.includes('# Native') && agents2.includes('keep me'), 'native AGENTS.md text is preserved');
  ok(agents2.includes('# Imported rules v2'), 'marked import region is updated');
  ok(!agents2.includes('# Imported rules\nkey:'), 'old marked body is replaced');

  const forced = applyImport(planImport({ home, cwd, force: true }));
  eq(readFileSync(join(home, '.zcode', 'commands', 'review.md'), 'utf8'), '# /review\n',
    '--force overwrites an existing command');
  ok(forced.items.find((i) => i.name === 'review.md').action === 'copied', 'forced item reports copied');

  const native = spliceAgents('# already here\n', 'incoming');
  ok(native.startsWith('# already here'), 'splice keeps leading native text');
  ok(native.includes(CUTOFF_START) && native.includes('incoming'), 'splice inserts the marked block');
  const again = spliceAgents(native, 'second');
  eq(again.includes('incoming'), false, 're-splice replaces the marked region');
  ok(again.includes('second') && again.includes('# already here'), 're-splice keeps native text');

  eq(redactSecrets(`use ${secret}`).includes(secret), false, 'redactSecrets strips sk- keys');
  ok(redactSecrets('api_key=supersecretvalue').includes('[redacted]'), 'redactSecrets strips assigned secrets');

  mkdirSync(join(home, '.claude', 'skills', 'linky'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'linky', 'SKILL.md'), '# linky\n');
  try { symlinkSync(join(home, '.claude', 'skills', 'demo'), join(home, '.claude', 'skills', 'outside')); } catch {}
  const withLink = planImport({ home, cwd });
  ok(!withLink.items.some((i) => i.name === 'outside'), 'escaping/sibling symlinks are not listed');

  // residual: apply-mode fs errors embed the absolute path — the
  // rendered error (both modes) must stay home-relative.
  writeFileSync(join(home, '.claude', 'commands', 'block.md'), '# /block\n');
  mkdirSync(join(home, '.zcode', 'commands', 'block.md'), { recursive: true });
  const failed = applyImport(planImport({ home, cwd, force: true }));
  const block = failed.items.find((i) => i.name === 'block.md');
  eq(block.action, 'error', 'a directory at the file destination fails the copy');
  ok(String(block.error).includes(home), 'raw fs error carries the absolute path');
  const failedJson = renderImport(failed, { json: true, home });
  const failedText = renderImport(failed, { json: false, home });
  ok(!failedJson.includes(home) && !failedText.includes(home),
    'rendered error output never prints the absolute home path');
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

summary('import-external');
