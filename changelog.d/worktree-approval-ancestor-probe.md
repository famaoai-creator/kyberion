---
category: Fixed
---

- `pnpm kyberion pr create` (and any approval request) from a linked worktree no longer fails with "a path component does not resolve" when the primary checkout has no `active/shared/coordination/channels/` yet. secure-io's missing-ancestor probe may now test whether the fixed directories above the authority stores (`active/shared/coordination`, `knowledge/confidential/<tenant>`, …) exist. This is an existence check only: those directories gain no read, write or listing grant.
