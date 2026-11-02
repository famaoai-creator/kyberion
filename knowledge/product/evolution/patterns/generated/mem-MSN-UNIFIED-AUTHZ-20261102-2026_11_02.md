---
record_id: mem-MSN-UNIFIED-AUTHZ-20261102-2026_11_02
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-UNIFIED-AUTHZ-20261102-2026_11_02
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-02T19:23:41.128Z
source_branch: feat/unified-authz-20261102
source_commit: 8e92e8d41c84629a03135a46926e63e7899e994f
---

# Declarative authorization registry — code base plus governed data layers

Operation authorization is declared in a typed code registry (effect class + authority + delegation) with two additive data layers: a governed JSON overlay and plugin-manifest authorizations. Code always wins; data layers cannot weaken reviewed declarations (schema rejects local_only/free and code-owned key collisions are dropped).

## Applicability

- mission
- mission:MSN-UNIFIED-AUTHZ-20261102

## Reusable Steps

1. Operation authorization is declared in a typed code registry (effect class + authority + delegation) with two additive data layers: a governed JSON overlay and plugin-manifest authorizations
2. Code always wins; data layers cannot weaken reviewed declarations (schema rejects local_only/free and code-owned key collisions are dropped)

## Expected Outcome

Three-layer model: (1) libs/core/foundation/authorization-registry.ts is the reviewed source of truth — EffectClass closed taxonomy, AuthorityRequirement, delegation metadata, exact+prefix declarations, fail-safe undeclared default. (2) knowledge/product/governance/authorization-registry.json is a governed-catalog overlay loaded via defineCatalog, schema-validated, additive-only. (3) plugin manifests may carry an authorizations block, scanned only from activation-allowed managed copies, tagged plugin:<id>, cached by content digest + activation status, errors never cached as empty. Lookup order: code exact → code longest-prefix → data exact → data longest-prefix → fail-safe. Data-layer hardening rules: no local_only, no free authority, code collision dropped with warning, manifest parse errors not cached. Undeclared operations resolve to external_mutation + admission so measurement can watch them before enforcement.

## Evidence

- active/missions/public/MSN-UNIFIED-AUTHZ-20261102/evidence/implementation-report.md
- active/missions/public/MSN-UNIFIED-AUTHZ-20261102/evidence/test-report.md
- active/missions/public/MSN-UNIFIED-AUTHZ-20261102/evidence/retrospective.md

## Artifacts
