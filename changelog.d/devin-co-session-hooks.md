---
category: Added
---

- **Devin CLI joins co-sessions as its own provider** — Devin CLI auto-loads the tracked `.claude/settings.json` hooks; the bridge now detects the Devin host via its hook-process env and registers presence as `devin-<session_id>` (previously `claude-<session_id>`). PreToolUse/PostToolUse matchers also cover Devin tool names (`exec`, `write`, `edit`, `apply_patch`, `notebook_edit`), and deny responses emit Devin's top-level `decision:"block"` contract, so tier-guard, the deny-only shell gate, lease enforcement, and audit recording now actually fire under Devin.
