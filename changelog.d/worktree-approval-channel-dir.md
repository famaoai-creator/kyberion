---
category: Fixed
---

- An approval decided from a linked worktree no longer fails with "a path component does not resolve" or "Path outside project root" when the primary checkout is fresh. The per-channel directory (`active/shared/{coordination,observability}/channels/<channel>`) now counts as shared authority state, matched exactly and not its other contents. The first approval can therefore create it in the primary checkout, and the missing-ancestor probe can walk through it.
