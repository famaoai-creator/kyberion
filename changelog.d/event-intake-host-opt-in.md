---
category: Added
---

- **Per-host event intake sources** — `KYBERION_EVENT_INTAKE_SOURCES=github` enables a declared intake source on one host without editing the shared `event-intake-policy.json`; the HMAC secret is still required. `repo-guardian` now wakes on GitHub `workflow_run`, `check_suite`, `pull_request` and `issues` events.
