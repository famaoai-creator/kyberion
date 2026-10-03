---
category: Added
---

- **Scope envelope (SC-01)** — the runtime can now mint a two-layer scope envelope (`identity` snapshot + attenuable `policy`) at dispatch boundaries, and delegations through the coordinated agent execution port run inside a narrowed child envelope. Caller-provided `security_scope`/`scope_envelope` inputs are checked as narrow requests and enlargement is denied. Unenveloped governed ops are still allowed but counted for the rollout. Also fixes service observations and egress context to read the canonical `tenant_slug` (previously only the legacy `tenant_id` alias).
