---
category: Fixed
---

- The monthly restore drill no longer fails with `BACKUP_DRILL_CREDENTIAL_COUNT_MISMATCH` when the backup could not count connection documents itself: when an ancestor such as the personal tier is not listable by the backup's role, tar archives that subtree directly, and the manifest now records the credential root as `uncounted` so the drill checks that the archive holds its members instead of comparing against 0. A counted root that disagrees with the archive still fails.
