---
category: Fixed
---

- 設定 › 自律度 (onboarding authority) loads for the personal owner again when a company scope is saved with `pnpm scope use <tenant>`.
  - The cause: personal approval store IO inherited the saved scope file's company binding, so listing `tenant-approvals/personal/shared/owners/<owner>/` failed with `tenant.scope_invalid_prefix`.
  - That IO now resolves its scope from the registered environment only. A company bound in the environment or explicitly still applies, so a company-bound process stays fenced from the owner partition.
  - The route now shows the person only known refusals, by allowlist. Anything else (role or policy violations, raw file errors, paths) is logged under a correlation id and answered with a generic, uncached 500.
  - Long ids in settings cards now wrap instead of widening the page on a phone.
