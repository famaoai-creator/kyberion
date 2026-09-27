---
category: Added
---

- **Approval-mediated mission close for intent-drift blocks** — `pnpm mission triage <ID>` diagnoses why a mission cannot finish and prints the lowest-privilege path out; `pnpm mission scope-approve <ID> --request-approval` files a hash-bound human approval request (visible via `pnpm kyberion approvals`, which now renders the full proposal inline), and `--approval-request-id` applies it without SUDO. The human decider is recorded as `approved_by`, and the rebaseline closes the `repair-intent-drift` task so `verify → distill → finish` completes.
