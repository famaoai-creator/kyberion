---
category: Fixed
---

- **Organization operation runs complete** — `pnpm organization operation run execute --apply` no longer fails with "operation run already exists" after the pipeline finishes, and `operation tick` can again close interrupted runs as `blocked`. Runs stuck in `started` from earlier versions are recovered by the next `operation tick --apply`.
- **New tenants pass activation's memory policy** — `pnpm tenant create` and `pnpm onboarding company` now register new tenants with strict isolation (`strict_isolation: true`, `allow_cross_distillation: false`), which `tenant:activation` requires. Existing tenants are unchanged.
- **Onboarding guidance matches what works** — `baseline-check` prints its `status` line, `pnpm check -- --only <gate>` finds full-scope gates such as `tenant-registry`, an unset operator persona is reported as `export KYBERION_PERSONA=sovereign` instead of a generic path-scope error, `onboarding company` rollback no longer hides the original error and its next steps include switching to the company stance and saving its identity, and the onboarding flow documents the AI-company order, activation probe evidence, and a new Step 10 for running the organization.
- **`pnpm tenant:activation probe`** — runs the four activation probes (isolation, viewer scope, service readiness, NHI ledger), writes evidence beside the activation receipt, and prints the `activate` command that cites it. `activate` / `plan` now reject a bare-path probe ref that does not exist, probe evidence that did not pass or belongs to another scope, and NHI ids that are malformed or belong to another organization; `<scheme>://` refs are accepted as before.
- **`pnpm stance:create` works without an operator persona** — its script role may now write `customer/` only.
- **`pnpm surfaces status` prints one line per surface** with a summary and next actions; `--json` keeps the full diagnostics.
- **`onboarding company` seeds the operating model** with the vertical's org-chart domains, so `pnpm organization domain list` starts populated.
- **Playwright revision check** — `env:bootstrap` / `doctor` now report when the browser cache lacks the revision the installed playwright needs, and a launch failure for that reason is classified with the install fix instead of "Unclassified error".
