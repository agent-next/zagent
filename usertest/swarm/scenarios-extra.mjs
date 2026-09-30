// scenarios-extra — the LIVING card pool.
//
// Every FLOCK finding, every real user report (live-session pastes
// above all), and every review finding that reveals a USER-FACING surface
// spawns a card here THE SAME TICK it is learned — the pool grows with the
// product's real history instead of staying a static 14. Base cards in
// scenarios.mjs stay stable; this file accumulates.
//
// Origin of each card is recorded in its `origin` field so triage can tell
// "regression watch" (a card born from a fixed bug re-finding it) from
// "fresh exploration".

const RULES_BASE = `
RULES (obey exactly):
- This sandbox IS your whole machine. Work only inside the current directory and $HOME. Never read files outside them, never use sudo, never print environment variables.
- zagent is installed and on PATH. The machine has NO zagent account and NO API key — that is the scenario, do not try to sign up.
- Act like a real human user trying to get things done. Do not read zagent's source code.
- A crash (stack trace / node internals), a hang beyond ~30s on a no-credential command, a silent exit 0 where an error belongs, or made-up numbers are BUGS.
- Finish with EXACTLY one line at the end:
  FLOCK-VERDICT: OK
  or, one line PER problem:
  FLOCK-FINDING: <short title> | CMD: <the exact command> | EXPECTED: <what a good CLI would do> | GOT: <what actually happened>`;

// FLOCK-PTY : interactive cards drive the REAL
// TUI through a pty — piped stdin can never test interactivity. The agent
// writes a pty-drive.py script, runs it, then READS the screen dumps and
// judges like a human. The oracle floor: every finding must cite the dump
// line it was judged from (SCREEN:) — the harness tags uncited findings
// unbacked, so a hallucinated "the screen was garbled" cannot land.
const RULES_PTY = `
RULES (obey exactly):
- This sandbox IS your whole machine. Work only inside the current directory and $HOME. Never read files outside them, never use sudo, never print environment variables.
- zagent is installed and on PATH. The machine has NO zagent account and NO API key — that is the scenario, do not try to sign up.
- A file pty-drive.py sits in the current directory. It runs a command inside a REAL terminal (a pty) and writes screen snapshots. Write a script file — one action per line:
    wait <ms> | send <text> | key enter|esc|tab|backspace|delete|ctrl-c|ctrl-d|up|down|left|right|home|end|shift-tab | snap <label> | expect <regex> [ms] | resize <cols>x<rows>
  then run it:  python3 pty-drive.py <scriptfile> <dumpdir> -- <the zagent command>
  'send' writes literal text (\\n \\t \\e \\xNN escapes ok); 'snap' saves the rendered screen to <dumpdir>/NN-<label>.txt; 'expect' waits for text on screen; 'resize' is a window drag.
- Drive it like a human at a keyboard: snap BEFORE and AFTER every keystroke so you can compare what changed; send keys one at a time with a short wait between; run the driver more than once with different scripts.
- Afterwards READ the dump .txt files and judge exactly what a person would see: garbled/overlapping/cut-off text, keys that did nothing, a screen that does not update while work happens, or a terminal left wedged after exit are BUGS. A screen that is simply honest about having no account is NOT a bug.
- Act like a real human user trying to get things done. Do not read zagent's source code.
- A crash (stack trace / node internals), a hang beyond ~30s, a silent dead screen, or text a human could not read are BUGS.
- Finish with EXACTLY one line at the end:
  FLOCK-VERDICT: OK
  or, one line PER problem:
  FLOCK-FINDING: <short title> | SCREEN: <the verbatim line from a dump .txt that proves it> | EXPECTED: <what a human expects> | GOT: <what the screen showed>`;

export const EXTRA_SCENARIOS = [
  {
    // Born from a real user's mac install report: "npm i zagent ... 13
    // vulnerabilities ... why error on my mac" (2026-09-16).
    id: 'install-trust-noise',
    weight: 3,
    origin: 'user report: npm install prints "13 vulnerabilities" — a new user asks whether the tool is safe',
    card: () => `You are a security-conscious developer who just ran a fresh install of a new CLI.
Check the install aftermath yourself: run npm install -g zagent@latest --prefix ./tmpprefix is NOT needed — instead inspect what a NEW user sees: run zagent --version, then zagent doctor, then look at what the tool itself says about your system.
Judge like a real first-timer: anything that sounds alarming, mentions "vulnerabilities", "deprecated", or warnings WITHOUT saying whether they matter or how to fix them counts as a trust problem. Honest tools say "found X, it's fine because Y" or point at a fix.
${RULES_BASE}`,
  },
  {
    // Born from a real user's live session: 5h window at 100% — the error
    // copy didn't say WHEN it resets (ux polish item in the ledger). The TUI
    // turn-failure leg (bare "Turn execution failed" + monitor-verdict reset
    // notice) is unreachable in a credential-free sandbox by design — it is
    // pinned by the PTY journey 'a bare turn failure names the window reset
    // when the monitor proves exhaustion' instead.
    id: 'quota-window-copy',
    weight: 3,
    origin: 'user report: quota-exhausted errors should name the reset time',
    card: () => `You are a user who hit a usage limit yesterday and wants to know when you can work again.
On this no-credential machine you can't hit the real limit — instead judge the COPY quality: run zagent quota, zagent quota --json, and read every error message about limits/keys carefully.
A good tool's limit messages say WHAT is limited, HOW LONG until it resets (or how to find out), and WHAT to do. Vague "limit reached, try later" without a reset hint or a where-to-look pointer counts as a finding.
${RULES_BASE}`,
  },
  {
    // Born from a real user's report: "zagent update / zagent: unknown
    // command 'update'" (the feature landed as F17 after it).
    id: 'self-update-journey',
    weight: 3,
    origin: 'user report: missing update command; F17 landed — regression-watch this surface',
    card: () => `You are a user on version X who heard a new version shipped. Try to update the tool itself the way a person would: zagent update --help, zagent update (if it exists), zagent --version before/after reading help.
RIGHT: a clear update path or honest "not supported yet, reinstall via npm" guidance. WRONG: unknown-command for something the README/help implies, a partial update that leaves version unchanged silently, or an update that prints success but does nothing.
${RULES_BASE}`,
  },
  {
    // Generalizes FLOCK-F3 (task list crashed on fresh DB) to EVERY
    // list-style subcommand on a brand-new machine.
    id: 'fresh-db-every-list',
    weight: 4,
    origin: 'FLOCK-F3 (task list crash on fresh machine) — generalized regression watch',
    card: () => `You are a brand-new user poking at every list-ish thing on the FIRST run of your life with this tool.
Try, one after another: zagent task list, zagent sessions list (or 'zagent sessions'), zagent cron list, zagent goal list, zagent subagents list, zagent usage stats — plus any other '<noun> list' the main help shows.
EVERY one must either work or fail gracefully on an empty machine: an empty-state line ("no tasks yet") with exit 0, or a clean usage message. ANY stack trace, "no such table", or crash is a BUG — report each broken one separately.
${RULES_BASE}`,
  },
  {
    // Generalizes FLOCK-F1: one typo per DOCUMENTED flag must get an
    // unknown-option error, not a wrong-but-plausible error.
    id: 'documented-flag-typo-sweep',
    weight: 4,
    origin: 'FLOCK-F1 (--efort swallowed by the credential gate) — generalized regression watch',
    card: () => `You are a fast typist. From \`zagent --help\`, pick SIX real documented flags and typo each one ONCE (drop a letter, swap two, or add one — e.g. --efort, --jsn, --modle).
Run each typo'd form with -p "hi" (no credential on this machine).
RULE: every typo must produce an unknown-option style error naming the bad flag — NOT a sign-in prompt, NOT a silent different behavior, NOT a hang. A typo that gets a CREDENTIAL error means flag validation happens too late; report it.
${RULES_BASE}`,
  },
  {
    // Born from the wave-3 triage finding: `-p hi --model` (a KNOWN flag
    // missing its value) got the sign-in card instead of "requires a value" —
    // the credential gate ran before selection parsing. Sibling class to the
    // typo sweep: the flag is spelled right, the VALUE is missing.
    id: 'flag-missing-value-gate-order',
    weight: 3,
    origin: 'FLOCK wave-3 finding (-p hi --model trailing showed the credential card, not the flag error) + enum-value residual (--mode=bogus masked the same way) + cross-flag/stat residuals (--target+-p, --browser-executable sans headless, bad --cwd) + 3.12.1 semantic-gate sweep (resume×continue, target-replace, whitespace values, glued boolean values, surface positional shape) — generalized regression watch',
    card: () => `You are a user who keeps dropping the value off a flag — or typing a value the flag does not take. On this no-credential machine, run forms like: zagent -p "hi" --model | zagent -p "hi" --effort | zagent -p "hi" --cwd | zagent -p "hi" --output-format | zagent -p "hi" --mode | zagent -p "hi" --resume | zagent -p "hi" --target | zagent -p "hi" --locale | zagent -p "hi" --surface | zagent -p "hi" --browser-use | zagent -p "hi" --browser-executable | zagent -p "hi" --disallowed-tools | zagent -p "hi" --mode -c — and bogus-value forms like: zagent -p "hi" --mode=bogus | zagent -p "hi" --mode auto | zagent -p "hi" --output-format xml | zagent -p "hi" --locale=zh-cn | zagent -p "hi" --surface bogus | zagent -p "hi" --browser-use headed | zagent -p "hi" --mode=-x — and bad-COMBINATION/bad-PATH forms like: zagent -p "hi" --target "do x" | zagent -p "hi" --browser-executable /bin/true | zagent -p "hi" --cwd /definitely-not-a-dir | zagent --browser-use headless --browser-executable /no-such-bin -p "hi" — and semantic-gate forms like: zagent --resume=abc -c | zagent --target-replace | zagent --target= | zagent -p " " | zagent --surface desktop | zagent --surface desktop --cwd /tmp | zagent -p "hi" --json=x | zagent -p "hi" --target-replace=x.
RULE: every missing value must produce an error naming the flag and that it requires a value (or at least one tool); every bogus enum value must produce an error naming the flag and its accepted values; every bad combination must name the conflicting flags (--target cannot be used with --prompt; --browser-executable requires --browser-use=headless; --resume and --continue cannot be used together; --target-replace requires --target; --surface can only be used with --prompt/--target/app-server/agent-server); every bad path must say the path is not accessible / not a directory / not executable; an empty or whitespace -p/--prompt/--target value must say non-empty text is required (an empty glued value is refused on most flags — --resume= is the verified exception, unset kernel-side); a glued value on a boolean flag must say the flag does not take an argument — NOT a sign-in prompt, NOT a silently different run, NOT a hang. Any of these getting a CREDENTIAL error means flag validation happens too late; report it.
${RULES_BASE}`,
  },
  {
    // Regression watch for the earlier-review residual (fixed 2026-09-19): flag
    // scans used to read past `--`, so `-p hi -- --model x` hit the selection
    // path's refusal and `-p hi -- --json` armed the JSON retry path. POSIX and
    // the kernel's parseArgs both treat post-`--` tokens as positionals (data).
    id: 'post-separator-args-are-data',
    weight: 2,
    origin: 'review-filed LOW (hasSelection scanned post-`--` args) — generalized regression watch on the `--` separator',
    card: () => `You are a careful CLI user who puts a \`--\` separator before anything that should be treated as plain text, not a flag. On this no-credential machine, run forms like: zagent -p "hi" -- --json | zagent -p "hi" -- --model glm-5.3 | zagent -p "hi" -- --effort low | zagent -p "hi" -- --no-browser | zagent -p "hi" -- -p | zagent login -- --no-browser — and compare each one's behavior to the same command WITHOUT the "-- <token>" tail. (Note: noun subcommands like \`quota\` deliberately strip the first \`--\` before dispatch — that convention is NOT under test here; only the -p/entry-flag and kernel-passthrough paths are.)
RULE: a token after \`--\` is positional data — it must NEVER change which flags apply. Each post-separator run must behave exactly like the same command without the tail (same error class, same exit-code class); specifically a post-\`--\` --json must NOT produce a JSON envelope when the plain run prints human text, and a post-\`--\` --model must NOT trigger a model-selection path or a refusal naming it. A refusal that treats the post-\`--\` token as a flag, or a silently different run, is a BUG — report the exact command pair. One deliberate exception: a run whose PRE-\`--\` argv carries --model/--effort is the selection path, which refuses post-\`--\` positionals with 'unrecognized arguments with --model/--effort: <names>' — naming ONLY the tail tokens as data (never the separator itself) is documented strictness, NOT a finding.
${RULES_BASE}`,
  },
  {
    // Born from FLOCK-F11: quota errors conflated "no key" (a sign-in
    // problem) with "limit hit" (a quota problem) — the message must name
    // the problem class and its fix.
    id: 'quota-error-classes',
    weight: 4,
    origin: 'FLOCK-F11 (quota auth-vs-quota conflation) — regression watch on error-copy classification',
    card: () => `You are a user diagnosing why 'zagent quota' fails on this no-credential machine.
Run: zagent quota; zagent quota --json; zagent quota usage --days 1; zagent quota balance; zagent quota reset — read every error line carefully.
RIGHT: each failure says WHICH problem it is — a sign-in/credential problem says so and names the fix (zagent login or ZAI_API_KEY); a usage-limit problem says so and points at the window/reset (zagent quota or zagent quota reset); a network problem says so. WRONG: a line that could mean either problem, or a bare "request failed" with no class and no next step — report the exact line.
${RULES_BASE}`,
  },
  {
    // Born from FLOCK-F15 (carry-over of F11): the stderr hint had the class
    // but the machine-readable JSON did not — a script parsing `quota --json`
    // could not tell auth from limit from network.
    id: 'quota-json-class-field',
    weight: 3,
    origin: 'FLOCK-F15 (quota --json failure envelopes lacked a class field) — regression watch',
    card: () => `You are a user writing a small script that reacts to 'zagent quota --json' output (e.g. alert when the window resets, re-login when the key dies).
Run the failing verbs with --json on this no-credential machine — zagent quota --json, zagent quota usage --json, zagent quota balance --json, zagent quota reset --json — and parse the JSON on stdout like your script would (e.g. pipe to python3 -c or node -e).
RIGHT: every error object carries a "class" field naming the problem kind (sign-in vs quota-window vs network) so a script can branch on it without parsing prose; the value agrees with the human message. WRONG: a failure JSON without a class field, a class that contradicts the message, or unparseable stdout — report the exact output.
${RULES_BASE}`,
  },
  {
    // Born from the real 0.0.211 redirect-leak incident (shipped with an
    // unfixed redirect vuln) — trust surfaces in error text.
    id: 'error-text-trust-surfaces',
    weight: 3,
    origin: '0.0.211 redirect-leak incident class: error/output text must not leak or mislead about endpoints',
    card: () => `You are a careful user who reads error text closely.
Trigger a few error paths (bogus flag, missing value, quota without key, doctor without key) and STUDY the messages: do any of them print full URLs with tokens/query strings, internal paths under /home, machine identifiers, or anything that looks like it should have been redacted? Does any message point you to an endpoint or command that does not exist?
Finding secrets-shaped text (long tokens, key=, bearer) or misleading pointers in output = report with the exact command.
${RULES_BASE}`,
  },
  {
    // A CJK user; mixes long CJK pastes with special chars —
    // none of the base cards combine CJK + size + shell-hostile bytes.
    id: 'cjk-hostile-paste',
    weight: 3,
    origin: 'user profile (CJK primary) + paste-safety card gap — combined stress',
    card: () => `你是一个中文用户，往命令行里粘贴了一大段混合内容。
构造一个文件：中文 + 表格竖线 | + 反引号 \` + 引号 + emoji + 500 行，然后 cat 那个文件 | zagent -p "总结一下"；再用其中一行含特殊字符的内容直接当 -p 的参数试一次。
无凭据机器上正确行为 = 快速、清楚的登录指引（不因输入内容而变）。错误行为 = 崩溃、挂起 >30 秒、退出码 0 但无输出、或错误信息里出现你粘贴内容的原始字节。
${RULES_BASE}`,
  },
  {
    // Born from FLOCK-F6: `quota balance|preview` (and the whole desktop-
    // credential family: reset, remote/offpeak surfaces) leaked a raw ENOENT
    // on credential-free machines while `quota status` said "no key".
    id: 'credential-free-every-verb',
    weight: 4,
    origin: 'FLOCK-F6 (quota balance/preview raw ENOENT on a fresh HOME) + FLOCK wave-4 T4 (reset use demanded --yes before the credential check) — generalized regression watch',
    card: () => `You are a brand-new user on a machine with NO account and NO key, exploring what this tool can do before signing in.
Run every safe-to-run verb you can find: zagent quota, quota balance, quota preview, quota usage --days 1, quota reset, quota reset use five-hour, quota reset use week, zagent inspect, zagent doctor, zagent models, zagent sessions, zagent --version — plus any other no-argument subcommand in zagent --help. (The two reset-use verbs are only safe while signed out — on a signed-in machine they consume real reset tickets, so skip them there.)
RIGHT: each either works or fails with a human sentence that says what is missing and what to run next (e.g. a sign-in command) — consistent across verbs. WRONG: raw ENOENT, "no such file or directory" with a system path, stack traces, node internals, one verb giving a friendly message while a sibling dumps an errno, or being asked to CONFIRM an action you cannot perform (e.g. a --yes prompt or "re-run with --yes" ahead of the sign-in error) — report each offender separately.
${RULES_BASE}`,
  },
  {
    // Born from the 2026-09-17 flock batch: `-p --json` on a credential-free
    // machine printed only the human card (stdout stayed empty) and quota
    // --json errors were plain text — a script parsing stdout got nothing.
    id: 'json-error-paths',
    weight: 4,
    origin: 'flock findings 2026-09-17 (no-account-first-turn, quota-window-copy): --json ignored on error paths — regression watch',
    card: () => `You are writing a shell script that drives this CLI, so you pass --json to everything and parse stdout.
Run: zagent -p "hi" --json; echo EXIT:$?; zagent quota --json; echo EXIT:$?; zagent quota balance --json; echo EXIT:$?; zagent sessions --json; echo EXIT:$?; zagent inspect --json; echo EXIT:$? — remember, this machine has NO credential.
RIGHT: every --json run prints a parseable JSON object on stdout — on failure an error object/envelope — and failures exit nonzero; human hints may still appear on stderr (check both streams). A clean EMPTY list on a genuinely empty machine (sessions on first run) is a success, not a failure.
WRONG: stdout empty or holding human prose on an error path, exit 0 on a real failure, or a warning that looks like a crash on a fresh install — report each offender separately.
${RULES_BASE}`,
  },
  {
    // Born from the 2026-09-18 triage wave-3 OPEN-LOWs: `usage --json` on a
    // session-less machine printed a human line where a script expected the
    // {"error"} envelope, and `quota stauts` dumped bare usage with no hint.
    id: 'cli-error-surface-hints',
    weight: 3,
    origin: 'FLOCK triage wave-3 2026-09-18 (usage --json no-session text-only; quota subcommand typo no did-you-mean) + ux triage U1 2026-09-20 (ssesion transposition fell off the distance bound) — regression watch on error-surface honesty',
    card: () => `You are a new user who mistypes commands and subcommands and a scripter who passes --json everywhere — both on this no-credential, no-session machine.
Run: zagent quota stauts; echo EXIT:$?; zagent quota preive; echo EXIT:$?; zagent quota balanc; echo EXIT:$?; zagent quota reset ues; echo EXIT:$?; zagent qouta; echo EXIT:$?; zagent sessoins; echo EXIT:$?; zagent ssesion; echo EXIT:$?; zagent sessinos; echo EXIT:$?; zagent usage --json; echo EXIT:$?; zagent usage stats --json; echo EXIT:$?; zagent usage --bogus --json; echo EXIT:$? — and any other typo'd command or subcommand form that occurs to you, including transposed-letter forms (teh-style).
RIGHT: a typo'd command or subcommand still fails nonzero AND names the closest real one ("did you mean 'status'?", "did you mean 'quota'?"); every --json failure prints a parseable {"error": ...} object on stdout while the human line stays on stderr.
WRONG: a bare usage dump with no suggestion for an obvious typo, human prose on stdout under --json, exit 0 on a failure, or a did-you-mean that names something unrelated — report each offender separately.
${RULES_BASE}`,
  },
  {
    // Born from FLOCK-F8/F9/F10 (2026-09-17): bare `zagent mcp` exited 0 with
    // no output, `goal list` dumped usage, `plugins list` was treated as a
    // plugin name. Regression-watch every list-verb and bare-subcommand form.
    id: 'list-verbs-and-bare-subcommands',
    weight: 4,
    origin: 'FLOCK-F8/F9/F10 (bare mcp silent exit 0; goal list → usage; plugins list → name lookup) — generalized regression watch',
    card: () => `You are exploring this CLI's subcommands the way a person does — guessing the obvious verb forms.
Run: zagent plugins list; zagent goal list; zagent goal list --json; zagent mcp < /dev/null; echo EXIT:$?; zagent mcp --help — plus 'list' on any other noun the help shows (bots list, hooks list, automation list).
RIGHT: '<noun> list' shows a list or a clean empty state; a server-style command run by hand (mcp) prints usage/guidance and exits nonzero, NEVER a silent exit 0 and NEVER a hang.
WRONG: 'list' treated as a name to look up ("no plugin matching 'list'"), a silent exit 0 with empty output, or usage dumped for a verb that plainly exists — report each offender separately.
${RULES_BASE}`,
  },
  {
    // Born from FLOCK-F13 (2026-09-17, cards cjk-new-user + union-alpha):
    // `-p --help` said "(default yolo)" without telling a new user that yolo
    // skips ALL confirmations or how to opt out — the most dangerous default
    // in the tool unexplained at its point of mention.
    id: 'yolo-default-disclosure',
    weight: 4,
    origin: 'FLOCK-F13 (-p --help yolo default undisclosed) — regression watch on permission-mode disclosure',
    card: () => `You are a brand-new user about to run your first headless command, and you read the help BEFORE running anything.
Run: zagent -p --help — study the permission-mode row and any safety note; then run zagent --help and see whether the danger of the default mode is learnable anywhere a new user would look.
RIGHT: the help tells you plainly that the DEFAULT -p mode (yolo) runs every tool with NO confirmation, and names how to opt out (e.g. --mode plan). WRONG: a bare "default yolo" (or mode list) with no explanation of what yolo means or how to pick a safer one — report the exact line.
${RULES_BASE}`,
  },
  {
    // Born from FLOCK-F7/F12 (2026-09-17): `import --dry-run` JSON printed
    // absolute home paths and `doctor` rendered config/disk/logs under $HOME
    // absolute — a privacy leak on shared terminals. Regression-watch every
    // surface that echoes a path inside the user home.
    id: 'home-path-privacy',
    weight: 4,
    origin: 'FLOCK-F7/F12 (import --dry-run + doctor leaked absolute home paths) — generalized regression watch',
    card: () => `You are a privacy-conscious user running this CLI on a shared machine.
Run: echo "$HOME"; zagent doctor; zagent import --dry-run; zagent import --dry-run --json; zagent inspect 2>&1 | head -20 — then compare each output against your real $HOME value.
RIGHT: any path INSIDE your home directory renders as ~/... (e.g. ~/.zcode/cli/config.json), and no output line contains your literal $HOME string. Paths outside home (the install dir, your cwd) may stay absolute.
WRONG: your literal $HOME path (or another user's home directory) printed anywhere — report the exact command and the leaked line.
NOTE: for this card only, \`echo "$HOME"\` is explicitly allowed — you need the value to compare against the output.
${RULES_BASE}`,
  },
  {
    // Born from FLOCK-F14a/F14d (user report): /permissions
    // listed five bare "Bash — allow_always" lines with no way to tell WHAT
    // was allowed, and deleting grants.json was the only revocation path.
    id: 'permission-grants-surface',
    weight: 4,
    origin: 'FLOCK-F14a/F14d (opaque grants list + no revoke path) — regression watch on the grants surface',
    card: () => `You are a user who earlier clicked "always allow" on a few permission prompts and now wants to review — and maybe revoke — what you approved.
Explore the surface the way a person would: zagent permissions, zagent permissions --json, zagent permissions revoke npm, zagent permissions --help — then, curious, create a fake store at ~/.zcode/cli/grants.json like {"version":1,"grants":{"<64 hex chars>":{"toolName":"Bash","optionId":"allow_always","pattern":"npm test","response":{"decision":"allow"}}}} and re-run the list + a real revoke.
RIGHT: the list shows WHAT was granted (e.g. Bash(npm test) — allow_always), an empty/absent store says so honestly, revoke removes only what matches and reports the count, and nothing ever crashes or creates the file just to say it is empty.
WRONG: bare tool names with no pattern, a silent exit 0 on a failed revoke, a stack trace on a corrupt store file, or no revocation path at all — report the exact command and output.
${RULES_BASE}`,
  },
  {
    // Born from the 2026-09-18 triage batch: `models test zai/glm-5.3` on a
    // no-credential machine forwarded an unconfigured provider id and relayed
    // the kernel's unlocalized -32603 verbatim ("Provider Registry 中不存在
    // Provider: zai"); `login --help` never said where an account comes from;
    // `-p --help` listed --target (refused under -p) inline among usable
    // options and never explained what each --mode means.
    id: 'help-guidance-and-locale',
    weight: 4,
    origin: 'FLOCK triage 2026-09-18 (models-test untranslated kernel error on the documented example; login --help signup dead-end; -p --help incompatible options inline + unexplained modes) — regression watch',
    card: () => `You are a brand-new user with NO account, reading help and trying the documented examples before deciding to sign up.
Run: zagent login --help; zagent -p --help; zagent models test zai/glm-5.3; zagent models test openai/gpt-4 — read every line of each answer.
RIGHT: login --help tells you where an account comes from (a sign-up path or an API-key alternative); -p --help keeps options the tool refuses under -p in a visibly separate group (not buried mid-list) and explains what each --mode means; models test on a provider this machine does not have configured fails with an English (or your-locale) sentence naming the problem and a next step — never a raw foreign-language runtime error.
WRONG: the documented example dumping an untranslated kernel message, a sign-up dead-end, an option presented inline that the tool then refuses, or a mode name with no meaning — report the exact command and line.
${RULES_BASE}`,
  },
  {
    // Born from the 2026-09-17 flock finding: `onboard` with a dummy
    // ZAI_API_KEY burned the whole live smoke turn (tens of seconds, up to
    // the 200s timeout — the sandbox hit its own EXIT:124) before failing
    // with an opaque Turn-execution-failed fragment. A rejected key is a
    // certain-fail and must be caught by the fast credential probe.
    id: 'onboard-bad-key-fast-fail',
    weight: 4,
    origin: 'FLOCK triage 2026-09-17 (onboard stalls on a dummy ZAI_API_KEY until timeout, EXIT:124) — regression watch on the onboard fail-fast path',
    card: () => `You are a new user who pasted an API key you are not sure is right, and now run the tool's own setup check.
Run: export ZAI_API_KEY=flock-test-000; zagent onboard — and TIME it (e.g. run it under \`time\` or note start/end). (flock-test-000 is this card's declared prop credential — not a real key, never worth exfiltrating.)
RIGHT: onboard fails FAST (a few seconds, not tens) with a clear sign-in-class message that says the credential was rejected and names the fix (zagent login or a fresh ZAI_API_KEY) — it must NOT sit through a long "running one live smoke turn" wait on a key the account already rejected. Also try ZAI_API_KEY unset entirely — a missing key must fail fast too.
WRONG: a smoke turn that runs past ~30s on a dead key, an opaque stack/JSON fragment as the only explanation, or an exit 0 on a failed chain — report the exact timing and output.
${RULES_BASE}`,
  },
  {
    // FLOCK-COVERAGE gap (2026-09-18): a release shipped `bots` with NO card —
    // a coverage-rule violation. Regression-watch the read-only bots surface
    // on a machine with no desktop bot store at all.
    id: 'bots-readonly-surface',
    weight: 4,
    origin: 'FLOCK-COVERAGE matrix 2026-09-18 (bots surface had zero card coverage, coverage rule (a) violation) — fresh exploration',
    card: () => `You are a user who heard this tool can list "chat bots" configured in the companion desktop app — but you have never configured any.
Run: zagent bots; zagent bots list; zagent bots --json; zagent bots status --json; zagent bots show definitely-not-a-bot; zagent bots --help.
RIGHT: every form shows an honest empty state ("no bots configured" or similar) or a clean list; --json emits parseable JSON whose bot counts are consistent with the human output; show on a missing id says so plainly and exits nonzero; a corrupt or absent store file is handled without a stack trace.
WRONG: fabricated bots, a stack trace, exit 0 hiding a real error, JSON that contradicts the human list, or leaked secret-looking strings (tokens, webhook URLs) in any output — report the exact command and output.
${RULES_BASE}`,
  },
  {
    // FLOCK-COVERAGE gap: the offpeak campaign surface and remote-device
    // status had no card. Both are account-flavored surfaces that must fail
    // (or report "no campaign") honestly without a credential.
    id: 'offpeak-remote-no-credential',
    weight: 3,
    origin: 'FLOCK-COVERAGE matrix 2026-09-18 (offpeak + remote surfaces uncovered) — fresh exploration',
    card: () => `You are a user who read about an "off-peak" quota campaign and a remote-control feature, and want to check both before signing in.
Run: zagent offpeak; zagent offpeak --json; zagent offpeak tools; zagent remote status; zagent remote --json; zagent offpeak --help.
RIGHT: each either reports the campaign/device state honestly or fails with a clear what-is-missing message (a sign-in pointer is fine); --json stays parseable; 'offpeak tools' must never claim a toggle succeeded while silently doing nothing. Note the wording carefully — a "window open" line must not read like "everything is free now".
WRONG: invented quota numbers, a hang, a raw ENOENT/stack, exit 0 on a real failure, or copy that promises free usage the tool cannot deliver — report the exact command and output.
${RULES_BASE}`,
  },
  {
    // FLOCK-COVERAGE gap: the rewind/rollback family (checkpoint list,
    // preview, restore) plus `diff` had no card — all must give clean empty
    // states or honest errors on a machine that never ran a turn.
    id: 'rewind-diff-fresh-machine',
    weight: 3,
    origin: 'FLOCK-COVERAGE matrix 2026-09-18 (rewind/diff family uncovered) — fresh exploration + FLOCK wave-4 T3 (rewind --session <bogus> off-topic hint — regression watch)',
    card: () => `You are a user exploring the undo/checkpoint feature on a machine where no session ever ran.
Run: zagent rewind list; zagent rewind preview; zagent rewind preview --session sess_bogus_123; zagent rewind checkpoint_bogus000; zagent diff; zagent diff sess_bogus_123; zagent rewind --help — read each answer. Do NOT run 'rewind latest' or 'rewind <a real id>' — those are restore verbs that overwrite workspace files; only inspect forms are in scope.
RIGHT: empty machine = a clean "no checkpoints/sessions" message or a graceful nonzero exit; a well-formed but bogus checkpoint/session id gets a not-found style error, never applied to anything ('rewind preview --session <bogus>' must refuse nonzero naming rewind/the session — never a success exit pointing at unrelated /goal /usage /agents verbs); help explains what rewind restores.
WRONG: a stack trace, a bogus id treated as real, any write to your files, or a silent exit 0 that did nothing — report the exact command and output.
${RULES_BASE}`,
  },
  {
    // FLOCK-COVERAGE gap: the sign-in lifecycle (login/logout) had no card.
    // On a no-credential sandbox the journey is: logout must say "not signed
    // in" honestly; login must either present a real sign-in path or fail
    // honestly — and must not wedge the terminal.
    id: 'signin-lifecycle-honesty',
    weight: 4,
    origin: 'FLOCK-COVERAGE matrix 2026-09-18 (login/logout journey uncovered) — fresh exploration',
    card: () => `You are a user poking the sign-in flow on a machine that was never signed in.
Run: zagent quota first — if it reports any signed-in account, STOP and skip the logout leg entirely (never sign a real account out). On this machine it should fail with no credential, so continue: zagent logout; echo EXIT:$?; zagent logout --json; echo EXIT:$?; zagent --json logout; echo EXIT:$?; then timeout 20 zagent login --no-browser < /dev/null; echo EXIT:$? — plus zagent login --help and zagent logout --help.
RIGHT: logout on a signed-out machine says so plainly (a nonzero exit is fine; the --json form stays parseable JSON); login prints a real way to authenticate (a URL to open, a device code, or an API-key instruction) or an honest error — if it waits for input, it must SAY what it is waiting for; timeout killing a waiting login is acceptable if the wait was explained.
WRONG: logout claiming success on a machine that was never signed in, login exiting 0 having authenticated nothing, a hang with zero output, or a stack trace — report the exact command and output.
${RULES_BASE}`,
  },
  {
    // FLOCK-COVERAGE gap: plugins (beyond 'list'), hooks, inspect, and memory
    // had no dedicated card. All are local inspection surfaces that must
    // behave on a fresh machine.
    id: 'local-inspection-surface',
    weight: 3,
    origin: 'FLOCK-COVERAGE matrix 2026-09-18 (plugins/inspect/memory/hooks partially uncovered) — fresh exploration',
    card: () => `You are a user inventorying what this tool can see and manage locally.
Run: zagent plugins; zagent plugins nosuchpluginxyz; timeout 30 zagent plugins install --offline totally-bogus-plugin-name-zzz; zagent hooks list; zagent inspect; zagent inspect --storage --json; zagent memory show; zagent memory index.
RIGHT: empty plugin/hook/memory stores show honest empty states; a bogus plugin name gets a not-found error; install of a nonsense name fails with a clear message (never a stack, never pretending it worked); inspect dumps real info and --storage --json is parseable.
WRONG: fabricated plugins/hooks/memory, a crash on a corrupt or absent store, exit 0 hiding a failed install, or any output printing your literal home path where ~/ would do — report the exact command and output.
${RULES_BASE}`,
  },
  {
    // FLOCK-COVERAGE gap: the local WRITE verbs (the closest thing to
    // "config editing" — there is no zagent config command) had no card:
    // memory append, cron add/remove, goal set/clear, permissions revoke on
    // a fabricated store. Each write must round-trip honestly.
    id: 'local-write-verbs-roundtrip',
    weight: 4,
    origin: 'FLOCK-COVERAGE matrix 2026-09-18 (config-editing/write verbs uncovered; no zagent config command exists) — fresh exploration',
    card: () => `You are a user testing the tool's local settings-like commands — things that remember state between runs.
Try a full round-trip of each: zagent memory append "flock-test-note alpha" then zagent memory show (did it persist? — note: memory has no remove verb, so keep the line obviously a test); zagent cron add --help then a cron add per its usage and cron list and cron remove on what you added; zagent goal set "ship the demo" then zagent goal show; zagent permissions revoke nothing-real.
RIGHT: each write is reflected by the matching read immediately after, OR fails honestly on a fresh machine (e.g. 'goal set' with no session may cleanly refuse — that is fine, a fake success is not); remove/revoke of something absent fails honestly nonzero; no file is created just to report emptiness; nothing crashes and nothing silently no-ops while claiming success.
WRONG: a write that the read cannot see, an absent-item delete exiting 0, a stack trace, or a "success" line for an operation that stored nothing — report the exact command sequence and outputs.
${RULES_BASE}`,
  },
  {
    // FLOCK-PTY: the bare `zagent` first-run surface is what EVERY new human
    // drives first — a TTY chooser no piped-stdin test can reach.
    id: 'pty-first-run-chooser',
    weight: 3,
    pty: true,
    origin: 'FLOCK-PTY (user report): interactive-TUI card class — first-run sign-in chooser is the no-credential interactive surface',
    card: () => `You are a brand-new user who just typed \`zagent\` with no arguments to see what happens.
Drive \`zagent\` under pty-drive.py: write a script that waits ~3s, snaps the boot screen, then explores whatever the screen offers — if it is a chooser/menu, press up/down/enter and snap after each; try Esc and, in a SECOND run, ctrl-c mid-screen; try a resize (resize 60x18 then resize 100x30) in a third run and snap after it.
RIGHT: the first screen a human sees is readable and honest (a sign-in guide is expected on this machine — that is CORRECT, not a bug); keys visibly change the screen; Esc/ctrl-c exit cleanly without garbage; resize does not corrupt the display.
WRONG: a blank/dead screen, overlapping or half-drawn text, keys doing nothing, the terminal left unusable after exit, a stack trace painted on screen — cite the dump line that shows it.
${RULES_PTY}`,
  },
  {
    // FLOCK-PTY: key handling, paste, resize and interrupt are the classes
    // that only ever broke interactively (raw-mode wedge, resize desync).
    id: 'pty-keys-resize-interrupt',
    weight: 3,
    pty: true,
    origin: 'FLOCK-PTY (user report): interactive-TUI card class — keys/resize/interrupt are unreachable via piped stdin',
    card: () => `You are a fidgety terminal user: you resize the window constantly and hit keys without waiting.
Drive \`zagent\` under pty-drive.py with a script that: waits for boot, snaps, presses arrow keys and any visible shortcuts one at a time (snap after each), types literal text with 'send' where a text field exists, hits backspace a few times, resizes small (resize 60x15), snaps, resizes large (resize 120x40), snaps, then ctrl-c and snap. Then run a SECOND script doing the same things faster (wait 200 between actions) — a real impatient user.
RIGHT: every keystroke either visibly does something or is safely ignored; resize reflows without corrupting rows; ctrl-c produces a clean state or clean exit — never a frozen frame, never escape soup leaking as literal text like "^[" or "[[A" on screen.
WRONG: leaked escape bytes rendered as text, duplicated/shifted rows after resize, a dead screen that stops reacting, or a hang needing SIGKILL — cite the dump line that shows it.
${RULES_PTY}`,
  },
  {
    // Regression card for the 2026-09-18 install-trust-noise finding: the
    // --json form dropped the "installed is newer than the npm release" state
    // the text form prints (fixed with newerThanRegistry). Guards the class:
    // the JSON must never say less than the prose.
    id: 'update-json-truth-parity',
    weight: 2,
    origin: 'flock finding 2026-09-18 (install-trust-noise): update --check --json claimed ok:true while installed was ahead of the registry — regression watch',
    card: () => `You are a script author checking whether this tool's JSON output can be trusted to tell the whole truth.
Run: zagent update --check; echo EXIT:$? — then zagent update --check --json; echo EXIT:$? — and compare them. Also try zagent update --help.
RIGHT: the --json output is parseable JSON and conveys every fact the plain-text form states (installed version, registry latest, whether an update exists, whether the install is NEWER than the registry, or why the check failed) — a script reader must reach the same conclusion a human would.
WRONG: JSON that omits or flattens a state the text form names (e.g. "newer than npm" reported as plain "ok"), mismatched exit codes, prose mixed into stdout before the JSON — report both outputs verbatim.
${RULES_BASE}`,
  },
  {
    // Feature card for the snapshot guard (parity-snapguard): the new
    // `zagent snapshot` surface plus the dispatcher auto-guard. A fresh
    // sandbox has no desktop staging dir, so status must be honest about
    // 'absent', and lock/unlock must round-trip cleanly.
    id: 'snapshot-guard-surface',
    weight: 3,
    origin: 'new user-facing feature (zagent snapshot status|lock|unlock + per-run auto-guard) — coverage rule (a) card shipped with the feature',
    card: () => `You are a privacy-conscious user who heard the companion desktop app stages encrypted workspace snapshots under ~/.zcode/v2/checkpoints, and this CLI can check or disable that staging.
Run: zagent snapshot status; zagent snapshot status --json; zagent snapshot --help; zagent snapshot lock; zagent snapshot status --json; zagent snapshot unlock; zagent snapshot status --json; zagent snapshot bogus.
RIGHT: on a machine that never ran the desktop app, status reports an honest absent/empty state (a prior lock from any earlier zagent run reporting 'locked' is also correct); --json is parseable and agrees with the human output; lock and unlock each report what they did and the state actually changes between them; an unknown verb is a usage error (nonzero), never a silent status.
WRONG: a stack trace, exit 0 on an unknown verb, --json that contradicts the human line, lock claiming success while status still shows writable staging, or output that leaks a secret-looking string — report the exact command and output.
${RULES_BASE}`,
  },
  {
    // Regression card for FLOCK-F17 (2026-09-18): `login --no-browser` on a
    // closed stdin blocked forever — the kernel OAuth flow waits on a
    // paste-back that can never arrive. Guards the class: any subcommand run
    // with dead stdin must answer, not hang.
    id: 'dead-stdin-never-hangs',
    weight: 3,
    origin: 'FLOCK-F17 (login --no-browser blocked forever on closed stdin) — generalized regression watch on dead-stdin hangs',
    card: () => `You are a user running commands from a script, so your stdin is /dev/null — nothing can ever be typed in.
Run: timeout 10 zagent login --no-browser < /dev/null; echo EXIT:$?; timeout 10 zagent mcp < /dev/null; echo EXIT:$?; timeout 10 zagent logout < /dev/null; echo EXIT:$? — plus any other help-listed verb that looks interactive, run the same way.
RIGHT: every command answers within the timeout — a refusal with guidance and a nonzero exit is correct when stdin is needed but dead; EXIT:124 (timeout kill) is ALWAYS wrong.
WRONG: any hang (EXIT:124), a silent exit 0 that did nothing, or a bare stack trace — report the exact command.
${RULES_BASE}`,
  },
  {
    // FLOCK-PTY card pack (user report): the slash layer is the TUI's
    // verb surface — piped stdin can never open /help or dismiss a chooser.
    // A deliberately-fake env key gets past the first-run sign-in card (it
    // signs nothing in; the wall blocks provider egress anyway).
    id: 'pty-tui-slash-surfaces',
    weight: 3,
    pty: true,
    origin: 'FLOCK-PTY card pack: slash-command surfaces (/help /status /permissions /mode) are unreachable without driving the real TUI',
    card: () => `You are a new user poking around the interactive interface to see what its slash commands do.
A fake credential gets you past the first-run sign-in card — it is not real, it signs nothing in, and this machine has no route to the model provider anyway. (The no-key RULES line describes this machine's default; this throwaway env var is a prop for this card, not a real sign-in.) Run under pty-drive.py:  env ZAI_API_KEY=flock-test-000 zagent
Script it: wait for the interface to finish booting (up to ~15s), snap, then type each slash command one at a time — /help, /status, /permissions, /mode, and a made-up one like /bogus — a short wait then a snap after each surface opens and again after you dismiss it (Esc or enter, whatever the screen hints). Then quit cleanly (ctrl-c twice, /exit, or ctrl-d — whatever the screen offers) and snap the returned shell.
RIGHT: the interface boots into a readable home screen (an honest error naming a missing runtime/component is ALSO correct on a minimal machine — check with zagent doctor first if boot fails); each real slash command opens a readable surface; an unknown slash command gets an honest reply, not silence or a crash; Esc/enter return to the input; quitting leaves a usable terminal.
WRONG: a screen that never finishes booting past ~15s with no honest error, slash output painted over old text, a modal that cannot be dismissed, a stack trace on screen, garbage left after exit — cite the dump line that shows it.
${RULES_PTY}`,
  },
  {
    // FLOCK-PTY card pack: input-box quality (TUI-CORE-SPEC wave 4) — cursor
    // editing, history, paste and wide CJK text only misbehave at a real tty.
    id: 'pty-tui-input-editing',
    weight: 3,
    pty: true,
    origin: 'FLOCK-PTY card pack: input editing/history/paste are the wave-4 surface piped-stdin cards cannot see',
    card: () => `You are a picky typist testing whether this interface's input box behaves like a proper terminal app.
Boot it under pty-drive.py with a fake credential to pass the sign-in card (a prop for this card, not a real sign-in):  env ZAI_API_KEY=flock-test-000 zagent
Wait for boot, snap — if the interface never boots, run zagent doctor and report what it says instead. In the input box: type a long line (80+ chars), move the cursor with left/right/home/end and edit the MIDDLE of the line, snap; flood backspace until empty; type something, press enter (expect whatever the interface does with no working account — an honest error is fine), wait for that turn to finish or fail, then press up-arrow to recall it from history, snap; 'send' a pasted chunk including punctuation and a couple of wide CJK characters like 测试, snap; clear it (Esc or ctrl-c, whatever works) and snap. Then quit cleanly and snap the returned shell. Repeat a couple of these in a second run at faster pacing.
RIGHT: typed text appears where the cursor is; mid-line edits insert at the cursor, not at the end; backspace deletes one visible character (wide chars erase cleanly — no half-characters left); once the previous turn has ended, history recall shows what you sent; a paste lands as text, not as leaked escape bytes; the screen is never left garbled.
WRONG: characters landing in the wrong place, doubled/shifted rows, literal "^[" or "[[D" painted on screen, a wide character leaving a phantom half-cell, the input box dying mid-edit — cite the dump line that shows it.
${RULES_PTY}`,
  },
  {
    // FLOCK-PTY card pack: the turn lifecycle (TUI-CORE-SPEC wave 1 adjacent).
    // The wall blocks provider egress, so every submitted turn MUST fail —
    // the card judges that failure's honesty and the interface's recovery,
    // which is exactly the surface a real user hits on a dead network.
    id: 'pty-tui-turn-lifecycle',
    weight: 3,
    pty: true,
    origin: 'FLOCK-PTY card pack: submit → activity → honest error → recovered input is the interactive turn contract',
    card: () => `You are a user on a machine whose network cannot reach the model provider — you want to see whether the interface handles that honestly.
Boot it under pty-drive.py with a fake credential (a prop for this card, not a real sign-in):  env ZAI_API_KEY=flock-test-000 zagent
Wait for boot, snap — if the interface never boots, run zagent doctor and report what it says instead. Type a real prompt like "hello, what can you do" and press enter. Give it a beat (wait 300), then snap — is anything showing the turn started (a spinner, a status line)? Wait ~10s and snap again, wait up to ~30s total for an answer or an error and snap. In a second run, submit the prompt and hit ctrl-c about 2s in — snap the result. Then quit cleanly.
RIGHT: submitting visibly starts something (an activity indicator or a status change) — a screen that sits dead-still through a turn is suspicious; the failed turn ends in an honest error a human can read (auth/network/quota all fine — the sandbox cannot reach a provider); ctrl-c mid-turn may cancel the turn OR ask to quit — either is fine as long as it says what it did, the input box works again afterwards, and the screen is not corrupted.
WRONG: no visible sign anything happened after enter, a spinner that never ends (a hang past ~30s is a bug), a raw stack trace painted as the answer, ctrl-c leaving a wedged or half-drawn screen, the interface exiting without you asking it to — cite the dump line that shows it.
${RULES_PTY}`,
  },
  {
    // FLOCK-PTY card pack slice 2 (TUI-CORE-SPEC wave 3): the fold/selection
    // machinery — shift-up picks a user turn, a peek row names it, j/k/o + h/l
    // walk and toggle that turn's foldables, ctrl-e toggles thinking globally.
    // Real tool-call rows need a live provider turn the sandbox cannot reach;
    // the reachable contract is the selection peek + honest fold-key behavior.
    id: 'pty-tui-turn-select-fold',
    weight: 3,
    pty: true,
    origin: 'FLOCK-PTY card pack: wave-3 fold/expand + turn selection are unreachable via piped stdin',
    card: () => `You are a user tidying a busy transcript — collapsing old turns the way the shortcuts hint.
Boot it under pty-drive.py with the fake-credential prop (not a real sign-in):  env ZAI_API_KEY=flock-test-000 zagent
Wait for boot, snap — if it never boots, run zagent doctor and report what it says instead. Submit two short prompts one at a time ("hi", then "what can you do") — each fails honestly on this machine (no provider route), that failure is EXPECTED and not a finding. Now exercise the selection layer: send the bytes for shift-up (send \\e[1;2A) — snap: a peek/selection row naming your last prompt should appear near the input (like "2/2 > what can you do"). send \\e[1;2A again to step to the older turn, snap; send \\e[1;2B (shift-down) to step back, snap. With a turn still selected and the input box EMPTY, press j, then k, then o, then h, then l — one at a time, snap after each. Press esc to drop the selection, snap; then type a normal sentence and snap — the letters must land in the input box. Quit cleanly.
RIGHT: shift-up/down visibly move a selection between your submitted turns (a peek row or highlight naming which); on a turn with nothing foldable the fold keys either toggle a named foldable (a "fold x/y <name>" tag is good) or simply type their letter — BOTH are honest; collapsing a turn never loses it for good (expand brings it back); esc clears the selection; nothing ever tears, duplicates, or garbles rows.
WRONG: shift-up/down doing nothing visible when submitted turns exist, a fold that erases content it cannot bring back, selection surviving an esc pressed while the interface is idle (esc during a still-running turn arms the interrupt instead — that is correct, not a finding), fold keys corrupting the screen, 'j' typed into the box while the peek row claims a fold target exists — cite the dump line that shows it.
${RULES_PTY}`,
  },
  {
    // FLOCK-PTY card pack slice 3 (TUI-CORE-SPEC wave 5): the layout chrome a
    // human stares at all day — status line (model/activity/elapsed/hints),
    // contextual hint bar, resize reflow WITH transcript content, and the exit
    // summary. All reachable without a provider turn.
    id: 'pty-tui-layout-status',
    weight: 3,
    pty: true,
    origin: 'FLOCK-PTY card pack: wave-5 layout/status surfaces (hint bar, status line, resize reflow, exit summary) need the real TUI',
    card: () => `You are a user who judges a terminal app by its chrome — the status line, the hints, and whether it survives a window drag.
Boot it under pty-drive.py with the fake-credential prop (not a real sign-in):  env ZAI_API_KEY=flock-test-000 zagent
Wait for boot, snap — if it never boots, run zagent doctor and report what it says instead. READ the home screen carefully: is there a status line (model/account, context or quota info) and a hint line teaching keys (something like "enter send · alt+enter newline")? snap it. Submit a prompt and snap ~300ms in — while the turn runs the status/hint area should show work happening (a spinner, "working"/"waiting", elapsed time, an esc-to-interrupt hint); snap again when the honest failure lands and check the status returned to idle. Then run /help (long output = real transcript content printed into the scrollback, not a popup) and resize: resize 60x15, snap; resize 120x40, snap — the transcript must reflow, not smear. Finally quit (ctrl-c twice or /exit or ctrl-d) and snap the shell: a session/resume hint (like "resume: zagent -c") is good chrome; its absence is acceptable only if no session ever started.
RIGHT: status and hint lines are present and readable at every stage; the busy state is visibly different from idle (if the honest failure landed before your snap and no busy frame exists, judge whatever the screen shows); resize with content reflows cleanly (no duplicated, shifted, or half-erased rows); quitting leaves a usable shell prompt.
WRONG: a missing or unreadable status/hint area, the busy state indistinguishable from idle, resize smearing the transcript, leftover escape soup or a dead terminal after exit — cite the dump line that shows it.
${RULES_PTY}`,
  },
  {
    // FLOCK-PTY card pack slice 3 (TUI-CORE-SPEC waves 4+5): Esc layering —
    // modal-dismiss vs armed-interrupt vs debris-clear vs deselect — is the
    // subtlest key contract and only exists at a real tty.
    id: 'pty-tui-esc-layers',
    weight: 3,
    pty: true,
    origin: 'FLOCK-PTY card pack: Esc layered semantics (popup dismiss, armed interrupt, deselect) are unreachable via piped stdin',
    card: () => `You are a user who hits Esc reflexively — the app must always do something sane with it and never quit on a single Esc.
Boot it under pty-drive.py with the fake-credential prop (not a real sign-in):  env ZAI_API_KEY=flock-test-000 zagent
Wait for boot, snap — if it never boots, run zagent doctor and report what it says instead. Leg 1 — popup: type / to open the slash popup, snap, press esc, snap (popup gone; a leftover bare "/" cleared on the NEXT esc is fine). Leg 2 — busy turn: submit a prompt, then press esc about 1s in, snap — a single esc while work runs should ARM an interrupt (a hint like "esc again"), not kill the app; if the hint appears press esc again within a few seconds and snap (turn aborted or cancelled honestly). If the turn already failed before your esc, that is fine — judge whatever the screen shows. Leg 3 — plain typing: type abc, press esc once, snap — your text either survives or the app says what esc did; then press esc again, snap. Quit cleanly at the end.
RIGHT: esc never exits the app on one press; a busy-turn esc visibly arms or interrupts and SAYS which; popup/modal esc dismisses the popup only; after any esc sequence the input box still works and the screen is intact.
WRONG: a single esc quitting the interface, esc doing something destructive with no hint (a vanished draft, a killed turn with no message), escape bytes painted as text, a wedged screen afterwards — cite the dump line that shows it.
${RULES_PTY}`,
  },
  {
    // Coverage rule (a): ships with the F14b/F14c PR — /permissions is now a
    // real management surface (picker + y/N revoke) and /mode teaches what
    // each mode does instead of listing bare names.
    id: 'pty-permissions-mode-pickers',
    weight: 3,
    pty: true,
    origin: 'new user-facing feature (in-TUI grant revoke + mode explanations + onboard mode table) — coverage rule (a) card shipped with the feature',
    card: () => `You are a user who approved some "always allow" prompts earlier and now wants to review them from inside the app — plus you want to know what the permission modes actually mean.
First seed a fake grant store so there is something to manage: create ~/.zcode/cli/grants.json containing {"version":1,"grants":{"aa11":{"toolName":"Bash","optionId":"allow_always","pattern":"npm test","response":{"decision":"allow"}},"bb22":{"toolName":"Write","optionId":"deny_always","pattern":"src/secret.txt","response":{"decision":"deny"}}}} — then boot the TUI under pty-drive.py with the fake-credential prop (not a real sign-in):  env ZAI_API_KEY=flock-test-000 zagent
Wait for boot, snap — if it never boots, run zagent doctor and report what it says instead. Type /permissions and press enter, snap: a list naming WHAT was granted (like "Bash(npm test) — allow_always") plus a chooser of those grants should be on screen. Press enter on the first grant, snap: a yes/no confirm must ask before anything is removed. Press y, snap: a "revoked" report must appear. Type /permissions again, enter, snap: the revoked grant must be gone and the OTHER grant still listed. Now type /mode and enter, snap: every mode name must carry a one-line meaning (not bare names) — and quit the picker with esc.
RIGHT: the grants list and picker show WHAT was approved; revoking asks first and removes only the chosen grant (re-open /permissions to verify the sibling is still there); the /mode picker explains each mode in a few words (e.g. what it asks about or skips); an honest "nothing saved" state when the store is empty is correct too — if you deleted both grants, saying so is fine.
WRONG: revoke happening with no confirm, the wrong grant (or both) disappearing, bare mode names with no explanation, a picker that cannot be dismissed, screen corruption — cite the dump line that shows it.
${RULES_PTY}`,
  },
  {
    // Regression card for the wave-2 MINOR filed 2026-09-19: git refusing a
    // REAL repo via its safe.directory check was led with "not a git repository" —
    // the lead contradicted git's own stderr. Watch the whole error-lead
    // honesty surface of the generator.
    id: 'commit-msg-error-honesty',
    weight: 2,
    origin: 'FLOCK wave-2 MINOR (commit-msg led with "not a git repository" on a safe.directory refusal) — regression watch on error-lead honesty',
    card: () => `You are a user trying this tool's commit-message generator in every wrong place you can think of.
Run: mkdir -p probe-notrepo && cd probe-notrepo && zagent commit-msg; echo EXIT:$?; cd .. — then mkdir -p probe-repo && cd probe-repo && git init -q . && zagent commit-msg; echo EXIT:$? — then GIT_TEST_ASSUME_DIFFERENT_OWNER=1 zagent commit-msg; echo EXIT:$? — and GIT_TEST_ASSUME_DIFFERENT_OWNER=1 zagent commit-msg --json; echo EXIT:$? (the env var is a prop that makes git refuse the repo as foreign-owned, like a checkout owned by another user).
RIGHT: outside a repo it plainly says not-a-git-repository; an unchanged real repo gets an honest "nothing to describe" style failure; the safe.directory refusal names the REAL problem and never claims "not a git repository"; every failure exits nonzero; --json failures emit a parseable JSON object carrying ok:false or an "error" field.
WRONG: an error lead contradicting git's own stderr (e.g. "not a git repository" while git complains about safe.directory), exit 0 on a failure, a stack trace, or human prose on stdout under --json — report each offender verbatim.
${RULES_BASE}`,
  },
  {
    // Regression card for the claude-lane finding filed 2026-09-19: the help's
    // `models [query|test …]` read as two keyword forms, but `models query
    // <term>` was refused with a bare usage line. Watch the whole class:
    // every form the help prints must actually run as shown.
    id: 'help-advertised-forms-run',
    weight: 3,
    origin: 'FLOCK claude-lane finding 2026-09-19 (models query <term> refused though --help advertised [query|test …]) + wave-4 T6 (-p --help --mode enum listed refused auto) — regression watch on help-vs-behavior honesty',
    card: () => `You are a new user who runs commands exactly as the help prints them — keywords, brackets removed, verbatim.
Run: zagent models --help; echo EXIT:$? — then try every form it lists: zagent models; echo EXIT:$?; zagent models glm; echo EXIT:$?; zagent models query glm; echo EXIT:$?; zagent models query; echo EXIT:$?; zagent models test; echo EXIT:$? — then open another command's help (zagent quota --help, zagent permissions --help) and run two of ITS advertised subcommand forms too.
Then: zagent -p --help — read the '--mode <…>' inline value list and try each value it prints (zagent -p "hi" --mode <value>; echo EXIT:$?). A sandbox without credentials answers with the sign-in/quota error AFTER accepting the mode — that is the parser accepting it.
RIGHT: a form spelled exactly as the help shows it either works or fails with an honest reason that still names the accepted forms; 'models query <term>' searches the catalog exactly like 'models <term>'; bare 'models query' with no term is a literal search for a model named 'query' (exit 1 "no model matching" when the catalog has none — intended, NOT a malformed-form refusal); malformed forms exit nonzero with a usage line that names the keyword form it accepts; a missing catalog/runtime message is an honest failure, not a bug. For --mode: every value inside the '<…>' enum is accepted by the parser (never 'must be one of'); 'auto' is NOT inside the enum — the modes legend explains it as reserved/unimplemented, and '--mode auto' refuses honestly naming the real choices.
WRONG: a verbatim-advertised form refused as unknown, a usage error that never mentions the keyword it actually accepts, exit 0 on a malformed command, human prose where the form asked for --json, a value printed inside the --mode '<…>' enum that the parser refuses, 'auto' presented inline as choosable, or a stack trace — report each offender separately.
${RULES_BASE}`,
  },
  {
    // Coverage rule (a): ships with the F14c follow-up — `zagent mode` is the
    // first user-facing surface for a PERSISTED default -p permission mode,
    // and -p now honors it when no --mode is passed.
    id: 'mode-default-verb',
    weight: 3,
    origin: 'new user-facing feature (persisted default mode verb + -p honoring it) — coverage rule (a) card shipped with the feature',
    card: () => `You are a user who runs headless prompts from scripts and heard this CLI can remember a default permission mode for them.
Run: zagent mode; zagent mode --json; zagent mode --help; zagent -p --help — and read how the yolo default and the precedence (an explicit --mode flag > the saved default > yolo) are explained. Then zagent mode set plan — on a machine with no ~/.zcode/cli/config.json it must refuse honestly; if so, create the file yourself (mkdir -p ~/.zcode/cli, write {} into config.json) and retry. Then zagent mode set bogus and zagent mode set auto (both must refuse, nonzero); zagent mode; zagent mode clear; zagent mode --json.
RIGHT: show reports the stored default or an honest "not set" state; set persists it (the next 'zagent mode' shows it and --json says {"defaultMode": ...}); bogus and reserved values are refused naming the real choices; clear removes it and --json reports {"defaultMode": null}; every failure exits nonzero with a human sentence; --json output stays parseable JSON. The copy must be honest that this default applies to -p runs without an explicit --mode and that interactive sessions keep their own per-project mode.
WRONG: a stack trace, exit 0 on a refused set or a failed write, a set the next 'zagent mode' cannot see, --json contradicting the human output, or copy claiming this changes the interactive /mode behavior — report the exact command and output.
${RULES_BASE}`,
  },
  {
    // Coverage rule (b): regression card for the wave-4 T1 fix — `usage stat`/
    // `st` and `quota reset use-five-hor` printed bare usage while sibling
    // surfaces already hinted did-you-mean.
    id: 'subcommand-typo-hints',
    weight: 2,
    origin: 'FLOCK wave-4 triage 2026-09-19 (T1: usage stat|st + quota reset use-five-hor no did-you-mean) — regression watch on typo-suggestion coverage',
    card: () => `You are a user with fast fingers who typos subcommands and expects the CLI to name what you meant.
Run: zagent usage stat; echo EXIT:$?; zagent usage st; echo EXIT:$?; zagent usage sttats; echo EXIT:$?; zagent usage nope; echo EXIT:$?; zagent quota stauts; echo EXIT:$?; zagent quota reset use-five-hor; echo EXIT:$?; zagent quota reset use-wek; echo EXIT:$?; zagent quota reset bogus; echo EXIT:$?; zagent usage stat --json; echo EXIT:$?
RIGHT: every near-miss of a real subcommand prints the usage line PLUS a "did you mean '…'?" naming the real form — 'usage stat'/'st'/'sttats' point at 'stats', 'quota stauts' at 'status', glued 'use-five-hor'/'use-wek' at the spaced 'use five-hour'/'use week'; 'usage nope' and 'quota reset bogus' are honest usage errors with NO suggestion (there is nothing near to name); under --json stdout stays a pure {"error"} envelope while the hint goes to stderr; every malformed form exits nonzero.
WRONG: an obvious typo getting a bare usage dump with no suggestion, a suggestion naming a wrong or unrelated command, a hint printed to stdout under --json, exit 0 on a malformed form, or a stack trace — report each offender separately.
${RULES_BASE}`,
  },
  {
    // Regression card for FLOCK wave-4 T7 (2026-09-19, PTY-verified): on a
    // no-model-access machine a submitted prompt echoed '> hi' and then the
    // screen sat byte-identical for 90s — no answer, no spinner, no error.
    // The kernel had answered instantly through a no-turnId `response` that
    // the slash-only print path dropped. Guards the class: a submitted turn
    // must always produce a VISIBLE outcome.
    id: 'pty-tui-no-access-turn',
    weight: 4,
    pty: true,
    origin: 'FLOCK wave-4 T7 (submitted TUI turn on no-model-access dead-screens ≥90s, PTY-verified) — regression watch',
    card: () => `You are a user on a machine with no working account who typed a prompt into the chat interface anyway.
Boot it under pty-drive.py with the fake-credential prop (not a real sign-in — this machine cannot reach a provider):  env ZAI_API_KEY=flock-test-000 zagent
Wait for boot, snap — a "No model access" line or a sign-in guide at boot is honest and correct, not a bug. Type a real prompt like "hi" and press enter. Snap ~1s in, again ~5s in, and again ~15s in.
RIGHT: submitting produces a VISIBLE outcome quickly — a printed reply/refusal naming the problem (e.g. telling you to sign in), or a clearly-visible activity state (a spinner or status word like "waiting") that then resolves to an honest error — all within ~15s. Your prompt's echo followed by an honest reply line is a PASS.
WRONG: the prompt echoes and then NOTHING changes for 15+ seconds — no reply, no spinner, no error, a byte-identical dead screen; or a raw stack trace painted as the answer — cite the dump lines that prove it.
${RULES_PTY}`,
  },
  {
    // Coverage rule (b): regression card for the wave-4 T2 fix — the
    // dispatcher's own refusals (unknown command/option) dropped the {"error"}
    // envelope every routed verb honors under --json.
    id: 'json-envelope-top-level-refusals',
    weight: 2,
    origin: 'FLOCK wave-4 triage 2026-09-19 (T2: top-level unknown command + --json → empty stdout) — regression watch on the dispatcher {"error"} envelope contract',
    card: () => `You are a script author who always passes --json and parses only stdout.
Run: zagent qouta --json; echo EXIT:$?; zagent sessoins --json; echo EXIT:$?; zagent --bogusopt --json; echo EXIT:$?; zagent --json --bogusopt; echo EXIT:$?; zagent qouta -- --json; echo EXIT:$?; zagent -- --json; echo EXIT:$?; zagent telegram --json; echo EXIT:$?; zagent quota statsu --json; echo EXIT:$?
RIGHT: every refusal under --json prints one {"error":"…"} object on stdout (valid JSON, nothing else) while the human message and any did-you-mean hint go to stderr, and the exit code stays nonzero — the flag counts in leading position too, so '--json --bogusopt' still envelopes; 'qouta -- --json' and '-- --json' are the exceptions — post-separator --json is payload, so stdout stays empty while stderr still names the refusal; 'quota statsu --json' shows the identical contract on a routed verb.
WRONG: an empty stdout on a --json refusal, the human error or hint leaking into stdout, malformed or multi-line JSON on stdout, exit 0 on an unknown command, or an envelope on the post-separator run — report each offender separately.
${RULES_BASE}`,
  },
  {
    // Regression card for FLOCK wave-4 T8 (2026-09-19, PTY-verified): at the
    // credential-less sign-in chooser, Esc did nothing and Esc+char inside
    // node:readline's escape window swallowed the char ('world' → 'orld').
    // Fixed: Esc (and the meta+char the parser merges Esc+char into) is the
    // chooser's cancel — quiet exit, same as decline. Guards the class: a
    // line-editor cancel affordance must exist and must never eat input.
    id: 'pty-signin-esc-cancel',
    weight: 2,
    pty: true,
    origin: 'FLOCK wave-4 T8 sign-in chooser Esc (Esc dead key + Esc+char eaten at the pick prompt, PTY-verified) — regression watch',
    card: () => `You are a new user at the sign-in chooser who reaches for Esc to back out — the universal cancel key.
Boot \`zagent\` bare under pty-drive.py on this credential-less machine: wait ~3s, snap the chooser, then press Esc (key esc) and snap — the program should exit cleanly. (If \`zagent\` boots straight into the TUI instead of the chooser, this machine is already signed in — record that and skip; it is not a finding.) Run a SECOND script that presses Esc and immediately types a word like "world" (send w, send o, ... one at a time, fast), snaps, and checks what the screen did with it. Run a THIRD that picks option 2 (send 2, key enter) to reach the key-paste prompt, then presses Esc there too.
RIGHT: Esc exits the chooser quietly — no stack, no hang, terminal left usable; a fast word typed after Esc is either fully ignored or fully kept, never missing its first letter; Esc at the key-paste prompt cancels the same way.
WRONG: Esc doing nothing (screen byte-identical before/after), a word losing its first character after Esc ("world" shown as "orld"), a hang needing SIGKILL, a stack trace, or the terminal left in a broken state — cite the dump lines that prove it.
${RULES_PTY}`,
  },
  {
    // Coverage rule (b): regression card for wave-4 T9 — a failed onboard
    // smoke turn printed a raw 160-char stderr tail (a mid-object slice like
    // 'e: false,\n  reason: undefined,…') instead of a classified cause.
    id: 'onboard-smoke-failure-classified',
    weight: 2,
    origin: 'FLOCK wave-4 triage 2026-09-19 (T9: onboard smoke-failure prints raw stderr tail) — regression watch on classified failure copy',
    card: () => `You are a brand-new user running \`zagent onboard\` to check your setup. Your credential cannot complete a turn — the point is HOW the failure is reported.
Run: ZAI_API_KEY=flock-test-000 zagent onboard; echo EXIT:$? — it may stop early at a credential check; that is fine. To force it through to the live smoke turn on a credential-less machine, stage a fake sign-in store first — ONLY if ~/.zcode/v2/credentials.json does not already exist (never overwrite or delete a real sign-in store): mkdir -p ~/.zcode/v2 && printf '{"oauth:zai:access_token":"flock-fake"}' > ~/.zcode/v2/credentials.json, then run the same onboard command again (the smoke turn WILL fail — judge the failure copy). Afterwards clean up only the file you created: rm -f ~/.zcode/v2/credentials.json.
RIGHT: onboard exits nonzero and every failure is EXPLAINED in human terms — the credential check names the problem (sign-in vs quota), and a failed smoke turn names a classified cause (a provider code like 1308 with its reset, the error sentence the tool itself reported, a stall/timeout stop reason, or a wrong-answer note), never raw internals.
WRONG: a failed smoke turn answered by a raw stderr tail — a mid-line slice of a stack trace, a dumped object fragment (like 'reason: undefined,' or 'e: false,'), truncated JSON, or 'at …' stack frames — or exit 0 on a failed turn. Cite the exact output lines.
${RULES_BASE}`,
  },
  {
    // Coverage rule (b): regression card for wave-4 T10 — doctor's 'staging
    // locked' line read like a failure ('cannot write here') and named no
    // severity or remedy; a locked staging dir is the intended guarded state.
    id: 'snapshot-lock-line-honesty',
    weight: 2,
    origin: 'FLOCK wave-4 triage 2026-09-19 (T10: doctor staging-locked line names no severity/remedy) — regression watch on state-line honesty',
    card: () => `You are a user auditing what zagent's doctor says about the desktop app's workspace-upload staging dir.
Run: zagent snapshot status; echo EXIT:$? — then stage a foreign file at the staging path: mkdir -p ~/.zcode/v2 && printf x > ~/.zcode/v2/checkpoints && zagent snapshot status; echo EXIT:$?; zagent snapshot lock; echo EXIT:$? — then clear it and lock for real: rm ~/.zcode/v2/checkpoints; zagent snapshot lock; echo EXIT:$?; zagent snapshot status; echo EXIT:$?; zagent doctor; echo EXIT:$? (doctor may exit nonzero on this credential-less machine — judge the snapshot line's copy, not the exit code).
RIGHT: with a plain file at the staging path, status says the path is held by a non-directory entry and names MANUAL removal as the remedy (never 'zagent snapshot unlock' — the tool refuses foreign files); after a real 'snapshot lock', the status/doctor line says the staging dir is locked and that this DISABLES the desktop workspace upload — reading as an intentional, healthy state that names how to undo it ('zagent snapshot unlock'). Other states are honest too: staged payloads are called out with the 'snapshot lock' remedy, and an absent/empty dir says upload is unlocked and names 'snapshot lock' to disable it.
WRONG: the locked line sounding like an error or something broken (e.g. 'cannot write here' with no sign this is on purpose), naming no way to undo it, treating the healthy locked state as a problem, a foreign file at the path being prescribed the 'unlock' remedy the tool itself refuses, or a stack trace — report each offender separately.
${RULES_BASE}`,
  },
  {
    // Coverage rule (b): regression card for wave-4 T5 — on a credential-free
    // machine the quota verbs disagreed: balance/preview/reset printed 'No
    // ZCode credentials; run zagent login…' while status/usage named the
    // failure class ('a sign-in problem, not a quota limit'). The verbs must
    // agree on the classified copy; the desktop-JWT verbs must not prescribe
    // ZAI_API_KEY, which cannot feed that path.
    id: 'quota-nocred-class-agreement',
    weight: 2,
    origin: 'FLOCK wave-4 triage 2026-09-19 (T5: quota verbs disagree on the no-credential message) — regression watch on classified failure copy',
    card: () => `You are a user on a machine that has never signed in, checking quota. The point is whether EVERY quota verb reports the same kind of problem the same way.
Run each of these and capture stdout, stderr, and the exit code: zagent quota; zagent quota status; zagent quota usage; zagent quota balance; zagent quota preview; zagent quota reset; zagent quota reset claim; zagent quota reset use five-hour --yes; then repeat 'zagent quota balance --json' and 'zagent quota reset --json'.
RIGHT: every one exits nonzero, names a SIGN-IN problem (not a quota-window problem), and names a working remedy — 'zagent login' on every verb, with ZAI_API_KEY mentioned only by the verbs that can actually use it (status/usage); under --json stdout carries a parseable {"error": …, "class": "auth"} object while the human line stays on stderr; no verb leaks a raw ENOENT/'no such file' or a stack trace.
WRONG: verbs disagreeing on the problem class (one says 'credentials', another says 'Coding Plan key' with no shared sign-in framing), a desktop-credential verb (balance/preview/reset) telling the user to set ZAI_API_KEY (it cannot help that path), a raw filesystem error or stack, or exit 0 — cite the exact lines per verb.
${RULES_BASE}`,
  },
];
