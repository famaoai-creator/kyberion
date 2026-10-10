---
record_id: mem-MSN-WEB-MANAGEMENT-RECOVERY-20261010-2026_10_10
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-WEB-MANAGEMENT-RECOVERY-20261010-2026_10_10
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-10T11:48:18.824Z
source_branch: feat/web-entity-management-20261010
source_commit: bc8cf1e2d3d46d950b7738da43afe50f25aa0b04
---

# Preserve operation semantics across security and dependency boundaries

Reauthorize the actual opened resource with the original operation permissions, and keep transport contracts independent of domain runtime code.

## Applicability

- mission
- mission:MSN-WEB-MANAGEMENT-RECOVERY-20261010

## Reusable Steps

1. Reauthorize the actual opened resource with the original operation permissions, and keep transport contracts independent of domain runtime code

## Expected Outcome

Descriptor pinning must preserve authorization semantics. Metadata-only stat access needs metadata checks at the literal path, canonical path, opened descriptor and nonregular-file fallback. Content readers retain read permissions. Keep foreign-hardlink, vault and inode identity defenses independent of metadata authorization. Default any new operation parameter to existing read behavior; only intended metadata callers opt in, and stat must reauthorize the actual opened target without a cached canonical shortcut.

Keep domain-dependent runtime validation outside transport contracts. Move validators and their runtime domain imports together, preserving validator bodies and admission call sites. Run the dependency-direction test itself, not only package type checks.

Regress both boundaries: metadata succeeds without content access; foreign opened-descriptor substitution, fallback identity changes and hardlinks are rejected; ordinary readers retain their permissions; clean-root management operations remain confined. Security integration should retain upstream race and vault tests without increasing baseline limits.

Examples: libs/core/secure-io.metadata-fd.test.ts; libs/core/secure-io-path-guard.ts; libs/core/surface/surface-management-validation.test.ts; scripts/check_module_boundaries.test.ts.

## Evidence

- active/missions/public/MSN-WEB-MANAGEMENT-RECOVERY-20261010/evidence/implementation-report.md
- active/missions/public/MSN-WEB-MANAGEMENT-RECOVERY-20261010/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-WEB-MANAGEMENT-RECOVERY-20261010/evidence/test-report.md

## Artifacts
