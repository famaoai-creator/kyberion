---
category: Fixed
---

- **`pnpm kyberion pr create` no longer fails under tenant scope with `ROLE_VIOLATION`** — the runtime external-operation authority resolver wrote its review evidence (`external-operation-review/…`) under ambient identity, which is denied on `active/shared/artifacts/confidential/<tenant>/`. When a trusted host already owns review artifacts via `withExplicitExternalApprovalRequest` (the publication host), the resolver now defers to `request.reviewArtifacts` — the refs it produced were discarded on that path anyway — so the write runs under the bound `pr_publication_store` role and resource ceiling. The pipeline-runtime path (no explicit request) is unchanged.
