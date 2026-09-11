---
name: using-zagent
description: Use when installing, diagnosing, or driving zagent (za) — the unofficial terminal client for an already-installed ZCode desktop runtime. Applies when choosing zagent vs ZCode GUI vs ccz, when doctor/inspect fail, when Coding Plan quota is involved, or when an agent needs the TUI, headless -p, import, hooks, or grants.
---

# Using zagent

zagent is **not** ZCode and **not** 0.1. It is the missing `@zcode/tui` plus CLI around a **separately installed** official ZCode kernel (`/opt/ZCode` or equivalent). Same `~/.zcode` store as the GUI.

## Know you are on zagent

| Signal | Meaning |
|---|---|
| `zagent --version` / `za --version` | npm package version (0.0.xx). **0.1.x is owner-only — do not ship it.** |
| `zagent doctor` | runtime path, key, degraded posture |
| `zagent inspect [--json]` | merged config, skills, tasks, plugins, wiki (read-only) |
| Binary names `zagent` and `za` | same entry; internal files still say `zmax` |
| `zagent@0.1.0` on npm | **deprecated mistake** — use latest 0.0.xx |

Need the official GUI for ADE panes (browser/PDF/Office preview, CUA, workflow **panel**). zagent will not grow those.

## Best use

1. Install runtime first, then `npm i -g zagent`. Coding Plan JWT — not a generic GLM API key.
2. `zagent doctor` then `zagent onboard` on a new machine.
3. Interactive: `zagent` in a repo (append-only TUI, no alt-screen). `$skill` `#conversation` `@file` `/slash`.
4. Headless: `zagent -p "…" [--json]`. Retry-on-envelope is the product path.
5. `zagent import --dry-run` then `--apply` to pull Claude `CLAUDE.md` / commands / skills. Project `.claude/commands` stay in the project.
6. `zagent hooks list` — official **seven** events only; it does not run hooks.
7. Always/Never grants persist in `~/.zcode/cli/grants.json` (0600). Bash is exact-command, never glob.
8. Idle/off-peak: window/eligibility only. **Do not claim free inference** (live 3001 still unverified).
9. Task **create** is GUI-only. CLI can list/pin/archive/rename/delete existing rows.

## Do not

- Publish or tag **0.1.x** (owner-only).
- Point zagent at a missing kernel and call it working.
- Treat `zcode-app-cli` / `ccz` as this package.
- Run source-only bots (`feishu`/`wechat`/`telegram`/`compact` daemon) from the npm tarball — they are not shipped.

`$using-zagent` is bundled in the install. User `~/.zcode/skills/using-zagent` overrides it.
