---
category: Added
---

- **Standing grants (PG-03/04)** — `pnpm kyberion grants list|check|grant|revoke` manages scoped, time-bounded grants decided ahead of time. `meeting.recording` can now be granted per tenant for meeting series ids and/or meeting URLs (up to 90 days); because it brings audio in from an external service, granting it needs a human approval bound to exactly what is granted (`grants grant --request-approval` → `pnpm kyberion approvals --approve <id>` → `grants grant --approval-request-id <id>`). Meeting recording consent accepts a matching standing grant when the mission has no `voice-consent.json`, and records which grant allowed it in the mission evidence (`evidence/grant-bindings.json`). Speaking stays a per-mission consent. The capability rules live in `knowledge/product/governance/grant-capability-policy.json`; grants are stored under `active/shared/runtime/grants/<tier>/<tenant>/`.
