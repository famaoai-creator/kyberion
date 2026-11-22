---
category: Changed
---

- **`check:docs-impact --out` writes into the same checkout's mission evidence** — the governed-writer fallback now also covers persona `POLICY_VIOLATION … NOT authorized to write` denials when `--mission-root` is given (tenant-scope and fail-closed denials still propagate). Pilot-1 retro's cross-checkout path is unchanged.
- **Canonical `AccountOwnerKind` vocabulary** — `service-binding-owner.ts` now exports `ACCOUNT_OWNER_KINDS`, `isAccountOwnerKind`, and `isPersonAccountOwner` (the non-operator subset of `BindingOwnerKind`); `account-introduction.ts` and `secret-guard.ts` consume it instead of re-declaring the `'person' | 'organization'` union.
- **`CURATION_REPORT.md` publication contract** — the report header and the `knowledge_steward` procedure now state that the weekly pipeline leaves the artifact uncommitted and each run lands via a `chore(knowledge)` PR.
- **Agent projection ownership documented** — `multi-provider-coexecution-contract.md` records that `.agents/agents/` is the AGY-only path; other provider CLIs consume their own `.devin/agents/`, `.claude/agents/`, `.cursor/agents/`, `.codex/agents/` directories.
