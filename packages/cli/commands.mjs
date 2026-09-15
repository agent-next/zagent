// The command table. One source of truth, because it is read three ways: the
// `help` palette prints all of it, `bin/zmax` answers `zagent <cmd> --help` from
// it, and the README's table is checked against it by a test. The README used to
// drift — it omitted `offpeak` and `task`, which have shipped and worked for a
// while, and it understated the Node requirement.
//
// Rows are [signature, one plain sentence, group]. Groups are the section
// headers `zagent help` prints; descriptions stay user-facing — internal jargon
// (envelope types, milestone codes, lane names) does not belong here.
export const GROUPS = ['Run', 'Set up', 'Account', 'Project', 'Extend', 'Debug'];

export const COMMANDS = [
  ['(default)', 'start the interactive terminal UI', 'Run'],
  ['-p "…" [--json]', 'run one headless prompt and print the answer', 'Run'],
  ['onboard', 'check your setup and run one test prompt', 'Set up'],
  ['doctor [--fix]', 'diagnose the runtime, config, and API key', 'Set up'],
  ['models [query]', 'list providers or search the model catalog', 'Set up'],
  ['quota [status|usage [--days 1..30]|balance|preview|reset] [--json]', 'Coding Plan quota and account usage', 'Account'],
  ['remote [status|connect] [--json]', 'whether this device is registered for remote control (not available yet)', 'Account'],
  ['offpeak [--refresh|--json]', 'the off-peak campaign window (exit 0 while open)', 'Account'],
  ['usage [--session id] [--json]', 'token totals for a session', 'Account'],
  ['sessions', 'your sessions across CLI and desktop', 'Project'],
  ['diff [sessionId]', 'the file changes a session made', 'Project'],
  ['task list|archive|pin|rename|delete', 'inspect or modify saved task records (no create)', 'Project'],
  ['memory show|index|append', 'view or add project memory', 'Project'],
  ['goal [show|set <text>|pause|resume|clear] [--session id] [--json]', "show or control a session's goal", 'Project'],
  ['subagents [--session id] [--json]', "list a session's child sessions", 'Project'],
  ['cron add|list|tick', 'schedule prompts to run later', 'Extend'],
  ['plugins', 'inspect and manage local plugins', 'Extend'],
  ['hooks list [--json]', 'list configured hook events', 'Extend'],
  ['import [--dry-run|--apply] [--force] [--json]', 'import Claude Code instructions, commands, and skills', 'Extend'],
  ['inspect [--storage] [--json]', 'dump runtime/config/skills; --storage = ~/.zcode category sizes (read-only)', 'Debug'],
  ['--version', 'print the zagent version', 'Debug'],
];

/** The bare verb a user types, e.g. "models [query]" -> "models". */
export const verbOf = (signature) => signature.split(/[\s[]/)[0];

/** The table row for a verb, or undefined. */
export const commandFor = (verb) => COMMANDS.find(([sig]) => verbOf(sig) === verb);

export const formatRow = ([sig, desc]) => `  zagent ${sig.padEnd(34)} ${desc}`;
