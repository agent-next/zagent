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
  ['login [--no-browser]', 'sign in to your account', 'Set up'],
  ['logout', 'sign out of the current account', 'Set up'],
  ['quota [status|usage [--days 1..30]|balance|preview|reset [claim|use five-hour|use week]] [--json] [--yes]', 'Coding Plan quota and account usage', 'Account'],
  ['remote [status|connect] [--json]', 'whether this device is registered for remote control (not available yet)', 'Account'],
  ['offpeak [--refresh] [--json] | offpeak tools [on|off] [--json]', 'the off-peak campaign window and tool toggle (exit 0 while open)', 'Account'],
  ['usage [--session id] [--json] | usage stats [--range all|7d|30d] [--json]', 'token totals for a session, or the app-usage dashboard', 'Account'],
  ['sessions [--json]', 'your sessions across CLI and desktop', 'Project'],
  ['diff [sessionId]', 'the file changes a session made', 'Project'],
  ['rewind [list|latest|<checkpointId>|changes|preview [<checkpointId>]] [--message id] [--session id] [--json]', 'inspect or restore workspace checkpoints (undo a turn\u2019s file edits)', 'Project'],
  ['task list [--all] [--json]|archive|unarchive|pin|unpin|rename|delete', 'inspect or modify saved task records (no create)', 'Project'],
  ['memory show|index|append', 'view or add project memory', 'Project'],
  ['commit-msg [--model provider/model|model] [--effort <level>] [--json]', 'generate a commit message for staged (or unstaged) changes', 'Project'],
  ['goal [show|set <text>|pause|resume|clear] [--session id] [--json]', "show or control a session's goal", 'Project'],
  ['subagents [--session id] [--json]', "list a session's child sessions", 'Project'],
  ['cron add [--json]|list [--json]|remove [--json]|tick', 'schedule prompts to run later (local crontab)', 'Extend'],
  ['automation list|create|update|delete|check-binding', 'scheduled prompts store served to the kernel', 'Extend'],
  ['bots [list|show <id>|status] [--json]', 'list chat bots configured in the desktop (read-only)', 'Extend'],
  ['plugins [name] [--json]|install <name> [--json] [--offline]', 'inspect and manage local plugins', 'Extend'],
  ['hooks list [--json]', 'list configured hook events', 'Extend'],
  ['import [--dry-run|--apply] [--force] [--json]', 'import Claude Code instructions, commands, and skills', 'Extend'],
  ['mcp', 'serve zagent as MCP tools over stdio so other agents can call it', 'Extend'],
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
  ['--effort <level>', "pick the reasoning effort (zagent extension — protocol-side; default = the model's last declared level)"],
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

// Per-command detail printed by `zagent <cmd> --help` after the palette row —
// the row alone used to be the whole answer, so a user exploring a subcommand
// got one line, no flag explanation, no example. Each entry is printed verbatim;
// the syntax itself stays in the signature column so it cannot drift from the
// table or the README. Entries also cover the kernel-passthrough verbs
// (login/logout/app-server) so their --help answers here instead of leaking the
// kernel's own usage text.
export const COMMAND_DETAILS = {
  onboard: [
    'Runs the setup checklist end to end: finds the runtime, checks your',
    'credential, then sends one real test prompt. Safe to re-run.',
    '',
    '  example: zagent onboard',
  ],
  doctor: [
    '  fix | --fix      apply safe repairs (e.g. create a missing config file)',
    '  --capabilities   probe which protocol calls this runtime answers',
    '',
    '  example: zagent doctor --fix',
  ],
  update: [
    '  --check   report the latest npm release without installing it',
    '  --json    machine-readable result',
    '',
    '  example: zagent update --check',
  ],
  models: [
    '  models                                  your plan selection + the catalog',
    '  models <query>                          search provider and model ids',
    '  models test <provider/model|model>      run one real connection check',
    '',
    '  example: zagent models test zai/glm-5.3',
  ],
  quota: [
    '  status (default)          the current plan windows and reset times',
    '  usage [--days 1..30]      usage over the last N days (default 7)',
    '  balance | preview         the legacy desktop billing surfaces',
    '  reset                     reset-ticket status',
    '  reset use five-hour|week  consume a ticket (asks first; --yes confirms)',
    '  reset claim               request a reset ticket',
    '  --json                    machine-readable output',
    '',
    '  example: zagent quota usage --days 7',
  ],
  remote: [
    'This-host relay registration and last heartbeat only; remote control from',
    'a second device is not available yet.',
    '  status (default)   local registration state, never contacts the relay',
    '  connect --live     register this device over a real websocket',
    '',
    '  example: zagent remote status',
  ],
  offpeak: [
    'Prints the off-peak campaign window; exit 0 while the window is open.',
    '  --refresh          bypass the cached window',
    '  tools [on|off]     persist the off-peak tool policy for new sessions',
    '  --json             machine-readable output',
    '',
    '  example: zagent offpeak tools on',
  ],
  usage: [
    '  usage                     token totals for a session (latest by default)',
    '  usage stats               the app-usage dashboard',
    '  --session <id>            pick a session (not with stats)',
    '  --range all|7d|30d        stats window (stats only)',
    '  --json                    machine-readable output',
    '',
    '  example: zagent usage stats --range 30d',
  ],
  sessions: [
    'Lists your sessions across CLI and desktop, most recent first.',
    '  --json   machine-readable output',
    '',
    '  example: zagent sessions',
  ],
  diff: [
    'With no session id, lists sessions that produced file changes; with one,',
    'renders that session\'s per-turn +A -D file hunks.',
    '',
    '  example: zagent diff sess_abc123',
  ],
  rewind: [
    '  list | latest | <checkpointId>   inspect checkpoints',
    '  changes | preview [<id>]         the file edits a checkpoint holds',
    '  --message <id>                   pick the checkpoint by message id',
    '  --session <id>                   pick the session (latest by default)',
    '  --json                           machine-readable output',
    '',
    '  example: zagent rewind latest',
  ],
  task: [
    '  list [--all] [--json]             saved task records',
    '  archive|unarchive|pin|unpin|delete <taskId>',
    '  rename <taskId> <title>',
    '',
    '  example: zagent task list --all',
  ],
  memory: [
    '  show (default)       this workspace\'s memory file',
    '  index                the memory index',
    '  append <text>        add a memory line',
    '',
    '  example: zagent memory append "prefers pnpm"',
  ],
  'commit-msg': [
    'Generates a message for staged changes (unstaged when nothing is staged).',
    '  --model <provider/model|model>   pick the model',
    '  --effort <level>                 pick the reasoning effort (default low)',
    '  --json                           machine-readable output',
    '',
    '  example: zagent commit-msg --model zai/glm-5.3',
  ],
  goal: [
    '  show (default)   the session\'s current goal',
    '  set <text>       run or replace the goal',
    '  pause | resume | clear',
    '  --session <id>   pick the session (latest by default)',
    '  --json           machine-readable output',
    '',
    '  example: zagent goal set "refactor the parser"',
  ],
  subagents: [
    "Lists a session's child sessions.",
    '  --session <id>   pick the session (latest by default)',
    '  --json           machine-readable output',
    '',
    '  example: zagent subagents',
  ],
  cron: [
    '  add <id> <5-field-cron> <prompt...>   schedule a prompt (local crontab)',
    '  list | remove <id> | tick             (tick takes no flags)',
    '  --json   machine-readable output (add|list|remove only)',
    'Fields: m h dom mon dow — *, lists a,b, ranges a-b, steps */n or a-b/n,',
    'names JAN..DEC SUN..SAT.',
    '',
    '  example: zagent cron add standup "0 9 * * 1-5" summarize the queue',
  ],
  automation: [
    '  list | create | update | delete | check-binding   the prompt store the',
    '  kernel reads for scheduled runs',
    "  create flags: --prompt T (--cron EXPR | --every \"N UNIT\") [--title T]",
    '  [--delay-minutes N] [--once|--recurring] [--max-runs N|none]',
    '  [--model P/M] [--task ID] [--mode M] [--json]',
    '',
    '  example: zagent automation list',
  ],
  bots: [
    'Chat bots the desktop is configured with (telegram, feishu, weixin,',
    'webhook, ...), read from the shared ~/.zcode/v2 store. Read-only:',
    'bot creation, credentials, and serving are not part of this surface.',
    '  list (default)    every configured bot',
    '  show <botId>      one bot\'s config and runtime state',
    '  status            counts + per-bot runtime state',
    '  --json            machine-readable output',
    '',
    '  example: zagent bots status',
  ],
  plugins: [
    '  plugins [name]             inspect installed/local plugins',
    '  install <name> [--offline] install a plugin (--offline skips the fetch)',
    '  --json                     machine-readable output',
    '',
    '  example: zagent plugins install my-plugin',
  ],
  hooks: [
    'Lists the configured hook events.',
    '  --json   machine-readable output',
    '',
    '  example: zagent hooks list',
  ],
  import: [
    'Imports Claude Code instructions, commands, and skills into this workspace.',
    '  --dry-run   print the plan without writing (default)',
    '  --apply     write the planned files',
    '  --force     overwrite existing files',
    '  --json      machine-readable output',
    '',
    '  example: zagent import --dry-run',
  ],
  mcp: [
    'Runs zagent as an MCP server on stdio (line-delimited JSON-RPC), so an',
    'MCP-capable agent can call it: zagent_turn, zagent_quota, zagent_models,',
    'zagent_doctor. Credentials stay in the local config — never sent to the',
    'calling agent. Register it in the client\'s MCP config, e.g. .mcp.json:',
    '  { "mcpServers": { "zagent": { "command": "zagent", "args": ["mcp"] } } }',
    'zagent_turn runs with -p semantics (tool permissions auto-approved);',
    'pass mode:"plan" for a read-only turn.',
    '',
    '  example: zagent mcp',
  ],
  inspect: [
    'Dumps runtime, config, and skills information.',
    '  --storage   ~/.zcode sizes by category (read-only, never deletes)',
    '  --json      machine-readable output',
    '',
    '  example: zagent inspect --storage',
  ],
  help: [
    'Prints the command palette you get from zagent --help.',
    '',
    '  example: zagent help',
  ],
  login: [
    'Signs in to your account through the runtime (opens a browser;',
    '--no-browser prints the URL instead).',
    '',
    '  example: zagent login',
  ],
  logout: [
    'Signs out of the current account.',
    '',
    '  example: zagent logout',
  ],
  'app-server': [
    'The kernel protocol endpoint the desktop and TUI bridge talk to — an',
    'internal headless entry you normally do not run directly.',
    '',
    '  example: zagent app-server --stdio',
  ],
};

/** The bare verb a user types, e.g. "models [query]" -> "models". */
export const verbOf = (signature) => signature.split(/[\s[]/)[0];

/** The table row for a verb, or undefined. */
export const commandFor = (verb) => COMMANDS.find(([sig]) => verbOf(sig) === verb);

export const formatRow = ([sig, desc]) => `  zagent ${sig.padEnd(34)} ${desc}`;
