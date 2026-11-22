---
category: Added
---

- Added integration coverage proving repository-scoped `vcs:pr_create` charter delegation end-to-end — a granted charter dispatches publication without a human approval request, while grant mismatch, tripwires and retirement all fail closed to the human gate — plus a dry-run-verified note in the delegated operations runbook on personal-runtime preconditions and the exactly-once reservation layer that charter delegation does not bypass.
- Made `email:send` and `voice:transcribe_provider` charter-delegable: recipient-pinned (`backend` + exact `to`, optional `from`) and provider-pinned grants respectively, completing the wiring their call sites already declared.
