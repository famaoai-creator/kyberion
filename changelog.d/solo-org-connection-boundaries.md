---
category: Security
---

- Personal connections are visible only to their identified owner, including on loopback. Ownerless legacy records remain stored but hidden until the existing owner migration explicitly assigns them; tenant visibility does not grant personal ownership.
- Tenant service execution requires an admitted tenant service binding even when the preset did not opt in. Personal non-tenant execution is unchanged; connection selection is not a substitute for credential, delegation, approval, or data-egress authorization.
