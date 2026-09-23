// E1 mention tests — sandboxed workspace with real files.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { extractMentions, resolveMentions, mentionsLine } from './mentions.mjs';
import path from 'node:path';
import os from 'node:os';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

ok(JSON.stringify(extractMentions('read @calc.py and @src/util.js please')) === '["calc.py","src/util.js"]', 'extracts tokens');
ok(JSON.stringify(extractMentions('email a@b.com not a mention')) === '[]', 'inline email not a mention (no leading space boundary…)');
ok(JSON.stringify(extractMentions('@lead token')) === '["lead"]', 'start-of-string mention');
ok(JSON.stringify(extractMentions('@@double')) === '[]', 'double @ is not a mention (strict boundary)');
ok(extractMentions(null).length === 0, 'null safe');

const ws = mkdtempSync(path.join(os.tmpdir(), 'zmention-'));
writeFileSync(`${ws}/calc.py`, 'x');
import { mkdirSync } from 'node:fs';
mkdirSync(`${ws}/src`, { recursive: true });
writeFileSync(`${ws}/src/util.js`, 'y');
mkdirSync(`${ws}/dir-only`, { recursive: true });

let r = resolveMentions('fix @calc.py using @src/util.js and @nope.md', ws);
ok(r.found.length === 2 && r.found[0].token === 'calc.py' && r.found[0].path === path.resolve(ws, 'calc.py'), 'found resolved absolute');
ok(r.missing.length === 1 && r.missing[0].token === 'nope.md', 'missing reported');
ok(r.rewritten.includes('@calc.py') && r.rewritten.includes('@src/util.js') && r.rewritten.includes('@nope.md'), 'rewritten preserves text');
r = resolveMentions('see @dir-only', ws);
ok(r.missing.length === 1 && r.found.length === 0, 'directories are NOT valid mentions (files only)');
// Resolve outside a nested workspace using our own fixture, independent of /tmp depth.
r = resolveMentions('see @../calc.py', `${ws}/src`);
ok(r.found.length === 1 && r.found[0].path === path.resolve(ws, 'calc.py'), 'escape resolves (read-only annotation, no sandbox claim)'); // separator-safe
ok(mentionsLine({ found: [], missing: [] }) === 'no file mentions', 'empty line');
ok(mentionsLine(resolveMentions('a @calc.py', ws)).includes('→'), 'line format');
rmSync(ws, { recursive: true, force: true });
console.log('interim:', fails ? `FAIL (${fails})` : 'ok');

// bot preprocessing
import { preprocessForBot } from './mentions.mjs';
const ws2 = mkdtempSync(path.join(os.tmpdir(), 'zmb-'));
writeFileSync(`${ws2}/f.txt`, 'x');
let b = preprocessForBot('read @f.txt', ws2);
ok(b.note === null && b.prompt.includes('(referenced:') && b.prompt.includes('f.txt'), 'valid mention annotated');
b = preprocessForBot('read @missing.txt', ws2);
ok(b.prompt === null && b.note.includes('@missing.txt'), 'missing mention → note, no prompt');
b = preprocessForBot('plain prompt', ws2);
ok(b.note === null && b.prompt === 'plain prompt', 'plain passthrough untouched');
rmSync(ws2, { recursive: true, force: true });
console.log('interim2:', fails ? `FAIL (${fails})` : 'ok');

// r15: boundary preservation, unicode tokens, mention cap
import { resolveMentions as rm2, extractMentions as em2 } from './mentions.mjs';
const ws3 = mkdtempSync(path.join(os.tmpdir(), 'zmr15-'));
writeFileSync(`${ws3}/a.json`, 'x');
let r15 = rm2('A\n@ a.json', ws3); // newline boundary form: @ then space? use real token on next line
r15 = rm2('A\n@a.json', ws3);
ok(r15.rewritten === 'A\n@a.json', 'newline boundary preserved (not collapsed to space)');
r15 = rm2('\t@a.json', ws3);
ok(r15.rewritten === '\t@a.json', 'tab boundary preserved');
const uni = '文件-' + '😀';
writeFileSync(`${ws3}/${uni}.txt`, 'x');
r15 = rm2(`see @${uni}.txt`, ws3);
ok(r15.found.length === 1 && r15.found[0].token === `${uni}.txt`, 'unicode+emoji token resolved (no surrogate split)');
const many = Array.from({ length: 50 }, (_, i) => { writeFileSync(`${ws3}/m${i}.txt`, 'x'); return `@m${i}.txt`; }).join(' ');
ok(em2(many).length === 32, 'mention extraction capped at 32');
ok(rm2(many, ws3).found.length === 32, 'resolution capped at 32');
rmSync(ws3, { recursive: true, force: true });
console.log(fails ? `FAIL (${fails})` : 'PASS mentions');
process.exit(fails ? 1 : 0);
