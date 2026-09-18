#!/usr/bin/env node
// zagent permissions — view and revoke the persisted always-allow/deny grants
// the TUI writes when a user picks an "always" option (F14a/F14d). The store
// is ~/.zcode/cli/grants.json, keyed by an opaque hash; each record carries a
// bounded, redacted `pattern` (the command or input it remembers) so this
// surface can show and match WHAT was allowed. Local file only — no runtime,
// no credential store, never creates the file to say it is empty.
import { listGrants, forgetGrants } from '../driver/permissions.mjs';

const argv = process.argv.slice(2);
// `permissions` bare means list — and a leading flag does too, so
// `zagent permissions --json` and `zagent permissions --reset` both parse.
const cmd = !argv.length || argv[0].startsWith('-') ? 'list' : argv[0];
const rest = cmd === argv[0] ? argv.slice(1) : argv;
const flags = new Set(rest.filter(x => x.startsWith('-')));
const pos = rest.filter(x => !x.startsWith('-'));
const usage = 'usage: zagent permissions [list] [--json] | revoke <pattern|all> [--json] | --reset';
if (!['list', 'revoke'].includes(cmd) ||
    [...flags].some(f => !['--json', '--reset'].includes(f)) ||
    (cmd === 'revoke' ? pos.length !== 1 : pos.length > 0) ||
    pos.some(p => !p.trim()) ||
    // --reset is the flag-first spelling of "revoke all": `zagent permissions
    // --reset` parses, but `permissions list --reset` must not quietly nuke.
    (flags.has('--reset') && (cmd !== 'list' || pos.length || !argv[0]?.startsWith('-')))) {
  console.error(usage); process.exit(2);
}
const json = flags.has('--json');
const label = g => `${g.toolName ?? '?'}${g.pattern ? `(${g.pattern})` : ''}`;

if (cmd === 'list' && !flags.has('--reset')) {
  const grants = listGrants();
  if (json) {
    console.log(JSON.stringify({ count: grants.length,
      grants: grants.map(({ key: _k, response, ...g }) =>
        ({ ...g, decision: response?.decision ?? null })) }, null, 2));
  } else {
    if (!grants.length) console.log('no persisted permission grants');
    else {
      console.log('persisted grants (~/.zcode/cli/grants.json):');
      for (const g of grants) console.log(`  ${label(g)} — ${g.optionId ?? '?'}`);
      console.log('revoke with: zagent permissions revoke <pattern|all>');
    }
  }
} else {
  // revoke <pattern|all>, or --reset which is revoke-all spelled as a flag.
  const query = cmd === 'revoke' ? pos[0] : 'all';
  const { removed } = forgetGrants(query);
  if (json) {
    console.log(JSON.stringify({ revoked: removed.length,
      revokedGrants: removed.map(({ key: _k, ...g }) => g) }, null, 2));
    // (key is the opaque store id — never printed; pattern carries meaning.)
  } else if (!removed.length) {
    if (query === 'all') console.log('no persisted permission grants');
    else { console.error(`no grant matching '${query}'`); process.exit(1); }
  } else {
    console.log(`revoked ${removed.length} grant${removed.length === 1 ? '' : 's'}:`);
    for (const g of removed) console.log(`  ${label(g)} — ${g.optionId ?? '?'}`);
  }
}
