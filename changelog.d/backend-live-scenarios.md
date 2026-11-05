---
category: Added
---

- Add opt-in live backend conformance scenarios (`pnpm kyberion check backend-live-scenarios --live --mode <mode>`): drive a reasoning backend through first / follow-up / reset / abort / artifact turns, judge each from the backend's own answer, and record one JSON run per backend under `active/shared/runtime/backend-live-scenarios/`. Without `--live` it only prints the plan and the model-turn cost warning.
- `check:backend-capability-honesty` now checks declared `session_continuity` and `abort` against recorded live runs: a declared capability a run failed is a `contradicted_capability` violation, and with no run the claim stays `unproven`.
