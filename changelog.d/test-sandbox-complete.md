---
category: Fixed
---

- **Test runs keep task sessions, work coordination, the feedback loop, tenants, service receipts, traces and runtime state out of the live `active/` tree.** These stores now resolve into the `vitest-live` sandbox like the outboxes and audit logs before them. `task-session` and `work-coordination` built their roots by hand and now go through the same remap. Several tests that seeded or deleted the live paths directly now use `pathResolver`; `feedback-loop.test` used to delete the real hints directory on every run.
- **New developer guide:** [`docs/developer/WRITING_TESTS.md`](docs/developer/WRITING_TESTS.md) covers where a test may write, the sandbox, fixture roots, path assertions and the leak guard.
