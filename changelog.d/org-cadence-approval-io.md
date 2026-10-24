---
category: Fixed
---

- **Organization cadence + Chronos approvals** — Tenant-scoped standup/retro operations no longer fail by listing the protected organizations tier parent; Chronos `approval_decision` can resolve members and write terminal approvals. CLI `approvals --approve` still cannot settle organization decisions (needs surface session); the decision-transition error now says so.
