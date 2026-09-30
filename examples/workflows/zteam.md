# zagent + Claude Code team workflow

Install the reusable user-level roles with `node scripts/setup-zteam.mjs --apply`.
Existing differing definitions are never overwritten. Start a fresh CLI session
after installation. This installs roles only; it does not alter main models,
enable free billing, or start an unattended queue.

For complex work, use GLM-5.3 as the zagent leader; this installer leaves the
existing main-model setting unchanged. `zteam-build`, `zteam-test`, and
`zteam-verify` use Flash explicitly in zagent; `zteam-review` uses GLM-5.3.
In Claude Code (routed to GLM), all roles default to `inherit`: the leader remains GLM-5.3 and decides
per delegation whether to use the full model or Flash. The leader can explicitly
select `sonnet` for Flash or `opus` for GLM-5.3 through a Claude Code setup that maps those aliases to GLM models.
Do not force every subagent onto Flash. Outside such a setup those aliases may route to
different models.
`model.lite` alone is not proof of subagent model selection.

Paste this workflow into the leader session along with a concrete objective:

> Work as a coordinated team. In Claude Code keep the main model GLM-5.3; choose
> each subagent model based on task difficulty, allowing Flash for suitable work. First inspect repository status and define the
> objective, owned files, and acceptance commands. Dispatch zteam-build and
> zteam-test with separate file scope; let them work in parallel where the
> dependency graph permits. After their changes are complete, dispatch
> zteam-review on the final diff and zteam-verify on the acceptance commands.
> Resolve findings, then repeat only the affected review and verification.
> The leader owns integration and completion. Use sufficient context and
> reasoning to complete the work; optimize useful throughput, not token savings.
> Keep a concrete backlog and advance to its next authorized item when the
> current item passes. Do not duplicate work or generate filler. Do not publish
> or deploy without authorization. Report tested files/commit, evidence and
> remaining blockers. Worker claims alone are not acceptance evidence.

Dedicated idle-time tasks must use the provider's ticket-backed channel. Their
execution model may be server-assigned: explicit role model configuration does
not establish actual free-channel model choice or entitlement. Foreground
subagents are supported in the documented free idle channel; background agents
are not. Manual follow-up messages use ordinary plan quota. Ordinary `zagent -p`
and `claude -p` invocations are not dedicated-idle jobs just because the clock is
inside a promotional window.

Sources: https://zcode.z.ai/en/docs/subagents and
https://zcode.z.ai/en/docs/idle-time-tasks (checked 2026-09-10).
