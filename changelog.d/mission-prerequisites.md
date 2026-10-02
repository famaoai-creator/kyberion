---
category: Fixed
---

- **Mission prerequisites work again** — a prerequisite mission now counts as met once it is `completed` or `archived` (previously a finished mission ended `archived` and blocked its dependents forever unless `--force` was used). `finish` no longer leaves a `mission-state.json` stub at the active path, prerequisite ids are case-insensitive, and the new `--prerequisites MSN-A,MSN-B` flag declares them on `create` / `kickoff` / `start`. Unmet prerequisites fail `start` with `[MISSION_PREREQUISITES_UNMET]` and a non-zero exit. `dispatch` now honors `enqueue` dependencies and keeps an entry pending when its start fails, instead of dropping it.
