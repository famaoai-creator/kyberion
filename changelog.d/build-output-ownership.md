---
category: Fixed
---

- Build outputs now have one compiler owner: libraries keep package-local dist and incremental records, while existing runtime launch paths share one runtime graph. Package entrypoints and build commands use those same owners.
- Clean removes only declared outputs and legacy build records. Physical source-shadow checks catch ignored/untracked artifacts while preserving documented source exceptions; freshness also reports orphaned outputs after deletion or rename.
- Bundles are separate final-stage artifacts instead of overwriting compiler emits. Real-compiler fixtures verify clean/ordered/incremental equivalence, source add/delete/rename, cleanup and runtime behavior.
