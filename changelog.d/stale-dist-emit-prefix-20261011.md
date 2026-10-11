---
category: Fixed
---

- **stale-dist emit_prefix regression coverage** — `StaleTargetSpec.emitPrefix` (landed via #1057) now has a pinned test so the package-rootDir emit path cannot silently regress to a flat `<distRoot>` mapping.
