---
category: Security
---

- **Custody-owner provider attestations** — material that belongs to no tenant (system role drafts, a person's own material) can now leave the machine only on an installation-level or person-level `training_use: none` attestation, recorded with `pnpm onboarding llm attest --custody system|person --request-approval` and decided by the installation owner via `pnpm kyberion approvals --approve <id>` (same TTL and single-use approval as tenant attestations). The reasoning-send gate and the delegation gate now decide confidential/personal sends with the same evaluator and custody owner, so both give the same answer; a payload `custody` that contradicts its `tenant_slug` is denied. No existing tenant behaviour is loosened except that a tenant's reasoning `no_training` send now accepts exactly the bases the delegation gate already accepted.
