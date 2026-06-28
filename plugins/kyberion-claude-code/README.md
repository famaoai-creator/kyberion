# kyberion-claude-code

A **real Claude Code plugin** that makes Claude Code a governed Kyberion front-end. Unlike `plugins/kyberion/` (the Cowork MCP connector, custom manifest), this plugin installs into Claude Code directly and bridges Claude Code's **native tool lifecycle** into Kyberion governance.

## What it adds

| Surface | Mechanism | Effect |
|---|---|---|
| **Tier-guard on writes** | `PreToolUse` hook (Write/Edit/MultiEdit/NotebookEdit) | Denies writes that leak a higher knowledge tier — the CLAUDE.md §1 invariant, now **enforced**, not just documented. Fails open on hook error. |
| **Unified audit trail** | `PostToolUse` hook (Write/Edit/Bash) | Records Claude-Code-initiated actions into Kyberion's audit chain → visible to Chronos / the feedback loop like any Kyberion action. |
| **Operating-guide priming** | `SessionStart` hook | Injects the governance status + lifecycle reminder. |
| **Prompt capture** | `UserPromptSubmit` hook | Captures the initial user prompt as a shared coordination signal and suggests the next Kyberion step. |
| **Session close** | `Stop` hook | Emits a review reminder so the session ends with an explicit handoff. |
| **MCP tool surface** | `.mcp.json` → `kyberion` stdio server | The ~15 governed `kyberion.*` tools (pipeline/mission/knowledge/approval/audit). |
| **Lifecycle commands** | `commands/` | `/ky-baseline`, `/ky-mission-start`, `/ky-review`. |
| **Collaboration skill** | `skills/kyberion-coordination/SKILL.md` | Minimal operator workflow for prompt capture, mission start, and review handoff. |

All hook logic lives in the unit-tested `@agent/core/claude-code-hook.ts`; the hooks call the thin `dist/scripts/claude_code_hook.js` wrapper.

## Install

Prerequisite: build the repo so `dist/` exists (`pnpm install && pnpm build`).

Add this directory as a plugin (or via a marketplace entry pointing here). The hooks self-locate the repo via `$CLAUDE_PLUGIN_ROOT/../..`, so no extra env is required when the plugin lives inside the repo.

## Scope / roadmap

- v0.1: tier-guard (writes), audit (Write/Edit/Bash), SessionStart priming, prompt capture, Stop review handoff, MCP surface, 3 commands.
- Planned: Bash-level secure-io screening and richer mission-level summaries.
