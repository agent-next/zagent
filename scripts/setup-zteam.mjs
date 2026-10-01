#!/usr/bin/env node
// Install explicit per-role model routing for zagent and Claude Code. No main-model changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.some(x => x !== '--apply') || args.length > 1) throw new Error('Usage: node scripts/setup-zteam.mjs [--apply]');
const roles = [
  { name: 'zteam-build', model: 'glm-5.3-flash', claude: 'inherit',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
    description: 'Implement an assigned component with explicit owned files and acceptance criteria.',
    instructions: 'Own only the implementation files assigned by the leader. Read the relevant call chain, implement the complete solution, and run focused checks. Coordinate with the test agent without editing its files. Never overwrite unrelated changes.' },
  { name: 'zteam-test', model: 'glm-5.3-flash', claude: 'inherit',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
    description: 'Design and implement independent regression tests for an assigned behavior.',
    instructions: 'Own only the test files assigned by the leader. Derive assertions from the requested behavior, including meaningful failure cases. Avoid tests that only mirror implementation. Run the real test command; report failures without changing product code.' },
  { name: 'zteam-review', model: 'glm-5.3', claude: 'inherit',
    tools: ['Read', 'Grep', 'Glob'],
    description: 'Independently review completed changes for correctness, regressions, and unsupported claims.',
    instructions: 'Read the final changed files and relevant callers. Review independently of the implementer. Report actionable findings with file references, trigger, impact, and a verification plan. Do not edit files. Missing evidence is unknown, never a pass.' },
  { name: 'zteam-verify', model: 'glm-5.3-flash', claude: 'inherit',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    description: 'Execute acceptance commands and verify the final artifact independently of its author.',
    instructions: 'Verify the final snapshot with the leader-provided acceptance commands. Do not edit source or weaken checks. Report exact commands, exit status, outputs, and the tested commit or diff. Distinguish source tests, installed package behavior, live execution, and billing evidence.' },
];
const common = 'Respect repository instructions and assigned file scope. Ask the leader about scope conflicts. Do not publish, deploy, change CI, add dependencies, or use destructive Git commands. Do not spawn further agents. In idle-time tasks, run in the foreground; never fall back to paid inference. Finish with evidence and remaining blockers.';
const files = roles.flatMap(role => ['zcode', 'claude'].map(client => {
  const dest = path.join(os.homedir(), `.${client}`, 'agents', `${role.name}.md`);
  const model = client === 'zcode' ? role.model : role.claude;
  const text = `---\nname: ${role.name}\ndescription: ${JSON.stringify(role.description)}\nmodel: ${model}\ntools: ${JSON.stringify(role.tools)}\nmaxTurns: 64\n---\n\n${role.instructions}\n\n${common}\n`;
  return { dest, text, client, model };
}));
// Validate every destination before making any changes. Never overwrite user edits.
for (const { dest, text } of files) {
  if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') !== text) throw new Error(`Existing agent differs: ${dest}`);
}
for (const { dest, text, client, model } of files) {
  if (args.includes('--apply') && !fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text, { flag: 'wx', mode: 0o600 });
  }
  console.log(`${args.includes('--apply') ? 'ready' : 'preview'} ${client} ${model} ${dest}`);
}
