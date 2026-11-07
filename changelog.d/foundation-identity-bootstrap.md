---
category: Security
---

- Separate configured identity resolution from the seam catalog while preserving synchronous audit recording. Enforce a single identity resolver, roll back failed registration, and restore the fallback on disposal even when a listener fails. Resolver lifetime follows module reloads.
