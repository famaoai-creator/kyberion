---
category: Fixed
---

- **Channel binding conflict checks** — strict reads now propagate invalid or
  unreadable tenant binding files, so a bind refuses to modify its target when
  another tenant's channel ownership cannot be checked. Non-strict discovery
  keeps its existing behavior for unavailable records.
