---
category: Fixed
---

- **Fallback success condition no longer passes a run** — when a browser recording has no explicit success anchor, the compiler's "last action's target is visible" condition is now marked `params.anchor: last_action_target` and counted as weak, so a click that changed nothing can no longer pass the golden check.
