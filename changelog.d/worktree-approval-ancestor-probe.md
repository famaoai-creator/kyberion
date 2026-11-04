---
category: Fixed
---

- `pnpm kyberion pr create` (and any approval request) from a linked worktree no longer fails with "a path component does not resolve" when the primary checkout has no `active/shared/coordination/channels/` yet. secure-io's missing-ancestor probe may now test whether the fixed directories above the authority stores exist (`active/shared/coordination`, `knowledge/confidential/<tenant>`, …). It also spells them back under the primary's logical root, so the first approval directory can be created even when the primary's real path differs from its spelled path. This is existence and spelling only: those directories gain no read, write, listing or mkdir grant, and they must already exist in the primary.
