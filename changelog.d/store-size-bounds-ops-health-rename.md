---
category: Changed
---

- **Breaking for external alert rules**: the ops-health trigger journal finding is renamed `trigger-store-near-cap` → `trigger-store-growth`, and the trigger store snapshot field `cap_bytes` → `warn_bytes`. The finding is now warn-only (the journal has no append cap). Update any alert matcher or dashboard that keys on the old id or field.
- `auditChain.record()` now throws `[AUDIT_SCOPE_DENIED]` when the caller's own access scope cannot read the audit chain tail, and `[AUDIT_CHAIN_TAIL_UNREADABLE]` when the newest audit day cannot be read or holds no valid record. Before, such appends chained from an older record and silently forked the chain.
