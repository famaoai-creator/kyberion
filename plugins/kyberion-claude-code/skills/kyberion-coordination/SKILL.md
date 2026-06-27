---
name: kyberion-coordination
description: Coordinate Claude Code work with Kyberion by capturing the user prompt, opening or resuming a governed mission, selecting the right preference profile, and closing with an explicit review handoff.
status: implemented
category: Orchestration
tags:
  - kyberion
  - claude-code
  - coordination
  - mission-control
---

# Kyberion Coordination

Use this skill when a Claude Code session should stay aligned with Kyberion instead of drifting into ad hoc edits.

## Workflow

1. Capture the user prompt as the shared coordination brief.
2. Decide whether this is mission work, a small follow-up, or a review-only request.
3. Use the governed Kyberion path first: `pnpm pipeline`, `scripts/mission_controller.ts`, or the `kyberion.*` MCP tools.
4. Keep brief, theme, and pattern decisions separate for presentation work.
5. End with `/ky-review` when code, knowledge, or audit state changed.

## Hook Expectations

- `SessionStart`: load the operating-guide reminder.
- `UserPromptSubmit`: summarize the prompt and surface the next Kyberion step.
- `PreToolUse`: enforce tier-guard on writes.
- `PostToolUse`: record audit metadata.
- `Stop`: remind the operator to review or checkpoint the mission.

## Notes

- Keep the prompt summary short.
- Prefer governed tools over raw shell or direct file edits when Kyberion has an actuator or pipeline for the task.
- Do not leak personal or confidential knowledge into the skill output.
