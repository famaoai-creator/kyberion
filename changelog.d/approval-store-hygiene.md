---
category: Changed
---

- **The approval store keeps only real decisions.**
  - Test runs no longer write approvals into the live store. They write to `active/shared/runtime/vitest-approvals/`, which is cleared after a day.
  - Policy auto-approvals of secrets are recorded as `decidedByType: service` with decider `policy:secret-introduction-local-low-risk` instead of as a human decision.
  - Secret introduction requests expire 24 hours after creation.
  - To clean up the leftovers, run `node dist/scripts/approval_store_hygiene.js` to see what it would do. Add `--apply` with `KYBERION_PERSONA=sovereign` to act; without that persona it stops before changing anything and prints the command to run. This moves fixture approvals left by earlier test runs to `active/archive/.trash/` (restorable for 30 days) and expires pending requests that are overdue or older than 14 days with no expiry.
