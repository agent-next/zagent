// The command table. One source of truth, because it is read three ways: the
// `help` palette prints all of it, `bin/zagent` answers `zagent <cmd> --help` from
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
  ['-p "…" [--json] [options]', 'run one headless prompt and print the answer (-p --help lists options)', 'Run'],
  ['onboard', 'check your setup and run one test prompt', 'Set up'],
  ['doctor [--fix]', 'diagnose the runtime, config, and API key', 'Set up'],
  ['update [--check] [--json]', 'update zagent itself to the latest npm release', 'Set up'],
  ['models [query|test <provider/model|model> [--json]]', 'list providers, search the catalog, or test a model connection', 'Set up'],
  ['quota [status|usage [--days 1..30]|balance|preview|reset [claim|use five-hour|use week]] [--json] [--yes]', 'Coding Plan quota and account usage', 'Account'],
  ['remote [status|connect] [--json]', 'whether this device is registered for remote control (not available yet)', 'Account'],
  ['offpeak [--refresh|--json|tools [on|off]]', 'the off-peak campaign window and tool toggle (exit 0 while open)', 'Account'],
  ['usage [--session id] [--json] | stats [--range all|7d|30d] [--json]', 'token totals for a session, or the app-usage dashboard', 'Account'],
  ['sessions [--json]', 'your sessions across CLI and desktop', 'Project'],
  ['diff [sessionId]', 'the file changes a session made', 'Project'],
  ['rewind [list|latest|<checkpointId>|changes|preview [<checkpointId>]] [--message id] [--session id] [--json]', 'inspect or restore workspace checkpoints (undo a turn\u2019s file edits)', 'Project'],
  ['task list [--all] [--json]|archive|unarchive|pin|unpin|rename|delete', 'inspect or modify saved task records (no create)', 'Project'],
  ['memory show|index|append', 'view or add project memory', 'Project'],
  ['commit-msg [--model provider/model|model] [--effort <level>] [--json]', 'generate a commit message for staged (or unstaged) changes', 'Project'],
  ['goal [show|set <text>|pause|resume|clear] [--session id] [--json]', "show or control a session's goal", 'Project'],
  ['subagents [--session id] [--json]', "list a session's child sessions", 'Project'],
  ['cron add|list [--json]|remove [--json]|tick', 'schedule prompts to run later (local crontab)', 'Extend'],
  ['automation list|create|update|delete|check-binding', 'scheduled prompts store served to the kernel', 'Extend'],
  ['plugins [name] [--json]|install <name> [--json] [--offline]', 'inspect and manage local plugins', 'Extend'],
  ['hooks list [--json]', 'list configured hook events', 'Extend'],
  ['import [--dry-run|--apply] [--force] [--json]', 'import Claude Code instructions, commands, and skills', 'Extend'],
  ['inspect [--storage] [--json]', 'dump runtime/config/skills; --storage = ~/.zcode category sizes (read-only)', 'Debug'],
  ['--version', 'print the zagent version', 'Debug'],
];

// Leading-position options the dispatcher accepts. The set is the kernel's own
// parseArgs table plus its manually pre-parsed flags — identical on 3.11.2 and
// 3.12.1 — verified by executing each against both builds (2026-09-15), plus
// two zagent extensions the kernel has no flags for: --model/--effort, consumed
// by zagent-print.mjs's protocol path rather than forwarded. The official --help
// lists six options its parser rejects outright: --print, --max-turns,
// --allowed-tools, --permission-mode, --settings, --allow-main-worktree-yolo.
// They are NOT here: accepting them would forward a guaranteed "Unknown option"
// that ends in the kernel's own usage text — the wrong product's answer for
// our product's surface.
export const ENTRY_FLAGS = new Set([
  '-p', '--prompt', '--json', '--output-format', '--no-color', '--no-browser',
  '--browser-use', '--browser-executable', '--attach', '--cwd', '--locale',
  '--resume', '--target', '--target-replace', '-c', '--continue',
  '-f', '--force', '--force-mcs', '--mode', '--verbose', '--stdio', '--surface',
  '--disallowedTools', '--disallowed-tools', '--model', '--effort',
]);

// The headless rows `zagent -p --help` prints. Only options a headless prompt
// can meaningfully take are listed; login's --no-browser and the server-side
// --stdio are forwarded but not headless documentation.
export const HEADLESS_OPTIONS = [
  ['-p, --prompt <text>', 'run one headless prompt'],
  ['--attach <path>', 'attach a local file to the prompt; repeat for more'],
  ['--mode <build|edit|plan|yolo|auto>', 'permission mode (default yolo for --prompt)'],
  ['--model <provider/model|model>', 'pick the model (zagent extension — protocol-side, bare id = zai provider)'],
  ['--effort <level>', 'pick the reasoning effort (zagent extension — protocol-side)'],
  ['--disallowed-tools <tools…>', 'comma/space-separated tool denylist (alias --disallowedTools)'],
  ['-c, --continue', 'continue the latest session for this directory'],
  ['--resume <sess_…>', 'resume a persisted session by id'],
  ['--target <text> [--target-replace]', 'run or replace the session goal (not with -p)'],
  ['--json', 'print the machine-readable result'],
  ['--output-format <text|json|stream-json>', 'output shape; stream-json emits one event per line'],
  ['--cwd <path>', 'run from the given directory'],
  ['--locale <en-US|zh-CN|auto>', 'UI locale'],
  ['--browser-use headless [--browser-executable <path>]', 'Browser Use backend'],
  ['--surface <terminal|desktop>', 'presentation surface'],
  ['--force-mcs', 'force mid-conversation system projection (Anthropic providers)'],
  ['--no-color', 'disable ANSI colors'],
  ['--verbose', 'print extra diagnostic detail'],
];

/** The bare verb a user types, e.g. "models [query]" -> "models". */
export const verbOf = (signature) => signature.split(/[\s[]/)[0];

/** The table row for a verb, or undefined. */
export const commandFor = (verb) => COMMANDS.find(([sig]) => verbOf(sig) === verb);

export const formatRow = ([sig, desc]) => `  zagent ${sig.padEnd(34)} ${desc}`;
