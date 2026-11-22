---
category: Fixed
---

- Removed the unregistered `view_code_item` tool from the agy subagent projection so `kyberion-reviewer` (and other generated agents) start under agy 1.5.x instead of failing with `tool "view_code_item" not found in registry`; added `pnpm prepare:worktree` for one-command fresh-worktree bootstrap; and taught `check:docs-impact --out` to accept `--mission-root` so mission evidence can be written into a sibling checkout's `active/missions/**` through the governed worktree writer.
