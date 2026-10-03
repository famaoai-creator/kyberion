---
record_id: mem-MSN-OWNER-SCOPE-RESOLVER-20261002-2026_10_03
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-OWNER-SCOPE-RESOLVER-20261002-2026_10_03
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-03T01:04:33.332Z
source_branch: claude/owner-scope-resolver
source_commit: a95e49e6d37176a8ebcd8e764ec23713de027ecc
---

# Resolve placement from the owner record; caller scope only narrows

Rejecting writes whose caller-supplied tier/tenant disagreed with the owner wasted work and still guessed directories elsewhere. One resolver (resolveOwnerScope) now derives tier, tenant, organization and directory from the owner record; caller values only narrow or select, and every remaining rejection is a structured code with a remedy. Two review rounds found the fail-open edges listed here.

## Applicability

- mission
- mission:MSN-OWNER-SCOPE-RESOLVER-20261002

## Reusable Steps

1. Rejecting writes whose caller-supplied tier/tenant disagreed with the owner wasted work and still guessed directories elsewhere
2. One resolver (resolveOwnerScope) now derives tier, tenant, organization and directory from the owner record; caller values only narrow or select, and every remaining rejection is a structured code with a remedy
3. Two review rounds found the fail-open edges listed here

## Expected Outcome

- Derive scope from the owner (mission state, project record, organization record) in one resolver; a caller tier/tenant is a hint that narrows or selects among same-id owners, and a contradiction is an explicit SCOPE_CONTRADICTS_OWNER error with a remedy, never a silent override.
- Fail closed on uncertainty: unknown owner, ambiguous id across tenants (writes), a state tenant that disagrees with its tenant directory, and a recorded tenant that is not a valid slug are unknown — never mapped to shared, which every tenant can see. Hints may normalize empty/'default' to shared; recorded state may not.
- A tenant-bound identity must not be able to resolve another tenant's owner at all (not found, no disclosure).
- Event and journal paths should select by tenant only: a mission's tier can be raised after an event was scoped.
- Read helpers may treat ambiguous/unknown as 'not mine' (keep output inline, skip); write paths must throw.
- Memoize lookups only with revalidation (state mtime) and never memoize not-found.
- Append-only ownership registries need a latest-row view before filtering, a separate history query for offboarding, and compaction that keeps one row per (artifact, owner) so audit history survives; dry runs take no lock, the rewrite re-reads under the append lock.
- Replacing guessed directory fallbacks across many call sites needs owners seeded in tests; tests writing for non-existent owners surface as OWNER_NOT_FOUND.

## Evidence

- active/missions/public/MSN-OWNER-SCOPE-RESOLVER-20261002/evidence/implementation-report.md
- active/missions/public/MSN-OWNER-SCOPE-RESOLVER-20261002/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-OWNER-SCOPE-RESOLVER-20261002/evidence/test-report.md

## Artifacts
