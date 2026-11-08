---
category: Security
---

- Viewer-tier narrowing now preserves an explicit empty access cap instead of restoring role defaults. Empty or missing resolved caps fail closed; omitted caps still receive defaults at the existing upstream resolution boundary.
