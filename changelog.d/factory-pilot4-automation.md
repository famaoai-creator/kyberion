---
category: Added
---

- **`pnpm kyberion knowledge curation-publish`** — turns a generated, uncommitted `CURATION_REPORT.md` into a `chore(knowledge)` PR (branch `chore/knowledge-curation-<date>`, single-file commit, push, then the governed `pr create` path — readiness gate, KL-03 and human approval all still apply). Refuses when the report is missing/unmodified or the worktree carries unrelated changes; `--dry-run` prints the plan.
- **`persona_write_denied` policy-violation type** — `error-classifier-rules.json` now types the tier-guard "NOT authorized to write" denial; `check:docs-impact --out` keys its governed-writer fallback on `explainPolicyViolation().violationType` instead of matching message substrings (other violation classes still propagate fail-closed).
- **Flake fix** — `personal-service-credential-dispatch.integration.test.ts` tests now carry the CI-class 30s timeout explicitly so broad parallel `vitest` runs cannot hit the local 10s default.
