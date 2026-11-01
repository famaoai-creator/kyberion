---
category: Changed
---

- **Breaking for external alert rules**: the ops-health trigger journal finding is renamed `trigger-store-near-cap` → `trigger-store-growth`, and the trigger store snapshot field `cap_bytes` → `warn_bytes`. The finding is now warn-only (the journal has no append cap). Update any alert matcher or dashboard that keys on the old id or field.
