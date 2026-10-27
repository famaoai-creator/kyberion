---
category: Fixed
---

- `audit mirror-reconcile` rebuild findings now name the mirror entries with no readable master copy in any tenant (`archive_only_entries`, `archive_only_ids`). An entry counts when its master line is unreadable or its mirror copy differs. The approval request says how many will survive only in the archive. The new fields are part of the approved findings, so a request opened before this change no longer matches such findings: reject it and request approval again.
- The reconcile apply path is now tested: refusals, including an approved record whose stored decision is not human-authenticated, plus archive, rebuild from the master, and the receipt. So is a `--since` audit verify window whose boundary file ends in a torn line or a forged record.
