// Scenario cards for the opencode real-user flock.
//
// Each card turns a free opencode agent into ONE kind of real human user on a
// fresh machine with NO credential. The honesty contract is spelled out: on a
// machine without a sign-in, the RIGHT behavior is a fast, human-readable
// refusal or guidance — a stack trace, a hang, a silent exit 0, or fabricated
// data is a BUG the agent must report. Agents never see a credential, so the
// free third-party model is never exposed to one (v2 adds a proxy-isolated
// signed-in class for live turns).

const RULES = `
RULES (obey exactly):
- This sandbox IS your whole machine. Work only inside the current directory and $HOME. Never read files outside them, never use sudo, never print environment variables.
- zagent is installed and on PATH. The machine has NO zagent account and NO API key — that is the scenario, do not try to sign up.
- Act like a real human user trying to get things done: run the commands a person would run, read what appears, poke a little. Do not read zagent's source code (it is not on this machine anyway).
- A crash (stack trace / node internals), a hang beyond ~30s on a no-credential command, a silent exit 0 where an error belongs, or made-up numbers are BUGS.
- Finish with EXACTLY one line at the end of your reply:
  FLOCK-VERDICT: OK
  or, one line PER problem:
  FLOCK-FINDING: <short title> | CMD: <the exact command> | EXPECTED: <what a good CLI would do> | GOT: <what actually happened, verbatim key part>`;

const PERSONA = (name, situation) =>
  `You are ${name}, ${situation} You are curious but not destructive.`;

export const SCENARIOS = [
  {
    id: 'fresh-install-first-look',
    weight: 5,
    card: () => `${PERSONA('a developer who just heard about zagent', 'on a brand-new machine.')}
You installed zagent a minute ago. Figure out: what is this tool, what version, and how do you get started? Try at least: zagent --version, zagent --help, zagent --help for one subcommand that interests you.
Judge like a first-time user: is it obvious what to do first? Missing/cut-off help text, wrong version, or anything that looks broken counts.
${RULES}`,
  },
  {
    id: 'no-account-first-turn',
    weight: 5,
    card: () => `${PERSONA('an impatient new user', 'who has not signed in anywhere.')}
You just try to use it immediately: zagent -p "hello, are you there?" — then with --json as well.
The RIGHT behavior on a machine with no credential: a fast, clear sign-in message (how to get a key / sign in) and a non-zero exit. WRONG: crash, hang, empty output, or a fake successful answer.
${RULES}`,
  },
  {
    id: 'doctor-journey',
    weight: 4,
    card: () => `${PERSONA('a careful user', 'who reads diagnostics before using a new tool.')}
Run: zagent doctor. Read it. Then try zagent doctor --fix even though you have no key (a real user might). Then zagent doctor --capabilities if it exists.
The RIGHT behavior: doctor explains the missing credential and how to fix it; --fix without a key does NOT pretend to fix anything or write a broken config; no stack traces.
${RULES}`,
  },
  {
    id: 'typo-fuzzer',
    weight: 5,
    card: () => `${PERSONA('a sloppy typist', 'who types fast and makes mistakes.')}
Try at least 6 of these (or similar typos you invent): zagent --versoin, zagent -vv, zagent quota --dayss 1, zagent -p (prompt flag with no value), zagent bogus-subcommand, zagent -p hi --efort low, zagent --json -p. (Note: -V/-v are deliberate aliases of --version and exit 0 — that is correct, not a bug; -vv is fair game.)
Every one should produce a SHORT, helpful usage/error message and a non-zero exit. A raw stack trace, a hang, or exit 0 with nothing done is a BUG. Also flag error messages that are actively misleading (pointing you to a fix that cannot work).
${RULES}`,
  },
  {
    id: 'model-id-copy-paste',
    weight: 5,
    card: () => `${PERSONA('a user who picks a model from a menu', 'and copies ids exactly as shown.')}
Run zagent models (or zagent models --help) to see what model ids look like. Then try the tool with the ids EXACTLY as printed, including any uppercase spelling, e.g.: zagent -p "hi" --model <id-from-the-list> for two or three different ids (mix uppercase and lowercase spellings if both appear).
On this no-credential machine the RIGHT result for every id is the same clear sign-in refusal — never a hang, crash, or a DIFFERENT confusing error depending on letter case.
${RULES}`,
  },
  {
    id: 'effort-flag-matrix',
    weight: 3,
    card: () => `${PERSONA('a power user', 'tuning generation effort.')}
Try: zagent -p "hi" --effort low, then --effort high, then --effort medium (does the tool accept it?), then --effort turbo (made-up value).
Right: consistent, fast sign-in refusal (no credential) or a clear "unsupported effort" message; WRONG: case-sensitive surprises (LOW vs low behaving differently), hangs, crashes.
${RULES}`,
  },
  {
    id: 'quota-before-login',
    weight: 4,
    card: () => `${PERSONA('a frugal user', 'who checks usage before spending anything.')}
Try: zagent quota, zagent quota --json, zagent quota usage, zagent quota usage --days 1 --json.
On a machine with no credential the RIGHT behavior is a clear "no key configured" style refusal — the tool must NOT invent numbers, show 0% used as if it queried something, or crash. Judge the --json ones extra hard: valid JSON claiming success would be a lie.
${RULES}`,
  },
  {
    id: 'cjk-new-user',
    weight: 3,
    card: () => `${PERSONA('一个中文用户', '刚装好工具，还没注册。')}
试试：zagent -p "你好，请帮我数到三"，再看 zagent --help 的可读性，然后用中文 prompt 加 --json 试一次。
正确行为：无凭据机器上快速给出清楚的登录/注册指引（语言不限），不崩溃、不挂起、不返回空成功。help 里把中文用户会误解的表述也记下来。
${RULES}`,
  },
  {
    id: 'stdin-paste-safety',
    weight: 3,
    card: () => `${PERSONA('a user with a big clipboard', 'who pastes before thinking.')}
Create a file with 300 lines of text (e.g. seq 1 300 > big.txt). Then: cat big.txt | zagent -p "summarize this" — and also try zagent -p "$(head -c 5000 /dev/urandom | base64)" if you like.
On a no-credential machine the tool must refuse FAST regardless of input size — it must not hang eating the paste, not crash on weird bytes, not exit 0 silently.
${RULES}`,
  },
  {
    id: 'tui-no-tty-smoke',
    weight: 4,
    card: () => `${PERSONA('a scripter', 'who runs tools inside pipes and cron.')}
Try: zagent < /dev/null (stdin closed immediately), then printf '/help\\n/quit\\n' | timeout 15 zagent, then echo hi | timeout 15 zagent.
A terminal UI tool must handle missing/pipe stdin gracefully: exit cleanly and quickly, print something honest (or nothing), never spin forever and never dump a stack trace. Report exactly what happened including how long each ran.
${RULES}`,
  },
  {
    id: 'json-envelope-honesty',
    weight: 4,
    card: () => `${PERSONA('an automation engineer', 'who pipes zagent output into jq.')}
Try: zagent -p "hi" --json | jq . and zagent -p "hi" --json 2>/dev/null; echo "exit=$?"; also try piping the error output into jq.
Contract: on failure the tool must NOT emit a well-formed envelope that LOOKS like success (a jq user would script against it and get burned). An honest non-zero exit + human-readable error, or a JSON error object clearly marked as an error, is right. Crash output that jq chokes on while exit code is 0 would be a BUG.
${RULES}`,
  },
  {
    id: 'surface-walkthrough',
    weight: 3,
    card: () => `${PERSONA('an evaluator', 'comparing agent CLIs this afternoon.')}
Walk the command surface: zagent --help, then --help for each subcommand that exists (e.g. onboard, login, logout, quota, models, update, doctor — whatever --help lists). Run the two most interesting read-only ones.
Judge: any subcommand whose help is missing, contradicts the main help, or crashes on a no-credential machine is a finding. Also flag help entries for commands that do not exist.
${RULES}`,
  },
  {
    id: 'arg-weirdness',
    weight: 4,
    card: () => `${PERSONA('a shell veteran', 'who writes long one-liners.')}
Try edge shapes: zagent -p "" (empty prompt), zagent -p hi --json extra-arg, zagent -p hi -- --json (does -- still work as separator?), zagent --json -p hi (flags before prompt), a -p with a 10_000-char prompt from a file.
Right: predictable parse errors or the same sign-in refusal as normal — never "sometimes works depending on flag order" surprises beyond documented ones, never crashes.
${RULES}`,
  },
  {
    id: 'concurrent-smoke',
    weight: 2,
    card: () => `${PERSONA('an impatient multitasker', 'with three terminals open.')}
Open three quick reads at once, e.g.: zagent doctor & zagent --version & zagent quota; wait. Run it twice with different mixes.
Any lock errors, interleaved garbled output from the tool itself, or crashes when run concurrently = findings. (Terminal echo mixing from the shell itself is not a bug.)
${RULES}`,
  },
];

// FLOCK-V2-SIGNIN: signed-in cards. They run ONLY under `--signin` — the
// harness seeds a broker-backed placeholder credential (the dotted
// 'flock-dummy.<hex>' literal, worthless upstream) pointing at the in-wall inner
// listener 127.0.0.1:3129, whose host end injects the real coding-plan key.
// The agent never sees a live credential by construction. Turns spend real
// quota, so cards keep prompts tiny and few.
const SIGNIN_RULES = `
RULES (obey exactly):
- This sandbox IS your whole machine. Work only inside the current directory and $HOME. Never read files outside them, never use sudo, never print environment variables.
- zagent is installed, on PATH, and IS signed in via a managed credential proxy — \`zagent -p "..."\` runs REAL inference that spends real quota, so keep every prompt tiny (a few words) and run at most 2 real turns. The placeholder key and 127.0.0.1 address visible in ~/.zcode config are the sandbox design, NOT a bug — do not report them, and never try to change or "fix" the credential.
- Act like a real signed-in user: run the commands a person would run, read what appears, poke a little. Do not read zagent's source code (it is not on this machine anyway).
- A crash (stack trace / node internals), a hang beyond ~60s, a refusal despite sign-in, a fake/stock answer with no real turn behind it, or the placeholder key appearing in output as if it were a live credential are BUGS.
- KNOWN WIRING LIMIT — not a finding: quota/usage verbs may refuse inside this sandbox even though turns work.
- Finish with EXACTLY one line at the end of your reply:
  FLOCK-VERDICT: OK
  or, one line PER problem:
  FLOCK-FINDING: <short title> | CMD: <the exact command> | EXPECTED: <what a good CLI would do> | GOT: <what actually happened, verbatim key part>`;

export const SIGNIN_SCENARIOS = [
  {
    id: 'signin-first-turn',
    weight: 5,
    signin: true,
    card: () => `${PERSONA('a signed-in user', 'on a machine where zagent was configured days ago.')}
Run 1-2 tiny real turns: zagent -p "reply with exactly: pong" — then once with --json. Verify the answer is REAL: the --json envelope should carry sessionId and usage with nonzero token counts.
Also try the read-only surfaces a signed-in user touches: zagent models, zagent doctor.
${SIGNIN_RULES}`,
  },
  {
    id: 'signin-surfaces-walk',
    weight: 3,
    signin: true,
    card: () => `${PERSONA('a signed-in evaluator', 'checking what a configured install exposes.')}
Walk the signed-in surfaces WITHOUT spending turns: zagent models, zagent models --help, zagent permissions, zagent sessions, zagent doctor. Then ONE tiny real turn: zagent -p "say ok" --json.
Judge like a paying user: surfaces must show real state (not fabricated), errors must be honest, nothing crashes or hangs.
${SIGNIN_RULES}`,
  },
];

// Signed-in PTY rules: the same managed-proxy contract as SIGNIN_RULES plus
// the pty-drive + SCREEN-cite discipline from the unsigned pty pool. Bare
// `zagent` under the driver boots the REAL signed-in TUI (the sandbox env is
// pre-wired — no prop env vars needed) and its turns are REAL: real tokens,
// real tool calls, real quota. Rate-limit retries in the status line are
// environmental evidence, never a finding.
const SIGNIN_RULES_PTY = `
RULES (obey exactly):
- This sandbox IS your whole machine. Work only inside the current directory and $HOME. Never read files outside them, never use sudo, never print environment variables.
- zagent is installed, on PATH, and IS signed in via a managed credential proxy — every submitted turn runs REAL inference that spends real quota, so keep every prompt tiny (a few words) and submit at most 2 turns total across all runs.
- A file pty-drive.py sits in the current directory. It runs a command inside a REAL terminal (a pty) and writes screen snapshots. Write a script file — one action per line:
    wait <ms> | send <text> | key enter|esc|tab|backspace|delete|ctrl-c|ctrl-d|up|down|left|right|home|end|shift-tab | snap <label> | expect <regex> [ms] | resize <cols>x<rows>
  then run it:  python3 pty-drive.py <scriptfile> <dumpdir> -- zagent
  'send' writes literal text; 'snap' saves the rendered screen to <dumpdir>/NN-<label>.txt; 'expect' waits for text on screen; 'resize' is a window drag.
- The placeholder key and 127.0.0.1 addresses visible in ~/.zcode config are the sandbox design, NOT a bug — do not report them, and never try to change or "fix" the credential. The env vars already in your shell that point the tool at the proxy are part of that design too.
- Turns may show a live status line (elapsed, retries, context). Retries and 429 rate-limit notices are environmental — NOT findings; wait for the turn to settle (~60s is fine).
- Afterwards READ the dump .txt files and judge exactly what a person would see: the turn must visibly start (activity/status), the reply must be the model's real answer (not a canned string), tool calls must render as readable rows with their results, and quitting must leave a usable terminal.
- A crash (stack trace / node internals painted on screen), a hang beyond ~90s, a dead screen that never reacts, a refusal despite sign-in, or garbled/overlapping rows are BUGS.
- Finish with EXACTLY one line at the end:
  FLOCK-VERDICT: OK
  or, one line PER problem:
  FLOCK-FINDING: <short title> | SCREEN: <the verbatim line from a dump .txt that proves it> | EXPECTED: <what a human expects> | GOT: <what the screen showed>`;

export const SIGNIN_PTY_SCENARIOS = [
  {
    // FLOCK-PTY wave-3 signed-in leg: the REAL turn display — spinner/status,
    // streamed answer, context meter — is only reachable when a real provider
    // turn succeeds, which unsigned pty cards can never do inside the wall.
    // Proven by execution before this card landed:
    // a seeded sandbox TUI completed `⏺ pong` through the TLS broker.
    id: 'signin-pty-first-turn',
    weight: 3,
    signin: true,
    pty: true,
    card: () => `${PERSONA('a signed-in user', 'who wants to watch the interface actually work.')}
Drive the signed-in TUI under pty-drive.py (plain \`zagent\` — sign-in is already wired, do not set any env vars yourself). Script: wait ~8s for boot, snap; send "reply with exactly: pong" and press enter; snap right after submit (did anything visibly start?), then expect the answer on screen (expect pong 60000) or wait and snap until it settles; snap the resting screen — look for the answer row AND any live status line (elapsed, context meter). Then quit cleanly (ctrl-c twice, /exit, or ctrl-d) and snap the returned shell.
RIGHT: the TUI boots into a readable signed-in home (an account/model status line is expected); submitting visibly starts work; the real answer 'pong' lands as a normal reply row; a status line showing elapsed/context is healthy; quit leaves a usable shell.
WRONG: the TUI booting to "No model access" or a sign-in wall (that means the sandbox wiring failed — report it), no visible activity after enter, the answer never landing within ~90s, a raw stack trace as the reply, a wedged screen after exit — cite the dump line that shows it.
${SIGNIN_RULES_PTY}`,
  },
  {
    // FLOCK-PTY wave-3 signed-in leg: TOOL-CALL display — the ⏺ Bash(...) row
    // + ⎿ result + duration is the parity surface the unsigned pool could
    // only fake. Proven by execution: `⏺ Bash(echo flockwave3) 47ms` +
    // `⎿ flockwave3` rendered through the TLS broker.
    id: 'signin-pty-tool-call-row',
    weight: 3,
    signin: true,
    pty: true,
    card: () => `${PERSONA('a signed-in user', 'watching how the interface shows real tool calls.')}
Drive the signed-in TUI under pty-drive.py (plain \`zagent\` — sign-in is pre-wired, set no env vars). Script: wait ~8s for boot, snap; send EXACTLY this prompt: run the bash command: echo flockwave3 — then press enter. Snap right after submit; then watch the turn (expect flockwave3[\\s\\S]+flockwave3[\\s\\S]+flockwave3 90000 — the word must appear THREE times: echoed prompt, tool row, result output — twice alone can be echo+tool-row before the result paints — or wait+snap): you are looking for a tool-call row (something like "Bash(echo flockwave3)" with a duration) and its result output rendered under it. Snap mid-turn at least once — a live status line with elapsed time, maybe retry counts, maybe a context meter, is healthy. When the turn settles snap the final screen. Then quit cleanly and snap the shell.
RIGHT: the tool call renders as a readable row naming the command; its output appears (the word flockwave3 must be visible); a permission prompt, if one appears, is a real surface — approve it (press enter on the allow choice) and continue; the turn ends and the input box works again.
WRONG: the tool row garbled/overlapped, the command output never shown after the turn settles, a permission prompt with no way to answer it, the screen dead for >90s, or a stack trace — cite the dump line that shows it.
${SIGNIN_RULES_PTY}`,
  },
  {
    // FLOCK-PTY wave-3 signed-in leg: fold/expand on REAL turn output. The
    // unsigned pool could only exercise the selection peek — real foldable
    // 'tool'/'thinking' entries need a live provider turn, which the TLS
    // broker now reaches. Keys verified against
    // packages/tui: shift-up/down select a user turn, j/k walk that turn's
    // foldables (peek tag 'fold x/y <name>'), o toggles the pick, h/l fold
    // all, esc drops the selection. j/k/o/h/l are gated on an empty input
    // box (shift-up/down and esc are not).
    // Transcript truth the card must teach: the writer is
    // APPEND-ONLY — collapsing a block whose body already printed cannot
    // un-print it (it silently retires), while expanding a born-collapsed
    // block (thinking) APPENDS its body at the tail. The visible gold
    // signals are the honest fold x/y tag counting the real blocks and an
    // expanded-thinking body landing; "collapse did not erase my output"
    // is correct-by-design, never a finding.
    id: 'signin-pty-fold-expand',
    weight: 3,
    signin: true,
    pty: true,
    card: () => `${PERSONA('a signed-in user', 'trying the transcript fold keys on a real finished turn.')}
Drive the signed-in TUI under pty-drive.py (plain \`zagent\` — sign-in is pre-wired, set no env vars). Script: wait ~8s for boot, snap. Send EXACTLY this prompt: run the bash command: echo flockwave3 — press enter, then let the turn fully settle (expect flockwave3[\\s\\S]+flockwave3[\\s\\S]+flockwave3 90000 — THREE times: echoed prompt, tool row, result output — or wait+snap); a permission prompt, if one appears, gets an enter on the allow choice. Snap the settled screen: a real tool row (like "Bash(echo flockwave3)") plus its result output must be visible.

Now the fold layer on that REAL turn, input box EMPTY. Send the bytes for shift-up (send \\e[1;2A), snap — a peek/selection row naming your prompt should appear near the input with a "fold x/y <name>" tag (the tag may count a thinking block plus the tool block — both are real foldables). Press j then k, snap after each — the tag's pick should move (fold 1/2 <-> fold 2/2) when more than one foldable exists. Walk the pick onto the tool block if it is not already picked, then press o and snap — READ what happened honestly: this transcript is APPEND-ONLY, so folding a block whose output already printed does NOT erase the printed lines and prints nothing new — the block is just marked folded (a "… +N lines" note belongs to a block that was ALREADY folded when it first printed, like thinking — it is not produced by your keypress). That is CORRECT, never a finding. If a thinking block exists it starts folded: pick it and press o — its reasoning body should now APPEND below the transcript tail; snap. Press h (fold all in the turn) then l (expand all), snap after each — again, folded-after-print stays printed, and expanding a still-folded block appends its body. Press esc, snap — the selection/peek row must drop. Type a normal sentence, snap — the letters must land in the input box (j/k/o must not have been eaten). Then quit cleanly (ctrl-c twice, /exit, or ctrl-d once the input is empty) and snap the shell.
RIGHT: shift-up visibly selects your submitted turn (peek row or highlight); the fold tag exists and counts/names the REAL blocks honestly (e.g. fold 2/2 Bash); j/k move the pick; expanding a folded block prints its body at the tail; folding never corrupts or duplicates rows; esc clears the selection; letters type normally afterwards.
WRONG: no peek/fold tag on a turn that plainly has a tool block, a fold x/y count that lies about the real blocks, j/k doing nothing with 2+ foldables, an expand that never prints the hidden body, any fold key garbling/duplicating rows, selection surviving esc, letters eaten after esc — cite the dump line that shows it.
${SIGNIN_RULES_PTY}`,
  },
  {
    // FLOCK-PTY wave-3 signed-in leg: streamed-partial-output-before-completion.
    // The unsigned pool can never reach this — only a real provider turn
    // produces a stream, so it rides the signin leg. The fake-host journey
    // oracle (packages/tui/test-journeys.mjs 'a streamed answer is visible
    // mid-turn, not only at the end') proves the mechanism renders; this card
    // judges the REAL-TUI end of it. Anchored expect is load-bearing: the
    // submitted prompt echoes into the transcript as a '> ...' line, so a
    // bare `expect DONE` matches the agent's OWN echoed prompt instantly and
    // lies about completion — `expect ^\s*DONE[.!?]?\s*$` anchors at line start,
    // tolerates the two-cell indent the renderer gives answer lines, and allows
    // trailing punctuation (the echo starts with `>` and can never match).
    id: 'signin-pty-streaming',
    weight: 3,
    signin: true,
    pty: true,
    card: () => `${PERSONA('a signed-in user', 'watching whether the answer types out live or dumps at the end.')}
Drive the signed-in TUI under pty-drive.py (plain \`zagent\` — sign-in is pre-wired, set no env vars). This card judges ONE thing: does the answer paint PROGRESSIVELY while the turn runs, or does the screen sit empty and the whole answer dump in one frame at the end (the historical dead-screen defect)?
Script: wait ~8s for boot, snap; send EXACTLY this prompt: count from 1 to 60, one number per line, then a last line that says DONE — then key enter. Snap RIGHT after submit, then run the wait+snap loop FIRST — the mid-turn snaps ARE the measurement (spacing like 800ms, 1200ms, 2000ms — aim for ~3-5 mid-turn snaps); do NOT put expect before the loop, it blocks the driver and you would get zero mid-turn snaps. Only after the loop settle to the end: expect ^\\s*DONE[.!?]?\\s*$ 90000 — anchored, whitespace-tolerant, and punctuation-tolerant because the answer's last line lands indented on screen and may end \`DONE.\` while your echoed prompt sits in a '> ...' line that starts with '>' and can never match; the fallback end signal is the status line going idle — the busy spinner row replaced by the \`>> <mode> · <model>\` line and the \`enter send · alt+enter newline\` hint. Snap the settled screen, then quit cleanly (ctrl-c twice, /exit, or ctrl-d) and snap the returned shell.
Phases: 'waiting' in the status line with no MODEL output yet is NORMAL — the provider has not started, never a finding (your own \`> …\` echo line is YOUR text, not the model's). Once a snap shows 'responding' (or a live spinner/elapsed/received-bytes counter advancing), the turn is live — but answer text is not owed yet: on a reasoning model a growing thinking/reasoning block or a tool row may be the only paint for many snaps, and that still proves the paint path is alive. A mid snap showing numbers 1-23 but not 60 is streaming working exactly right. The phase word may be localized — judge the semantics, not the literal string.
RIGHT: at least one mid-turn snap shows PARTIAL answer text while the turn is still active; the visible answer grows across snaps; the settled snap shows the list ending correctly (…, 59, 60, then the DONE line — earlier rows scrolled off the viewport is normal, not missing output).
WRONG (the defect): snap after snap shows an ACTIVE status (responding/advancing counters) with NO transcript growth of any kind — no answer text, no growing thinking block, no tool row — then the complete answer appears in a single frame at the end. Sharp discriminator: if the received-bytes counter climbed gradually while nothing painted, deltas were dropped — the defect; if it jumped once when the answer arrived, the provider batched — inconclusive, not a finding. Also wrong: the answer never lands within ~90s, rows garbling/overlapping as text grows, or a stack trace — cite the dump line that shows it.
INCONCLUSIVE is a valid outcome: if EVERY mid snap already shows the finished answer, the provider outran your snap rhythm — say so in prose and still end with FLOCK-VERDICT: OK. The batched-bytes case above is inconclusive too. You may retry ONCE with the prompt: count from 1 to 150, one number per line, then a last line that says DONE — the 2-turn cap already counts this retry, do not exceed it.
${SIGNIN_RULES_PTY}`,
  },
];

export function pickScenario(rng, recentIds = [], scenarios = SCENARIOS) {
  // Weighted pick over the GIVEN pool (base, or base + living extras) that
  // avoids repeating the last few scenarios a worker ran.
  const pool = scenarios.filter((s) => !recentIds.includes(s.id));
  const candidates = pool.length ? pool : scenarios;
  const total = candidates.reduce((a, s) => a + s.weight, 0);
  let r = rng() * total;
  for (const s of candidates) { r -= s.weight; if (r <= 0) return s; }
  return candidates[candidates.length - 1];
}
