---
category: Added
---

- **Claude Code on the web sessions start ready to run.** A `SessionStart` hook (`.claude/hooks/session-start.sh`) switches the container to Node 24, runs `pnpm install`, and builds `dist/` when it is missing or was built from a different commit. The mandatory session-start baseline check (`pnpm pipeline --input pipelines/baseline-check.json`) then works without manual setup. The first start in a fresh container takes about 6 minutes; later starts on the same commit take seconds. Local sessions are unaffected.
