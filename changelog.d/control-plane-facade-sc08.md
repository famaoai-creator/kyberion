---
category: Changed
---

- **Single control-plane facade + shared surface access (SC-08)** — `getControlPlaneForScope` is now the only construction site for `CloudflareOsControlPlane` (fail-closed tenant validation; the journal already namespaces by tenant), and `resolveOsSurfaceAccess` centralizes the viewer→access rule the OS surfaces duplicated (`KYBERION_TENANT` narrowing + `human:` principal requirement). computer-surface / operator-surface / chronos share-grants / service-actuator / held-effect-bridge all go through the shared instance; a contract test rejects any new direct `new CloudflareOsControlPlane(`.
- **Governance stamps no longer leak into op inputs** — waterfall stage metadata (`_effect`, `_resource_ref`, `_egress_taint`) is extracted into `preflight.governance_stamps` by `finalizePreflightResult`, so strict op schemas never see it; post-op stages consume it alongside the cleaned input.
