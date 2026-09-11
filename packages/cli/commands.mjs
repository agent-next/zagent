// The command table. One source of truth, because it is read three ways: the
// `help` palette prints all of it, `bin/zmax` answers `zagent <cmd> --help` from
// it, and the README's table is checked against it by a test. The README used to
// drift — it omitted `offpeak` and `task`, which have shipped and worked for a
// while, and it understated the Node requirement.
export const COMMANDS = [
  ['--version', 'print the installed zagent package version (offline)'],
  ['(default)', 'interactive TUI'],
  ['-p "…" [--json]', 'headless one-shot (retry-on-envelope product path)'],
  ['onboard', 'first-run chain proof: doctor + live smoke + guidance'],
  ['doctor [--fix]', 'runtime/config/key diagnosis (+degraded-posture warnings)'],
  ['models [query]', 'search the official provider catalog (10 providers/130 models)'],
  ['quota [status|usage [--days 1..30]|balance|preview|reset] [--json]', 'Coding Plan quota and account usage'],
  ['sessions', 'GUI task store panel (both worlds, one view)'],
  ['diff [sessionId]', 'per-turn +A -D aggregate + per-file hunks'],
  ['task list|archive|pin|rename|delete', 'inspect or modify existing runtime task records (no create)'],
  ['memory show|index|append', 'runtime-compatible memory store'],
  ['offpeak [--refresh|--json]', 'campaign time window (exit 0 = open; billing unverified)'],
  ['cron add|list|tick', 'scheduled prompts (heartbeat receipts, no daemon)'],
  ['plugins', 'inspect and manage local plugins'],
  ['hooks list [--json]', 'list configured ZCode hook events (does not run them)'],
  ['inspect [--json]', 'dump runtime, config layers, skills, tasks, plugins (secrets redacted)'],
  ['import [--dry-run|--apply] [--force] [--json]', 'copy Claude Code instructions/commands/skills (no overwrite without --force)'],
  ['goal [show|set <text>|pause|resume|clear] [--session id] [--json]', 'show or control the current session objective'],
  ['subagents [--session id] [--json]', 'list running and ended child session ids'],
  ['remote [status|connect] [--json]', 'this-host relay device id / last ack (no second-device control)'],
];

/** The bare verb a user types, e.g. "models [query]" -> "models". */
export const verbOf = (signature) => signature.split(/[\s[]/)[0];

/** The table row for a verb, or undefined. */
export const commandFor = (verb) => COMMANDS.find(([sig]) => verbOf(sig) === verb);

export const formatRow = ([sig, desc]) => `  zagent ${sig.padEnd(34)} ${desc}`;
