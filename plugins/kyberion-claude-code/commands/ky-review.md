---
description: Run the Kyberion review/distill phase — capture learnings and clean up.
---

Run the Review phase (CLAUDE.md §3 ⑤):

1. Distill the session's learnings (successes and failures) into `knowledge/` via the normal review flow / `scripts/refactor/mission-distill.ts` where a mission is active.
2. Clean up temp files (`active/shared/tmp/` or mission-local only).
3. Confirm the audit chain captured this session's Write/Edit/Bash actions (the plugin's PostToolUse hook records them automatically) — call `kyberion.audit.verify` if integrity needs confirming.
4. Summarize what was learned and what was promoted to knowledge.
