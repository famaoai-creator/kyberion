---
category: Fixed
---

- **Organization operation runs complete** — `pnpm organization operation run execute --apply` no longer fails with "operation run already exists" after the pipeline finishes, and `operation tick` can again close interrupted runs as `blocked`. Runs stuck in `started` from earlier versions are recovered by the next `operation tick --apply`.
- **New tenants pass activation's memory policy** — `pnpm tenant create` and `pnpm onboarding company` now register new tenants with strict isolation (`strict_isolation: true`, `allow_cross_distillation: false`), which `tenant:activation` requires. Existing tenants are unchanged.
- **Onboarding guidance matches what works** — `baseline-check` prints its `status` line, `pnpm check -- --only <gate>` finds full-scope gates such as `tenant-registry`, an unset operator persona is reported as `export KYBERION_PERSONA=sovereign` instead of a generic path-scope error, `onboarding company` rollback no longer hides the original error and its next steps include switching to the company stance and saving its identity, and the onboarding flow documents the AI-company order, activation probe evidence, and a new Step 10 for running the organization.
