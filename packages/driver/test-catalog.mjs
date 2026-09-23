#!/usr/bin/env node
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { listSkills, mcpSummary, listConversationsAsync } from './catalog.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails += 1; } else console.log('ok -', m); };

const home = mkdtempSync(join(tmpdir(), 'zagent-cat-'));
const cwd = mkdtempSync(join(tmpdir(), 'zagent-cwd-'));
try {
  mkdirSync(join(home, '.zcode', 'skills', 'reviewer'), { recursive: true });
  writeFileSync(join(home, '.zcode', 'skills', 'reviewer', 'SKILL.md'), '# Review\n');
  writeFileSync(join(home, '.zcode', 'skills', 'notes.md'), '# notes\n');
  mkdirSync(join(cwd, '.zcode', 'skills', 'local-one'), { recursive: true });
  writeFileSync(join(cwd, '.zcode', 'skills', 'local-one', 'SKILL.md'), '# Local\n');
  // workspace skill with the same name as a global one must not duplicate
  mkdirSync(join(cwd, '.zcode', 'skills', 'reviewer'), { recursive: true });

  const skills = listSkills({ home, cwd });
  ok(skills.some(s => s.value === 'reviewer'), 'global skill directory is listed');
  ok(skills.filter(s => s.value === 'reviewer').length === 1, 'duplicate names collapse');
  ok(skills.some(s => s.value === 'notes'), 'a markdown skill file uses its stem');
  ok(skills.some(s => s.value === 'local-one'), 'workspace skills are listed');
  ok(!skills.some(s => s.value.startsWith('.')), 'dotfiles are skipped');
  ok(skills.some(s => s.value === 'using-zagent'), 'bundled using-zagent skill is listed');

  const empty = listSkills({ home: join(home, 'missing'), cwd: join(cwd, 'missing') });
  ok(empty.some(s => s.value === 'using-zagent') && !empty.some(s => s.value === 'reviewer'),
    'missing user roots still expose the bundled skill and do not throw');

  const none = mcpSummary(undefined);
  ok(none.total === 0 && none.connected === 0, 'missing MCP map is zero');
  const sum = mcpSummary({
    a: { status: 'connected' },
    b: { status: 'ready' },
    c: { status: 'failed', error: 'boom' },
    d: { status: 'connecting' },
  });
  ok(sum.connected === 2 && sum.failed === 1 && sum.other === 1 && sum.total === 4,
    'MCP statuses are bucketed');

  const conv = await listConversationsAsync({ home: join(home, 'no-db') });
  ok(Array.isArray(conv) && conv.length === 0, 'missing task db yields [] rather than throw');
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
