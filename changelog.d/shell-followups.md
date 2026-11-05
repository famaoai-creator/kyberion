---
category: Fixed
---

- The 仕事 mission board has a 計画中 column, so its counts match the Home mission tile; the "planned" status reads 計画中 in the shared status pill and the mission vocabulary.
- Missions created without a goal show a readable name built from their id (`CLI GOV FIX (2026-10-30)`) instead of the raw id.
- `/ops` no longer logs a hydration mismatch: Mission Intelligence reads the locale through the mount-safe hook.
