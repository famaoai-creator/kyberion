---
category: Fixed
---

- `audit mirror-reconcile` findings now name the mirror entries that have no readable master copy (`mirror_only_entries`, `mirror_only_ids`). The approval request also says how many survive only in the archive after the rebuild.
- The reconcile apply path is now tested: approval gating, archive, rebuild from the master, and the receipt. So is a `--since` audit verify window whose boundary file ends in a torn line.
