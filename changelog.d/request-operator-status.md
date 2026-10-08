---
category: Added
---

- **Request-specific diagnostic status** — Inspect one exact request without advancing work. Browser handoffs identify each request and revision, while status separates pending human approval from an approved operator handoff and verifies current evidence.
- **Denied audit persistence** — Required tenant-scope checks keep access denied when audit storage is unavailable, report a bounded redacted failure, and no longer recursively queue audit failures that keep the command running.
