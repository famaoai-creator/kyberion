---
category: Added
---

- Add opt-in live backend conformance scenarios (`pnpm kyberion check backend-live-scenarios --live --mode <mode>`): drive a reasoning backend through first / follow-up / reset / abort / artifact turns, judge each from the backend's own answer, and record one JSON run per backend under `active/shared/runtime/backend-live-scenarios/`. Without `--live` it only prints the plan and the model-turn cost warning.
- `check:backend-capability-honesty` now checks declared `session_continuity` and `abort` against recorded live runs: a declared capability a run failed is a `contradicted_capability` violation, and with no run the claim stays `unproven`.
- Abort and latency measurements now observe the provider, not a wrapper: backend conformance refuses a failover chain and treats its own forwarded abort reason as `unavailable`, an aborted CLI delegation rejects only after its child process exits (SIGTERM, then SIGKILL after the grace window) and the live abort scenario passes only on that observed exit, and role-fitness probes run on a caller-bounded backend so a probe beyond 60s is no longer dropped.
