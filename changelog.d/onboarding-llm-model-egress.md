---
category: Added
---

- **Choose the model and provider egress during onboarding** — `pnpm onboarding llm select --backend <mode> [--model <id>] --apply` records the reasoning backend and model (validated against `reasoning-backend-policy.json` allowed_modes and the model registry) in the operator LLM selection that routing already reads, and audits it. `pnpm onboarding llm attest --tenant <slug> --provider <id> --training-use none --plan … --basis … --attested-by … --apply --accept` records an audited per-tenant provider attestation (same store as `pnpm tenant attest-provider`, which now also rejects undeclared providers and writes `tenant.attest_provider` to the audit chain), so confidential work such as mission distillation can use that provider for that tenant only. Default stays deny.
- **See what each data tier can use** — `pnpm onboarding llm show --tenant <slug>` and `pnpm tenant:activation plan` (`llm_availability`) list, per tier, the providers usable for LLM work and point to `attest` when confidential has none.
