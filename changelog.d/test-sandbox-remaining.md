---
category: Fixed
---

- **Test runs leave less behind in live runtime state.** Child processes started by a test now inherit `VITEST`/`VITEST_POOL_ID`, so they use the same `vitest-live` sandbox as the test itself. The sandbox also covers orchestration, pipeline runs, run graphs, worker events, health and similar internal state. On a full local run, files written into live `active/` dropped from 83 to 39. Task sessions, work coordination, the feedback loop, tenants, service receipts and traces are not sandboxed yet, because their tests seed the live paths directly. `active/shared/tmp/vitest-active-leaks.json` still reports them.
