---
description: Open a governed Kyberion mission for the work described in $ARGUMENTS.
argument-hint: <mission goal>
---

Open a governed Kyberion mission for: $ARGUMENTS

1. Confirm the goal with me in one line (Alignment — no code changes until agreed).
2. Start the mission via `scripts/mission_controller.ts` (start), not by editing mission state directly.
3. Prefer the deterministic-first ladder: an existing `pipelines/` pipeline → governed actuators → hand-written ADF → ad-hoc edits. Check `pipelines/README.md` / `CAPABILITIES_GUIDE.md` first.
4. Work through Execution (change one thing, test immediately), then run `/ky-review`.
