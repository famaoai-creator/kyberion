---
category: Added
---

- **Organization approval re-request** — `decision transition --record-status pending_approval --request-approval --chosen-option <o>` now opens a new approval request on an already-`pending_approval` decision instead of failing (no `deferred` detour needed).
- **`pnpm scope push` / `pnpm scope pop`** — stash and restore the persisted scope around temporary `scope use` for `tick`/`execute` (depth-capped at 10, discarded by `scope clear`).
- **Review close-out guidance** — `review-task` now prints the next step (write the REVIEW deliverable, then `record-evidence`) instead of leaving the task pending until `finish`.
